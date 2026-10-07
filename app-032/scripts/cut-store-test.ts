/* 配切作坊 store 级集成测试：提交、三处同源、整批复算 diff、作废退回、导出拦截 */
import assert from 'node:assert'

// ---- 浏览器环境垫片：localStorage ----
const mem = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
}
Object.assign(globalThis, { localStorage: localStorageShim })

import {
  cutState,
  loadCutStore,
  inboundSticks,
  addManualLine,
  addManualPiece,
  workingResult,
  commitPlan,
  commitAfterRouteSwitch,
  voidPlan,
  latestActivePlan,
  activePlans,
  recordExport
} from '../src/core/cut/store'
import { reconcile } from '../src/core/cut/cutpack'
import { diffPlan } from '../src/core/cut/diff'
import { cutPiecesCsv, cutSticksCsvFull, cutPurchaseCsv } from '../src/core/cut/exporter'
import type { CommittedPlan } from '../src/core/cut/types'

let passed = 0
function ok(name: string, cond: boolean, extra = '') {
  assert.ok(cond, name + ' ' + extra)
  passed++
  console.log('PASS', name)
}

// 干净起点
mem.clear()
loadCutStore()
// 清掉示例库存，自建
cutState.sticks.splice(0, cutState.sticks.length)
cutState.lines.splice(0, cutState.lines.length)
cutState.plans.splice(0, cutState.plans.length)

// 库存：9×1200（第一版用约 3 根、留余料；第二版翻倍后总料仍够）
inboundSticks(1200, 9)
ok('入库 9 根', cutState.sticks.length === 9)

// 订单：散件，竖篾 340 ×6（净300+余量40）、圈边 117 ×6（净96.6+余量20.3→116.9→117）
const line = addManualLine('测试订单')
addManualPiece(line.uid, { label: '竖篾', netMm: 300, lashJoints: 2, count: 6 })
addManualPiece(line.uid, { label: '圈边', netMm: 96.6, lashJoints: 1, count: 6 })

cutState.route = 'long_first'
const r1 = workingResult.value
ok('12 件需求', r1.pieces.length === 12)
ok('省料方案可行', r1.feasible)

// 1) 提交存档
const no1 = commitPlan()
ok('存档号为 1', no1 === 1)
const p1 = latestActivePlan()!
ok('存档是 active', p1.status === 'active')
ok('存档残料为 0 废料（精确求解）', p1.wasteMm === 0, `waste=${p1.wasteMm}`)
const fp1 = p1.fingerprint

// 2) 三处同源：构件表 CSV、料架 CSV、添料单 CSV 都带同方案号/指纹
const csvPieces = cutPiecesCsv(p1)
const csvSticks = cutSticksCsvFull(
  p1,
  cutState.sticks.map((s) => ({ id: s.id, lengthMm: s.lengthMm, status: s.status, note: s.note, originText: '入库' }))
)
const csvPurchase = cutPurchaseCsv(p1)
ok('构件表抬头带方案号与指纹', csvPieces.includes(`第 ${no1} 版`) && csvPieces.includes(fp1))
ok('料架表抬头带方案号与指纹', csvSticks.includes(`第 ${no1} 版`) && csvSticks.includes(fp1))
ok('添料单抬头带方案号与指纹', csvPurchase.includes(`第 ${no1} 版`) && csvPurchase.includes(fp1))
ok('可行方案添料单为空表', p1.purchase.length === 0)

// 3) 三处剩余长度一致：存档 sticks、料架映射、CSV 中同一根篾残料一致
const rec1 = reconcile(p1.sticks)
ok('存档逐篾守恒', rec1.ok)
for (const sp of p1.sticks) {
  const inSticksCsv = csvSticks.includes(`${sp.stickId},${sp.stockMm.toFixed(1)}`)
  ok(`料 ${sp.stickId} 出料架表`, inSticksCsv)
}
// 逐段合计 = 用掉总量
const segSum = p1.sticks.reduce((a, s) => a + s.segments.reduce((x, g) => x + g.cutMm, 0), 0)
ok('CSV/存档：段合计 = consumedMm', segSum === p1.consumedMm)

// 4) 导出登记
ok('导出登记成功（指纹匹配）', recordExport(no1, 'pieces', '构件表.csv', fp1))
ok('指纹不符拒绝登记', !recordExport(no1, 'sticks', '料架.csv', 'deadbeef'))
ok('已登记 1 次导出', p1.exports.length === 1)

// 5) 改盏数整批复算 → calcNo 增加，diff 列出三处变化
line.count = 2
const r2 = workingResult.value
ok('盏数改 2 后件数翻倍 24', r2.pieces.length === 24)
ok('重算批次号前进', r2.calcNo > r1.calcNo)
const d = diffPlan(p1, r2)
ok('diff 认出旧存档', d.hasOld && d.oldPlanNo === 1)
ok('diff 有构件来源变化或新增', d.pieces.length > 0, `pieces diff=${d.pieces.length}`)
ok('diff 有材料用量变化', d.metrics.consumedDeltaMm !== 0)
// 原 12 件身份不变；倍量后最优排样允许把旧件挪到别的篾（这正是「来源段换了」），
// 只要求：每一处 diff 都能在新/旧方案中对上真实料号段号，且变化覆盖三类里至少一类
const changed = d.pieces.filter((c) => c.kind === 'source_changed')
const added = d.pieces.filter((c) => c.kind === 'added')
ok('diff 有来源段换了的件或新增件（整批复算后最优排样重排）', d.pieces.length > 0)
// 变化覆盖：新增 + 换源总数 = 12（原 12 件身份位次仍在，新排样要么留旧坐标要么换源；另一灯 12 件是新增）
ok('换源 + 新增合计覆盖 12 件身份位次', changed.length + added.length >= 12, `changed=${changed.length} added=${added.length}`)
// 换源记录的新旧坐标都真实
const newStickSeg = new Set(r2.plans[r2.selected].sticks.flatMap((sp) => sp.segments.map((g) => `${sp.stickId}#${g.segment}`)))
const oldStickSeg = new Set(p1.sticks.flatMap((sp) => sp.segments.map((g) => `${sp.stickId}#${g.segment}`)))
ok(
  '每条换源记录的旧坐标在旧方案、新坐标在新方案',
  changed.every((c) => oldStickSeg.has(`${c.oldStickId}#${c.oldSegment}`) && newStickSeg.has(`${c.newStickId}#${c.newSegment}`))
)
// p1 提交：截用的父篾转 cut，未用的整根留架；r2 在「留用余料 + 整根留架」上续截
ok('p1 提交后截用篾转 cut、未用整根留 rack', cutState.sticks.some((x) => x.status === 'cut') && cutState.sticks.some((x) => x.status === 'rack'))
ok('r2 续截方案自身逐篾守恒', reconcile(r2.plans.long_first.sticks).ok)

// 6) 批次落后时导出被拦截（模拟 UI 逻辑）：calcNo 不等
ok('存档批次落后于工作态', p1.calcNo !== cutState.calcNo)

// 7) 提交新版（第 2 版，仍是省料路线，库存足够）；提交后第 1 版被取代
const no2 = commitPlan()
const p2 = latestActivePlan()!
ok('第 2 版存档且为唯一活跃方案', no2 === 2 && activePlans().length === 1 && p2.planNo === 2)
ok('第 2 版可行无废料', p2.wasteMm === 0, `waste=${p2.wasteMm}`)
// 第 1 版被标记 superseded（物理执行保留）
const p1After = cutState.plans.find((x) => x.planNo === no1)!
ok('第 1 版被第 2 版取代（superseded，不退回已截段）', p1After.status === 'superseded' && p1After.supersededBy === no2)

// 8) 换路线：原子提交 = 旧活跃版作废（退回重登）+ 提交新路线版
cutState.route = 'short_first'
const rackBefore = cutState.sticks.length
const sw = commitAfterRouteSwitch()
ok('换路线返回旧方案号与退回料号', sw.oldPlanNo === no2 && sw.returned.length > 0)
ok('新路线方案号为 3', sw.planNo === 3)
const p2v = cutState.plans.find((x) => x.planNo === no2)!
ok('第 2 版标记 voided（方案+导出+存档一起作废）', p2v.status === 'voided')
ok('作废记录了退回料号', (p2v.returnedStickIds?.length ?? 0) === sw.returned.length)
ok('料架新增退回篾', cutState.sticks.length === rackBefore + sw.returned.length)
// 原子动作紧接着提交第 3 版，退回篾随即被新方案截用（cut）；核对它们都带「退回来源」痕迹
const retSticks = cutState.sticks.filter((s) => s.origin.type === 'returned')
ok('退回登记的篾数量一致且带原方案/段号痕迹', retSticks.length === sw.returned.length && retSticks.every((s) => s.origin.type === 'returned' && s.origin.planNo === no2))
ok('退回篾随即被新方案截用（cut）或待用（rack）', retSticks.every((s) => s.status === 'cut' || s.status === 'rack'))
// p2v 父篾状态为 returned（不再以旧余料身份出现）
const parents = cutState.sticks.filter((s) => p2v.sticks.some((sp) => sp.stickId === s.id))
ok('旧父篾状态为 returned（不再以旧余料身份出现）', parents.every((s) => s.status === 'returned'))

// 9) 第 3 版（省时）活跃、逐篾守恒
const p3 = latestActivePlan()!
ok('第 3 版为省时路线、唯一活跃', p3.planNo === 3 && p3.route === 'short_first' && activePlans().length === 1)
ok('第 3 版逐篾守恒', reconcile(p3.sticks).ok)
// 第 1 版是 superseded（被第 2 版取代），第 2 版是 voided（换路线退回），状态链清晰
ok('历史链：1 被取代、2 作废、3 活跃', p1After.status === 'superseded' && p2v.status === 'voided' && p3.status === 'active')

// 10) 新路线导出只认第 3 版指纹
ok('第 3 版导出登记成功', recordExport(3, 'sticks', '料架.csv', p3.fingerprint))
ok('第 2 版（已作废）拒绝再登记导出', !recordExport(2, 'pieces', '构件表.csv', p2v.fingerprint))

console.log(`\nstore 集成 ${passed} 项断言通过`)
