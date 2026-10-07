/**
 * 配切算法（1D 条材下料，整数 mm 口径）
 *
 * 取整规则（本活难点，唯一口径）：
 *   cutMm = ceil(净长 + 余量处数 × 每处绑扎余量)
 *   库存容量 capMm = floor(原长)
 *   残料能否接下一件：remainMm(整数) >= 本批最短 cutMm(整数)，一律整数相比，不碰未取整小数。
 *
 * 两条互斥路线：
 *   long_first  省料·先保长件：件从长到短；已开料选「装得下且最满」的一根，开新料取最短装得下的库存篾（长篾尽量留架）。
 *   short_first 省时·短件凑齐：件从短到长；先摊最长几根库存篾（开新料取最长），同样 best-fit，动用根数/余料归架最少。
 */
import type {
  CommittedPlan,
  CutPlanResult,
  CutRoute,
  LaborCost,
  PieceDemand,
  PieceGroup,
  PurchaseLine,
  RoutePlan,
  Shortage,
  StockStick,
  StickPlan
} from './types'

/** 向上取整到整 mm（消除浮点尾差 1e-9） */
export const ceilMm = (v: number): number => Math.ceil(v - 1e-9)
/** 库存原长向下取整到整 mm */
export const floorMm = (v: number): number => Math.floor(v + 1e-9)
/** mm → m，保留 3 位小数（精确到 1mm） */
export const toMeters = (mm: number): number => Math.round(mm) / 1000

/** 工时口径（单位：工分 = 1/60 工时） */
export const LABOR = {
  /** 每动用一根篾：找料/上凳/丈量 */
  handleMin: 3,
  /** 每锯一截 */
  sawMin: 2,
  /** 每根余料归架留用：登记/签标签 */
  remnantMin: 2,
  minutesPerHour: 60
} as const

/** 灯样展开回调：给出该灯样每个构件行的稳定信息（由 cut/store 接 frame.ts） */
export interface MemberSpec {
  memberSeq: number
  memberId: string
  label: string
  netMm: number
  /** 该构件余量合计 mm（= 余量处数 × 每处余量） */
  allowanceMm: number
  /** 每盏该构件根数（frame 表 qty） */
  qty: number
}

export interface OrderLineInput {
  uid: string
  lanternId?: string
  lanternName: string
  count: number
  members?: MemberSpec[]
  manual?: { uid: string; label: string; netMm: number; allowanceMm: number; qty: number }[]
}

/**
 * 展开订单为逐件需求。
 * 身份键：灯样件 `${lanternId}#${memberId}`；手工件 `manual#${uid}`。
 * 排序稳定（行序 → 构件序号 → 第 n 盏），改盏数只增删件、不换身份。
 */
export function expandPieces(lines: OrderLineInput[]): PieceDemand[] {
  const out: PieceDemand[] = []
  let pieceNo = 0
  for (const line of lines) {
    const count = Math.max(0, Math.round(line.count))
    if (line.members && line.members.length) {
      const specs = [...line.members].sort((a, b) => a.memberSeq - b.memberSeq)
      for (let c = 0; c < count; c++) {
        for (const sp of specs) {
          const gross = sp.netMm + sp.allowanceMm
          for (let q = 0; q < Math.max(1, Math.round(sp.qty)); q++) {
            out.push({
              lineUid: line.uid,
              key: `${line.lanternId}#${sp.memberId}`,
              memberSeq: sp.memberSeq,
              label: sp.label,
              lanternName: line.lanternName,
              netMm: sp.netMm,
              lashMm: sp.allowanceMm,
              grossRawMm: gross,
              cutMm: ceilMm(gross),
              pieceNo: ++pieceNo
            })
          }
        }
      }
    } else if (line.manual) {
      const specs = [...line.manual].sort((a, b) => a.uid.localeCompare(b.uid))
      specs.forEach((mp, seq) => {
        const total = Math.max(0, Math.round(mp.qty)) * count
        for (let c = 0; c < total; c++) {
          const gross = mp.netMm + mp.allowanceMm
          out.push({
            lineUid: line.uid,
            key: `manual#${mp.uid}`,
            memberSeq: seq,
            label: mp.label,
            lanternName: line.lanternName,
            netMm: mp.netMm,
            lashMm: mp.allowanceMm,
            grossRawMm: gross,
            cutMm: ceilMm(gross),
            pieceNo: ++pieceNo
          })
        }
      })
    }
  }
  return out
}

/** 同一种件合并计数（构件分组表用） */
export function groupPieces(pieces: PieceDemand[]): PieceGroup[] {
  const map = new Map<string, PieceGroup>()
  for (const p of pieces) {
    let g = map.get(p.key)
    if (!g) {
      g = {
        key: p.key,
        label: p.label,
        lanternName: p.lanternName,
        netMm: p.netMm,
        lashMm: p.lashMm,
        cutMm: p.cutMm,
        qty: 0,
        pieceNos: []
      }
      map.set(p.key, g)
    }
    g.qty++
    g.pieceNos.push(p.pieceNo)
  }
  return [...map.values()].sort((a, b) => b.cutMm - a.cutMm || a.label.localeCompare(b.label))
}

/** 料架上一根本次可截的篾（整根新料，或上次留用余料的续截） */
export interface RackRef {
  stick: StockStick
  /** 本次可用容量（整 mm）：整根=floor(原长)；续截=上次残料 */
  availMm: number
  /** 段号接续：该篾已截段数（续截时 >0，新段号从 baseSegment+1 起） */
  baseSegment: number
  /** 段起点偏移：续截时为上次已用长度（startMm 仍按整根篾的绝对位置给） */
  startOffsetMm: number
}

interface Bin {
  ref: RackRef
  cap: number
  remain: number
  segCuts: number[] // 已排段的 cutMm（按排放顺序）
  segPieceNos: number[]
}

interface PackOutcome {
  bins: Bin[]
  unmet: PieceDemand[]
}

/**
 * 单路线装箱。
 * @param rack 本次可截的料（料架待用整根 + 留用余料续截）
 */
function pack(pieces: PieceDemand[], rack: RackRef[], route: CutRoute): PackOutcome {
  const ordered = [...pieces].sort((a, b) => {
    const d = route === 'long_first' ? b.cutMm - a.cutMm : a.cutMm - b.cutMm
    return d || a.key.localeCompare(b.key) || a.pieceNo - b.pieceNo
  })
  // 未开料：省料路线最短优先（保长篾），省时路线最长优先（少动根数）
  const freshSorted = [...rack].sort((a, b) =>
    route === 'long_first' ? a.availMm - b.availMm || a.stick.id.localeCompare(b.stick.id) : b.availMm - a.availMm || a.stick.id.localeCompare(b.stick.id)
  )

  // 小批量走精确分支限界（作坊一单单做，件数通常不大）；大批量走多起点启发式 + 局部搜索
  const seed = bestHeuristic(ordered, freshSorted, route)
  if (ordered.length <= EXACT_PIECE_LIMIT && freshSorted.length <= EXACT_RACK_LIMIT) {
    const exact = packExact(ordered, freshSorted, route, seed)
    if (exact) return exact
  }
  return seed
}

/** 多起点启发式：候选料按「路线默认序」与「反向序」各跑一遍，取满足件最多、评分最好的一份 */
function bestHeuristic(ordered: PieceDemand[], freshSorted: RackRef[], route: CutRoute): PackOutcome {
  const forward = [...freshSorted].sort((a, b) =>
    route === 'long_first' ? a.availMm - b.availMm || a.stick.id.localeCompare(b.stick.id) : b.availMm - a.availMm || a.stick.id.localeCompare(b.stick.id)
  )
  const reverse = [...forward].reverse()
  const minCut = ordered.reduce((m, p) => Math.min(m, p.cutMm), Infinity)
  const mode: 'material' | 'time' = route === 'long_first' ? 'material' : 'time'
  const candidates = [forward, reverse].map((f) => packHeuristic(ordered, f, route))
  const rank = (o: PackOutcome) => {
    const sc = packScore(o.bins.map((b) => b.remain), minCut, mode)
    return { placed: o.bins.reduce((a, b) => a + b.segCuts.length, 0), p: sc.p, s: sc.s, t: sc.t }
  }
  return candidates.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra.placed !== rb.placed) return rb.placed - ra.placed
    if (ra.p !== rb.p) return ra.p - rb.p
    if (ra.s !== rb.s) return ra.s - rb.s
    return ra.t - rb.t
  })[0]
}

const EXACT_PIECE_LIMIT = 60
const EXACT_RACK_LIMIT = 40

/** 装箱评分（越小越好）：省料 = 废料、动用根数、负留用；省时 = 动用根数、残料根数、废料 */
function packScore(remain: number[], minCut: number, mode: 'material' | 'time'): { p: number; s: number; t: number } {
  const waste = remain.reduce((a, r) => a + wasteOf(r, minCut), 0)
  if (mode === 'material') return { p: waste, s: remain.length, t: -remain.reduce((a, r) => a + (r >= minCut ? r : 0), 0) }
  return { p: remain.length, s: remain.filter((r) => r > 0).length, t: waste }
}
const scoreLess = (a: { p: number; s: number; t: number }, b: { p: number; s: number; t: number }) =>
  a.p !== b.p ? a.p < b.p : a.s !== b.s ? a.s < b.s : a.t < b.t

interface ExactNode {
  /** 已开料对应 rack 下标（每个 rack 至多一箱） */
  rackIdx: number
  cap: number
  remain: number
  pieceNos: number[]
}

/** 精确 DFS：件从长到短，逐件选箱；同容量箱/同尺寸件去重；不可行即判缺料 */
function packExact(ordered: PieceDemand[], freshSorted: RackRef[], route: CutRoute, seed: PackOutcome | null): PackOutcome | null {
  const piecesDesc = [...ordered].sort((a, b) => b.cutMm - a.cutMm || a.pieceNo - b.pieceNo)
  const minCut = piecesDesc.reduce((m, p) => Math.min(m, p.cutMm), Infinity)
  const mode: 'material' | 'time' = route === 'long_first' ? 'material' : 'time'
  let best: { boxes: ExactNode[]; score: { p: number; s: number; t: number } } | null = null
  let nodes = 0
  let aborted = false
  let proven = false
  const NODE_LIMIT = 2_000_000

  // 箱数与废料的理论下界
  const totalLen = piecesDesc.reduce((a, p) => a + p.cutMm, 0)
  const capsDesc = freshSorted.map((r) => r.availMm).sort((a, b) => b - a)
  let capAcc = 0
  let boxLB = 0
  for (const c of capsDesc) {
    if (capAcc >= totalLen) break
    capAcc += c
    boxLB++
  }
  const wasteLB = 0 // 废料下界恒 0（可能存在零废料装法）

  // 先用启发式解作初始上界（含其评分），剪枝立刻有力
  if (seed && seed.unmet.length === 0 && seed.bins.length) {
    const refIdx = new Map(freshSorted.map((r, i) => [r.stick.id, i]))
    const boxes0: ExactNode[] = seed.bins.map((b) => {
      const ri = refIdx.get(b.ref.stick.id) ?? -1
      return { rackIdx: ri, cap: b.cap, remain: b.remain, pieceNos: [...b.segPieceNos] }
    })
    if (boxes0.every((b) => b.rackIdx >= 0)) {
      best = { boxes: boxes0, score: packScore(boxes0.map((b) => b.remain), minCut, mode) }
    }
  }

  const dfs = (k: number, boxes: ExactNode[], usedRack: Set<number>, prevBoxIdx: number) => {
    if (++nodes > NODE_LIMIT) {
      aborted = true
      return
    }
    if (k === piecesDesc.length) {
      const sc = packScore(boxes.map((b) => b.remain), minCut, mode)
      if (!best || scoreLess(sc, best.score)) best = { boxes: boxes.map((b) => ({ ...b, pieceNos: [...b.pieceNos] })), score: sc }
      // 已达理论下界（省料：废料 0 且箱数=下界；省时：箱数=下界且废料 0），无需再找
      if (
        (mode === 'material' && sc.p === wasteLB && boxes.length === boxLB) ||
        (mode === 'time' && boxes.length === boxLB && sc.t === wasteLB)
      ) {
        proven = true
      }
      return
    }
    if (proven) return
    if (best) {
      // 省时：箱数是第一目标，只增不减，超最优即剪
      if (mode === 'time' && boxes.length > best.score.p) return
      // 省料：锁定废料下界——某箱残料已小于剩余所有件中最短者，
      // 该残料只会再减（不会再塞件），锁定为废料；锁定废料已超最优即剪
      if (mode === 'material') {
        const futureMin = k < piecesDesc.length ? piecesDesc[piecesDesc.length - 1].cutMm : minCut
        let locked = 0
        for (const b of boxes) if (b.remain < futureMin && b.remain > 0) locked += b.remain
        if (locked > best.score.p) return
        // 箱数第二目标：废料已不可能更优（锁定==best.p 且当前箱数超最优）时也剪
        if (locked === best.score.p && boxes.length > best.score.s) return
      }
    }
    const piece = piecesDesc[k]
    const sameAsPrev = k > 0 && piecesDesc[k - 1].cutMm === piece.cutMm
    const triedRemain = new Set<number>()
    // 1) 放进已开料的箱：best-fit 优先；同尺寸件不回退到前一件所放箱之前（对称剪枝）
    const openCandidates = boxes
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => b.remain >= piece.cutMm && (!sameAsPrev || i >= prevBoxIdx))
      .sort((x, y) => x.b.remain - y.b.remain)
    for (const { b, i } of openCandidates) {
      if (triedRemain.has(b.remain)) continue
      triedRemain.add(b.remain)
      b.remain -= piece.cutMm
      b.pieceNos.push(piece.pieceNo)
      dfs(k + 1, boxes, usedRack, i)
      b.pieceNos.pop()
      b.remain += piece.cutMm
      if (aborted || proven) return
    }
    // 2) 开新箱：同容量的未用候选料只试一根；新箱编号总在已开箱之后，同尺寸件自然满足不回退
    const triedCap = new Set<number>()
    for (let ri = 0; ri < freshSorted.length; ri++) {
      if (usedRack.has(ri)) continue
      const ref = freshSorted[ri]
      if (ref.availMm < piece.cutMm) continue
      if (triedCap.has(ref.availMm)) continue
      triedCap.add(ref.availMm)
      const box: ExactNode = { rackIdx: ri, cap: ref.availMm, remain: ref.availMm - piece.cutMm, pieceNos: [piece.pieceNo] }
      boxes.push(box)
      usedRack.add(ri)
      dfs(k + 1, boxes, usedRack, boxes.length - 1)
      usedRack.delete(ri)
      boxes.pop()
      if (aborted || proven) return
    }
  }

  dfs(0, [], new Set(), 0)
  if ((aborted && !proven) || !best) return null
  const placedSet = new Set(best.boxes.flatMap((b) => b.pieceNos))
  const bins: Bin[] = best.boxes.map((b) => ({
    ref: freshSorted[b.rackIdx],
    cap: b.cap,
    remain: b.remain,
    segCuts: [],
    segPieceNos: []
  }))
  // 段顺序按件原序号还原（最终 finalizeBins 会再按实际排放顺序给段号）
  const byPiece = new Map<number, Bin>()
  best.boxes.forEach((b, bi) => b.pieceNos.forEach((no) => byPiece.set(no, bins[bi])))
  for (const p of ordered) {
    const bin = byPiece.get(p.pieceNo)
    if (bin) {
      bin.segCuts.push(p.cutMm)
      bin.segPieceNos.push(p.pieceNo)
    }
  }
  const unmet = ordered.filter((p) => !placedSet.has(p.pieceNo))
  return { bins, unmet }
}

function packHeuristic(ordered: PieceDemand[], freshSorted: RackRef[], route: CutRoute): PackOutcome {
  const fresh = [...freshSorted]
  const opened: Bin[] = [] // 始终按剩余量升序维护（best-fit：取装得下的第一根 = 最满的一根）
  const unmet: PieceDemand[] = []

  const openNew = (need: number): Bin | null => {
    const idx = fresh.findIndex((r) => r.availMm >= need)
    if (idx < 0) return null
    const [ref] = fresh.splice(idx, 1)
    const bin: Bin = { ref, cap: ref.availMm, remain: ref.availMm, segCuts: [], segPieceNos: [] }
    // 插入剩余量有序位置
    const pos = opened.findIndex((b) => b.remain < bin.remain)
    opened.splice(pos < 0 ? opened.length : pos, 0, bin)
    return bin
  }

  for (const p of ordered) {
    const idx = opened.findIndex((b) => b.remain >= p.cutMm)
    let bin = idx >= 0 ? opened[idx] : openNew(p.cutMm)
    if (!bin) {
      unmet.push(p)
      continue
    }
    bin.remain -= p.cutMm
    bin.segCuts.push(p.cutMm)
    bin.segPieceNos.push(p.pieceNo)
    if (idx >= 0) {
      // 剩余量变了，重新归位（opened 保持升序）
      opened.splice(idx, 1)
      const pos = opened.findIndex((b) => b.remain > bin.remain)
      opened.splice(pos < 0 ? opened.length : pos, 0, bin)
    }
  }
  mergeBins(opened)
  improveBins(opened, minCutOf(ordered), route === 'long_first' ? 'material' : 'time')
  return { bins: opened, unmet }
}

/** 本批最短截取长（局部搜索判废料用，整数 mm） */
function minCutOf(pieces: PieceDemand[]): number {
  return pieces.reduce((m, p) => Math.min(m, p.cutMm), Infinity)
}

interface BinPlaced {
  cut: number
  pieceNo: number
}

/**
 * 装箱后改进：尝试把「最闲一根篾」上的段全部塞进其他已开料的篾，
 * 成功就把这根整根退回未开料（少动一根、碎片变整料）。反复到合并不动为止。
 */
function mergeBins(opened: Bin[]): void {
  const usedOf = (b: Bin) => b.segCuts.reduce((s, x) => s + x, 0)
  for (let guard = 0; guard < 64; guard++) {
    if (opened.length < 2) return
    let candIdx = -1
    let candUsed = Infinity
    opened.forEach((b, i) => {
      if (b.segCuts.length && usedOf(b) < candUsed) {
        candUsed = usedOf(b)
        candIdx = i
      }
    })
    if (candIdx < 0) return
    const cand = opened[candIdx]
    const others = opened.filter((b) => b !== cand)
    const items: BinPlaced[] = cand.segCuts.map((cut, i) => ({ cut, pieceNo: cand.segPieceNos[i] })).sort((a, b) => b.cut - a.cut)
    const remain = new Map<Bin, number>(others.map((b) => [b, b.remain]))
    const placements: { bin: Bin; cut: number; pieceNo: number }[] = []
    let allFit = true
    for (const it of items) {
      const fits = others.filter((b) => (remain.get(b) ?? 0) >= it.cut).sort((a, b) => (remain.get(a) ?? 0) - (remain.get(b) ?? 0))
      if (!fits.length) {
        allFit = false
        break
      }
      const target = fits[0]
      remain.set(target, (remain.get(target) ?? 0) - it.cut)
      placements.push({ bin: target, cut: it.cut, pieceNo: it.pieceNo })
    }
    if (!allFit) return
    for (const pl of placements) {
      pl.bin.segCuts.push(pl.cut)
      pl.bin.segPieceNos.push(pl.pieceNo)
      pl.bin.remain -= pl.cut
    }
    opened.splice(candIdx, 1)
  }
}

/** 残料是否算废料（整数口径） */
function wasteOf(remain: number, minCut: number): number {
  return remain > 0 && remain < minCut ? remain : 0
}

/**
 * 局部搜索：通过「整段移到别的篾」与「两篾之间交换一段」改进装箱。
 * 省料路线以明确废料最少为目标；省时路线以动用根数、其次以非空残料根数为目标。
 * 允许一根篾被腾空（整根退回料架）。
 */
function improveBins(opened: Bin[], minCut: number, mode: 'material' | 'time'): void {
  // 假设各箱剩余量（空箱剔除）下的评分
  const scoreOf = (rems: number[]): { p: number; s: number; t: number } => {
    const waste = rems.reduce((a, r) => a + wasteOf(r, minCut), 0)
    if (mode === 'material') {
      const usable = rems.reduce((a, r) => a + (r >= minCut ? r : 0), 0)
      return { p: waste, s: rems.length, t: -usable }
    }
    return { p: rems.length, s: rems.filter((r) => r > 0).length, t: waste }
  }
  const better = (a: { p: number; s: number; t: number }, b: { p: number; s: number; t: number }) =>
    a.p !== b.p ? a.p < b.p : a.s !== b.s ? a.s < b.s : a.t < b.t

  // 总评估次数预算：箱多/段多时 O(n²·seg²) 会爆。大批量放宽到 12 万次，保住响应
  const pieceCount = opened.reduce((a, b) => a + b.segCuts.length, 0)
  const MAX_TRIALS = pieceCount > 120 ? 120_000 : 500_000
  const MAX_ITERS = pieceCount > 120 ? 30 : 60
  let trials = 0
  let iter = 0
  while (iter++ < MAX_ITERS && trials < MAX_TRIALS) {
    const baseRem = opened.map((b) => b.remain)
    const base = scoreOf(baseRem)
    let bestScore = base
    let bestMove: (() => void) | null = null
    const trial = (rems: number[], apply: () => void) => {
      trials++
      const sc = scoreOf(rems)
      if (better(sc, bestScore)) {
        bestScore = sc
        bestMove = apply
      }
    }

    for (let i = 0; i < opened.length && trials < MAX_TRIALS; i++) {
      for (let j = 0; j < opened.length && trials < MAX_TRIALS; j++) {
        if (i === j) continue
        const A = opened[i]
        const B = opened[j]
        for (let ai = 0; ai < A.segCuts.length && trials < MAX_TRIALS; ai++) {
          // 移动 A[ai] → B；若 A 变空则整箱剔除
          if (B.remain >= A.segCuts[ai]) {
            const aEmpty = A.segCuts.length === 1
            const rems = opened.map((b, k) => (k === i ? A.remain + A.segCuts[ai] : k === j ? B.remain - A.segCuts[ai] : b.remain)).filter((_, k) => !(aEmpty && k === i))
            const aiCap = ai
            trial(rems, () => {
              const cut = A.segCuts.splice(aiCap, 1)[0]
              const pn = A.segPieceNos.splice(aiCap, 1)[0]
              B.segCuts.push(cut)
              B.segPieceNos.push(pn)
              B.remain -= cut
              A.remain += cut
              if (!A.segCuts.length) {
                const idx = opened.indexOf(A)
                if (idx >= 0) opened.splice(idx, 1)
              }
            })
          }
          // 交换 A[ai] ↔ B[bj]
          for (let bj = 0; bj < B.segCuts.length; bj++) {
            const newAR = A.remain - (B.segCuts[bj] - A.segCuts[ai])
            const newBR = B.remain + (B.segCuts[bj] - A.segCuts[ai])
            if (newAR < 0 || newBR < 0) continue
            const rems = opened.map((b, k) => (k === i ? newAR : k === j ? newBR : b.remain))
            trial(rems, () => {
              const c1 = A.segCuts[ai]
              const p1 = A.segPieceNos[ai]
              A.segCuts[ai] = B.segCuts[bj]
              A.segPieceNos[ai] = B.segPieceNos[bj]
              B.segCuts[bj] = c1
              B.segPieceNos[bj] = p1
              A.remain = newAR
              B.remain = newBR
            })
          }
        }
      }
    }
    const moveBox: { fn?: () => void } = {}
    if (bestMove) moveBox.fn = bestMove
    if (typeof moveBox.fn !== 'function') break
    moveBox.fn()
  }
}

function laborOf(openedCount: number, segments: number, remnantCount: number, wasteBinCount: number): LaborCost {
  // 一根用尽（remain=0）的篾截 k 段只需 k-1 锯；有余料的 k 段需 k 锯（最后一锯分离余料）
  const saw = segments + remnantCount + wasteBinCount - openedCount
  const handle = openedCount * LABOR.handleMin
  const remnant = remnantCount * LABOR.remnantMin
  return { handle, saw: saw * LABOR.sawMin, remnant, total: handle + saw * LABOR.sawMin + remnant }
}

/** 把装箱结果整理成 StickPlan（含逐段定位与残料判定，全部整数 mm） */
function finalizeBins(bins: Bin[], piecesById: Map<number, PieceDemand>, minCutMm: number): StickPlan[] {
  const plans: StickPlan[] = []
  for (const bin of bins) {
    let cursor = bin.ref.startOffsetMm
    const segments = bin.segCuts.map((cut, i) => {
      const p = piecesById.get(bin.segPieceNos[i])!
      const seg = {
        segment: bin.ref.baseSegment + i + 1,
        startMm: cursor,
        pieceNo: p.pieceNo,
        pieceKey: p.key,
        label: p.label,
        lanternName: p.lanternName,
        netMm: p.netMm,
        lashMm: p.lashMm,
        grossRawMm: p.grossRawMm,
        cutMm: cut
      }
      cursor += cut
      return seg
    })
    const usedMm = bin.segCuts.reduce((s, x) => s + x, 0)
    const remainMm = bin.cap - usedMm
    const stockCap = floorMm(bin.ref.stick.lengthMm)
    plans.push({
      stickId: bin.ref.stick.id,
      stockMm: bin.ref.stick.lengthMm,
      stockCapMm: stockCap,
      capMm: bin.cap,
      priorUsedMm: bin.ref.startOffsetMm,
      startOffsetMm: bin.ref.startOffsetMm,
      baseSegment: bin.ref.baseSegment,
      isRemnantReuse: bin.ref.baseSegment > 0,
      segments,
      usedMm,
      remainMm,
      // 整数对整数：残料 ≥ 本批最短件才可留用；==0 为用尽；0<残料<最短件为明确废料
      remainKind: remainMm <= 0 ? 'none' : remainMm >= minCutMm ? 'usable' : 'waste'
    })
  }
  // 展示顺序：料号
  return plans.sort((a, b) => a.stickId.localeCompare(b.stickId))
}

/** 缺料诊断 + 添料建议（长度不够 / 根数不够要说清） */
function diagnose(unmetGroups: PieceGroup[], maxStockCap: number): { shortages: Shortage[]; purchase: PurchaseLine[] } {
  const shortages: Shortage[] = []
  for (const g of unmetGroups) {
    const type: Shortage['type'] = g.cutMm > maxStockCap ? 'length' : 'count'
    shortages.push({
      type,
      pieceKey: g.key,
      label: g.label,
      lanternName: g.lanternName,
      cutMm: g.cutMm,
      shortQty: g.qty,
      maxStockMm: type === 'length' ? maxStockCap : undefined,
      suggestLengthMm: g.cutMm,
      suggestQty: g.qty
    })
  }
  // 添料同规格合并计数
  const map = new Map<number, PurchaseLine>()
  for (const s of shortages) {
    const line = map.get(s.suggestLengthMm) ?? { specMm: s.suggestLengthMm, qty: 0, totalMm: 0, totalM: 0, reason: '' }
    line.qty += s.suggestQty
    const why = s.type === 'length' ? `${s.label}（${s.cutMm}mm，库内最长仅 ${s.maxStockMm}mm，长度不够）` : `${s.label}（${s.cutMm}mm，缺 ${s.shortQty} 根，根数不够）`
    line.reason = line.reason ? `${line.reason}；${why}` : why
    map.set(s.suggestLengthMm, line)
  }
  const purchase = [...map.values()]
    .map((l) => ({ ...l, totalMm: l.specMm * l.qty, totalM: toMeters(l.specMm * l.qty) }))
    .sort((a, b) => b.specMm - a.specMm)
  return { shortages, purchase }
}

function buildRoutePlan(route: CutRoute, pieces: PieceDemand[], rack: RackRef[], minCutMm: number): RoutePlan {
  const { bins, unmet } = pack(pieces, rack, route)
  const piecesById = new Map(pieces.map((p) => [p.pieceNo, p]))
  const sticks = finalizeBins(bins, piecesById, minCutMm)
  const unmetGroups = groupPieces(unmet)
  const maxStockCap = rack.reduce((m, r) => Math.max(m, r.availMm), 0)
  const { shortages, purchase } = diagnose(unmetGroups, maxStockCap)

  const placedPieceNos = sticks.flatMap((s) => s.segments.map((g) => g.pieceNo))
  const consumedMm = sticks.reduce((a, s) => a + s.usedMm, 0)
  const usable = sticks.filter((s) => s.remainKind === 'usable')
  const wasteBins = sticks.filter((s) => s.remainKind === 'waste')
  const segments = sticks.reduce((a, s) => a + s.segments.length, 0)
  // 整根未动用（不含续截余料：余料本来就在已开料的篾上）
  const wholeUnused = rack.filter((r) => r.baseSegment === 0 && !sticks.some((sp) => sp.stickId === r.stick.id)).length

  return {
    route,
    sticks,
    placedPieceNos: placedPieceNos.sort((a, b) => a - b),
    unmet: unmetGroups,
    unmetPieces: unmet,
    shortages,
    purchase,
    usedStickCount: sticks.filter((s) => !s.isRemnantReuse).length,
    reusedRemnantCount: sticks.filter((s) => s.isRemnantReuse).length,
    unusedStickCount: wholeUnused,
    consumedMm,
    wasteMm: wasteBins.reduce((a, s) => a + s.remainMm, 0),
    usableRemnantMm: usable.reduce((a, s) => a + s.remainMm, 0),
    usableRemnantCount: usable.length,
    cuts: segments,
    labor: laborOf(sticks.length, segments, usable.length, wasteBins.length),
    totalPieces: pieces.length,
    satisfiedPieces: placedPieceNos.length,
    fullyFeasible: unmet.length === 0
  }
}

/** 每行可完成盏数：本行某构件缺 k 根 ⇒ 本行少 ceil(k / 每盏该构件根数) 盏，取各行最大缺口 */
export function feasibleByLine(
  lines: OrderLineInput[],
  unmetPieces: PieceDemand[]
): { uid: string; name: string; requested: number; feasible: number; missing: number }[] {
  const shortByLine = new Map<string, Map<string, number>>()
  for (const p of unmetPieces) {
    const m = shortByLine.get(p.lineUid) ?? new Map<string, number>()
    m.set(p.key, (m.get(p.key) ?? 0) + 1)
    shortByLine.set(p.lineUid, m)
  }
  return lines.map((line) => {
    const count = Math.max(0, Math.round(line.count))
    const perLight = new Map<string, number>()
    line.members?.forEach((m) => perLight.set(`${line.lanternId}#${m.memberId}`, Math.max(1, m.qty)))
    line.manual?.forEach((m) => perLight.set(`manual#${m.uid}`, Math.max(1, m.qty)))
    let maxMiss = 0
    const m = shortByLine.get(line.uid)
    if (m) {
      for (const [key, q] of m) {
        maxMiss = Math.max(maxMiss, Math.min(count, Math.ceil(q / (perLight.get(key) ?? 1))))
      }
    }
    return { uid: line.uid, name: line.lanternName, requested: count, feasible: count - maxMiss, missing: maxMiss }
  })
}

export interface ComputeInput {
  calcNo: number
  lashAllowanceMm: number
  lines: OrderLineInput[]
  rack: RackRef[]
  selected: CutRoute
  generatedAt: string
}

/** 整批重算：两条路线各算一份，返回同一份结果（构件表/备料/存档只从这里取数） */
export function computeCutPlan(input: ComputeInput): CutPlanResult {
  const pieces = expandPieces(input.lines)
  const groups = groupPieces(pieces)
  const minCutMm = pieces.reduce((m, p) => Math.min(m, p.cutMm), Infinity)
  const finiteMin = Number.isFinite(minCutMm) ? minCutMm : 0
  const plans = {
    long_first: buildRoutePlan('long_first', pieces, input.rack, finiteMin),
    short_first: buildRoutePlan('short_first', pieces, input.rack, finiteMin)
  }
  const byLine = feasibleByLine(input.lines, plans[input.selected].unmetPieces)
  const requestedLights = input.lines.reduce((s, x) => s + Math.max(0, Math.round(x.count)), 0)
  const feasibleLights = byLine.reduce((s, x) => s + x.feasible, 0)
  const demandMm = pieces.reduce((s, p) => s + p.cutMm, 0)
  return {
    calcNo: input.calcNo,
    lashAllowanceMm: input.lashAllowanceMm,
    minCutMm: finiteMin,
    pieces,
    groups,
    requestedLights,
    feasibleLights,
    feasible: plans[input.selected].fullyFeasible,
    plans,
    selected: input.selected,
    purchase: plans[input.selected].purchase,
    demandMm,
    demandM: toMeters(demandMm),
    generatedAt: input.generatedAt
  }
}

/** 方案内容指纹（FNV-1a，32 位）：三处清单与存档凭它对得上同一份配切 */
export function fingerprintOf(route: CutRoute, sticks: StickPlan[], purchase: PurchaseLine[]): string {
  const body = JSON.stringify({
    r: route,
    s: sticks.map((s) => [s.stickId, s.segments.map((g) => [g.segment, g.pieceKey, g.cutMm]), s.remainMm, s.remainKind]),
    p: purchase.map((l) => [l.specMm, l.qty])
  })
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 对账：一根篾 容量 = 段合计 + 残料；全批 动用容量 = 用掉 + 留用 + 废料（差 1mm 也报） */
export function reconcile(sticks: StickPlan[]): {
  ok: boolean
  perStick: { stickId: string; diffMm: number; fullDiffMm: number }[]
  totalDiffMm: number
} {
  const perStick = sticks.map((s) => {
    // 本次账：本次容量 = 本次截用 + 本次残料
    const diffMm = s.capMm - s.usedMm - s.remainMm
    // 整根篾账（续截也要对得上）：整根容量 = 历史已用 + 本次截用 + 本次残料
    const fullDiffMm = s.stockCapMm - s.priorUsedMm - s.usedMm - s.remainMm
    return { stickId: s.stickId, diffMm, fullDiffMm }
  })
  const totalDiffMm = perStick.reduce((a, x) => a + x.diffMm + x.fullDiffMm, 0)
  return { ok: perStick.every((x) => x.diffMm === 0 && x.fullDiffMm === 0) && totalDiffMm === 0, perStick, totalDiffMm }
}

/** 两条路线代价对比（被放弃的那条让出了什么：材料 mm / 工时 工分） */
export function routeTradeoff(result: CutPlanResult): {
  chosen: CutRoute
  other: CutRoute
  wasteDeltaMm: number
  remnantDeltaMm: number
  laborDeltaMin: number
  stickDelta: number
  text: string
} {
  const a = result.plans[result.selected]
  const otherRoute: CutRoute = result.selected === 'long_first' ? 'short_first' : 'long_first'
  const b = result.plans[otherRoute]
  const wasteDeltaMm = b.wasteMm - a.wasteMm
  const remnantDeltaMm = a.usableRemnantMm - b.usableRemnantMm
  const laborDeltaMin = a.labor.total - b.labor.total
  const stickDelta = a.usedStickCount - b.usedStickCount
  const chosenName = result.selected === 'long_first' ? '省料·先保长件' : '省时·短件凑齐'
  const otherName = otherRoute === 'long_first' ? '省料·先保长件' : '省时·短件凑齐'
  const parts: string[] = []
  parts.push(wasteDeltaMm > 0 ? `选「${chosenName}」比放弃的「${otherName}」少出废料 ${wasteDeltaMm}mm` : wasteDeltaMm < 0 ? `选「${chosenName}」比放弃的「${otherName}」多出废料 ${-wasteDeltaMm}mm（材料上让出的代价）` : `两条路线废料同为 ${a.wasteMm}mm`)
  parts.push(laborDeltaMin < 0 ? `省工时 ${-laborDeltaMin} 工分（${(-laborDeltaMin / LABOR.minutesPerHour).toFixed(2)} 工时）` : laborDeltaMin > 0 ? `多花工时 ${laborDeltaMin} 工分（${(laborDeltaMin / LABOR.minutesPerHour).toFixed(2)} 工时，工时上让出的代价）` : '工时相同')
  parts.push(stickDelta !== 0 ? `动用篾根${stickDelta > 0 ? `多 ${stickDelta} 根` : `少 ${-stickDelta} 根`}` : '动用篾根数相同')
  void remnantDeltaMm
  return { chosen: result.selected, other: otherRoute, wasteDeltaMm, remnantDeltaMm, laborDeltaMin, stickDelta, text: parts.join('；') }
}

/** 从已存档方案还原一个等价 RoutePlan（diff/展示复用） */
export function routePlanFromCommitted(p: CommittedPlan): RoutePlan {
  const usable = p.sticks.filter((s) => s.remainKind === 'usable')
  const segments = p.sticks.reduce((a, s) => a + s.segments.length, 0)
  return {
    route: p.route,
    sticks: p.sticks,
    placedPieceNos: p.sticks.flatMap((s) => s.segments.map((g) => g.pieceNo)).sort((a, b) => a - b),
    unmet: p.unmet,
    unmetPieces: [],
    shortages: p.shortages,
    purchase: p.purchase,
    usedStickCount: p.sticks.length,
    reusedRemnantCount: p.sticks.filter((s) => s.isRemnantReuse).length,
    unusedStickCount: p.unusedStickIds.length,
    consumedMm: p.consumedMm,
    wasteMm: p.wasteMm,
    usableRemnantMm: p.usableRemnantMm,
    usableRemnantCount: usable.length,
    cuts: segments,
    labor: { handle: 0, saw: 0, remnant: 0, total: p.laborTotal },
    totalPieces: p.sticks.reduce((a, s) => a + s.segments.length, 0),
    satisfiedPieces: segments,
    fullyFeasible: p.shortages.length === 0
  }
}
