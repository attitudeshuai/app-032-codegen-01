/**
 * 配切作坊状态（料架库存 + 订单行 + 已存档方案），localStorage 本地持久化。
 * 三份清单（构件表 / 备料料架 / 添料单）与本机灯样存档只认已提交的 CommittedPlan 快照。
 */
import { reactive, computed, watch } from 'vue'
import type {
  CommittedPlan,
  CutRoute,
  ExportRecord,
  OrderLine,
  PieceDemand,
  StockStick
} from './types'
import { computeCutPlan, fingerprintOf, floorMm, type OrderLineInput, type RackRef } from './cutpack'
import { buildFrame } from '../frame'
import { getLantern, state as lanternState } from '../store'

const KEY = 'lantern-cut-workshop.v1'

interface CutStoreState {
  ready: boolean
  storageError: string
  sticks: StockStick[]
  lines: OrderLine[]
  /** 手工件每处绑扎余量（mm，每端一处） */
  lashAllowanceMm: number
  route: CutRoute
  /** 工作态重算批次号（输入每变一次 +1） */
  calcNo: number
  plans: CommittedPlan[]
  seq: { stick: number; plan: number; line: number; piece: number }
}

export const cutState = reactive<CutStoreState>({
  ready: false,
  storageError: '',
  sticks: [],
  lines: [],
  lashAllowanceMm: 20,
  route: 'long_first',
  calcNo: 1,
  plans: [],
  seq: { stick: 0, plan: 0, line: 0, piece: 0 }
})

function nowIso(): string {
  return new Date().toISOString()
}

function nextStickId(): string {
  cutState.seq.stick += 1
  return 'M' + String(cutState.seq.stick).padStart(4, '0')
}

// ---------------- 料架 ----------------

/** 入库登记：同长度 × 根数，一根一条记录（同一根篾才能逐段对账） */
export function inboundSticks(lengthMm: number, qty: number): number {
  const len = Number(lengthMm)
  const n = Math.max(0, Math.round(qty))
  if (!Number.isFinite(len) || len <= 0) return 0
  for (let i = 0; i < n; i++) {
    cutState.sticks.push({ id: nextStickId(), lengthMm: Math.round(len * 10) / 10, status: 'rack', origin: { type: 'inbound', at: nowIso() } })
  }
  return n
}

/** 删除料架上尚未截用的整根 */
export function removeRackStick(id: string): boolean {
  const i = cutState.sticks.findIndex((s) => s.id === id && s.status === 'rack')
  if (i < 0) return false
  cutState.sticks.splice(i, 1)
  return true
}

export function clearRack(): void {
  cutState.sticks = cutState.sticks.filter((s) => s.status !== 'rack')
}

// ---------------- 订单行 ----------------

/** 订单行骨架：字段必须在进 reactive 之后再补齐，否则后加字段不被深 watch 追踪 */
function pushLine(line: OrderLine): OrderLine {
  cutState.lines.push(line)
  return cutState.lines[cutState.lines.length - 1]
}

export function addLanternLine(lanternId: string, count = 1): OrderLine | undefined {
  const l = getLantern(lanternId)
  if (!l) return undefined
  cutState.seq.line += 1
  return pushLine({
    uid: 'OL' + String(cutState.seq.line).padStart(3, '0'),
    lanternId: l.id,
    lanternName: l.name,
    count: Math.max(1, Math.round(count)),
    manualPieces: []
  })
}

export function addManualLine(name = '手工件订单'): OrderLine {
  cutState.seq.line += 1
  return pushLine({
    uid: 'OL' + String(cutState.seq.line).padStart(3, '0'),
    lanternName: name,
    count: 1,
    manualPieces: []
  })
}

export function removeLine(uid: string): void {
  const i = cutState.lines.findIndex((x) => x.uid === uid)
  if (i >= 0) cutState.lines.splice(i, 1)
}

export function addManualPiece(lineUid: string, p: { label: string; netMm: number; lashJoints: number; count: number }): void {
  const line = cutState.lines.find((x) => x.uid === lineUid)
  if (!line) return
  cutState.seq.piece += 1
  line.manualPieces.push({
    uid: 'MP' + String(cutState.seq.piece).padStart(3, '0'),
    label: p.label || '手工构件',
    netMm: Math.max(0, Number(p.netMm) || 0),
    lashJoints: Math.max(0, Math.round(p.lashJoints)),
    count: Math.max(1, Math.round(p.count))
  })
}

export function removeManualPiece(lineUid: string, pieceUid: string): void {
  const line = cutState.lines.find((x) => x.uid === lineUid)
  if (!line) return
  const i = line.manualPieces.findIndex((x) => x.uid === pieceUid)
  if (i >= 0) line.manualPieces.splice(i, 1)
}

// ---------------- 展开 → 算法入参 ----------------

function lineInputs(): OrderLineInput[] {
  return cutState.lines.map((line) => {
    if (line.lanternId) {
      const l = lanternState.lanterns.find((x) => x.id === line.lanternId)
      if (l) {
        const fr = buildFrame(l)
        return {
          uid: line.uid,
          lanternId: l.id,
          lanternName: line.lanternName,
          count: line.count,
          members: fr.members.map((m, i) => ({
            memberSeq: i,
            memberId: m.id,
            label: `${line.lanternName}·${m.label}`,
            netMm: m.rawLengthMm,
            allowanceMm: Math.round((m.lengthMm - m.rawLengthMm) * 10) / 10,
            qty: m.qty
          }))
        }
      }
    }
    return {
      uid: line.uid,
      lanternName: line.lanternName,
      count: line.count,
      manual: line.manualPieces.map((mp) => ({
        uid: mp.uid,
        label: mp.label,
        netMm: mp.netMm,
        allowanceMm: mp.lashJoints * cutState.lashAllowanceMm,
        qty: mp.count
      }))
    }
  })
}

/** 本次可截的料：料架整根 + 各活跃存档方案最新留用余料（段号接续） */
function rackRefs(): RackRef[] {
  const refs: RackRef[] = []
  for (const s of cutState.sticks) {
    if (s.status === 'rack') {
      refs.push({ stick: s, availMm: floorMm(s.lengthMm), baseSegment: 0, startOffsetMm: 0 })
    }
  }
  // 每根篾取「最新的活跃方案」里的残料状态
  const latest = new Map<string, CommittedPlan>()
  for (const p of cutState.plans) {
    if (p.status !== 'active') continue
    for (const sp of p.sticks) {
      if (sp.remainKind === 'usable') latest.set(sp.stickId, p)
    }
  }
  for (const [stickId, plan] of latest) {
    const stick = cutState.sticks.find((s) => s.id === stickId)
    if (!stick || stick.status !== 'cut') continue // 已退回重登的不再以旧余料身份出现
    const sp = plan.sticks.find((x) => x.stickId === stickId)!
    refs.push({
      stick,
      availMm: sp.remainMm,
      baseSegment: sp.baseSegment + sp.segments.length,
      startOffsetMm: sp.startOffsetMm + sp.usedMm
    })
  }
  return refs
}

// ---------------- 工作态重算（输入一改整批复算，calcNo +1） ----------------

let suspendInputWatch = 0

export const workingResult = computed(() =>
  computeCutPlan({
    calcNo: cutState.calcNo,
    lashAllowanceMm: cutState.lashAllowanceMm,
    lines: lineInputs(),
    rack: rackRefs(),
    selected: cutState.route,
    generatedAt: nowIso()
  })
)

export function activePlans(): CommittedPlan[] {
  return cutState.plans.filter((p) => p.status === 'active')
}

export function latestActivePlan(): CommittedPlan | undefined {
  return activePlans().slice(-1)[0]
}

// ---------------- 提交存档（三处同源的唯一来源） ----------------

/**
 * 内部动作（提交/作废）会改料架/方案，这不算「用户输入变更」。
 * 用重入计数挂起 calcNo 自增：动作期间所有同步 watch 都被挡住，动作结束立即恢复。
 */
function runInternal<T>(fn: () => T): T {
  suspendInputWatch += 1
  try {
    const out = fn()
    persist()
    return out
  } finally {
    suspendInputWatch -= 1
  }
}

/** 把当前选中路线的工作结果记进本机存档；返回方案号 */
export function commitPlan(): number {
  return runInternal(() => {
    const r = workingResult.value
    const planNo = cutState.seq.plan + 1
    cutState.seq.plan = planNo
    const plan = r.plans[r.selected]
    const fp = fingerprintOf(r.selected, plan.sticks, r.purchase)

    const committed: CommittedPlan = {
      planNo,
      calcNo: r.calcNo,
      route: r.selected,
      committedAt: nowIso(),
      lashAllowanceMm: r.lashAllowanceMm,
      orderLines: JSON.parse(JSON.stringify(cutState.lines)),
      requestedLights: r.requestedLights,
      feasibleLights: r.feasibleLights,
      sticks: JSON.parse(JSON.stringify(plan.sticks)),
      unmet: JSON.parse(JSON.stringify(plan.unmet)),
      shortages: JSON.parse(JSON.stringify(plan.shortages)),
      purchase: JSON.parse(JSON.stringify(r.purchase)),
      consumedMm: plan.consumedMm,
      wasteMm: plan.wasteMm,
      usableRemnantMm: plan.usableRemnantMm,
      laborTotal: plan.labor.total,
      consumedStickIds: plan.sticks.map((s) => s.stickId),
      usableStickIds: plan.sticks.filter((s) => s.remainKind === 'usable').map((s) => s.stickId),
      unusedStickIds: cutState.sticks.filter((s) => s.status === 'rack' && !plan.sticks.some((sp) => sp.stickId === s.id)).map((s) => s.id),
      exports: [],
      status: 'active',
      fingerprint: fp
    }

    // 料架状态翻转：截过的整根 → cut（余料是否留用挂在方案上）
    for (const sp of plan.sticks) {
      const stick = cutState.sticks.find((s) => s.id === sp.stickId)
      if (stick) {
        stick.status = 'cut'
        stick.planNo = planNo
        stick.note = sp.remainKind === 'usable' ? `第 ${planNo} 版留用余料 ${sp.remainMm}mm` : sp.remainKind === 'waste' ? `第 ${planNo} 版残料 ${sp.remainMm}mm 接不上件` : `第 ${planNo} 版用尽`
      }
    }
    // 旧活跃方案被本版取代（物理执行保留，只是不再是当前方案；其留用余料由本版重新裁决）
    for (const old of cutState.plans) {
      if (old.status === 'active') {
        old.status = 'superseded'
        old.supersededBy = planNo
      }
    }
    cutState.plans.push(committed)
    return planNo
  })
}

/**
 * 作废一版方案：方案 + 已导出清单 + 余料留用记录一起失效；
 * 已截好的各段（连同残料）退回料架，以新料号重新登记（旧料号保留痕迹）。
 */
export function voidPlan(planNo: number, reason: string): string[] {
  const ids = runInternal(() => {
    const p = cutState.plans.find((x) => x.planNo === planNo && x.status === 'active')
    if (!p) return []
    const returnedIds: string[] = []
    const at = nowIso()

    for (const sp of p.sticks) {
      const parent = cutState.sticks.find((s) => s.id === sp.stickId)
      // 每一段已截好的篾退回（按该段取整长登记）
      sp.segments.forEach((seg) => {
        cutState.seq.stick += 1
        const id = 'M' + String(cutState.seq.stick).padStart(4, '0')
        cutState.sticks.push({
          id,
          lengthMm: seg.cutMm,
          status: 'rack',
          origin: { type: 'returned', planNo, stickId: sp.stickId, segment: seg.segment, at },
          note: `作废第 ${planNo} 版退回：原 ${sp.stickId} 第 ${seg.segment} 段（${seg.label}）`
        })
        returnedIds.push(id)
      })
      // 残料（留用的或报废的）物理上也在，退回重登
      if (sp.remainMm > 0) {
        cutState.seq.stick += 1
        const id = 'M' + String(cutState.seq.stick).padStart(4, '0')
        cutState.sticks.push({
          id,
          lengthMm: sp.remainMm,
          status: 'rack',
          origin: { type: 'returned', planNo, stickId: sp.stickId, segment: sp.segments.length + 1, at },
          note: `作废第 ${planNo} 版退回：原 ${sp.stickId} 残料 ${sp.remainMm}mm`
        })
        returnedIds.push(id)
      }
      if (parent) {
        parent.status = 'returned'
        parent.note = `第 ${planNo} 版作废，各段已退回重登`
      }
    }

    p.status = 'voided'
    p.voidedAt = at
    p.voidReason = reason || '换路线整批复算，旧版作废'
    p.returnedStickIds = returnedIds
    return returnedIds
  })
  // 作废退回后料架变了，整批进入新批次（已截段重新参与配切）
  if (ids.length) bumpCalc()
  return ids
}

/** 登记一次导出（只认存档方案；指纹不符拒绝） */
export function recordExport(planNo: number, kind: ExportRecord['kind'], filename: string, fingerprint: string): boolean {
  const p = cutState.plans.find((x) => x.planNo === planNo)
  if (!p || p.status !== 'active' || p.fingerprint !== fingerprint) return false
  p.exports.push({ kind, filename, at: nowIso(), fingerprint })
  return true
}

/**
 * 换路线提交（规格：两条路只能选一条）：
 * 旧活跃方案连同已导出清单、本机存档一起作废 → 已截段与残料退回料架重新登记 →
 * 料架变化后按新路线整批复算 → 提交新版。返回 { oldVoided, returned, planNo }。
 */
export function commitAfterRouteSwitch(): { oldPlanNo?: number; returned: string[]; planNo: number } {
  const active = activePlans()
  let oldPlanNo: number | undefined
  let returned: string[] = []
  // 作废所有活跃旧版：路线不同的必须退回重登；同路线但批次落后的也一并清掉（只留新路线这一版）
  for (const old of active) {
    oldPlanNo = old.planNo
    returned = returned.concat(
      voidPlan(old.planNo, `改走「${cutState.route === 'long_first' ? '省料·先保长件' : '省时·短件凑齐'}」路线，旧版连同导出清单与存档作废，已截段退回重登`)
    )
  }
  // voidPlan 已 bumpCalc，workingResult 现在是退回料架后的新路线结果
  const planNo = commitPlan()
  return { oldPlanNo, returned, planNo }
}

// ---------------- 持久化 ----------------

/** 落盘（不改变 suspendInputWatch 标志；挂起由调用方 runInternal 负责） */
function persist(): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        sticks: cutState.sticks,
        lines: cutState.lines,
        lashAllowanceMm: cutState.lashAllowanceMm,
        route: cutState.route,
        calcNo: cutState.calcNo,
        plans: cutState.plans,
        seq: cutState.seq
      })
    )
    cutState.storageError = ''
  } catch (e) {
    cutState.storageError = e instanceof Error ? e.message : String(e)
  }
}

/** 首次载入示例库存（可一键清空），方便立即试配切 */
function seedSample(): void {
  const samples: [number, number][] = [
    [1200, 4],
    [900, 4],
    [700, 6],
    [500, 8]
  ]
  for (const [len, qty] of samples) inboundSticks(len, qty)
}

export function loadCutStore(): void {
  if (cutState.ready) return
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (Array.isArray(d.sticks)) cutState.sticks = d.sticks
      if (Array.isArray(d.lines)) cutState.lines = d.lines
      if (Array.isArray(d.plans)) cutState.plans = d.plans
      if (typeof d.lashAllowanceMm === 'number') cutState.lashAllowanceMm = d.lashAllowanceMm
      if (d.route === 'long_first' || d.route === 'short_first') cutState.route = d.route
      if (typeof d.calcNo === 'number') cutState.calcNo = d.calcNo
      if (d.seq) cutState.seq = { ...cutState.seq, ...d.seq }
    }
  } catch {
    cutState.storageError = '配切作坊本地数据损坏，已按空库启动'
  }
  if (cutState.sticks.length === 0 && cutState.plans.length === 0) seedSample()
  cutState.ready = true

  // 输入类编辑（盏数/库存/手工件/路线/余量）整批复算：calcNo +1 并落盘。
  // 用同步 watch 保证「改完立刻读到新批次」；提交/作废等内部库存翻转发在 suspendInputWatch 内，不触发。
  watch(
    () => [cutState.sticks, cutState.lines, cutState.route, cutState.lashAllowanceMm],
    () => {
      if (suspendInputWatch > 0) return
      bumpCalc()
    },
    { deep: true, flush: 'sync' }
  )
  watch(
    () => cutState.plans,
    () => persist(),
    { deep: true, flush: 'sync' }
  )
  persist()
}

/** 输入改了：批次前进并落盘（UI 直接编辑与内部动作都可显式调用） */
export function bumpCalc(): void {
  cutState.calcNo += 1
  persist()
}

/** 重算批次说明用 */
export function piecesOfResult(): PieceDemand[] {
  return workingResult.value.pieces
}
