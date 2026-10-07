<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  cutState,
  loadCutStore,
  inboundSticks,
  removeRackStick,
  clearRack,
  addLanternLine,
  addManualLine,
  removeLine,
  addManualPiece,
  removeManualPiece,
  workingResult,
  activePlans,
  latestActivePlan,
  commitPlan,
  commitAfterRouteSwitch,
  voidPlan,
  recordExport
} from '../core/cut/store'
import { state as lanternState } from '../core/store'
import { reconcile, routeTradeoff, toMeters } from '../core/cut/cutpack'
import { diffPlan, type PlanDiff } from '../core/cut/diff'
import { cutPiecesCsv, cutSticksCsvFull, cutPurchaseCsv, downloadCutCsv, cutPreviewCsv } from '../core/cut/exporter'
import { downloadText } from '../core/exporter'
import type { CutRoute, StockStick } from '../core/cut/types'

loadCutStore()

// ---- 录入态 ----
const inboundLen = ref(900)
const inboundQty = ref(2)
const newLanternId = ref(lanternState.lanterns[0]?.id ?? '')
const newLanternCount = ref(2)
const newManualName = ref('散件订单')
const pieceDraft = ref<Record<string, { label: string; net: number; joints: number; count: number }>>({})
const showDiff = ref(true)

const result = computed(() => workingResult.value)
const selectedPlan = computed(() => result.value.plans[result.value.selected])
const tradeoff = computed(() => routeTradeoff(result.value))
const lastPlan = computed(() => latestActivePlan())
const diffView = computed<PlanDiff>(() => diffPlan(lastPlan.value ?? undefined, result.value))
const rec = computed(() => reconcile(selectedPlan.value.sticks))

function routeMeta(r: CutRoute) {
  return r === 'long_first'
    ? { name: '省料 · 先保长件', desc: '件从长到短下锯；开新料先吃最短装得下的篾，长篾尽量留架。废料最少。' }
    : { name: '省时 · 短件凑齐', desc: '件从短到长、先摊最长几根料；动用篾根数与余料归架次数最少，上下料最省工。' }
}

function addInbound() {
  const n = inboundSticks(inboundLen.value, inboundQty.value)
  if (!n) alert('长度要大于 0、根数至少 1')
}

function addLineFromLantern() {
  if (!newLanternId.value) return
  addLanternLine(newLanternId.value, newLanternCount.value)
}

function addManual() {
  addManualLine(newManualName.value || '散件订单')
}

function draftFor(uid: string) {
  if (!pieceDraft.value[uid]) pieceDraft.value[uid] = { label: '竖篾', net: 300, joints: 2, count: 1 }
  return pieceDraft.value[uid]
}

function pushPiece(uid: string) {
  const d = draftFor(uid)
  addManualPiece(uid, { label: d.label, netMm: d.net, lashJoints: d.joints, count: d.count })
}

// ---- 料架当前表（含余料续截信息） ----
const rackView = computed(() => {
  // 活跃方案留用余料
  const remnants = new Map<string, { planNo: number; remain: number; totalSeg: number }>()
  for (const p of activePlans()) {
    for (const sp of p.sticks) {
      if (sp.remainKind === 'usable') remnants.set(sp.stickId, { planNo: p.planNo, remain: sp.remainMm, totalSeg: sp.segments.length })
    }
  }
  return cutState.sticks.map((s) => ({ s, remnant: remnants.get(s.id) }))
})

const rackLengthGroups = computed(() => {
  const map = new Map<number, number>()
  for (const s of cutState.sticks) {
    if (s.status === 'rack') {
      const cap = Math.floor(s.lengthMm + 1e-9)
      map.set(cap, (map.get(cap) ?? 0) + 1)
    }
  }
  // 余料续截也算待用料
  const usable = new Map<string, { remain: number }>()
  for (const p of activePlans()) for (const sp of p.sticks) if (sp.remainKind === 'usable') usable.set(sp.stickId, { remain: sp.remainMm })
  for (const [id, v] of usable) {
    const stick = cutState.sticks.find((x) => x.id === id)
    if (stick && stick.status === 'cut') map.set(v.remain, (map.get(v.remain) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0])
})

const statusText: Record<StockStick['status'], string> = {
  rack: '料架待用',
  cut: '已截',
  returned: '作废旧料',
  scrap: '报废'
}

function originText(s: StockStick): string {
  if (s.origin.type === 'inbound') return '入库'
  return `第${s.origin.planNo}版退回（原 ${s.origin.stickId} 第 ${s.origin.segment} 段）`
}

// ---- 提交 / 作废 / 导出 ----
const needsRouteSwitch = computed(() => !!lastPlan.value && lastPlan.value.route !== cutState.route)
const needsRecommit = computed(() => !lastPlan.value || lastPlan.value.calcNo !== cutState.calcNo)

function doCommit() {
  if (needsRouteSwitch.value) {
    const lp = lastPlan.value!
    if (!window.confirm(
      `要从「${routeMeta(lp.route).name}」改走「${routeMeta(cutState.route).name}」。\n` +
      `旧版（第 ${lp.planNo} 版）连同已导出的备料单、本机存档记录将一起作废；按旧版已截好的各段会退回料架以新料号重新登记，旧版余料留用记录同时失效。\n\n确认要换路线吗？`
    )) return
    const res = commitAfterRouteSwitch()
    showDiff.value = false
    alert(`已作废第 ${res.oldPlanNo} 版（退回重登 ${res.returned.length} 根），新路线方案记为第 ${res.planNo} 版。三份清单请按新版重新导出。`)
    return
  }
  const no = commitPlan()
  showDiff.value = false
  alert(`第 ${no} 版方案已记进本机存档：${routeMeta(cutState.route).name}。三份清单现可按此版导出。`)
}

function doVoidAndSwitch() {
  const lp = lastPlan.value
  if (!lp) {
    showDiff.value = true
    return
  }
  if (!window.confirm(`作废第 ${lp.planNo} 版并让已截段退回料架重登？导出记录与余料留用会一并失效。`)) return
  const reason = `第 ${lp.planNo} 版放弃重算（输入变动），已截段退回料架重登`
  const ids = voidPlan(lp.planNo, reason)
  showDiff.value = true
  alert(`第 ${lp.planNo} 版已作废：已导出清单标记失效、余料留用记录作废；已截段退回重登 ${ids.length} 根新料。确认方案后请重新提交。`)
}

function doExport(kind: 'pieces' | 'sticks' | 'purchase') {
  const p = lastPlan.value
  if (!p || p.status !== 'active') {
    alert('还没有生效的存档方案：请先在底部「确认配切方案」提交。工作态只可预览，不能作为正式清单。')
    return
  }
  // 存档必须与当前库存/订单一致：指纹之外，再要求工作结果与方案数据一致
  if (p.calcNo !== cutState.calcNo) {
    alert('输入已改动（盏数/库存/路线），存档是旧批次。请重新确认提交后再导出。')
    return
  }
  const allSticks = cutState.sticks.map((s) => {
    const rem = rackView.value.find((r) => r.s.id === s.id)?.remnant
    return {
      id: s.id,
      lengthMm: s.lengthMm,
      status: s.status,
      note: s.note,
      originText: originText(s),
      remnantText: rem ? `活跃留用余料 ${rem.remain}mm（第 ${rem.planNo} 版）` : undefined
    }
  })
  const content = kind === 'pieces' ? cutPiecesCsv(p) : kind === 'sticks' ? cutSticksCsvFull(p, allSticks) : cutPurchaseCsv(p)
  const filename = downloadCutCsv(p, kind, content)
  recordExport(p.planNo, kind, filename, p.fingerprint)
}

function previewCsv() {
  downloadText(`工作态预览-CALC-${result.value.calcNo}.csv`, cutPreviewCsv(result.value, tradeoff.value))
}

function fmtM(mm: number): string {
  return toMeters(mm).toFixed(3)
}

// 按构件合并的配切视图（同一种件合并计数，同时列出每一件的料号段号）
const pieceRows = computed(() => {
  const plan = selectedPlan.value
  const srcByPiece = new Map<number, { stickId: string; segment: number; remain: number; kind: string }>()
  for (const sp of plan.sticks) for (const seg of sp.segments) srcByPiece.set(seg.pieceNo, { stickId: sp.stickId, segment: seg.segment, remain: sp.remainMm, kind: sp.remainKind })
  return result.value.groups.map((g) => ({
    group: g,
    rows: g.pieceNos.map((no) => ({ no, src: srcByPiece.get(no) }))
  }))
})

// 每个订单行的构件合并小表（从同一份 result.pieces 派生）
const lineMembers = computed(() => {
  const map = new Map<string, { key: string; label: string; qty: number; netMm: number; lashMm: number; cutMm: number }[]>()
  for (const line of cutState.lines) {
    const agg = new Map<string, { key: string; label: string; qty: number; netMm: number; lashMm: number; cutMm: number }>()
    for (const p of result.value.pieces) {
      if (p.lineUid !== line.uid) continue
      const a = agg.get(p.key) ?? { key: p.key, label: p.label, qty: 0, netMm: p.netMm, lashMm: p.lashMm, cutMm: p.cutMm }
      a.qty++
      agg.set(p.key, a)
    }
    map.set(line.uid, [...agg.values()].sort((a, b) => b.cutMm - a.cutMm))
  }
  return map
})

const routeCards = computed(() => {
  return (['long_first', 'short_first'] as CutRoute[]).map((r) => {
    const p = result.value.plans[r]
    return { route: r, ...routeMeta(r), plan: p }
  })
})
</script>

<template>
  <div class="cut-view">
    <section class="head">
      <div>
        <h2>配切下料作坊 · 按现有竹篾配切</h2>
        <p class="sub">
          录入库存长度与根数 → 填灯型盏数 → 每段按 <b>ceil(净长 + 两端绑扎余量)</b> 取整毫米配切，残料拿取整后的整数判能否接下一件。
          目标：废料最少、能做盏数最多。构件表、备料料架、本机存档三处同一份配切结果，同一根篾剩余长度三处一致。
        </p>
      </div>
      <div class="ops">
        <button @click="previewCsv">工作态预览 CSV（非正式）</button>
      </div>
    </section>

    <!-- 路线二选一 -->
    <section class="route-box">
      <h3>第一步：截长路线只能选一条</h3>
      <div class="routes">
        <label v-for="c in routeCards" :key="c.route" class="route" :class="{ on: cutState.route === c.route, disabled: cutState.route !== c.route }">
          <input type="radio" :value="c.route" v-model="cutState.route" />
          <div>
            <strong>{{ c.name }}</strong>
            <p>{{ c.desc }}</p>
            <div class="route-stat">
              废料 <b :class="c.plan.wasteMm === 0 ? 'good' : 'warn'">{{ c.plan.wasteMm }}mm</b> ·
              留用 {{ c.plan.usableRemnantMm }}mm（{{ c.plan.usableRemnantCount }} 根）·
              动用 {{ c.plan.usedStickCount }} 根 ·
              工时 {{ c.plan.labor.total }} 工分
            </div>
          </div>
        </label>
      </div>
      <p class="tradeoff">本批代价对比（被放弃的那条让出了什么）：<b>{{ tradeoff.text }}</b></p>
      <p v-if="diffView.routeChanged && lastPlan" class="route-warn">
        路线已与存档的第 {{ lastPlan.planNo }} 版不同：旧版方案连同已导出备料单、存档记录需一起作废，已截段退回料架重登（见底部）。
      </p>
    </section>

    <!-- 库存 -->
    <section class="card">
      <h3>第二步：库里现有竹篾（长度 × 根数）</h3>
      <div class="inbound">
        <label>长度(mm) <input type="number" min="1" step="0.1" v-model.number="inboundLen" /></label>
        <label>根数 <input type="number" min="1" step="1" v-model.number="inboundQty" /></label>
        <button class="primary" @click="addInbound">入库登记</button>
        <button @click="clearRack" class="ghost">清空待用整根</button>
        <label class="lash">散件绑扎余量 每端 <input type="number" min="0" step="0.5" v-model.number="cutState.lashAllowanceMm" /> mm（灯样行用灯样自身余量）</label>
      </div>
      <table class="grid">
        <thead>
          <tr><th>料号</th><th class="num">原长(mm)</th><th>状态</th><th>来源/备注</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rackView" :key="row.s.id">
            <td class="mono">{{ row.s.id }}</td>
            <td class="num mono">{{ row.s.lengthMm.toFixed(1) }}</td>
            <td>
              <span :class="['tag', row.s.status]">{{ statusText[row.s.status] }}</span>
              <span v-if="row.remnant" class="tag usable">第{{ row.remnant.planNo }}版留用余料 {{ row.remnant.remain }}mm（已截 {{ row.remnant.totalSeg }} 段）</span>
            </td>
            <td class="note">{{ originText(row.s) }}<template v-if="row.s.note">｜{{ row.s.note }}</template></td>
            <td><button v-if="row.s.status === 'rack'" class="mini" @click="removeRackStick(row.s.id)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <p class="hint">待用料按整 mm 合并：<span v-for="g in rackLengthGroups" :key="g[0]" class="chip">{{ g[0] }}mm × {{ g[1] }} 根</span><span v-if="!rackLengthGroups.length" class="warn">料架空</span></p>
    </section>

    <!-- 订单 -->
    <section class="card">
      <h3>第三步：这一单做哪几种灯、各几盏</h3>
      <div class="inbound">
        <select v-model="newLanternId">
          <option v-for="l in lanternState.lanterns" :key="l.id" :value="l.id">{{ l.name }}（{{ l.maxDiameterMm }}mm / {{ l.totalHeightMm }}mm）</option>
        </select>
        <label>盏数 <input type="number" min="1" step="1" v-model.number="newLanternCount" /></label>
        <button class="primary" @click="addLineFromLantern">加灯样行</button>
        <input v-model="newManualName" placeholder="散件订单名" style="width:120px" />
        <button @click="addManual">加散件行（手填构件）</button>
      </div>

      <div v-for="line in cutState.lines" :key="line.uid" class="order-line">
        <div class="line-head">
          <strong>{{ line.lanternName }}</strong>
          <label class="count">盏数 <input type="number" min="0" step="1" v-model.number="line.count" /></label>
          <button class="mini" @click="removeLine(line.uid)">删行</button>
        </div>
        <table v-if="line.lanternId" class="grid inner">
          <thead><tr><th>构件（来自本机灯样）</th><th class="num">本行件数(=每盏根数×盏数)</th><th class="num">净长(mm)</th><th class="num">余量合计(mm)</th><th class="num">截取长(mm,取整)</th></tr></thead>
          <tbody>
            <tr v-for="m in lineMembers.get(line.uid)" :key="m.key">
              <td>{{ m.label }}</td>
              <td class="num mono">{{ m.qty }}（{{ line.count }} 盏）</td>
              <td class="num mono">{{ m.netMm.toFixed(1) }}</td>
              <td class="num mono">{{ m.lashMm.toFixed(1) }}</td>
              <td class="num mono strong">{{ m.cutMm }}</td>
            </tr>
            <tr v-if="!(lineMembers.get(line.uid)?.length)"><td colspan="5" class="dim">该灯样已不在本机灯样库，请改用散件行。</td></tr>
          </tbody>
        </table>
        <div v-if="!line.lanternId" class="manual">
          <table class="grid inner">
            <thead><tr><th>构件名</th><th class="num">净长(mm)</th><th class="num">余量处数（端×1）</th><th class="num">每盏根数</th><th></th></tr></thead>
            <tbody>
              <tr v-for="mp in line.manualPieces" :key="mp.uid">
                <td>{{ mp.label }}</td>
                <td class="num mono">{{ mp.netMm.toFixed(1) }}</td>
                <td class="num mono">{{ mp.lashJoints }}（{{ mp.lashJoints * cutState.lashAllowanceMm }}mm）</td>
                <td class="num mono">{{ mp.count }}</td>
                <td><button class="mini" @click="removeManualPiece(line.uid, mp.uid)">删</button></td>
              </tr>
            </tbody>
          </table>
          <div class="inbound tight">
            <input v-model="draftFor(line.uid).label" placeholder="构件名" />
            <label>净长 <input type="number" min="0" step="0.1" v-model.number="draftFor(line.uid).net" /></label>
            <label>余量处数 <input type="number" min="0" step="1" v-model.number="draftFor(line.uid).joints" /></label>
            <label>根数 <input type="number" min="1" step="1" v-model.number="draftFor(line.uid).count" /></label>
            <button @click="pushPiece(line.uid)">加构件</button>
          </div>
          <p class="hint">每处余量 = 绑扎余量 {{ cutState.lashAllowanceMm }}mm（竖篾 2 处，圈接头 1 处），取整截取 = ceil(净长 + 处数 × {{ cutState.lashAllowanceMm }})</p>
        </div>
      </div>
      <p v-if="!cutState.lines.length" class="warn">还没有订单行</p>
    </section>

    <!-- 结果总览 -->
    <section class="card result">
      <h3>配切结果（CALC-{{ String(result.calcNo).padStart(3, '0') }}，输入一改整批复算）</h3>
      <div class="stats">
        <div class="stat"><span>订单 / 能做</span><b>{{ result.requestedLights }} / {{ result.feasibleLights }} 盏</b></div>
        <div class="stat"><span>构件件数（已配/总数）</span><b>{{ selectedPlan.satisfiedPieces }} / {{ result.pieces.length }}</b></div>
        <div class="stat"><span>需求截取合计</span><b>{{ result.demandMm }}mm ＝ {{ fmtM(result.demandMm) }}m</b></div>
        <div class="stat"><span>本批用掉（逐段合计）</span><b>{{ selectedPlan.consumedMm }}mm ＝ {{ fmtM(selectedPlan.consumedMm) }}m</b></div>
        <div class="stat"><span>留用余料</span><b>{{ selectedPlan.usableRemnantMm }}mm / {{ selectedPlan.usableRemnantCount }} 根</b></div>
        <div class="stat"><span>明确废料（接不上件）</span><b :class="selectedPlan.wasteMm ? 'warn' : 'good'">{{ selectedPlan.wasteMm }}mm</b></div>
        <div class="stat"><span>动用新篾 / 续截旧料 / 整根留架</span><b>{{ selectedPlan.usedStickCount }} / {{ selectedPlan.reusedRemnantCount }} / {{ selectedPlan.unusedStickCount }} 根</b></div>
        <div class="stat"><span>守恒对账</span><b :class="rec.ok ? 'good' : 'warn'">{{ rec.ok ? '逐篾差 0mm' : `差 ${rec.totalDiffMm}mm！` }}</b></div>
      </div>
      <p class="hint">单位：长度毫米（mm），每段净长+余量按 mm 向上取整；汇总折米（m）保留 3 位小数（精确到 1mm）。判残料一律取整后整数相比。</p>

      <!-- 缺料 -->
      <div v-if="selectedPlan.shortages.length" class="shortage">
        <h4>挑不出可行方案 —— 说清缺什么：</h4>
        <ul>
          <li v-for="s in selectedPlan.shortages" :key="s.pieceKey" :class="s.type">
            <b>{{ s.type === 'length' ? '【长度不够】' : '【根数不够】' }}</b>
            {{ s.label }}（{{ s.lanternName }}）需截取 {{ s.cutMm }}mm，缺 {{ s.shortQty }} 根；
            <template v-if="s.type === 'length'">料架最长仅 {{ s.maxStockMm }}mm，添再短的料也没用，要添 ≥ {{ s.cutMm }}mm 的篾。</template>
            <template v-else>料里有这么长的，但根数不够；添 {{ s.cutMm }}mm × {{ s.suggestQty }} 根即可。</template>
          </li>
        </ul>
      </div>
    </section>

    <!-- 构件表（逐件 + 合并） -->
    <section class="card">
      <h3>骨架构件表：同一种件合并计数，每件标清取自哪根篾、第几段</h3>
      <table class="grid">
        <thead>
          <tr><th>构件（合并）</th><th class="num">根数</th><th class="num">净长</th><th class="num">余量</th><th class="num">截取(取整)</th><th>每件来源（料号·段号·残料）</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in pieceRows" :key="row.group.key">
            <td>{{ row.group.label }}<div class="dim">{{ row.group.lanternName }}</div></td>
            <td class="num mono">{{ row.group.qty }}</td>
            <td class="num mono">{{ row.group.netMm.toFixed(1) }}</td>
            <td class="num mono">{{ row.group.lashMm.toFixed(1) }}</td>
            <td class="num mono strong">{{ row.group.cutMm }}</td>
            <td>
              <span v-for="x in row.rows" :key="x.no" class="seg-chip" :class="x.src ? '' : 'unmet'">
                #{{ x.no }}
                <template v-if="x.src">{{ x.src.stickId }}-第{{ x.src.segment }}段<em v-if="x.src.kind === 'usable'">留{{ x.src.remain }}</em><em v-else-if="x.src.kind === 'waste'" class="warn">废{{ x.src.remain }}</em></template>
                <template v-else class="warn">缺料</template>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 逐篾配切 -->
    <section class="card">
      <h3>逐根篾配切：截给哪些件、第几段、剩下那一截的去向</h3>
      <table class="grid">
        <thead>
          <tr><th>料号</th><th class="num">原长</th><th class="num">历史已用</th><th class="num">本次容量(整mm)</th><th>各段（件号→构件，截长）</th><th class="num">本次段合计</th><th class="num">残料</th><th>残料去向</th><th class="num">本次差</th><th class="num">整根差</th></tr>
        </thead>
        <tbody>
          <tr v-for="sp in selectedPlan.sticks" :key="sp.stickId">
            <td class="mono">{{ sp.stickId }}<div v-if="sp.isRemnantReuse" class="dim">续截（前段 {{ sp.baseSegment }} 段）</div></td>
            <td class="num mono">{{ sp.stockMm.toFixed(1) }}</td>
            <td class="num mono">{{ sp.priorUsedMm }}</td>
            <td class="num mono">{{ sp.capMm }}</td>
            <td>
              <div v-for="seg in sp.segments" :key="seg.segment" class="segline">
                第{{ seg.segment }}段({{ seg.startMm }}–{{ seg.startMm + seg.cutMm }}) → #{{ seg.pieceNo }} {{ seg.label }} <b class="mono">{{ seg.cutMm }}mm</b>
              </div>
            </td>
            <td class="num mono">{{ sp.usedMm }}</td>
            <td class="num mono" :class="sp.remainKind === 'waste' ? 'warn' : sp.remainKind === 'usable' ? 'good' : ''">{{ sp.remainMm }}</td>
            <td>
              <span v-if="sp.remainKind === 'usable'" class="tag usable">留用下次（≥最短件 {{ result.minCutMm }}mm）</span>
              <span v-else-if="sp.remainKind === 'waste'" class="tag waste">剩 {{ sp.remainMm }}mm 接不上任何件（最短件 {{ result.minCutMm }}mm），明确废料</span>
              <span v-else class="tag none">用尽</span>
            </td>
            <td class="num mono" :class="sp.capMm - sp.usedMm - sp.remainMm === 0 ? 'good' : 'warn'">{{ sp.capMm - sp.usedMm - sp.remainMm }}</td>
            <td class="num mono" :class="sp.stockCapMm - sp.priorUsedMm - sp.usedMm - sp.remainMm === 0 ? 'good' : 'warn'">{{ sp.stockCapMm - sp.priorUsedMm - sp.usedMm - sp.remainMm }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">构件表逐行截取长合计 {{ selectedPlan.consumedMm }}mm，必须等于本批用掉总量 {{ selectedPlan.consumedMm }}mm；逐篾容量 − 段合计 − 残料全为 0（差 1mm 也看得出来）。</p>
    </section>

    <!-- 添料 -->
    <section v-if="result.purchase.length" class="card">
      <h3>材料页：还要再添几根、添多长（与备料统计、添料单同源）</h3>
      <table class="grid">
        <thead><tr><th class="num">添料规格(mm)</th><th class="num">根数</th><th class="num">合计(mm)</th><th class="num">合计(m)</th><th>为什么添</th></tr></thead>
        <tbody>
          <tr v-for="l in result.purchase" :key="l.specMm"><td class="num mono strong">{{ l.specMm }}</td><td class="num mono">{{ l.qty }}</td><td class="num mono">{{ l.totalMm }}</td><td class="num mono">{{ l.totalM.toFixed(3) }}</td><td class="note">{{ l.reason }}</td></tr>
        </tbody>
      </table>
    </section>

    <!-- 三处差异 -->
    <section v-if="diffView.hasOld" class="card">
      <h3 class="diff-head">
        <button class="mini" @click="showDiff = !showDiff">{{ showDiff ? '收起' : '展开' }}三处变动</button>
        相对存档第 {{ diffView.oldPlanNo }} 版（CALC-{{ String(diffView.oldCalcNo).padStart(3, '0') }}）→ 当前 CALC-{{ String(diffView.newCalcNo).padStart(3, '0') }}
        <span v-if="!diffView.anyChange" class="good">三处无数值变化</span>
      </h3>
      <div v-if="showDiff" class="diff-body">
        <div class="diff-col">
          <h4>① 构件表：来源段换了的件</h4>
          <p v-if="!diffView.pieces.length" class="dim">无</p>
          <ul>
            <li v-for="c in diffView.pieces" :key="c.kind + c.pieceNo" :class="c.kind"><span class="badge">{{ c.kind === 'source_changed' ? '换源' : c.kind === 'added' ? '新增' : '删除' }}</span>{{ c.text }}</li>
          </ul>
        </div>
        <div class="diff-col">
          <h4>② 材料页：添料规格/根数变化</h4>
          <p v-if="!diffView.purchase.length" class="dim">无</p>
          <ul><li v-for="c in diffView.purchase" :key="c.specMm" :class="c.kind"><span class="badge">{{ c.kind === 'added' ? '新增' : c.kind === 'removed' ? '取消' : '改量' }}</span>{{ c.text }}</li></ul>
          <p class="dim">用量：用掉 {{ diffView.metrics.consumedDeltaMm >= 0 ? '+' : '' }}{{ diffView.metrics.consumedDeltaMm }}mm ｜ 废料 {{ diffView.metrics.wasteDeltaMm >= 0 ? '+' : '' }}{{ diffView.metrics.wasteDeltaMm }}mm ｜ 留用 {{ diffView.metrics.remnantDeltaMm >= 0 ? '+' : '' }}{{ diffView.metrics.remnantDeltaMm }}mm ｜ 工时 {{ diffView.metrics.laborDeltaMin >= 0 ? '+' : '' }}{{ diffView.metrics.laborDeltaMin }} 工分</p>
        </div>
        <div class="diff-col">
          <h4>③ 存档：上次留用余料的变动</h4>
          <p v-if="!diffView.remnants.length" class="dim">无</p>
          <ul><li v-for="c in diffView.remnants" :key="c.stickId + c.kind" :class="c.kind"><span class="badge">{{ c.kind === 'released' ? '不再留用' : c.kind === 'consumed_more' ? '续截' : '新留用' }}</span>{{ c.text }}</li></ul>
        </div>
      </div>
    </section>

    <!-- 提交/作废 + 导出 -->
    <section class="card commit">
      <h3>存档与三份清单（同走一份配切结果）</h3>
      <div v-if="lastPlan" class="archive">
        <p>
          当前生效存档：<b>第 {{ lastPlan.planNo }} 版</b>（CALC-{{ String(lastPlan.calcNo).padStart(3, '0') }}，{{ routeMeta(lastPlan.route).name }}，
          指纹 <span class="mono">{{ lastPlan.fingerprint }}</span>，{{ new Date(lastPlan.committedAt).toLocaleString() }}）
          <span v-if="lastPlan.calcNo !== cutState.calcNo" class="tag waste">已落后于工作态 CALC-{{ String(cutState.calcNo).padStart(3, '0') }}</span>
          <span v-else class="tag usable">与当前一致</span>
        </p>
        <ul class="exports">
          <li v-for="e in lastPlan.exports" :key="e.kind + e.at">
            <span class="mono">{{ { pieces: '构件表', sticks: '备料料架', purchase: '添料单' }[e.kind] }}</span>
            {{ e.filename }} · {{ new Date(e.at).toLocaleString() }}
            <em v-if="lastPlan.status === 'voided'" class="warn">（随方案作废）</em>
          </li>
          <li v-if="!lastPlan.exports.length" class="dim">还没导出过</li>
        </ul>
      </div>
      <div v-else class="dim">尚无存档方案。</div>

      <div class="inbound">
        <button class="primary big" :disabled="!needsRecommit && !needsRouteSwitch" @click="doCommit">
          <template v-if="needsRouteSwitch">换路线并作废旧版、退回已截段后提交（{{ routeMeta(cutState.route).name }}）</template>
          <template v-else-if="needsRecommit">确认配切方案并记进本机存档（{{ routeMeta(cutState.route).name }}）</template>
          <template v-else>当前已是存档版本（{{ routeMeta(cutState.route).name }}）</template>
        </button>
        <button class="danger" v-if="lastPlan && needsRecommit && !needsRouteSwitch" @click="doVoidAndSwitch">
          放弃当前存档（清单+存档失效，已截段退回重登）
        </button>
      </div>
      <p v-if="needsRouteSwitch" class="route-warn">
        路线从「{{ routeMeta(lastPlan!.route).name }}」换成了「{{ routeMeta(cutState.route).name }}」：两条路只能选一条，
        点上面按钮会把旧版方案、已导出备料单、本机存档一起作废，按旧版已截好的段退回料架重新登记，旧版余料留用记录同时失效。
        代价对比见顶部：{{ tradeoff.text }}
      </p>
      <div class="inbound exports-btns">
        <button @click="doExport('pieces')">导出 ① 构件表 CSV</button>
        <button @click="doExport('sticks')">导出 ② 备料料架 CSV</button>
        <button @click="doExport('purchase')">导出 ③ 添料单 CSV</button>
        <span class="hint">三份清单抬头同方案号/批次/指纹；只认已提交存档，改了盏数或库存必须重新提交。</span>
      </div>
      <div v-if="cutState.storageError" class="warn">本地存储异常：{{ cutState.storageError }}</div>
    </section>
  </div>
</template>

<style scoped>
.cut-view { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h2 { margin: 0 0 6px; font-size: 18px; color: #8f1c19; border-left: 4px solid var(--red); padding-left: 10px; }
h3 { margin: 0 0 10px; font-size: 14px; color: #8f1c19; }
h4 { margin: 6px 0; font-size: 12.5px; }
.sub { margin: 0; font-size: 12.5px; color: var(--ink-soft); max-width: 980px; }
.card, .route-box { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; box-shadow: var(--shadow); }
.ops { display: flex; gap: 8px; }
button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--surface-2); padding: 6px 12px; font-size: 12.5px; }
button:hover { border-color: var(--red); color: var(--red); }
button.primary { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
button.primary:hover { background: #9c1f1b; color: #fff; }
button.primary:disabled { background: var(--line-strong); border-color: var(--line-strong); cursor: not-allowed; opacity: .7; }
button.danger { background: #fff; border-color: var(--red-soft); color: var(--red); font-weight: 600; }
button.ghost { background: transparent; }
button.mini { padding: 2px 8px; font-size: 11.5px; }
button.big { padding: 9px 18px; font-size: 13.5px; }
.inbound { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.inbound.tight { margin: 8px 0 4px; }
.inbound label, .line-head .count { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
input, select { font: inherit; padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; width: 90px; }
input[placeholder] { width: 110px; }
select { width: 260px; }
.routes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.route { display: flex; gap: 10px; border: 2px solid var(--line); border-radius: 10px; padding: 12px; cursor: pointer; }
.route.on { border-color: var(--red); background: #fdf3ef; }
.route strong { font-size: 13.5px; }
.route p { margin: 4px 0; font-size: 12px; color: var(--ink-soft); }
.route-stat { font-size: 12px; }
.tradeoff { margin: 10px 0 0; font-size: 12.5px; }
.route-warn { color: var(--red); font-size: 12.5px; margin: 6px 0 0; }
table.grid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.grid th { text-align: left; padding: 6px 10px; color: var(--ink-soft); font-weight: 500; font-size: 11.5px; border-bottom: 1px solid var(--line); }
table.grid td { padding: 6px 10px; border-bottom: 1px dashed var(--line); vertical-align: top; }
table.grid tr:last-child td { border-bottom: none; }
.num { text-align: right; }
.mono { font-family: var(--mono); }
.strong { font-weight: 700; color: #8f1c19; }
.note { color: var(--ink-soft); font-size: 12px; }
.dim { color: var(--ink-soft); font-size: 12px; }
.hint { font-size: 11.5px; color: var(--ink-soft); margin: 8px 0 0; }
.warn { color: var(--red); font-weight: 600; }
.good { color: var(--jade); font-weight: 600; }
.chip, .seg-chip { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 7px; border: 1px solid var(--line-strong); border-radius: 999px; font-size: 11.5px; background: var(--surface-2); font-family: var(--mono); }
.seg-chip em { font-style: normal; color: var(--jade); margin-left: 3px; }
.seg-chip.unmet { border-color: var(--red-soft); color: var(--red); }
.tag { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11.5px; margin-right: 6px; }
.tag.rack { background: #eef3ea; color: var(--jade); }
.tag.cut { background: #f3ece0; color: var(--gold); }
.tag.returned { background: #f6e4e2; color: var(--red); }
.tag.scrap { background: #eee; color: #777; }
.tag.usable { background: #e4f0eb; color: var(--jade); }
.tag.waste { background: #f8e3e1; color: var(--red); }
.tag.none { background: #eee; color: #777; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
.stat { background: #fff; padding: 8px 12px; display: flex; flex-direction: column; font-size: 11px; color: var(--ink-soft); }
.stat b { font-family: var(--mono); font-size: 13.5px; color: var(--ink); }
.order-line { border: 1px dashed var(--line-strong); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.line-head { display: flex; gap: 14px; align-items: center; margin-bottom: 8px; }
table.inner { background: #fffdf8; }
.shortage { border: 1px solid var(--red-soft); background: #fdf0ef; border-radius: 8px; padding: 8px 12px; }
.shortage ul { margin: 6px 0; padding-left: 20px; }
.shortage li.length { color: var(--red); }
.segline { font-size: 12px; padding: 1px 0; }
.diff-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.diff-body { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
.diff-col { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; background: #fffdf8; }
.diff-col ul { margin: 6px 0; padding-left: 0; list-style: none; }
.diff-col li { font-size: 11.8px; padding: 3px 0; border-bottom: 1px dotted var(--line); }
.badge { display: inline-block; min-width: 44px; text-align: center; background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: 4px; padding: 0 5px; margin-right: 6px; font-size: 10.5px; }
li.source_changed .badge, li.qty_changed .badge { background: #fbf0da; color: var(--gold); }
li.added .badge, li.new_retained .badge, li.consumed_more .badge { background: #e4f0eb; color: var(--jade); }
li.removed .badge, li.released .badge { background: #f8e3e1; color: var(--red); }
.archive { background: var(--surface-2); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.exports { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
.exports-btns { margin-top: 6px; }
.lash { margin-left: auto; color: var(--ink-soft); font-size: 12px; }
.lash input { width: 64px; }
</style>
