/**
 * 整批复算后的三处差异（构件表 / 材料页 / 存档留用），都从同一份 CutPlanResult 取数。
 * 旧 = 最近一版活跃存档（CommittedPlan 快照）；新 = 当前工作态选中路线。
 */
import type { CommittedPlan, CutPlanResult, PurchaseLine, RoutePlan, StickPlan } from './types'

export interface PieceSourceChange {
  pieceNo: number
  label: string
  cutMm: number
  oldStickId?: string
  oldSegment?: number
  newStickId?: string
  newSegment?: number
  kind: 'source_changed' | 'added' | 'removed'
  text: string
}

export interface PurchaseChange {
  specMm: number
  oldQty?: number
  newQty?: number
  kind: 'added' | 'removed' | 'qty_changed'
  text: string
}

export interface RemnantChange {
  stickId: string
  oldPlanNo: number
  oldRemainMm: number
  newRemainMm?: number
  newKind?: StickPlan['remainKind']
  /** 续截：留用余料本批又截去了多少 */
  consumedMm?: number
  kind: 'released' | 'consumed_more' | 'new_retained'
  text: string
}

export interface PlanDiff {
  hasOld: boolean
  oldPlanNo?: number
  oldCalcNo?: number
  newCalcNo: number
  routeChanged: boolean
  oldRoute?: CommittedPlan['route']
  newRoute?: CommittedPlan['route']
  pieces: PieceSourceChange[]
  purchase: PurchaseChange[]
  remnants: RemnantChange[]
  metrics: {
    consumedDeltaMm: number
    wasteDeltaMm: number
    remnantDeltaMm: number
    laborDeltaMin: number
    usedStickDelta: number
  }
  anyChange: boolean
}

interface SourceIndex {
  stickId: string
  segment: number
  label: string
  cutMm: number
  pieceKey: string
  /** 件序号（当前批次） */
  pieceNo: number
}

/**
 * 构件身份 = 构件键 + 同构件的第几根（按件序号）。
 * 改盏数只在末尾增删同身份件，加灯不会让前面的件「换身份」；身份相同而料号/段号变了才算来源段换了。
 */
function indexSources(sticks: StickPlan[]): Map<string, SourceIndex> {
  const m = new Map<string, SourceIndex>()
  const occ = new Map<string, number>()
  const flat = sticks
    .flatMap((s) => s.segments.map((seg) => ({ s, seg })))
    .sort((a, b) => a.seg.pieceNo - b.seg.pieceNo)
  for (const { s, seg } of flat) {
    const rank = (occ.get(seg.pieceKey) ?? 0) + 1
    occ.set(seg.pieceKey, rank)
    m.set(`${seg.pieceKey}#${rank}`, { stickId: s.stickId, segment: seg.segment, label: seg.label, cutMm: seg.cutMm, pieceKey: seg.pieceKey, pieceNo: seg.pieceNo })
  }
  return m
}

function diffPieces(oldSticks: StickPlan[] | undefined, newSticks: StickPlan[]): PieceSourceChange[] {
  const out: PieceSourceChange[] = []
  const oldMap = oldSticks ? indexSources(oldSticks) : new Map<string, SourceIndex>()
  const newMap = indexSources(newSticks)
  const ids = new Set<string>([...oldMap.keys(), ...newMap.keys()])
  const collator = new Intl.Collator('zh-Hans-CN')
  for (const id of [...ids].sort((a, b) => collator.compare(a, b))) {
    const o = oldMap.get(id)
    const n = newMap.get(id)
    if (o && n) {
      if (o.stickId !== n.stickId || o.segment !== n.segment) {
        out.push({
          pieceNo: n.pieceNo,
          label: n.label,
          cutMm: n.cutMm,
          oldStickId: o.stickId,
          oldSegment: o.segment,
          newStickId: n.stickId,
          newSegment: n.segment,
          kind: 'source_changed',
          text: `${n.label}（${n.cutMm}mm，第 ${n.pieceNo} 件）：${o.stickId} 第 ${o.segment} 段 → ${n.stickId} 第 ${n.segment} 段`
        })
      }
    } else if (n) {
      out.push({ pieceNo: n.pieceNo, label: n.label, cutMm: n.cutMm, newStickId: n.stickId, newSegment: n.segment, kind: 'added', text: `${n.label}（${n.cutMm}mm，第 ${n.pieceNo} 件）为本批新增，取自 ${n.stickId} 第 ${n.segment} 段` })
    } else if (o) {
      out.push({ pieceNo: o.pieceNo, label: o.label, cutMm: o.cutMm, oldStickId: o.stickId, oldSegment: o.segment, kind: 'removed', text: `${o.label}（${o.cutMm}mm，第 ${o.pieceNo} 件）本批不再需要，原占 ${o.stickId} 第 ${o.segment} 段` })
    }
  }
  return out
}

function purchaseMap(lines: PurchaseLine[]): Map<number, number> {
  return new Map(lines.map((l) => [l.specMm, l.qty]))
}

function diffPurchase(oldLines: PurchaseLine[] | undefined, newLines: PurchaseLine[]): PurchaseChange[] {
  const out: PurchaseChange[] = []
  const oldMap = purchaseMap(oldLines ?? [])
  const newMap = purchaseMap(newLines)
  for (const spec of new Set<number>([...oldMap.keys(), ...newMap.keys()])) {
    const o = oldMap.get(spec)
    const n = newMap.get(spec)
    if (o === undefined && n !== undefined) {
      out.push({ specMm: spec, newQty: n, kind: 'added', text: `新增添料 ${spec}mm × ${n} 根` })
    } else if (n === undefined && o !== undefined) {
      out.push({ specMm: spec, oldQty: o, kind: 'removed', text: `不再需要添料 ${spec}mm（原需 ${o} 根）` })
    } else if (o !== n) {
      out.push({ specMm: spec, oldQty: o, newQty: n, kind: 'qty_changed', text: `${spec}mm 添料根数 ${o} → ${n} 根` })
    }
  }
  return out.sort((a, b) => b.specMm - a.specMm)
}

/** 存档留用差异：旧方案留用、新方案里不再留用（被续截/释放） */
function diffRemnants(oldPlan: CommittedPlan | undefined, newPlan: RoutePlan): RemnantChange[] {
  const out: RemnantChange[] = []
  if (!oldPlan) {
    for (const s of newPlan.sticks.filter((x) => x.remainKind === 'usable')) {
      out.push({ stickId: s.stickId, oldPlanNo: 0, oldRemainMm: 0, newRemainMm: s.remainMm, newKind: 'usable', kind: 'new_retained', text: `${s.stickId} 新留用余料 ${s.remainMm}mm` })
    }
    return out
  }
  const newByStick = new Map(newPlan.sticks.map((s) => [s.stickId, s]))
  for (const oldS of oldPlan.sticks.filter((x) => x.remainKind === 'usable')) {
    const ns = newByStick.get(oldS.stickId)
    if (!ns) {
      // 本批没动这根：仍然留用，不报
      continue
    }
    if (ns.isRemnantReuse && ns.remainKind === 'usable') {
      out.push({
        stickId: oldS.stickId,
        oldPlanNo: oldPlan.planNo,
        oldRemainMm: oldS.remainMm,
        newRemainMm: ns.remainMm,
        newKind: 'usable',
        consumedMm: oldS.remainMm - ns.remainMm,
        kind: 'consumed_more',
        text: `${oldS.stickId} 上次留用 ${oldS.remainMm}mm，本批续截 ${oldS.remainMm - ns.remainMm}mm，剩 ${ns.remainMm}mm 仍留用`
      })
    } else {
      out.push({
        stickId: oldS.stickId,
        oldPlanNo: oldPlan.planNo,
        oldRemainMm: oldS.remainMm,
        newRemainMm: ns.remainMm,
        newKind: ns.remainKind,
        consumedMm: oldS.remainMm - ns.remainMm,
        kind: 'released',
        text:
          ns.remainKind === 'waste'
            ? `${oldS.stickId} 上次留用 ${oldS.remainMm}mm 不再留用：本批续截后剩 ${ns.remainMm}mm，短于本批最短件，判废`
            : `${oldS.stickId} 上次留用 ${oldS.remainMm}mm 不再留用：本批续截后用尽`,
      })
    }
  }
  // 新留用（上版方案中未留用或新动用的篾）
  for (const s of newPlan.sticks.filter((x) => x.remainKind === 'usable')) {
    if (!oldPlan.sticks.some((x) => x.stickId === s.stickId && x.remainKind === 'usable')) {
      out.push({ stickId: s.stickId, oldPlanNo: oldPlan.planNo, oldRemainMm: 0, newRemainMm: s.remainMm, newKind: 'usable', kind: 'new_retained', text: `${s.stickId} 新留用余料 ${s.remainMm}mm` })
    }
  }
  return out
}

/**
 * 比对旧存档与新工作结果。
 * oldPlan 缺省时（首次提交前）只报新增，不报「换了」。
 */
export function diffPlan(oldPlan: CommittedPlan | undefined, result: CutPlanResult): PlanDiff {
  const newPlan = result.plans[result.selected]
  const pieces = diffPieces(oldPlan?.sticks, newPlan.sticks)
  const purchase = diffPurchase(oldPlan?.purchase, result.purchase)
  const remnants = diffRemnants(oldPlan, newPlan)
  const metrics = {
    consumedDeltaMm: newPlan.consumedMm - (oldPlan?.consumedMm ?? 0),
    wasteDeltaMm: newPlan.wasteMm - (oldPlan?.wasteMm ?? 0),
    remnantDeltaMm: newPlan.usableRemnantMm - (oldPlan?.usableRemnantMm ?? 0),
    laborDeltaMin: newPlan.labor.total - (oldPlan?.laborTotal ?? 0),
    usedStickDelta: newPlan.usedStickCount - (oldPlan?.sticks.length ?? 0)
  }
  const routeChanged = !!oldPlan && oldPlan.route !== result.selected
  return {
    hasOld: !!oldPlan,
    oldPlanNo: oldPlan?.planNo,
    oldCalcNo: oldPlan?.calcNo,
    newCalcNo: result.calcNo,
    routeChanged,
    oldRoute: oldPlan?.route,
    newRoute: result.selected,
    pieces,
    purchase,
    remnants,
    metrics,
    anyChange: pieces.length > 0 || purchase.length > 0 || remnants.length > 0 || Object.values(metrics).some((v) => v !== 0)
  }
}
