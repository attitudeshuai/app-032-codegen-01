/**
 * 配切三份清单导出：构件表（逐段）/ 备料料架（库存与添料）/ 添料单。
 * 三份都从同一个 CommittedPlan 快照取数，抬头同方案号、同批次、同指纹——同源可核。
 */
import { toCsv, downloadText } from '../exporter'
import type { CommittedPlan, CutPlanResult } from './types'
import { reconcile, routeTradeoff } from './cutpack'

const routeName = (r: CommittedPlan['route']) => (r === 'long_first' ? '省料·先保长件' : '省时·短件凑齐')

function header(p: CommittedPlan, title: string): (string | number)[][] {
  return [
    [`${title} · 第 ${p.planNo} 版配切方案`],
    [
      `批次 CALC-${String(p.calcNo).padStart(3, '0')} / 路线 ${routeName(p.route)} / 指纹 ${p.fingerprint} / 提交 ${new Date(p.committedAt).toLocaleString()} / 单位：长度 mm（整毫米向上取整），汇总折 m（3 位小数）`
    ],
    []
  ]
}

/** ① 骨架构件表：每段一行，标出取自哪根篾、第几段；末尾逐篾对账 + 全批守恒 */
export function cutPiecesCsv(p: CommittedPlan): string {
  const rows: (string | number)[][] = header(p, '配切骨架构件表（逐段）')
  rows.push(['件号', '构件', '灯型', '净长(mm)', '余量合计(mm)', '取整前合计(mm)', '截取长(mm,向上取整)', '取自料号', '第几段', '段起点(mm)', '该篾截后残料(mm)', '残料判定'])
  const flat = p.sticks
    .flatMap((s) => s.segments.map((seg) => ({ s, seg })))
    .sort((a, b) => a.seg.pieceNo - b.seg.pieceNo)
  const kindText = (k: string) => (k === 'usable' ? '留用' : k === 'waste' ? '接不上件·废料' : '用尽')
  for (const { s, seg } of flat) {
    rows.push([
      seg.pieceNo,
      seg.label,
      seg.lanternName,
      seg.netMm.toFixed(1),
      seg.lashMm.toFixed(1),
      seg.grossRawMm.toFixed(1),
      seg.cutMm,
      s.stickId,
      seg.segment,
      seg.startMm,
      s.remainMm,
      kindText(s.remainKind)
    ])
  }
  const rec = reconcile(p.sticks)
  const segSum = flat.reduce((a, x) => a + x.seg.cutMm, 0)
  rows.push([])
  rows.push(['逐篾对账（差 1mm 也算出错）：本次 容量−段合计−残料；整根 原长−历史已用−本次段合计−残料'])
  rows.push(['料号', '原长(mm)', '历史已用(mm)', '本次容量(mm)', '本次段合计(mm)', '残料(mm)', '本次差(mm)', '整根差(mm)'])
  for (const s of p.sticks) {
    rows.push([
      s.stickId,
      s.stockMm.toFixed(1),
      s.priorUsedMm,
      s.capMm,
      s.usedMm,
      s.remainMm,
      s.capMm - s.usedMm - s.remainMm,
      s.stockCapMm - s.priorUsedMm - s.usedMm - s.remainMm
    ])
  }
  rows.push([])
  rows.push(['全批守恒', '段合计(mm)', segSum, '用掉总量(mm)', p.consumedMm, '差(mm)', segSum - p.consumedMm, rec.ok ? '对账通过' : '对账不平！'])
  rows.push(['', '留用余料(mm)', p.usableRemnantMm, '明确废料(mm)', p.wasteMm, '', '', ''])
  rows.push(['需求盏数', p.requestedLights, '能做盏数', p.feasibleLights, '动用篾(根)', p.sticks.length, '工时(工分)', p.laborTotal])
  return toCsv(rows)
}

/** ② 备料料架页：由 UI 传入全量库存行（含退回重登），+ 还要添几根/多长 */
export function cutSticksCsvFull(
  p: CommittedPlan,
  allSticks: { id: string; lengthMm: number; status: string; note?: string; originText: string; remnantText?: string }[]
): string {
  const rows: (string | number)[][] = header(p, '配切备料·料架清单')
  rows.push(['料号', '原长(mm)', '料架状态', '本版角色', '本版截用(mm)', '截后残料(mm)', '残料判定', '本版段数', '来源/备注'])
  const spById = new Map(p.sticks.map((s) => [s.stickId, s]))
  const statusText: Record<string, string> = { rack: '料架待用', cut: '已截', returned: '作废退回(旧料)', scrap: '报废' }
  const kindText = (k?: string) => (k === 'usable' ? '留用' : k === 'waste' ? '废料' : k === 'none' ? '用尽' : '—')
  for (const st of allSticks) {
    const sp = spById.get(st.id)
    rows.push([
      st.id,
      st.lengthMm.toFixed(1),
      statusText[st.status] ?? st.status,
      sp ? '截用' : p.unusedStickIds.includes(st.id) ? '整根留架' : '未涉及',
      sp?.usedMm ?? 0,
      sp?.remainMm ?? '',
      sp ? kindText(sp.remainKind) : '—',
      sp?.segments.length ?? 0,
      st.originText + (st.note ? `｜${st.note}` : '') + (st.remnantText ? `｜${st.remnantText}` : '')
    ])
  }
  const purchaseMm = p.purchase.reduce((a, l) => a + l.totalMm, 0)
  rows.push([])
  rows.push(['添料汇总（与添料单同源）'])
  rows.push(['添料规格(mm)', '根数', '合计(mm)', '合计(m)'])
  for (const l of p.purchase) rows.push([l.specMm, l.qty, l.totalMm, l.totalM.toFixed(3)])
  rows.push(['添料合计', '', purchaseMm, (purchaseMm / 1000).toFixed(3)])
  rows.push([])
  rows.push(['本版用掉(mm)', p.consumedMm, (p.consumedMm / 1000).toFixed(3) + ' m', '留用余料(mm)', p.usableRemnantMm, '废料(mm)', p.wasteMm])
  return toCsv(rows)
}

/** ③ 添料单：哪种长度不够 / 根数不够 + 同规格合并 */
export function cutPurchaseCsv(p: CommittedPlan): string {
  const rows: (string | number)[][] = header(p, '配切添料单')
  rows.push(['缺料诊断'])
  rows.push(['构件', '灯型', '截取长(mm)', '缺口类型', '还缺(根)', '库内最长可用(mm)', '说明'])
  for (const s of p.shortages) {
    rows.push([
      s.label,
      s.lanternName,
      s.cutMm,
      s.type === 'length' ? '长度不够' : '根数不够',
      s.shortQty,
      s.maxStockMm ?? '—',
      s.type === 'length' ? `库内最长 ${s.maxStockMm}mm，短于该件 ${s.cutMm}mm，添再短也没用` : `长度够，但料架根数不足`
    ])
  }
  rows.push([])
  rows.push(['添料合并（同规格计数；长度按 mm，总量折 m）'])
  rows.push(['添料规格(mm)', '根数', '合计(mm)', '合计(m)', '用途'])
  const totalMm = p.purchase.reduce((a, l) => a + l.totalMm, 0)
  for (const l of p.purchase) rows.push([l.specMm, l.qty, l.totalMm, l.totalM.toFixed(3), l.reason])
  rows.push(['合计', p.purchase.reduce((a, l) => a + l.qty, 0), totalMm, (totalMm / 1000).toFixed(3), ''])
  return toCsv(rows)
}

export function downloadCutCsv(p: CommittedPlan, kind: 'pieces' | 'sticks' | 'purchase', content: string): string {
  const stamp = `${p.planNo}-${p.calcNo}`
  const map = { pieces: `配切构件表-方案${stamp}`, sticks: `配切料架清单-方案${stamp}`, purchase: `配切添料单-方案${stamp}` } as const
  const filename = `${map[kind]}.csv`
  downloadText(filename, content)
  return filename
}

/** 工作态（未提交）预览 CSV：抬头打「工作态·未存档」，禁止作为正式清单 */
export function cutPreviewCsv(result: CutPlanResult, tradeoff: ReturnType<typeof routeTradeoff>): string {
  const plan = result.plans[result.selected]
  const rows: (string | number)[][] = [
    [`工作态配切预览 · CALC-${String(result.calcNo).padStart(3, '0')} · 未提交存档（非正式清单，导出无效）`],
    [`路线 ${routeName(result.selected)} / 生成 ${new Date(result.generatedAt).toLocaleString()}`],
    [tradeoff.text],
    [],
    ['件号', '构件', '灯型', '净长(mm)', '截取长(mm)', '料号', '第几段', '残料(mm)', '残料判定']
  ]
  const flat = plan.sticks
    .flatMap((s) => s.segments.map((seg) => ({ s, seg })))
    .sort((a, b) => a.seg.pieceNo - b.seg.pieceNo)
  for (const { s, seg } of flat) {
    rows.push([seg.pieceNo, seg.label, seg.lanternName, seg.netMm.toFixed(1), seg.cutMm, s.stickId, seg.segment, s.remainMm, s.remainKind])
  }
  return toCsv(rows)
}
