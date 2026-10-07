/**
 * 竹篾配切下料引擎（一维 cutting stock）
 *
 * 取整与余量规则（本活难点）：
 * - 每段「下料长 = 净长 + 绑扎余量合计」，一律按毫米向上取整（ceil，整数 mm）。
 * - 库存篾长也登记为整数 mm；残料能否接上下一件，只用取整后的整数长度比较，
 *   绝不拿没取整的小数净长去比（避免 0.4mm 误差把本来放不下的件硬塞进去）。
 * - 备料总量折成米（÷1000，保留 3 位小数，只用于展示；账仍按整数 mm 记）。
 *
 * 两条互斥的配切路（一次只能选一条）：
 * - longFirst  先保长件：件长按降序，最优适应（Best-Fit Decreasing）→ 最省料（废料少）。
 * - shortFirst 先凑短件：件长按升序，下次适应（Next-Fit，不回头翻旧篾）→ 最省时（翻找/试配次数少）。
 *
 * 最大化盏数：订单按灯种轮转，一轮各做 1 盏，直到某一种再做整盏也配不齐为止；
 * 配不齐时记录缺的是哪一种件、缺几根（长度不够 还是 根数不够）。
 */
import type { FrameMember, Lantern } from './types'

// ---------------------------------------------------------------- 常量与取整

/** 余料短于该长度则视为接不上任何常用件，明确记为废料（mm，整数） */
export const MIN_USEFUL_OFFCUT_MM = 100

/** 工时折算：每次量尺试配（含一次长度比较）耗时（秒） */
export const SEC_PER_FIT_ATTEMPT = 3
/** 工时折算：每下一刀（一段）耗时（秒） */
export const SEC_PER_CUT = 20
/** 工时折算：每翻找一根库存篾（取篾上料）耗时（秒） */
export const SEC_PER_STRIP_HANDLE = 45

/** 绑扎余量合计（mm）：竖篾/中轴两端各一处，圈件接头一处；与 frame.ts 的 lashJoints 一致 */
export function allowanceMm(member: FrameMember, lashPerEndMm: number): number {
  const joints = Math.max(1, member.lashJoints || 1)
  return joints * Math.max(0, lashPerEndMm)
}

/** 每段下料长（mm，向上取整为整数）：净长（保留 1 位）+ 绑扎余量合计，再 ceil */
export function pieceLengthMm(member: FrameMember, lashPerEndMm: number): number {
  return Math.ceil(member.rawLengthMm + allowanceMm(member, lashPerEndMm) - 1e-9)
}

export type CutStrategyId = 'longFirst' | 'shortFirst'

export interface StrategyMeta {
  id: CutStrategyId
  name: string
  goal: string
  rule: string
}

export const STRATEGIES: Record<CutStrategyId, StrategyMeta> = {
  longFirst: {
    id: 'longFirst',
    name: '先保长件（省料）',
    goal: '废料最少',
    rule: '件长降序，最优适应：每段先放进当前余料最贴近的那根篾，没有合适的才开新篾。'
  },
  shortFirst: {
    id: 'shortFirst',
    name: '先凑短件（省时）',
    goal: '工时最少',
    rule: '件长升序，下次适应：只盯手头这一根篾，接不下就封箱另开新篾，不回头翻旧料。'
  }
}

// ---------------------------------------------------------------- 数据模型

/** 库存竹篾（整数 mm） */
export interface StockStrip {
  /** 料号，如 K01 */
  code: string
  /** 原长（整数 mm） */
  lengthMm: number
  /** 根数（同长合并录入） */
  qty: number
  /** 材质备注（竹种/批次，可空） */
  note?: string
}

/** 要做的灯：灯样 + 盏数 */
export interface OrderItem {
  lanternId: string
  lanternName: string
  qty: number
}

/** 构件需求行（同一种件合并计数） */
export interface DemandRow {
  /** 构件种类键：灯名/分组/构件名 */
  key: string
  lanternId: string
  lanternName: string
  memberId: string
  label: string
  group: string
  /** 净长（1 位小数 mm） */
  netMm: number
  /** 绑扎余量合计（mm） */
  allowanceMm: number
  /** 取整后下料长（整数 mm）——判定与切割都只认它 */
  cutMm: number
  /** 需求根数（该灯盏数 × 单灯件数） */
  needQty: number
}

/** 一根篾上截出的一段（骨架构件表逐行取它） */
export interface CutSegment {
  /** 段号，该篾上第几段，从 1 起 */
  segNo: number
  demandKey: string
  lanternName: string
  label: string
  /** 取整后下料长（整数 mm） */
  cutMm: number
  /** 净长（1 位小数 mm） */
  netMm: number
  allowanceMm: number
}

/** 一根被启用的库存篾的配切结果 */
export interface UsedStrip {
  /** 同料号多根时的实例序号（从 1 起，区分同 code 的不同篾） */
  instanceNo: number
  /** 指向库存条目的料号 */
  stockCode: string
  originalMm: number
  segments: CutSegment[]
  /** 截完剩余（整数 mm）= 原长 − Σ下料长；三处取数都以它为准 */
  residualMm: number
  /** true = 残料留用（≥ MIN_USEFUL_OFFCUT_MM）；false = 接不上别的件，明确为废料 */
  reusable: boolean
  /** 留用料号（reusable 时给，如 K01-Y1） */
  offcutCode?: string
}

/** 缺料诊断 */
export interface ShortageRow {
  demandKey: string
  lanternName: string
  label: string
  cutMm: number
  needQty: number
  /** 已配出根数 */
  haveQty: number
  /** 还缺根数 */
  shortQty: number
  /** length=长度不够（库里最长的篾也短于该件下料长）；count=根数不够（长度够但总量/根数配不齐） */
  reason: 'length' | 'count'
  /** 最长库存篾（诊断用） */
  maxStockMm: number
  /** 建议添料：添几根、每根多长（整数 mm） */
  buyStripLenMm: number
  buyQty: number
}

/** 一种灯实际配出的整盏数 */
export interface BuiltQty {
  lanternId: string
  lanternName: string
  ordered: number
  built: number
}

/** 策略代价（两条路对比 + 让路代价都用它） */
export interface StrategyMetrics {
  strategy: CutStrategyId
  /** 动用库存篾根数（含被完全截用的） */
  stripsUsed: number
  /** Σ下料长（整数 mm）= 构件表逐行长度之和（守恒） */
  usedLengthMm: number
  /** 动用篾原长合计（整数 mm） */
  consumedStockMm: number
  /** 废料合计（不可复用残料，整数 mm） */
  wasteMm: number
  /** 留用余料合计（可复用残料，整数 mm） */
  retainedMm: number
  /** 留用余料根数 */
  retainedCount: number
  /** 翻找/试配次数（工时口径） */
  fitAttempts: number
  /** 刀数（= 段数） */
  cuts: number
  /** 估算工时（秒） */
  laborSec: number
  /** 配出整盏总数 */
  builtLanterns: number
}

export interface CutPlan {
  /** 计划号：P<时间戳36>-<rand> */
  id: string
  strategy: CutStrategyId
  generatedAt: string
  input: {
    stock: StockStrip[]
    orders: OrderItem[]
    minOffcutMm: number
  }
  demands: DemandRow[]
  usedStrips: UsedStrip[]
  shortages: ShortageRow[]
  built: BuiltQty[]
  metrics: StrategyMetrics
  /** 另一条路的代价（未选中的那条让了什么） */
  alternative: StrategyMetrics
  /** 未动用的库存篾（原样留着下次再用，合并计数） */
  untouched: { stockCode: string; lengthMm: number; qty: number }[]
}

// ---------------------------------------------------------------- 需求展开

export interface LanternSpec {
  lantern: Lantern
  /** 单灯构件（取 buildFrame） */
  members: FrameMember[]
}

/** 展开订单：同一种件（同灯/同构件）按盏数合并计数 */
export function buildDemands(
  specs: { spec: LanternSpec; qty: number }[]
): DemandRow[] {
  const rows: DemandRow[] = []
  for (const { spec, qty } of specs) {
    const l = spec.lantern
    const n = Math.max(0, Math.round(qty))
    if (n <= 0) continue
    for (const m of spec.members) {
      const cut = pieceLengthMm(m, l.lashAllowanceMm)
      rows.push({
        key: `${l.name}/${m.group}/${m.label}`,
        lanternId: l.id,
        lanternName: l.name,
        memberId: m.id,
        label: m.label,
        group: m.group,
        netMm: m.rawLengthMm,
        allowanceMm: allowanceMm(m, l.lashAllowanceMm),
        cutMm: cut,
        needQty: m.qty * n
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------- 分配引擎

interface PieceTask {
  demandKey: string
  cutMm: number
  lanternId: string
  /** 件序号（用于稳定排序） */
  seq: number
}

interface BinState {
  stockCode: string
  originalMm: number
  stockIndex: number
  remainMm: number
  segments: CutSegment[]
}

interface PackResult {
  bins: BinState[]
  /** 未配下的件（demandKey 计数） */
  leftover: Map<string, number>
  fitAttempts: number
  /** 每种库存条目动用的根数（索引 = 库存条目序号） */
  usedCountByStock: number[]
}

/** 库存实例池：每个条目展开 qty 根，保持同长相邻；取篾时按需展开 */
interface StockPool {
  items: { code: string; lengthMm: number; index: number }[]
  /** 每个条目下一个可用实例下标 */
  cursor: number[]
  base: number[]
  qty: number[]
}

function makePool(stock: StockStrip[]): StockPool {
  const items: StockPool['items'] = []
  const cursor: number[] = []
  const base: number[] = []
  const qty: number[] = []
  stock.forEach((s, index) => {
    base[index] = items.length
    cursor[index] = 0
    qty[index] = Math.max(0, Math.round(s.qty))
    for (let k = 0; k < qty[index]; k++) {
      items.push({ code: s.code, lengthMm: s.lengthMm, index })
    }
  })
  return { items, cursor, base, qty }
}

/** 从指定库存条目取一根未用篾；没有则 null */
function takeFrom(pool: StockPool, index: number): StockPool['items'][number] | null {
  if (pool.cursor[index] >= pool.qty[index]) return null
  const it = pool.items[pool.base[index] + pool.cursor[index]]
  pool.cursor[index]++
  return it
}

/** 从未动用的库存里挑一根：pick=longest 取最长（省料），pick=shortest 取能放下的最短篾（省时） */
function takeNew(pool: StockPool, needMm: number, pick: 'longest' | 'shortest'): StockPool['items'][number] | null {
  let best: StockPool['items'][number] | null = null
  for (let i = 0; i < pool.qty.length; i++) {
    if (pool.cursor[i] >= pool.qty[i]) continue
    const cand = pool.items[pool.base[i] + pool.cursor[i]]
    if (cand.lengthMm < needMm) continue
    if (!best) best = cand
    else if (pick === 'longest' && cand.lengthMm > best.lengthMm) best = cand
    else if (pick === 'shortest' && cand.lengthMm < best.lengthMm) best = cand
  }
  if (!best) return null
  return takeFrom(pool, best.index)
}

function orderPieces(pieces: PieceTask[], strategy: CutStrategyId): PieceTask[] {
  const sorted = [...pieces]
  sorted.sort((a, b) => {
    if (strategy === 'longFirst') return b.cutMm - a.cutMm || a.seq - b.seq
    return a.cutMm - b.cutMm || a.seq - b.seq
  })
  return sorted
}

/**
 * 单策略装箱。pieces 为本次要配的全部件（已按最大化盏数的前缀给定）。
 * longFirst（省料）：先跑 BFD 贪心；贪心配不下时启用「精确装箱」（分支限界 + 记忆化 +
 *   同构剪枝），保证可行域内不丢件；节点超预算才回退贪心结果。
 * shortFirst（省时）：Next-Fit，只试当前篾一次，放不下就封箱开新篾（每件至多 1 次试配）。
 */
function pack(
  pieces: PieceTask[],
  stock: StockStrip[],
  strategy: CutStrategyId
): PackResult {
  if (strategy === 'shortFirst') return packGreedy(pieces, stock, 'shortFirst')
  const greedy = packGreedy(pieces, stock, 'longFirst')
  if (greedy.leftover.size === 0 || pieces.length === 0) return greedy
  const exact = packExact(pieces, stock)
  return exact ?? greedy
}

const EXACT_NODE_BUDGET = 60000

/** 精确装箱：件长降序，逐件试「已开篾（同余料去重）/ 每一种未用长度开新篾」，失败状态记忆化 */
function packExact(pieces: PieceTask[], stock: StockStrip[]): PackResult | null {
  // 库存实例按长度降序展开（同长相邻）
  const instances: { code: string; stockIndex: number; lengthMm: number }[] = []
  stock.forEach((s, stockIndex) => {
    for (let k = 0; k < Math.max(0, Math.round(s.qty)); k++) instances.push({ code: s.code, stockIndex, lengthMm: s.lengthMm })
  })
  instances.sort((a, b) => b.lengthMm - a.lengthMm)
  const ps = [...pieces].sort((a, b) => b.cutMm - a.cutMm || a.seq - b.seq)
  if (ps.length === 0) return null
  if (ps[0].cutMm > (instances[0]?.lengthMm ?? 0)) return null // 最长篾也放不下
  const n = ps.length
  const m = instances.length
  const cap = instances.map((x) => x.lengthMm)
  // 快速可行性预判（不可行就不烧搜索预算）：件数不超根数、总长不超库存总长
  if (n > m) return null
  let demandSum = 0
  for (const p of ps) demandSum += p.cutMm
  let capSum = 0
  for (const c of cap) capSum += c
  if (demandSum > capSum) return null

  const remain = cap.slice()
  const open: number[] = [] // 已开篾实例下标（按开篾顺序）
  const assign: number[] = new Array(n).fill(-1) // 每件分到哪个实例
  const used = new Array(m).fill(false)
  const usedCountByStock = stock.map(() => 0)
  let nodes = 0
  let fitAttempts = 0
  const memo = new Set<string>()
  const lenKeys = [...new Set(cap)].sort((a, b) => b - a)
  const unusedCountByLen = new Map<number, number>()
  for (const c of cap) unusedCountByLen.set(c, (unusedCountByLen.get(c) || 0) + 1)

  const stateKey = (i: number): string => {
    const r = open.map((b) => remain[b]).sort((a, b) => a - b).join('.')
    const u = lenKeys.map((l) => unusedCountByLen.get(l) || 0).join('.')
    return i + '|' + r + '|' + u
  }

  function dfs(i: number): boolean {
    if (++nodes > EXACT_NODE_BUDGET) return false
    if (i === n) return true
    if (memo.has(stateKey(i))) return false
    const p = ps[i]

    // 1) 已开篾：按余料从小到大试，相同余料只试一次（同构）
    const triedRemain = new Set<number>()
    const fitting = open.filter((b) => remain[b] >= p.cutMm).sort((a, b) => remain[a] - remain[b])
    for (const b of fitting) {
      if (triedRemain.has(remain[b])) continue
      triedRemain.add(remain[b])
      fitAttempts++
      remain[b] -= p.cutMm
      assign[i] = b
      if (dfs(i + 1)) return true
      remain[b] += p.cutMm
      assign[i] = -1
    }

    // 2) 开新篾：每种未用长度只试一次（同构剪枝），短料优先以省大篾
    for (const l of lenKeys) {
      if ((unusedCountByLen.get(l) || 0) <= 0 || l < p.cutMm) continue
      let b = -1
      for (let k = 0; k < m; k++) if (!used[k] && cap[k] === l) { b = k; break }
      if (b < 0) continue
      fitAttempts++
      used[b] = true
      unusedCountByLen.set(l, (unusedCountByLen.get(l) || 0) - 1)
      open.push(b)
      remain[b] -= p.cutMm
      assign[i] = b
      if (dfs(i + 1)) return true
      remain[b] += p.cutMm
      assign[i] = -1
      open.pop()
      unusedCountByLen.set(l, (unusedCountByLen.get(l) || 0) + 1)
      used[b] = false
    }

    memo.add(stateKey(i))
    return false
  }

  if (!dfs(0)) return null

  // 组装 bins（段号在每根篾内从 1 起）
  const bins: BinState[] = []
  const binByInstance = new Map<number, BinState>()
  for (const b of open) {
    usedCountByStock[instances[b].stockIndex]++
    const bin: BinState = {
      stockCode: instances[b].code,
      originalMm: instances[b].lengthMm,
      stockIndex: instances[b].stockIndex,
      remainMm: remain[b],
      segments: []
    }
    bins.push(bin)
    binByInstance.set(b, bin)
  }
  ps.forEach((p, i) => {
    const bin = binByInstance.get(assign[i])!
    bin.segments.push({
      segNo: bin.segments.length + 1,
      demandKey: p.demandKey,
      lanternName: '',
      label: '',
      cutMm: p.cutMm,
      netMm: 0,
      allowanceMm: 0
    })
  })
  // 精确方案成立：工时只按这一趟的试配次数计（贪心只是心里验算，不上料架）
  return { bins, leftover: new Map(), fitAttempts, usedCountByStock }
}

function packGreedy(
  pieces: PieceTask[],
  stock: StockStrip[],
  strategy: CutStrategyId
): PackResult {
  const pool = makePool(stock)
  const openBins: BinState[] = []
  const bins: BinState[] = []
  let fitAttempts = 0
  const usedCountByStock = stock.map(() => 0)
  const leftover = new Map<string, number>()
  function addLeftover(p: PieceTask) {
    leftover.set(p.demandKey, (leftover.get(p.demandKey) || 0) + 1)
  }

  const openBin = (it: StockPool['items'][number]): BinState => {
    const b: BinState = {
      stockCode: it.code,
      originalMm: it.lengthMm,
      stockIndex: it.index,
      remainMm: it.lengthMm,
      segments: []
    }
    usedCountByStock[it.index]++
    return b
  }

  for (const p of orderPieces(pieces, strategy)) {
    let target: BinState | null = null
    if (strategy === 'longFirst') {
      let bestRemain = Infinity
      for (const b of openBins) {
        fitAttempts++ // 一次量尺试配（余料长度比较）
        if (b.remainMm >= p.cutMm && b.remainMm < bestRemain) {
          bestRemain = b.remainMm
          target = b
        }
      }
      if (!target) {
        // 开新篾：优先用能放下的最长篾（保证长件先占大料，省料）
        fitAttempts++ // 取新篾前的一次择料比较
        const it = takeNew(pool, p.cutMm, 'longest')
        if (!it) {
          addLeftover(p)
          continue
        }
        target = openBin(it)
        openBins.push(target)
      }
    } else {
      // Next-Fit：只看当前（最后一根未封箱）篾
      const cur = openBins.length ? openBins[openBins.length - 1] : null
      if (cur) {
        fitAttempts++
        if (cur.remainMm < p.cutMm) {
          bins.push(cur)
          openBins.pop()
          target = null
        } else {
          target = cur
        }
      }
      if (!target) {
        fitAttempts++ // 取新篾择料（取最短可用，避免长料被短件吃掉，仍不回头）
        const it = takeNew(pool, p.cutMm, 'shortest')
        if (!it) {
          addLeftover(p)
          continue
        }
        target = openBin(it)
        openBins.push(target)
      }
    }

    target.segments.push({
      segNo: target.segments.length + 1,
      demandKey: p.demandKey,
      lanternName: '',
      label: '',
      cutMm: p.cutMm,
      netMm: 0,
      allowanceMm: 0
    })
    target.remainMm -= p.cutMm
  }
  bins.push(...openBins)

  return { bins, leftover, fitAttempts, usedCountByStock }
}

// ---------------------------------------------------------------- 最大化盏数

/**
 * 贪心配切：订单按灯种轮转，一轮各加一盏；每轮对当前前缀试配，
 * 某灯种再加一盏会导致它自己的构件配不齐，则该灯种定格（其余灯种继续凑）。
 * 这样最大化「能做的整盏数」，同时不浪费料去配半成品。
 */
export interface AllocationInput {
  stock: StockStrip[]
  orders: OrderItem[]
  specs: Map<string, LanternSpec>
  strategy: CutStrategyId
  minOffcutMm?: number
}

interface AllocationCore {
  plan: Omit<CutPlan, 'id' | 'generatedAt' | 'alternative'>
}

function allocate(input: AllocationInput): AllocationCore {
  const { stock, orders, specs, strategy } = input
  const minOffcut = input.minOffcutMm ?? MIN_USEFUL_OFFCUT_MM

  // 每灯种每轮要追加的件（1 盏的件清单）
  const unitPieces: { order: OrderItem; unit: PieceTask[] }[] = []
  for (const o of orders) {
    const spec = specs.get(o.lanternId)
    if (!spec || o.qty <= 0) continue
    const unit: PieceTask[] = []
    let seq = 0
    for (const d of buildDemands([{ spec, qty: 1 }])) {
      for (let k = 0; k < d.needQty; k++) {
        unit.push({ demandKey: d.key, cutMm: d.cutMm, lanternId: o.lanternId, seq: seq++ })
      }
    }
    unitPieces.push({ order: o, unit })
  }

  const builtArr = unitPieces.map((x) => ({
    lanternId: x.order.lanternId,
    lanternName: x.order.lanternName,
    ordered: x.order.qty,
    built: 0
  }))
  let seqBase = 0

  // 可行性判定：给定各灯种盏数向量，所有件能否整批配下（不留半成品）
  const feasible = (counts: number[]): boolean => {
    const trial: PieceTask[] = []
    counts.forEach((cnt, i) => {
      for (let k = 0; k < cnt; k++) {
        for (const p of unitPieces[i].unit) trial.push({ ...p, seq: seqBase + trial.length })
      }
    })
    return pack(trial, stock, strategy).leftover.size === 0
  }

  // ① 先求「各灯种同步」最大轮数 t（每轮每种 +1 盏）——对每个灯种都公平的底座
  let t = 0
  const maxT = Math.min(...unitPieces.map((x) => x.order.qty))
  for (let k = 1; k <= maxT; k++) {
    if (feasible(unitPieces.map(() => k))) t = k
    else break
  }
  const counts = unitPieces.map((x) => Math.min(t, x.order.qty))

  // ② 底座之上，枚举所有「加灯次序」可达的总数向量，取总盏数最大；
  //    同总数按订单顺序做字典序优先（靠前的灯种先满足）。
  let best = counts.slice()
  const visitedVecs = new Set<string>()
  /** 字典序：a 是否不劣于 b（靠前灯种优先满足时用） */
  const lexGe = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i]
    }
    return true
  }
  const visit = (cur: number[]) => {
    const key = cur.join(',')
    if (visitedVecs.has(key)) return
    visitedVecs.add(key)
    const curTotal = cur.reduce((s, x) => s + x, 0)
    const bestTotal = best.reduce((s, x) => s + x, 0)
    if (curTotal > bestTotal || (curTotal === bestTotal && lexGe(cur, best))) best = cur.slice()
    for (let i = 0; i < unitPieces.length; i++) {
      if (cur[i] >= unitPieces[i].order.qty) continue
      const trial = cur.slice()
      trial[i]++
      if (feasible(trial)) visit(trial)
    }
  }
  visit(counts)

  builtArr.forEach((b, i) => (b.built = best[i]))

  // 最终装箱（按最终盏数向量）
  const pieces: PieceTask[] = []
  best.forEach((cnt, i) => {
    for (let k = 0; k < cnt; k++) {
      for (const p of unitPieces[i].unit) pieces.push({ ...p, seq: seqBase + pieces.length })
    }
  })
  const final = pack(pieces, stock, strategy)

  // 需求表（按最终配出盏数 + 订单需求两份口径合一：needQty 仍按订单，haveQty 另算）
  const specQty = orders
    .map((o) => {
      const spec = specs.get(o.lanternId)
      const built = builtArr.find((b) => b.lanternId === o.lanternId)?.built ?? 0
      return spec ? { spec, qty: o.qty, built } : null
    })
    .filter((x): x is { spec: LanternSpec; qty: number; built: number } => !!x)
  const demands: DemandRow[] = []
  const haveQtyByKey = new Map<string, number>()
  for (const b of final.bins) for (const s of b.segments) haveQtyByKey.set(s.demandKey, (haveQtyByKey.get(s.demandKey) || 0) + 1)
  for (const { spec, qty } of specQty) {
    for (const d of buildDemands([{ spec, qty }])) demands.push(d)
  }
  const demandMap = new Map(demands.map((d) => [d.key, d]))

  // 补全每段的展示字段
  for (const b of final.bins) {
    for (const s of b.segments) {
      const d = demandMap.get(s.demandKey)
      if (d) {
        s.lanternName = d.lanternName
        s.label = d.label
        s.netMm = d.netMm
        s.allowanceMm = d.allowanceMm
      }
    }
  }

  // 库存篾结果 + 未动用
  const instSeq = new Map<string, number>()
  const usedStrips: UsedStrip[] = final.bins.map((b) => {
    const no = (instSeq.get(b.stockCode) || 0) + 1
    instSeq.set(b.stockCode, no)
    const reusable = b.remainMm >= minOffcut
    return {
      instanceNo: no,
      stockCode: b.stockCode,
      originalMm: b.originalMm,
      segments: b.segments,
      residualMm: b.remainMm,
      reusable
    }
  })
  // 留用料号：按同料号实例序号编号（与 K01 第几根对应）
  for (const u of usedStrips) {
    if (!u.reusable) continue
    u.offcutCode = `${u.stockCode}-Y${u.instanceNo}`
  }

  const untouched: CutPlan['untouched'] = []
  stock.forEach((s, i) => {
    const used = final.usedCountByStock[i] || 0
    if (used < s.qty) untouched.push({ stockCode: s.code, lengthMm: s.lengthMm, qty: s.qty - used })
  })

  // 缺料诊断
  const maxStock = stock.reduce((m, s) => Math.max(m, s.lengthMm), 0)
  const shortages: ShortageRow[] = []
  for (const d of demands) {
    const have = haveQtyByKey.get(d.key) || 0
    if (have >= d.needQty) continue
    const shortQty = d.needQty - have
    const reason: ShortageRow['reason'] = maxStock < d.cutMm ? 'length' : 'count'
    shortages.push({
      demandKey: d.key,
      lanternName: d.lanternName,
      label: d.label,
      cutMm: d.cutMm,
      needQty: d.needQty,
      haveQty: have,
      shortQty,
      reason,
      maxStockMm: maxStock,
      buyStripLenMm: Math.max(d.cutMm, maxStock > 0 ? maxStock : d.cutMm),
      buyQty: shortQty
    })
  }

  const metrics = metricsOf(strategy, final, usedStrips, builtArr)

  return {
    plan: {
      strategy,
      input: {
        stock: stock.map((s) => ({ ...s })),
        orders: orders.map((o) => ({ ...o })),
        minOffcutMm: minOffcut
      },
      demands,
      usedStrips,
      shortages,
      built: builtArr,
      metrics,
      untouched
    }
  }
}

function metricsOf(
  strategy: CutStrategyId,
  r: PackResult,
  usedStrips: UsedStrip[],
  built: BuiltQty[]
): StrategyMetrics {
  let usedLengthMm = 0
  let consumedStockMm = 0
  let wasteMm = 0
  let retainedMm = 0
  let retainedCount = 0
  let cuts = 0
  for (const u of usedStrips) {
    consumedStockMm += u.originalMm
    cuts += u.segments.length
    for (const s of u.segments) usedLengthMm += s.cutMm
    if (u.reusable) {
      retainedMm += u.residualMm
      retainedCount++
    } else {
      wasteMm += u.residualMm
    }
  }
  // 守恒：动用原长 = 用掉 + 废料 + 留用（整数 mm，差 1mm 也暴露）
  const laborSec =
    r.fitAttempts * SEC_PER_FIT_ATTEMPT + cuts * SEC_PER_CUT + usedStrips.length * SEC_PER_STRIP_HANDLE
  return {
    strategy,
    stripsUsed: usedStrips.length,
    usedLengthMm,
    consumedStockMm,
    wasteMm,
    retainedMm,
    retainedCount,
    fitAttempts: r.fitAttempts,
    cuts,
    laborSec,
    builtLanterns: built.reduce((s, b) => s + b.built, 0)
  }
}

// ---------------------------------------------------------------- 计划入口

function makePlanId(): string {
  return 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 生成配切计划：同一份输入分别跑两条路，选中的按其目标（省料/省时），另一份仅作让路代价 */
export function generatePlan(
  stock: StockStrip[],
  orders: OrderItem[],
  specs: Map<string, LanternSpec>,
  strategy: CutStrategyId,
  minOffcutMm: number = MIN_USEFUL_OFFCUT_MM
): CutPlan {
  const chosen = allocate({ stock, orders, specs, strategy, minOffcutMm }).plan
  const otherId: CutStrategyId = strategy === 'longFirst' ? 'shortFirst' : 'longFirst'
  const other = allocate({ stock, orders, specs, strategy: otherId, minOffcutMm }).plan
  return {
    ...chosen,
    alternative: other.metrics,
    id: makePlanId(),
    generatedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------- 三处同源取数

/** 构件表逐行（每段一行，不合并） */
export interface ComponentRow {
  /** 行号 */
  rowNo: number
  /** 取自哪一根篾（料号） */
  stockCode: string
  /** 同料号的第几根（实例号） */
  instanceNo: number
  /** 这根篈的第几段 */
  segNo: number
  lanternName: string
  group: string
  label: string
  netMm: number
  allowanceMm: number
  cutMm: number
  /** 本根剩余（整数 mm，三处同源） */
  residualMm: number
  reusable: boolean
  offcutCode?: string
}

export function componentRows(plan: CutPlan): ComponentRow[] {
  const labelOf = new Map(plan.demands.map((d) => [d.key, d]))
  const rows: ComponentRow[] = []
  let rowNo = 0
  for (const u of plan.usedStrips) {
    for (const s of u.segments) {
      rowNo++
      const d = labelOf.get(s.demandKey)
      rows.push({
        rowNo,
        stockCode: u.stockCode,
        instanceNo: u.instanceNo,
        segNo: s.segNo,
        lanternName: s.lanternName,
        group: d?.group ?? '',
        label: s.label,
        netMm: s.netMm,
        allowanceMm: s.allowanceMm,
        cutMm: s.cutMm,
        residualMm: u.residualMm,
        reusable: u.reusable,
        offcutCode: u.offcutCode
      })
    }
  }
  return rows
}

/** 同一种件合并计数（构件种类汇总，标注来源料号/段号集合） */
export interface MergedComponentRow {
  demandKey: string
  lanternName: string
  group: string
  label: string
  netMm: number
  allowanceMm: number
  cutMm: number
  needQty: number
  haveQty: number
  sources: { stockCode: string; instanceNo: number; segNo: number }[]
}

export function mergedComponentRows(plan: CutPlan): MergedComponentRow[] {
  const map = new Map<string, MergedComponentRow>()
  for (const d of plan.demands) {
    map.set(d.key, {
      demandKey: d.key,
      lanternName: d.lanternName,
      group: d.group,
      label: d.label,
      netMm: d.netMm,
      allowanceMm: d.allowanceMm,
      cutMm: d.cutMm,
      needQty: d.needQty,
      haveQty: 0,
      sources: []
    })
  }
  for (const u of plan.usedStrips) {
    for (const s of u.segments) {
      const row = map.get(s.demandKey)
      if (!row) continue
      row.haveQty++
      row.sources.push({ stockCode: u.stockCode, instanceNo: u.instanceNo, segNo: s.segNo })
    }
  }
  return [...map.values()]
}

// ---------------------------------------------------------------- 备料/材料页

/** 材料页某一项（竹篈按规格长度分组） */
export interface MaterialRow {
  /** 材料项键：料长规格 */
  specMm: number
  /** 库存该规格根数 */
  stockQty: number
  /** 动用根数（整根启用） */
  usedStripQty: number
  /** 用掉总长（整数 mm） */
  usedLengthMm: number
  /** 留用根数 / 留用长度 */
  retainedQty: number
  retainedMm: number
  /** 废料长度 */
  wasteMm: number
  /** 还要再添几根（0 = 不用添） */
  addQty: number
  /** 添料每根长度（整数 mm） */
  addStripLenMm: number
}

export interface MaterialSummary {
  rows: MaterialRow[]
  /** 动用篈原长合计（整数 mm） */
  consumedStockMm: number
  /** 用掉总量（= 构件表 Σ截取长，整数 mm） */
  usedLengthMm: number
  /** 废料合计（整数 mm） */
  wasteMm: number
  /** 留用合计（整数 mm） */
  retainedMm: number
  /** 添料合计根数 */
  addQty: number
  /** 添料总长（整数 mm） */
  addLengthMm: number
}

export function materialSummary(plan: CutPlan): MaterialSummary {
  const bySpec = new Map<number, MaterialRow>()
  for (const s of plan.input.stock) {
    if (!bySpec.has(s.lengthMm)) {
      bySpec.set(s.lengthMm, {
        specMm: s.lengthMm,
        stockQty: 0,
        usedStripQty: 0,
        usedLengthMm: 0,
        retainedQty: 0,
        retainedMm: 0,
        wasteMm: 0,
        addQty: 0,
        addStripLenMm: s.lengthMm
      })
    }
    bySpec.get(s.lengthMm)!.stockQty += s.qty
  }
  const ensure = (specMm: number): MaterialRow => {
    let r = bySpec.get(specMm)
    if (!r) {
      r = { specMm, stockQty: 0, usedStripQty: 0, usedLengthMm: 0, retainedQty: 0, retainedMm: 0, wasteMm: 0, addQty: 0, addStripLenMm: specMm }
      bySpec.set(specMm, r)
    }
    return r
  }
  for (const u of plan.usedStrips) {
    const r = ensure(u.originalMm)
    r.usedStripQty++
    for (const s of u.segments) r.usedLengthMm += s.cutMm
    if (u.reusable) {
      r.retainedQty++
      r.retainedMm += u.residualMm
    } else {
      r.wasteMm += u.residualMm
    }
  }
  // 添料按缺料诊断聚合：同建议料长合并根数
  for (const sh of plan.shortages) {
    const r = ensure(sh.buyStripLenMm)
    r.addQty += sh.buyQty
    r.addStripLenMm = sh.buyStripLenMm
  }
  const rows = [...bySpec.values()].sort((a, b) => b.specMm - a.specMm)
  const sum = rows.reduce(
    (acc, r) => {
      acc.consumed += r.usedLengthMm + r.retainedMm + r.wasteMm
      acc.used += r.usedLengthMm
      acc.waste += r.wasteMm
      acc.retained += r.retainedMm
      acc.addQty += r.addQty
      acc.addLen += r.addQty * r.addStripLenMm
      return acc
    },
    { consumed: 0, used: 0, waste: 0, retained: 0, addQty: 0, addLen: 0 }
  )
  return {
    rows,
    consumedStockMm: sum.consumed,
    usedLengthMm: sum.used,
    wasteMm: sum.waste,
    retainedMm: sum.retained,
    addQty: sum.addQty,
    addLengthMm: sum.addLen
  }
}

// ---------------------------------------------------------------- 存档页

/** 存档中的一根留用余料 */
export interface RetainedOffcut {
  offcutCode: string
  sourceStockCode: string
  lengthMm: number
  /** 产生它的计划号 */
  planId: string
  planGeneratedAt: string
}

export function retainedOffcuts(plan: CutPlan): RetainedOffcut[] {
  return plan.usedStrips
    .filter((u) => u.reusable)
    .map((u) => ({
      offcutCode: u.offcutCode!,
      sourceStockCode: u.stockCode,
      lengthMm: u.residualMm,
      planId: plan.id,
      planGeneratedAt: plan.generatedAt
    }))
}

// ---------------------------------------------------------------- 守恒自检

export interface ConsistencyCheck {
  id: string
  pass: boolean
  detail: string
}

/**
 * 三处同源守恒（构件表 / 备料材料页 / 存档；同一根篈三处剩余长度不许有出入）。
 * 全部按整数 mm 比，差 1mm 也判失败。
 */
export function checkConsistency(plan: CutPlan): ConsistencyCheck[] {
  const out: ConsistencyCheck[] = []
  const rows = componentRows(plan)
  const mat = materialSummary(plan)

  // 1. 构件表 Σ截取长 == metrics 用掉量（本批用掉竹篈总量）
  const compSum = rows.reduce((s, r) => s + r.cutMm, 0)
  out.push({
    id: 'CUT-C1',
    pass: compSum === plan.metrics.usedLengthMm,
    detail: `构件表逐行截取长合计 ${compSum}mm，配切用掉总量 ${plan.metrics.usedLengthMm}mm（差 ${compSum - plan.metrics.usedLengthMm}mm）`
  })

  // 2. 材料页用掉量 == 构件表合计
  out.push({
    id: 'CUT-C2',
    pass: mat.usedLengthMm === compSum,
    detail: `材料页用掉 ${mat.usedLengthMm}mm，构件表合计 ${compSum}mm（差 ${mat.usedLengthMm - compSum}mm）`
  })

  // 3. 每根篈：原长 = Σ段长 + 剩余；构件表行/存档剩余都与配切剩余逐根一致（同料号按实例号区分）
  const archive = new Map(retainedOffcuts(plan).map((o) => [o.offcutCode, o.lengthMm]))
  let bad = 0
  const details: string[] = []
  const instKeyOf = (code: string, no: number) => `${code}#${no}`
  const rowByInstance = new Map<string, number>()
  for (const r of rows) {
    const no = r.instanceNo
    rowByInstance.set(instKeyOf(r.stockCode, no), r.residualMm)
  }
  for (const u of plan.usedStrips) {
    const segSum = u.segments.reduce((s, x) => s + x.cutMm, 0)
    const expect = u.originalMm - segSum
    if (expect !== u.residualMm) {
      bad++
      details.push(`${u.stockCode}#${u.instanceNo} 原长 ${u.originalMm}−段合计 ${segSum} = ${expect} ≠ 记剩余 ${u.residualMm}`)
    }
    const rowRes = rowByInstance.get(instKeyOf(u.stockCode, u.instanceNo))
    if (rowRes !== undefined && rowRes !== u.residualMm) {
      bad++
      details.push(`${u.stockCode}#${u.instanceNo} 构件表剩余 ${rowRes} ≠ 配切剩余 ${u.residualMm}`)
    }
    if (u.reusable) {
      const arc = archive.get(u.offcutCode!)
      if (arc !== u.residualMm) {
        bad++
        details.push(`${u.offcutCode} 存档剩余 ${arc} ≠ 配切剩余 ${u.residualMm}`)
      }
    }
  }
  out.push({
    id: 'CUT-C3',
    pass: bad === 0,
    detail: bad === 0
      ? `每根篈原长 = Σ段长 + 剩余，构件表/材料页/存档三处剩余逐根一致（共 ${plan.usedStrips.length} 根）`
      : details.slice(0, 3).join('；')
  })

  // 4. 总量守恒：动用原长 = 用掉 + 废料 + 留用
  const balance = plan.metrics.usedLengthMm + plan.metrics.wasteMm + plan.metrics.retainedMm
  out.push({
    id: 'CUT-C4',
    pass: balance === plan.metrics.consumedStockMm,
    detail: `用掉 ${plan.metrics.usedLengthMm} + 废料 ${plan.metrics.wasteMm} + 留用 ${plan.metrics.retainedMm} = ${balance}mm，动用篈原长合计 ${plan.metrics.consumedStockMm}mm（差 ${balance - plan.metrics.consumedStockMm}mm）`
  })

  // 5. 取整检查：所有段长/剩余/库存长均为整数；段长 ≥ 净长向上取整
  const nonInt: string[] = []
  for (const u of plan.usedStrips) {
    for (const s of u.segments) {
      if (!Number.isInteger(s.cutMm)) nonInt.push(`${u.stockCode}#${s.segNo}`)
    }
  }
  const badCeil = plan.demands.filter((d) => d.cutMm < Math.ceil(d.netMm + d.allowanceMm - 1e-9))
  out.push({
    id: 'CUT-C5',
    pass: nonInt.length === 0 && badCeil.length === 0,
    detail: nonInt.length === 0 && badCeil.length === 0
      ? '每段下料长 = (净长 + 绑扎余量) 按毫米向上取整，残料判定只用取整后整数长度'
      : `非整数段：${nonInt.slice(0, 3).join('、') || '无'}；未正确取整：${badCeil.slice(0, 3).map((d) => d.label).join('、') || '无'}`
  })

  return out
}

// ---------------------------------------------------------------- 重算 diff（三处各变了什么）

export interface PlanDiff {
  fromPlanId: string
  toPlanId: string
  /** 构件表：哪几根构件来源段换了 */
  memberSourceChanges: {
    demandKey: string
    label: string
    before: { stockCode: string; instanceNo: number; segNo: number }[]
    after: { stockCode: string; instanceNo: number; segNo: number }[]
  }[]
  /** 构件表：新增/消失的配出件（按种类 + 根数） */
  membersAdded: { demandKey: string; label: string; qty: number }[]
  membersRemoved: { demandKey: string; label: string; qty: number }[]
  /** 材料页：哪几项材料与根数变了 */
  materialChanges: {
    specMm: number
    before?: Partial<MaterialRow>
    after?: Partial<MaterialRow>
  }[]
  /** 存档：上次留用、这次不再留用的余料 */
  retentionRevoked: RetainedOffcut[]
  retentionAdded: RetainedOffcut[]
  /** 废料/用掉/工时的总变化（整数 mm / 秒） */
  totals: {
    wasteDeltaMm: number
    usedDeltaMm: number
    laborDeltaSec: number
    builtDelta: number
  }
}

export function diffPlans(before: CutPlan, after: CutPlan): PlanDiff {
  // 构件来源：按种类聚合（来源多重集比对，同料号按实例号区分）
  const key = (s: { stockCode: string; instanceNo: number; segNo: number }) => `${s.stockCode}#${s.instanceNo}-${s.segNo}`
  const beforeMerged = new Map(mergedComponentRows(before).map((r) => [r.demandKey, r]))
  const afterMerged = new Map(mergedComponentRows(after).map((r) => [r.demandKey, r]))

  const memberSourceChanges: PlanDiff['memberSourceChanges'] = []
  const membersAdded: PlanDiff['membersAdded'] = []
  const membersRemoved: PlanDiff['membersRemoved'] = []
  const keys = new Set([...beforeMerged.keys(), ...afterMerged.keys()])
  for (const k of keys) {
    const b = beforeMerged.get(k)
    const a = afterMerged.get(k)
    const label = a?.label || b?.label || k
    if (b && a) {
      if (a.haveQty > b.haveQty) membersAdded.push({ demandKey: k, label, qty: a.haveQty - b.haveQty })
      if (b.haveQty > a.haveQty) membersRemoved.push({ demandKey: k, label, qty: b.haveQty - a.haveQty })
      const bs = new Map(b.sources.map((s) => [key(s), s]))
      const as = new Map(a.sources.map((s) => [key(s), s]))
      const onlyB = b.sources.filter((s) => !as.has(key(s)))
      const onlyA = a.sources.filter((s) => !bs.has(key(s)))
      if (onlyB.length || onlyA.length) {
        memberSourceChanges.push({ demandKey: k, label, before: onlyB, after: onlyA })
      }
    } else if (a) {
      membersAdded.push({ demandKey: k, label, qty: a.haveQty })
    } else if (b) {
      membersRemoved.push({ demandKey: k, label, qty: b.haveQty })
    }
  }

  // 材料页变化
  const bm = new Map(materialSummary(before).rows.map((r) => [r.specMm, r]))
  const am = new Map(materialSummary(after).rows.map((r) => [r.specMm, r]))
  const materialChanges: PlanDiff['materialChanges'] = []
  for (const spec of new Set([...bm.keys(), ...am.keys()])) {
    const b = bm.get(spec)
    const a = am.get(spec)
    const fields: (keyof MaterialRow)[] = ['stockQty', 'usedStripQty', 'usedLengthMm', 'retainedQty', 'retainedMm', 'wasteMm', 'addQty', 'addStripLenMm']
    const pick = (r: MaterialRow | undefined) => (r ? Object.fromEntries(fields.map((f) => [f, r[f]])) : undefined)
    const pb = pick(b)
    const pa = pick(a)
    const changed = fields.some((f) => (pb?.[f] ?? 0) !== (pa?.[f] ?? 0))
    if (changed) materialChanges.push({ specMm: spec, before: pb, after: pa })
  }

  // 留用变化（按留用料号）
  const bOff = new Map(retainedOffcuts(before).map((o) => [o.offcutCode, o]))
  const aOff = new Map(retainedOffcuts(after).map((o) => [o.offcutCode, o]))
  const retentionRevoked = [...bOff.keys()].filter((c) => !aOff.has(c)).map((c) => bOff.get(c)!)
  const retentionAdded = [...aOff.keys()].filter((c) => !bOff.has(c)).map((c) => aOff.get(c)!)

  return {
    fromPlanId: before.id,
    toPlanId: after.id,
    memberSourceChanges,
    membersAdded,
    membersRemoved,
    materialChanges,
    retentionRevoked,
    retentionAdded,
    totals: {
      wasteDeltaMm: after.metrics.wasteMm - before.metrics.wasteMm,
      usedDeltaMm: after.metrics.usedLengthMm - before.metrics.usedLengthMm,
      laborDeltaSec: after.metrics.laborSec - before.metrics.laborSec,
      builtDelta: after.metrics.builtLanterns - before.metrics.builtLanterns
    }
  }
}

/** 两条路对比：被放弃的那条在材料与工时上让出的代价 */
export interface StrategyConcession {
  chosen: CutStrategyId
  givenUp: CutStrategyId
  /** 相对被放弃方案，选中方案在废料上多/少多少 mm（正=选中方案更费料） */
  wasteDeltaMm: number
  /** 相对被放弃方案，选中方案在工时上多/少多少秒（正=选中方案更费工） */
  laborDeltaSec: number
  retainedDeltaMm: number
  stripsDelta: number
  text: string
}

export function strategyConcession(plan: CutPlan): StrategyConcession {
  const chosen = plan.metrics
  const alt = plan.alternative
  const givenUp = alt.strategy
  const m = STRATEGIES[chosen.strategy]
  const g = STRATEGIES[givenUp]
  const wasteDelta = chosen.wasteMm - alt.wasteMm
  const laborDelta = chosen.laborSec - alt.laborSec
  const text =
    `已选「${m.name}」（${m.goal}），放弃「${g.name}」。` +
    `让路代价：废料 ${wasteDelta >= 0 ? '多' : '少'} ${Math.abs(wasteDelta)}mm` +
    `（留用余料 ${chosen.retainedMm}mm 对 ${alt.retainedMm}mm，动用 ${chosen.stripsUsed} 根对 ${alt.stripsUsed} 根），` +
    `工时 ${laborDelta >= 0 ? '多' : '少'} ${Math.abs(laborDelta)} 秒` +
    `（试配 ${chosen.fitAttempts} 次对 ${alt.fitAttempts} 次、${chosen.cuts} 刀对 ${alt.cuts} 刀）。`
  return {
    chosen: chosen.strategy,
    givenUp,
    wasteDeltaMm: wasteDelta,
    laborDeltaSec: laborDelta,
    retainedDeltaMm: chosen.retainedMm - alt.retainedMm,
    stripsDelta: chosen.stripsUsed - alt.stripsUsed,
    text
  }
}

// ---------------------------------------------------------------- 展示小工具

/** mm 折成 m（3 位小数，四舍五入；仅展示，账仍按整数 mm） */
export function mmToM(mm: number): number {
  return Math.round(mm) / 1000
}

export function formatM(mm: number): string {
  return (Math.round(mm) / 1000).toFixed(3)
}

export function formatLabor(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return h > 0 ? `${h}时${m}分${s}秒` : m > 0 ? `${m}分${s}秒` : `${s}秒`
}
