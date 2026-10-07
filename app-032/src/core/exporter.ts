/** 导出：构件清单 / 裁片清单 / 备料单（CSV，本地生成，无外部请求） */
import type { FrameMember, Lantern, Panel } from './types'
import type { BatchMaterials, SingleLightMaterials } from './materials'
import { coveringSpec } from './craft'
import {
  checkConsistency,
  componentRows,
  formatM,
  materialSummary,
  mergedComponentRows,
  retainedOffcuts,
  STRATEGIES,
  strategyConcession,
  type CutPlan
} from './cutting'

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: (string | number)[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function membersCsv(l: Lantern, members: FrameMember[]): string {
  const rows: (string | number)[][] = [
    [`花灯构件清单 · ${l.name}`],
    [`最大直径 ${l.maxDiameterMm}mm / 总高 ${l.totalHeightMm}mm / 绑扎余量 每端 ${l.lashAllowanceMm}mm / 生成 ${new Date().toLocaleString()}`],
    [],
    ['构件名称', '类别', '分组', '净长(mm)', '截取长度(mm,含余量)', '余量处数', '数量', '总截取长度(mm)', '弯曲半径(mm)', '折角(°)', '备注']
  ]
  for (const m of members) {
    rows.push([
      m.label,
      kindName(m.kind),
      m.group,
      m.rawLengthMm.toFixed(1),
      m.lengthMm.toFixed(1),
      m.lashJoints,
      m.qty,
      (m.lengthMm * m.qty).toFixed(1),
      m.bendRadiusMm ? m.bendRadiusMm.toFixed(1) : '—',
      m.bendAngleDeg ? m.bendAngleDeg.toFixed(1) : '—',
      m.note || ''
    ])
  }
  const stock = members.reduce((s, m) => s + m.lengthMm * m.qty, 0)
  const raw = members.reduce((s, m) => s + m.rawLengthMm * m.qty, 0)
  rows.push([])
  rows.push(['合计', '', '', raw.toFixed(1), '', '', members.reduce((s, m) => s + m.qty, 0), stock.toFixed(1), '', '', `备料 ${(stock / 1000).toFixed(3)}m`])
  return toCsv(rows)
}

export function panelsCsv(l: Lantern, panels: Panel[]): string {
  const rows: (string | number)[][] = [
    [`蒙面裁片清单 · ${l.name}`],
    [`蒙面 ${coveringSpec(l.covering).name} / 缝份 每边 ${l.seamAllowanceMm}mm（已含在裁片尺寸内）/ 生成 ${new Date().toLocaleString()}`],
    [],
    ['裁片编号', '名称', '形状', '净上宽(mm)', '净下宽(mm)', '净高(mm)', '裁切上宽(mm)', '裁切下宽(mm)', '裁切高(mm)', '半径/对边(mm)', '数量', '对位标记数']
  ]
  for (const p of panels) {
    rows.push([
      p.id,
      p.label,
      shapeName(p.shape),
      p.rawWidthTopMm.toFixed(1),
      p.rawWidthBottomMm.toFixed(1),
      p.rawHeightMm.toFixed(1),
      p.widthTopMm.toFixed(1),
      p.widthBottomMm.toFixed(1),
      p.heightMm.toFixed(1),
      p.radiusMm ? p.radiusMm.toFixed(1) : '—',
      p.qty,
      p.marksMm.length
    ])
  }
  return toCsv(rows)
}

export function materialsCsv(
  l: Lantern,
  single: SingleLightMaterials,
  batch: BatchMaterials
): string {
  const cov = coveringSpec(l.covering)
  const rows: (string | number)[][] = [
    [`备料单 · ${l.name}`],
    [`生成 ${new Date().toLocaleString()} / 单位 mm·m²·m·g`],
    [],
    ['项目', '单灯用量', '单位', `批量 ${batch.count} 个（含 ${(batch.wasteRatio * 100).toFixed(0)}% 损耗）`],
    ['竹篾/铁丝（含绑扎余量）', single.frameM.toFixed(3), 'm', batch.frameM.toFixed(3)],
    ['竹篾构件净长', single.frameRawM.toFixed(3), 'm', batch.frameRawM.toFixed(3)],
    [`蒙面（${cov.name}，含缝份）`, single.coveringM2.toFixed(3), 'm²', batch.coveringM2.toFixed(3)],
    ['蒙面净面积（不含缝份）', single.coveringNetM2.toFixed(3), 'm²', batch.coveringNetM2.toFixed(3)],
    ['扎线', single.lashM.toFixed(3), 'm', batch.lashM.toFixed(3)],
    ['胶', single.glueG.toFixed(1), 'g', batch.glueG.toFixed(1)],
    ['LED 灯珠建议', single.ledCount, '颗', batch.ledCount],
    [],
    ['灯体体积', single.volumeL.toFixed(3), 'L', batch.volumeL.toFixed(3)],
    ['灯体表面积', single.surfaceM2.toFixed(3), 'm²', batch.surfaceM2.toFixed(3)]
  ]
  return toCsv(rows)
}

export function kindName(k: FrameMember['kind']): string {
  const map: Record<FrameMember['kind'], string> = {
    vertical: '竖篾',
    ring: '横篾',
    mouth_ring: '收口圈',
    base_ring: '底盘圈',
    rib: '母线篾',
    spoke: '辐条/中轴'
  }
  return map[k]
}

export function shapeName(s: Panel['shape']): string {
  const map: Record<Panel['shape'], string> = {
    trapezoid: '梯形',
    rectangle: '矩形',
    sector: '扇形',
    circle: '圆形/正多边形',
    triangle: '三角形'
  }
  return map[s]
}

// ---------------------------------------------------------------- 配切下料三份清单
// 三处导出全部从同一个 CutPlan 对象取数（同源），导出前先跑守恒检查。

function planStamp(plan: CutPlan): (string | number)[][] {
  return [
    [`计划号 ${plan.id} / 路线 ${STRATEGIES[plan.strategy].name} / 生成 ${new Date(plan.generatedAt).toLocaleString()}`],
    ['单位：长度整数毫米(mm)（净长保留1位小数），备料总量折米(m,3位小数)；每段下料长=(净长+绑扎余量)按mm向上取整，残料判定只用取整后长度']
  ]
}

/** 清单一：骨架构件配切表（每段一行：取自哪根篾、第几段、剩余） */
export function cuttingComponentsCsv(plan: CutPlan): string {
  const rows: (string | number)[][] = [
    ['骨架构件配切表（按现有竹篾配切下料）'],
    ...planStamp(plan),
    [],
    ['行号', '灯种', '构件名称', '分组', '净长(mm)', '绑扎余量合计(mm)', '截取长度(mm,向上取整)', '取自料号', '同料号第几根', '本根第几段', '本根剩余(mm)', '残料处理', '留用料号']
  ]
  for (const r of componentRows(plan)) {
    rows.push([
      r.rowNo,
      r.lanternName,
      r.label,
      r.group,
      r.netMm.toFixed(1),
      r.allowanceMm,
      r.cutMm,
      r.stockCode,
      r.instanceNo,
      r.segNo,
      r.residualMm,
      r.reusable ? '留用下次' : '废料（接不上别的件）',
      r.offcutCode || '—'
    ])
  }
  const compSum = componentRows(plan).reduce((s, r) => s + r.cutMm, 0)
  rows.push([])
  rows.push([
    '合计', '', '', '', '', '', compSum, '', '', '', '', `本批用掉竹篾 ${formatM(compSum)}m（应与材料页一致，差1mm即可查出）`
  ])
  const checks = checkConsistency(plan).filter((c) => !c.pass)
  rows.push(checks.length ? ['守恒检查', '未通过：' + checks.map((c) => c.id).join('、')] : ['守恒检查', '通过：构件表/材料页/存档三处同源一致'])
  return toCsv(rows)
}

/** 清单一（合并视图）：同一种件合并计数，来源料号/段号列全 */
export function cuttingMergedCsv(plan: CutPlan): string {
  const rows: (string | number)[][] = [
    ['骨架构件配切表 · 同件合并计数'],
    ...planStamp(plan),
    [],
    ['灯种', '构件名称', '分组', '净长(mm)', '余量合计(mm)', '截取长度(mm,取整)', '需求根数', '已配根数', '缺', '来源（料号#段号）']
  ]
  for (const r of mergedComponentRows(plan)) {
    rows.push([
      r.lanternName,
      r.label,
      r.group,
      r.netMm.toFixed(1),
      r.allowanceMm,
      r.cutMm,
      r.needQty,
      r.haveQty,
      Math.max(0, r.needQty - r.haveQty),
      r.sources.map((s) => `${s.stockCode}(${s.instanceNo})#${s.segNo}`).join(' ')
    ])
  }
  return toCsv(rows)
}

/** 清单二：备料统计 / 材料页（还要再添几根、添多长；按同一份配切结果算） */
export function cuttingMaterialsCsv(plan: CutPlan): string {
  const mat = materialSummary(plan)
  const rows: (string | number)[][] = [
    ['备料统计与添料单 · 按现有库存配切'],
    ...planStamp(plan),
    [],
    ['料长规格(mm)', '库存根数', '动用根数', '用掉总长(mm)', '留用根数', '留用长度(mm)', '废料(mm)', '需添根数', '添料每根(mm)']
  ]
  for (const r of mat.rows) {
    rows.push([r.specMm, r.stockQty, r.usedStripQty, r.usedLengthMm, r.retainedQty, r.retainedMm, r.wasteMm, r.addQty, r.addQty > 0 ? r.addStripLenMm : '—'])
  }
  rows.push([])
  rows.push(['合计', '', '', mat.usedLengthMm, '', mat.retainedMm, mat.wasteMm, mat.addQty, mat.addLengthMm])
  rows.push([])
  rows.push(['本批用掉竹篾', `${formatM(mat.usedLengthMm)} m`, '', `动用原长 ${formatM(mat.consumedStockMm)}m`, '', `留用 ${formatM(mat.retainedMm)}m`, `废料 ${formatM(mat.wasteMm)}m`, `添 ${mat.addQty} 根`, `添料合计 ${formatM(mat.addLengthMm)}m`])
  if (plan.shortages.length) {
    rows.push([])
    rows.push(['缺料诊断'])
    rows.push(['灯种', '构件', '下料长(mm)', '需求', '已配', '缺', '原因', '建议添料'])
    for (const s of plan.shortages) {
      rows.push([
        s.lanternName,
        s.label,
        s.cutMm,
        s.needQty,
        s.haveQty,
        s.shortQty,
        s.reason === 'length' ? `长度不够（库内最长 ${s.maxStockMm}mm < 件长 ${s.cutMm}mm）` : '根数不够（长度够但配不齐）',
        `${s.buyQty} 根 × ${s.buyStripLenMm}mm`
      ])
    }
  }
  return toCsv(rows)
}

/** 清单三：本机灯样存档（留用余料、未动用整篾、计划版本与作废记录） */
export function cuttingArchiveCsv(plan: CutPlan, status: 'draft' | 'adopted' | 'superseded' | 'voided'): string {
  const retained = retainedOffcuts(plan)
  const rows: (string | number)[][] = [
    ['本机配切存档（灯样/余料留用台账）'],
    ...planStamp(plan),
    ['版本状态', status === 'adopted' ? '已采用（生效）' : status === 'draft' ? '试算草稿（未生效，不可据此下料/导出）' : '已作废（导出单与留用记录同时失效）'],
    [],
    ['【留用余料】料号', '来源料号', '剩余长度(mm)', '产生计划号'],
  ]
  for (const o of retained) rows.push([o.offcutCode, o.sourceStockCode, o.lengthMm, o.planId])
  rows.push([])
  rows.push(['【未动用整篾】料号', '料长(mm)', '根数', '说明'])
  for (const u of plan.untouched) rows.push([u.stockCode, u.lengthMm, u.qty, '原样留着下次再用'])
  rows.push([])
  rows.push(['【本批配出】灯种', '订盏数', '实配整盏数'])
  for (const b of plan.built) rows.push([b.lanternName, b.ordered, b.built])
  rows.push([])
  const c = strategyConcession(plan)
  rows.push(['让路代价', c.text])
  return toCsv(rows)
}

