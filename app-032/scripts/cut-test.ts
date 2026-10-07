/* 配切算法验收（node 脚本，经 esbuild 转译运行，不进产物） */
import assert from 'node:assert'
import { computeCutPlan, reconcile, routeTradeoff, ceilMm, floorMm, toMeters, fingerprintOf, type OrderLineInput, type RackRef } from '../src/core/cut/cutpack'
import type { StockStick } from '../src/core/cut/types'

let passed = 0
function ok(name: string, cond: boolean, extra = '') {
  assert.ok(cond, name + ' ' + extra)
  passed++
  console.log('PASS', name)
}

// 1) 取整口径
ok('ceilMm 向上取整并消浮点尾差', ceilMm(299.2 + 40) === 340 && ceilMm(300 + 40) === 340 && ceilMm(100.0000001) === 101)
ok('floorMm 库存容量向下取整', floorMm(899.9) === 899 && floorMm(900.0000001) === 900)
ok('toMeters 折米 3 位', toMeters(1234) === 1.234)

function stick(id: string, lengthMm: number, at = 't'): StockStick {
  return { id, lengthMm, status: 'rack', origin: { type: 'inbound', at } }
}
function rack(list: [string, number][]): RackRef[] {
  return list.map(([id, len]) => ({ stick: stick(id, len), availMm: floorMm(len), baseSegment: 0, startOffsetMm: 0 }))
}

const lash = 20
const lines: OrderLineInput[] = [
  {
    uid: 'OL1',
    lanternId: 'L1',
    lanternName: '六角宫灯',
    count: 2,
    members: [
      { memberSeq: 0, memberId: 'FM001', label: '竖篾', netMm: 300, allowanceMm: 40, qty: 6 }, // cut 340 ×12
      { memberSeq: 1, memberId: 'FM002', label: '底盘圈边', netMm: 96.6, allowanceMm: 20, qty: 6 } // 96.6+20=116.6 → ceil 117 ×12
    ]
  }
]

const inventory: RackRef[] = rack([
  ['M0001', 1200],
  ['M0002', 1200],
  ['M0003', 1200],
  ['M0004', 1200],
  ['M0005', 1200],
  ['M0006', 1200]
])

const r = computeCutPlan({ calcNo: 1, lashAllowanceMm: lash, lines, rack: inventory, selected: 'long_first', generatedAt: 't' })

// 2) 需求合并与取整
ok('件数 = 2 盏 × (6+6) = 24', r.pieces.length === 24)
ok('合并构件 2 种', r.groups.length === 2)
ok('竖篾截取 = ceil(340) = 340', r.groups.find((g) => g.label === '竖篾')!.cutMm === 340)
ok('底盘圈边截取 = ceil(116.6) = 117（不能拿 116.6 比）', r.groups.find((g) => g.label.includes('底盘'))!.cutMm === 117)
ok('需求合计 = 12*340 + 12*117 = 5484mm = 5.484m', r.demandMm === 5484 && r.demandM === 5.484)

const plan = r.plans.long_first
// 3) 可行 + 守恒
ok('省料路线可行', plan.fullyFeasible && plan.shortages.length === 0)
ok('能做 2 盏', r.feasibleLights === 2 && r.requestedLights === 2)
const rec = reconcile(plan.sticks)
ok('逐篾守恒 容量=段合计+残料（差 1mm 也失败）', rec.ok && rec.totalDiffMm === 0, JSON.stringify(rec.perStick))
ok('逐段合计 = 用掉总量 = 需求合计', plan.consumedMm === 5484)
for (const s of plan.sticks) {
  const segSum = s.segments.reduce((a, x) => x.cutMm + a, 0)
  ok(`料 ${s.stickId} 段合计 ${segSum} = usedMm ${s.usedMm}`, segSum === s.usedMm)
  // 段号连续、起点累计
  s.segments.forEach((seg, i) => {
    ok(`料 ${s.stickId} 第 ${i + 1} 段编号正确`, seg.segment === i + 1)
    if (i > 0) ok(`料 ${s.stickId} 段起点连续`, seg.startMm === s.segments[i - 1].startMm + s.segments[i - 1].cutMm)
  })
  if (s.remainKind === 'usable') ok(`料 ${s.stickId} 留用残料 ${s.remainMm} ≥ 最短件 ${r.minCutMm}`, s.remainMm >= r.minCutMm)
  if (s.remainKind === 'waste') ok(`料 ${s.stickId} 废料 ${s.remainMm} < 最短件 ${r.minCutMm}`, s.remainMm < r.minCutMm)
}

// 4) 省料 vs 省时：两条路都给方案；代价方向用「省料废料不高于省时废料 / 省时箱数不高于省料箱数」核对
const sh = r.plans.short_first
ok('省时路线可行', sh.fullyFeasible)
ok('本数据：省料 0 废料 6 箱，省时 156 废料 5 箱——省料省在料，省时省在工', plan.wasteMm === 0 && plan.usedStickCount === 6 && sh.wasteMm === 156 && sh.usedStickCount === 5)
const to = routeTradeoff(r)
ok('代价对比文案给出材料与工时', to.text.includes('废料') && to.text.includes('工时'))
ok('工时账：搬运+锯截+归架自洽', plan.labor.total === plan.labor.handle + plan.labor.saw + plan.labor.remnant)

// 4b) 另一组数据上省时确实少动根数（两路线的优劣由数据决定，文案如实报）
const mixRack = rack([
  ['N1', 1000], ['N2', 1000], ['N3', 600], ['N4', 600]
])
// 340×4 + 117×8 = 1360+936 = 2296
const mixLines: OrderLineInput[] = [
  { uid: 'OL1', lanternName: '散', count: 1, manual: [
    { uid: 'A', label: '竖篾', netMm: 300, allowanceMm: 40, qty: 4 },
    { uid: 'B', label: '圈边', netMm: 97, allowanceMm: 20, qty: 8 } // 117
  ] }
]
const mix = computeCutPlan({ calcNo: 21, lashAllowanceMm: lash, lines: mixLines, rack: mixRack, selected: 'short_first', generatedAt: 't' })
ok('混搭库存：省时动用根数 ≤ 省料', mix.plans.short_first.usedStickCount <= mix.plans.long_first.usedStickCount,
  `省时 ${mix.plans.short_first.usedStickCount} vs 省料 ${mix.plans.long_first.usedStickCount}`)

// 5) 指纹稳定
const fp1 = fingerprintOf('long_first', plan.sticks, r.purchase)
const fp2 = fingerprintOf('long_first', JSON.parse(JSON.stringify(plan.sticks)), JSON.parse(JSON.stringify(r.purchase)))
ok('指纹确定性', fp1 === fp2 && /^[0-9a-f]{8}$/.test(fp1))

// 6) 根数不够诊断
const shortCount = computeCutPlan({
  calcNo: 2, lashAllowanceMm: lash, lines,
  rack: rack([
    ['M1', 1200], ['M2', 1200], ['M3', 1200], ['M4', 1200]
  ]),
  selected: 'long_first', generatedAt: 't'
})
ok('库存不足时不可行', !shortCount.feasible)
const cntShort = shortCount.plans.long_first.shortages.filter((s) => s.type === 'count')
ok('诊断为根数不够（长度都够）', cntShort.length > 0 && shortCount.plans.long_first.shortages.every((s) => s.type === 'count'))
ok('添料按规格合并计数', shortCount.purchase.every((l) => l.qty > 0 && l.totalMm === l.specMm * l.qty && Math.abs(l.totalM - toMeters(l.totalMm)) < 1e-9))

// 7) 长度不够诊断：竖篾 340mm，库内最长 300mm
const longLines: OrderLineInput[] = [{ uid: 'OL1', lanternName: '散', count: 1, manual: [{ uid: 'MP1', label: '长竖篾', netMm: 320, allowanceMm: 40, qty: 2 }] }] // 360
const shortLen = computeCutPlan({
  calcNo: 3, lashAllowanceMm: lash, lines: longLines,
  rack: rack([['M1', 300], ['M2', 200]]),
  selected: 'long_first', generatedAt: 't'
})
ok('任何库存都短 → 长度不够', shortLen.plans.long_first.shortages.some((s) => s.type === 'length' && s.cutMm === 360 && s.maxStockMm === 300))
ok('长度不够时能做 0 盏', shortLen.feasibleLights === 0)
ok('添料建议 ≥ 360mm', shortLen.purchase[0].specMm >= 360)

// 8) 残料判定必须用取整后整数：库存 457mm，件 117×3 = 351，余 106 < 117 → 废料；若用 116.6 误判会以为 106<116.6 也废；构造 117 件余 117 边界
const edge: RackRef[] = rack([['E1', 457]]) // 3×117=351, remain 106 → waste
const edgeLines: OrderLineInput[] = [{ uid: 'OL1', lanternName: '散', count: 1, manual: [{ uid: 'MP1', label: '圈边', netMm: 96.6, allowanceMm: 20.3, qty: 3 }] }] // 116.9 → ceil 117
const edgeRes = computeCutPlan({ calcNo: 4, lashAllowanceMm: lash, lines: edgeLines, rack: edge, selected: 'long_first', generatedAt: 't' })
const esp = edgeRes.plans.long_first.sticks[0]
ok('取整后残料 106 < 取整件 117 → 明确废料（不是拿 116.9 比）', esp.remainMm === 106 && esp.remainKind === 'waste')

// 边界：余料恰好 = 最短件 → usable；4×117=468 用尽
const edge2: RackRef[] = rack([['E2', 468]])
const edgeLines4: OrderLineInput[] = [{ uid: 'OL1', lanternName: '散', count: 1, manual: [{ uid: 'MP1', label: '圈边', netMm: 96.6, allowanceMm: 20.3, qty: 4 }] }]
const e2 = computeCutPlan({ calcNo: 5, lashAllowanceMm: lash, lines: edgeLines4, rack: edge2, selected: 'long_first', generatedAt: 't' })
ok('恰好用尽 remainKind=none', e2.plans.long_first.sticks[0].remainMm === 0 && e2.plans.long_first.sticks[0].remainKind === 'none')

// 9) 余料续截：RackRef baseSegment/startOffset
const reuse: RackRef[] = [{ stick: stick('M0001', 1200), availMm: 200, baseSegment: 3, startOffsetMm: 1000 }]
const reuseLines: OrderLineInput[] = [{ uid: 'OL1', lanternName: '散', count: 1, manual: [{ uid: 'MP1', label: '短件', netMm: 97, allowanceMm: 20, qty: 1 }] }] // 117
const rr = computeCutPlan({ calcNo: 6, lashAllowanceMm: lash, lines: reuseLines, rack: reuse, selected: 'long_first', generatedAt: 't' })
const rsp = rr.plans.long_first.sticks[0]
ok('续截段号接续为第 4 段', rsp.segments[0].segment === 4 && rsp.isRemnantReuse)
ok('续截起点为绝对位置 1000', rsp.segments[0].startMm === 1000)
ok('续截后残料 83 < 117 判废', rsp.remainMm === 83 && rsp.remainKind === 'waste')
// 续截整根账也要平：原长 1200 = 历史已用 1000 + 本次 117 + 残料 83
const rrec = reconcile(rr.plans.long_first.sticks)
const rrow = rrec.perStick[0]
ok('续截整根对账：原长 = 历史已用 + 本次段合计 + 残料', rrow.fullDiffMm === 0 && rsp.stockCapMm - rsp.priorUsedMm - rsp.usedMm - rsp.remainMm === 0)

// 10) 改盏数后再算：身份键不变、件数变
const lines3: OrderLineInput[] = [{ ...lines[0], count: 3 }]
const r3 = computeCutPlan({ calcNo: 7, lashAllowanceMm: lash, lines: lines3, rack: inventory, selected: 'long_first', generatedAt: 't' })
ok('3 盏 = 36 件', r3.pieces.length === 36)
ok('同构件身份键跨批次不变', r3.pieces[0].key === r.pieces[0].key)

console.log(`\n全部 ${passed} 项断言通过`)
