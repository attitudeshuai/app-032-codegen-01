/**
 * 配切下料域模型（按现有竹篾配切，使废料最少 / 能做盏数最多）
 *
 * 单位约定（全应用唯一口径）：
 * - 库存长度、净长、绑扎余量：mm（允许 1 位小数录入）
 * - 每段「截取长度」= ceil(净长 + 余量合计)，整数 mm；残料能否接下一件一律拿取整后的整数比，
 *   不许用未取整的小数比（规格难点，见 cutpack.ts）
 * - 汇总展示折米时 = 整数 mm / 1000，保留 3 位小数（精确到 1mm）
 */

/** 配切路线：省料（先保长件） / 省时（先把短件凑齐），二选一，不能并存 */
export type CutRoute = 'long_first' | 'short_first'

/** 库存竹篾在料架上的状态 */
export type StockStatus = 'rack' | 'cut' | 'returned' | 'scrap'

/** 料架上的一根竹篾（录入时按长度+根数批量登记，每根一条记录） */
export interface StockStick {
  /** 料号，全库唯一：M0001…；退回重登的切段使用新料号（RET-…） */
  id: string
  /** 原长（mm，录入可 1 位小数；判容量时按 ceil） */
  lengthMm: number
  /** 当前状态：料架待用 / 已截 / 作废后退回重登 / 报废 */
  status: StockStatus
  /** 来源：入库登记 / 某方案作废退回（记原方案号与原段号） */
  origin: { type: 'inbound'; at: string } | { type: 'returned'; planNo: number; stickId: string; segment: number; at: string }
  /** 被哪一版方案截用（status=cut 时有效） */
  planNo?: number
  /** 备注，如「余料留用」 */
  note?: string
}

/** 订单行：某灯样做几盏（灯样引用本机灯样库 id；也可只写名称做手工件） */
export interface OrderLine {
  /** 行 id（DOM/key 用，与构件身份无关） */
  uid: string
  /** 灯样 id（可空，表示手工填写的构件行） */
  lanternId?: string
  /** 灯型名称快照（灯样被删时仍认得出来） */
  lanternName: string
  /** 盏数 */
  count: number
  /** 手工构件行：lanternId 为空时生效（从灯样带出时留空数组） */
  manualPieces: ManualPiece[]
}

/** 手工构件（不走灯样库时直接填） */
export interface ManualPiece {
  uid: string
  label: string
  netMm: number
  /** 余量处数：每处 = 一个端头绑扎余量（竖篾 2，圈接头 1） */
  lashJoints: number
  count: number
}

/** 需求展开后的一件（每根待截的构件是一件） */
export interface PieceDemand {
  /** 所属订单行 uid（缺料摊到哪一种灯的盏数用） */
  lineUid: string
  /**
   * 构件身份键：同一构件行合并计数用。
   * 灯样件 = `${lanternId}#${memberId}`；手工件 = `manual#${uid}`。
   * 改盏数只复制已有身份、不换身份，diff 才能认出「同一构件的来源段换了」。
   */
  key: string
  /** 行内构件序号（member 在该灯样 buildFrame 输出里的固定序号；手工件按 uid 稳定排序） */
  memberSeq: number
  label: string
  lanternName: string
  /** 净长（mm，构件原数） */
  netMm: number
  /** 余量处数 × 每处余量（mm） */
  lashMm: number
  /** 取整前净长 + 余量合计（mm） */
  grossRawMm: number
  /** 截取长度（mm，向上取整，整数；判容量 / 备料只用它） */
  cutMm: number
  /** 该件在本批中的序号 1..N（构件表行号，身份无关） */
  pieceNo: number
}

/** 构件合并行（同一种件合并计数，对应「同一种件的长度要能合并计数」） */
export interface PieceGroup {
  key: string
  label: string
  lanternName: string
  netMm: number
  lashMm: number
  cutMm: number
  qty: number
  /** 该件需求在本批中的序号范围（第几~第几件） */
  pieceNos: number[]
}

/** 一根库存篾上截出的一段 */
export interface CutSegment {
  /** 是这根篾的第几段（从 1 起，构件表逐行要标出） */
  segment: number
  /** 在本根篾上的起点（mm，整数累计；0 起） */
  startMm: number
  /** 截给哪一件（全局件序号） */
  pieceNo: number
  pieceKey: string
  label: string
  lanternName: string
  /** 该段净长（mm） */
  netMm: number
  /** 该段余量合计（mm） */
  lashMm: number
  /** 取整前合计（mm，净长 + 余量） */
  grossRawMm: number
  /** 该段截取长度（mm，整数取整） */
  cutMm: number
}

/** 一根库存篾的配切结果 */
export interface StickPlan {
  stickId: string
  /** 原长（mm，录入值） */
  stockMm: number
  /** 原长容量（整 mm，= floor(stockMm)） */
  stockCapMm: number
  /** 本次开截时可用容量（整 mm；整根=stockCap，余料续截=上次残料） */
  capMm: number
  /** 本次开截前已用长度（整 mm；整根=0，续截>0） */
  priorUsedMm: number
  /** 本次第一段在整根篾上的绝对起点（整 mm） */
  startOffsetMm: number
  /** 段号接续基数（本次第一段号 = baseSegment + 1） */
  baseSegment: number
  /** 续截标记：该篾是上版方案留用余料再开截 */
  isRemnantReuse: boolean
  segments: CutSegment[]
  /** 本次截用整 mm 合计 */
  usedMm: number
  /** 截后残料（整 mm）= cap - used（整根篾的当前剩余，三处同源都是它） */
  remainMm: number
  /** 残料判定：none(用尽) / usable(留用，还能接本批最短件) / waste(明确报废，接不上任何件)；未截的整根不在这里 */
  remainKind: 'none' | 'usable' | 'waste'
}

/** 缺料诊断 */
export interface Shortage {
  /** length: 哪种长度不够（任何库存篾都短于该截取长）；count: 根数/总量不够 */
  type: 'length' | 'count'
  pieceKey: string
  label: string
  lanternName: string
  cutMm: number
  /** 该件还缺几根 */
  shortQty: number
  /** 库存最长一根（mm，取整）——length 型诊断用 */
  maxStockMm?: number
  /** 建议添料：几根 × 多长（mm，按该件截取长取整） */
  suggestLengthMm: number
  suggestQty: number
}

/** 添料建议（材料页 / 备料单同源派生） */
export interface PurchaseLine {
  specMm: number
  qty: number
  totalMm: number
  totalM: number
  reason: string
}

/** 工时口径（省时路线对比用，单位「工分」= 1/60 工时） */
export interface LaborCost {
  /** 动用篾根数 × 每根搬运分 */
  handle: number
  /** 锯截次数（段数）× 每锯分 */
  saw: number
  /** 余料归架根数 × 每根分 */
  remnant: number
  total: number
}

/** 一条路线的完整方案（省料 / 省时各算一份） */
export interface RoutePlan {
  route: CutRoute
  sticks: StickPlan[]
  /** 已排入的件（件序号集合） */
  placedPieceNos: number[]
  /** 未满足件（按合并构件分组） */
  unmet: PieceGroup[]
  /** 未满足件（逐件，含 lineUid，算各行可成盏数用） */
  unmetPieces: PieceDemand[]
  shortages: Shortage[]
  purchase: PurchaseLine[]
  /** 动用库存根数（不含只续截的旧篾的新开计数） */
  usedStickCount: number
  /** 续截动用的旧留用余料根数 */
  reusedRemnantCount: number
  /** 未动用（整根留架）根数 */
  unusedStickCount: number
  /** 用掉整 mm（= 各段 cutMm 之和；构件表逐行合计必须等于它，差 1mm 也可见） */
  consumedMm: number
  /** 明确废料 mm（接不上任何件的残料） */
  wasteMm: number
  /** 留用余料 mm 与根数（还能接本批最短件） */
  usableRemnantMm: number
  usableRemnantCount: number
  /** 截口数（段数） */
  cuts: number
  labor: LaborCost
  /** 需求总件数 / 已满足件数 / 已满足盏数信息 */
  totalPieces: number
  satisfiedPieces: number
  fullyFeasible: boolean
}

/** 方案整体结果（含两条路线、选中路线与添料建议） */
export interface CutPlanResult {
  /** 重算批次号（每次输入变更 +1，工作态方案不入库也带号，供导出标注） */
  calcNo: number
  lashAllowanceMm: number
  minCutMm: number
  pieces: PieceDemand[]
  groups: PieceGroup[]
  /** 全订单应做盏数（行计） */
  requestedLights: number
  /** 能做的盏数（按行计，受最短缺件约束的可完成盏数） */
  feasibleLights: number
  feasible: boolean
  plans: Record<CutRoute, RoutePlan>
  selected: CutRoute
  /** 添料建议（只在有缺口时生成；同一规格合并） */
  purchase: PurchaseLine[]
  /** 需求合计截取长（mm，整数）/ 折米 */
  demandMm: number
  demandM: number
  generatedAt: string
}

/** 已提交（记进本机存档）的一版配切方案 */
export interface CommittedPlan {
  planNo: number
  calcNo: number
  route: CutRoute
  committedAt: string
  lashAllowanceMm: number
  /** 订单快照（灯样 id + 名称 + 盏数 + 手工件） */
  orderLines: OrderLine[]
  requestedLights: number
  feasibleLights: number
  /** 配切结果快照（选中路线） */
  sticks: StickPlan[]
  unmet: PieceGroup[]
  shortages: Shortage[]
  purchase: PurchaseLine[]
  consumedMm: number
  wasteMm: number
  usableRemnantMm: number
  laborTotal: number
  /** 被本版截用的库存料号（status 已置 cut） */
  consumedStickIds: string[]
  /** 留用余料料号（parent 仍为 cut 状态、余料挂在其上） */
  usableStickIds: string[]
  /** 整根留架料号 */
  unusedStickIds: string[]
  /** 已导出清单记录（哪份文件、何时、方案内容指纹；作废时随方案一起标记作废） */
  exports: ExportRecord[]
  status: 'active' | 'voided' | 'superseded'
  voidedAt?: string
  voidReason?: string
  /** 作废时退回料架的新料号（已截段重登）；superseded 时不退回（物理执行保留） */
  returnedStickIds?: string[]
  supersededBy?: number
  /** 方案内容指纹（三处同源校验与重复导出识别用） */
  fingerprint: string
}

/** 导出记录（三份清单同源、随方案作废） */
export interface ExportRecord {
  kind: 'pieces' | 'sticks' | 'purchase'
  filename: string
  at: string
  fingerprint: string
}
