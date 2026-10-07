/**
 * 配切工作台本地存档（localStorage，与灯样库同源风格）
 *
 * 版本纪律：
 * - 改盏数 / 换库存 → 旧的「已采用」计划自动作废（superseded），整批重算。
 * - 切换路线（省料 ↔ 省时）→ 选错的那一版连同导出的备料单、本机存档一起作废：
 *   已截好的段退回料架重新登记（按段料登记为新库存篾，料号 R-*），
 *   旧版余料留用记录失效（但实物还在，按普通料登记为 U-* 库存）。
 * - 未「采用」的草稿只是试算，不动库存，导出按钮也不可用。
 */
import { reactive, watch } from 'vue'
import {
  diffPlans,
  generatePlan,
  type CutPlan,
  type CutStrategyId,
  type LanternSpec,
  type OrderItem,
  type PlanDiff,
  type StockStrip
} from './cutting'

const KEY = 'lantern-cutting-lofting.v1'

export interface RestoredStrip {
  code: string
  lengthMm: number
  qty: number
  note?: string
}

export interface PlanVersion {
  plan: CutPlan
  status: 'draft' | 'adopted' | 'superseded' | 'voided'
  adoptedAt?: string
  supersededAt?: string
  /** 作废原因（盏数/库存变更 或 切换路线） */
  supersedeReason?: string
  /** 作废时退回料架的登记 */
  restored?: RestoredStrip[]
  /** 与上一版采用计划的差异（整批重算时算） */
  diffFromAdopted?: PlanDiff
}

interface CuttingState {
  stock: StockStrip[]
  orders: OrderItem[]
  strategy: CutStrategyId
  minOffcutMm: number
  versions: PlanVersion[]
  ready: boolean
  storageError: string
}

export const cuttingState = reactive<CuttingState>({
  stock: [],
  orders: [],
  strategy: 'longFirst',
  minOffcutMm: 100,
  versions: [],
  ready: false,
  storageError: ''
})

let suspendPersist = false
let timer: number | undefined

// ---------------------------------------------------------------- 库存录入

function codeExists(code: string, except?: number): boolean {
  return cuttingState.stock.some((s, i) => s.code === code && i !== except)
}

function nextStockCode(): string {
  for (let n = 1; n < 100; n++) {
    const code = 'K' + String(n).padStart(2, '0')
    if (!codeExists(code)) return code
  }
  return 'K' + Date.now().toString(36)
}

export function addStock(lengthMm: number, qty: number, note = ''): StockStrip {
  const s: StockStrip = { code: nextStockCode(), lengthMm: normalizeLen(lengthMm), qty: Math.max(1, Math.round(qty)), note }
  cuttingState.stock.push(s)
  return s
}

export function updateStock(index: number, patch: Partial<StockStrip>) {
  const s = cuttingState.stock[index]
  if (!s) return
  if (patch.lengthMm !== undefined) s.lengthMm = normalizeLen(patch.lengthMm)
  if (patch.qty !== undefined) s.qty = Math.max(1, Math.round(patch.qty))
  if (patch.note !== undefined) s.note = patch.note
  if (patch.code !== undefined && patch.code.trim() && !codeExists(patch.code.trim(), index)) {
    s.code = patch.code.trim()
  }
}

export function removeStock(index: number) {
  cuttingState.stock.splice(index, 1)
}

/** 同长合并（录入时「同一种长度合并计数」）：返回是否发生合并 */
export function addStockMerged(lengthMm: number, qty: number, note = ''): boolean {
  const len = normalizeLen(lengthMm)
  const exist = cuttingState.stock.find((s) => s.lengthMm === len)
  if (exist) {
    exist.qty += Math.max(1, Math.round(qty))
    if (note) exist.note = mergeNote(exist.note, note)
    return true
  }
  addStock(len, qty, note)
  return false
}

function mergeNote(a: string | undefined, b: string): string {
  return [a, b].filter(Boolean).join('；')
}

function normalizeLen(v: number): number {
  // 库存长按毫米登记，非整数向上取整，保证后续只与整数比
  return Math.max(1, Math.ceil(Number(v) || 0))
}

// ---------------------------------------------------------------- 订单

export function setOrder(lanternId: string, lanternName: string, qty: number) {
  const q = Math.max(0, Math.round(qty))
  const i = cuttingState.orders.findIndex((o) => o.lanternId === lanternId)
  if (i >= 0) {
    if (q === 0) cuttingState.orders.splice(i, 1)
    else cuttingState.orders[i].qty = q
  } else if (q > 0) {
    cuttingState.orders.push({ lanternId, lanternName, qty })
  }
}

export function removeOrder(lanternId: string) {
  const i = cuttingState.orders.findIndex((o) => o.lanternId === lanternId)
  if (i >= 0) cuttingState.orders.splice(i, 1)
}

// ---------------------------------------------------------------- 计划生命周期

export function currentAdopted(): PlanVersion | undefined {
  return cuttingState.versions.find((v) => v.status === 'adopted')
}

export function currentDraft(): PlanVersion | undefined {
  return cuttingState.versions.find((v) => v.status === 'draft')
}

function supersedeAdopted(reason: string): PlanVersion | undefined {
  const cur = currentAdopted()
  if (!cur) return undefined
  cur.status = 'superseded'
  cur.supersededAt = new Date().toISOString()
  cur.supersedeReason = reason
  return cur
}

/**
 * 整批重算（改盏数 / 换库存 / 切路线后必做）。
 * previousAdopted 若存在，会作废并把三段差异（构件来源 / 材料项 / 留用失效）算进新版本。
 */
export function recalc(specs: Map<string, LanternSpec>, reason: string, strategy?: CutStrategyId): PlanVersion {
  const strat = strategy ?? cuttingState.strategy
  const adoptedNow = currentAdopted()
  const switchingTrial = !!adoptedNow && strategy !== undefined && strategy !== adoptedNow.plan.strategy
  cuttingState.strategy = strat

  // 切路线只做试算时，已采用版先保留（点「采用新路」才作废它）；其余重算立即作废旧采用版
  const prev = switchingTrial ? currentAdopted() : supersedeAdopted(reason)
  // 旧草稿直接作废（只保留最近一版试算，避免成堆）
  for (const v of cuttingState.versions) {
    if (v.status === 'draft') {
      v.status = 'voided'
      v.supersededAt = new Date().toISOString()
      v.supersedeReason = '新试算覆盖'
    }
  }

  const plan = generatePlan(cuttingState.stock, cuttingState.orders, specs, strat, cuttingState.minOffcutMm)
  const version: PlanVersion = reactive({
    plan,
    status: 'draft',
    diffFromAdopted: prev ? diffPlans(prev.plan, plan) : undefined
  })
  cuttingState.versions.unshift(version)
  pruneHistory()
  return version
}

/**
 * 采用当前草稿：试算转为正式计划，本机存档生效，三份清单才可导出。
 */
export function adopt(version: PlanVersion): RestoredStrip[] {
  const cur = currentAdopted()
  let restored: RestoredStrip[] = []
  if (cur && cur !== version) {
    if (cur.plan.strategy !== version.plan.strategy) {
      // 换路线采用：旧版必须「作废重来」，而不是普通替代
      restored = voidAdopted('切换路线：旧版配切方案连同导出备料单与本机存档一起作废')
    } else {
      supersedeAdopted('被新采用计划替代（整批重算）')
    }
  }
  version.status = 'adopted'
  version.adoptedAt = new Date().toISOString()
  return restored
}

/**
 * 作废当前采用的计划（选错路线时用）：
 * - 已截好的段退回料架重新登记（R-* 料号，按段长，整数 mm）；
 * - 旧版留用余料记录失效，实物按普通库存登记（U-* 料号）；
 * - 导出的备料单与存档一并作废（同一版本记录即三处的同源凭证）。
 * 返回登记好的退回料。
 */
export function voidAdopted(reason: string): RestoredStrip[] {
  const cur = currentAdopted()
  if (!cur) return []
  const restored: RestoredStrip[] = []
  let rSeq = 0
  let uSeq = 0
  const segMerge = new Map<number, number>()
  const offMerge = new Map<number, number>()
  for (const u of cur.plan.usedStrips) {
    for (const s of u.segments) {
      // 已截好的段：同长合并登记
      const n = (segMerge.get(s.cutMm) || 0) + 1
      segMerge.set(s.cutMm, n)
    }
    if (u.reusable) {
      const n = (offMerge.get(u.residualMm) || 0) + 1
      offMerge.set(u.residualMm, n)
    }
  }
  for (const [len, qty] of [...segMerge.entries()].sort((a, b) => b[0] - a[0])) {
    rSeq++
    restored.push({ code: `R${String(rSeq).padStart(2, '0')}`, lengthMm: len, qty, note: `旧计划 ${cur.plan.id} 已截段退回重登` })
    cuttingState.stock.push(restored[restored.length - 1])
  }
  for (const [len, qty] of [...offMerge.entries()].sort((a, b) => b[0] - a[0])) {
    uSeq++
    restored.push({ code: `U${String(uSeq).padStart(2, '0')}`, lengthMm: len, qty, note: `旧计划 ${cur.plan.id} 留用余料记录失效，实物按普通料登记` })
    cuttingState.stock.push(restored[restored.length - 1])
  }
  cur.status = 'voided'
  cur.supersededAt = new Date().toISOString()
  cur.supersedeReason = reason
  cur.restored = restored
  return restored
}

/** 保留最近 12 个版本，更早的丢弃（作废记录仍在采用状态变迁中留痕） */
function pruneHistory() {
  if (cuttingState.versions.length > 12) {
    cuttingState.versions.splice(12, cuttingState.versions.length - 12)
  }
}

// ---------------------------------------------------------------- 持久化

function persistNow() {
  suspendPersist = true
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        stock: cuttingState.stock,
        orders: cuttingState.orders,
        strategy: cuttingState.strategy,
        minOffcutMm: cuttingState.minOffcutMm,
        versions: cuttingState.versions
      })
    )
    cuttingState.storageError = ''
  } catch (e) {
    cuttingState.storageError = e instanceof Error ? e.message : String(e)
  } finally {
    suspendPersist = false
  }
}

function schedulePersist() {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = undefined
    persistNow()
  }, 180)
}

export function loadCuttingStore() {
  if (cuttingState.ready) return
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (Array.isArray(d.stock)) cuttingState.stock = d.stock
      if (Array.isArray(d.orders)) cuttingState.orders = d.orders
      if (d.strategy === 'longFirst' || d.strategy === 'shortFirst') cuttingState.strategy = d.strategy
      if (typeof d.minOffcutMm === 'number') cuttingState.minOffcutMm = d.minOffcutMm
      if (Array.isArray(d.versions)) cuttingState.versions = d.versions
    }
  } catch {
    cuttingState.storageError = '配切存档数据损坏，已保留可解析部分'
  }
  // 预置一批示例库存，便于立刻试算
  if (cuttingState.stock.length === 0) {
    cuttingState.stock.push(
      { code: 'K01', lengthMm: 1800, qty: 6, note: '头批大毛竹' },
      { code: 'K02', lengthMm: 1200, qty: 8 },
      { code: 'K03', lengthMm: 900, qty: 10 },
      { code: 'K04', lengthMm: 600, qty: 12 }
    )
  }
  cuttingState.ready = true
  watch(
    () => [cuttingState.stock, cuttingState.orders, cuttingState.strategy, cuttingState.minOffcutMm, cuttingState.versions] as const,
    () => {
      if (suspendPersist) return
      schedulePersist()
    },
    { deep: true }
  )
  persistNow()
}

// ---------------------------------------------------------------- 给视图用的取数（单一来源：当前采用计划；没采用则空）

export function activePlan(): CutPlan | null {
  return currentAdopted()?.plan ?? null
}
