<script setup lang="ts">
import { computed, ref } from 'vue'
import { state as lanternStore } from '../core/store'
import { buildFrame } from '../core/frame'
import {
  checkConsistency,
  componentRows,
  formatLabor,
  formatM,
  materialSummary,
  mergedComponentRows,
  retainedOffcuts,
  STRATEGIES,
  strategyConcession,
  type CutPlan,
  type CutStrategyId,
  type LanternSpec
} from '../core/cutting'
import {
  addStockMerged,
  adopt,
  currentAdopted,
  cuttingState,
  loadCuttingStore,
  recalc,
  removeStock,
  setOrder,
  updateStock,
  voidAdopted
} from '../core/cuttingStore'
import {
  cuttingArchiveCsv,
  cuttingComponentsCsv,
  cuttingMaterialsCsv,
  cuttingMergedCsv,
  downloadText
} from '../core/exporter'

loadCuttingStore()

// --------------------------------------------------------------- 输入
const newLen = ref<number>(1500)
const newQty = ref<number>(1)
const newNote = ref<string>('')
const tab = ref<'components' | 'materials' | 'archive'>('components')

function addStockRow() {
  if (!newLen.value || newLen.value <= 0) return
  addStockMerged(newLen.value, newQty.value || 1, newNote.value.trim())
  newNote.value = ''
}

function orderQty(lanternId: string): number {
  return cuttingState.orders.find((o) => o.lanternId === lanternId)?.qty ?? 0
}
function onOrder(lanternId: string, name: string, qty: number) {
  setOrder(lanternId, name, qty)
}

// --------------------------------------------------------------- 灯样规格（构件展开）
const specs = computed<Map<string, LanternSpec>>(() => {
  const m = new Map<string, LanternSpec>()
  for (const l of lanternStore.lanterns) {
    m.set(l.id, { lantern: l, members: buildFrame(l).members })
  }
  return m
})

// --------------------------------------------------------------- 计划
const adoptedVersion = computed(() => currentAdopted())
const adoptedPlan = computed<CutPlan | null>(() => adoptedVersion.value?.plan ?? null)
const draftVersion = computed(() => cuttingState.versions.find((v) => v.status === 'draft'))
const draftPlan = computed<CutPlan | null>(() => draftVersion.value?.plan ?? null)
/** 页面展示的计划：优先试算草稿，否则采用版 */
const shownPlan = computed<CutPlan | null>(() => draftPlan.value ?? adoptedPlan.value)

/** 输入相对已采用计划是否已变（改盏数/换库存后需整批重算） */
const dirty = computed(() => {
  const p = adoptedPlan.value
  if (!p) return cuttingState.orders.length > 0 || cuttingState.stock.length > 0
  if (p.strategy !== cuttingState.strategy) return true
  const os = [...cuttingState.orders].sort((a, b) => a.lanternId.localeCompare(b.lanternId))
  const po = [...p.input.orders].sort((a, b) => a.lanternId.localeCompare(b.lanternId))
  if (os.length !== po.length || os.some((o, i) => o.lanternId !== po[i].lanternId || o.qty !== po[i].qty)) return true
  const ss = [...cuttingState.stock].sort((a, b) => a.code.localeCompare(b.code))
  const ps = [...p.input.stock].sort((a, b) => a.code.localeCompare(b.code))
  if (ss.length !== ps.length || ss.some((s, i) => s.code !== ps[i].code || s.lengthMm !== ps[i].lengthMm || s.qty !== ps[i].qty)) return true
  return cuttingState.minOffcutMm !== p.input.minOffcutMm
})

function doRecalc(reason: string) {
  if (cuttingState.orders.length === 0) {
    window.alert('先在订单里填至少一种灯的盏数。')
    return
  }
  recalc(specs.value, reason)
  tab.value = 'components'
}

function doRecompute() {
  doRecalc(adoptedPlan.value ? '改盏数/换库存后整批重算' : '首次整批配切')
}

function pickStrategy(s: CutStrategyId) {
  if (s === cuttingState.strategy) return
  // 仅改试算：旧采用版在「采用新路」时才真正作废；此处先试算（草稿）
  recalc(specs.value, '切换配切路线试算', s)
}

function adoptDraft() {
  const v = draftVersion.value
  if (!v) return
  const prev = adoptedVersion.value
  const switched = !!prev && prev.plan.strategy !== v.plan.strategy
  // adopt 内部：同路线重算→旧版标「已替代」；换路线→旧版作废、截段退回、旧留用失效
  const restored = adopt(v)
  if (switched) {
    window.alert(
      `已按「${STRATEGIES[v.plan.strategy].name}」重新采用。\n` +
        `旧版作废：${restored.length} 批已截段/旧余料已退回料架重新登记（见库存 R*/U* 料号），旧版余料留用记录与已导出备料单同时失效。`
    )
  }
}

function voidCurrent() {
  if (!adoptedVersion.value) return
  if (!window.confirm('确定作废当前采用的配切方案？已截好的段退回料架重新登记，旧版余料留用记录失效，导出的备料单一并作废。')) return
  const restored = voidAdopted('手工作废：方案/备料单/存档一起作废重来')
  window.alert(`已作废，${restored.length} 批料已退回料架重新登记（R*/U* 料号）。`)
}

// --------------------------------------------------------------- 同源取数
const compRows = computed(() => (shownPlan.value ? componentRows(shownPlan.value) : []))
const mergedRows = computed(() => (shownPlan.value ? mergedComponentRows(shownPlan.value) : []))
const mat = computed(() => (shownPlan.value ? materialSummary(shownPlan.value) : null))
const retained = computed(() => (shownPlan.value ? retainedOffcuts(shownPlan.value) : []))
const checks = computed(() => (shownPlan.value ? checkConsistency(shownPlan.value) : []))
const concession = computed(() => (shownPlan.value ? strategyConcession(shownPlan.value) : null))
const diff = computed(() => draftVersion.value?.diffFromAdopted ?? null)

function exportComponents() {
  const p = adoptedPlan.value
  if (!p) return
  downloadText(`配切-构件表-${p.id}.csv`, cuttingComponentsCsv(p))
}
function exportMerged() {
  const p = adoptedPlan.value
  if (!p) return
  downloadText(`配切-构件合并表-${p.id}.csv`, cuttingMergedCsv(p))
}
function exportMaterials() {
  const p = adoptedPlan.value
  if (!p) return
  downloadText(`配切-备料添料单-${p.id}.csv`, cuttingMaterialsCsv(p))
}
function exportArchive() {
  const v = adoptedVersion.value
  if (!v) return
  downloadText(`配切-本机存档-${v.plan.id}.csv`, cuttingArchiveCsv(v.plan, v.status))
}

function stockTotalM(): string {
  return formatM(cuttingState.stock.reduce((s, x) => s + x.lengthMm * x.qty, 0))
}
function statusLabel(s: string): string {
  return { draft: '试算草稿', adopted: '已采用', superseded: '已被重算替代', voided: '已作废' }[s] || s
}
function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}
</script>

<template>
  <div class="cutting">
    <section class="head">
      <div>
        <h2>竹篾配切下料 · 按现有库存配到每一盏灯</h2>
        <p class="sub">
          录入库里现有的竹篾（长度整数毫米、根数）与要做灯的盏数，系统定出<b>每根篾截给哪些件、第几段、剩多少</b>，
          使废料最少 / 能做的盏数最多。每段下料长 =（净长 + 两端绑扎余量）<b>按毫米向上取整</b>，
          残料能不能接下一件只拿取整后的整数长度判；备料总量折米（3 位小数）。
        </p>
      </div>
      <div class="ops">
        <button :disabled="!adoptedPlan" @click="exportComponents">导出构件表 CSV</button>
        <button :disabled="!adoptedPlan" @click="exportMaterials">导出备料/添料单 CSV</button>
        <button :disabled="!adoptedPlan" @click="exportArchive">导出台账存档 CSV</button>
      </div>
    </section>

    <p v-if="!adoptedPlan" class="banner warn">
      当前没有「已采用」的配切方案：三份导出与本机存档均不可用。填好库存与订单 → 整批重算 → 核对后点「采用此方案」。
    </p>
    <p v-else-if="draftVersion" class="banner warn">
      已按最新输入整批重算（试算草稿，计划 {{ draftVersion.plan.id }}）：核对无误后点「④ 采用当前试算方案」，
      三份导出与存档才会切换到新方案；未采用前，导出/存档仍以旧采用版 {{ adoptedPlan.id }} 为准。
    </p>
    <p v-else-if="dirty" class="banner warn">
      盏数或库存已改动：现采用版（{{ adoptedPlan.id }}）已过期，需要<b>整批重算</b>；重算后三处清单按新方案走，旧方案留痕为「已替代」。
    </p>
    <p v-else class="banner ok">现采用方案 {{ adoptedPlan.id }}（{{ STRATEGIES[adoptedPlan.strategy].name }}）生效中：构件表、备料单、存档三处同源。</p>

    <div class="grid-top">
      <!-- 库存 -->
      <section class="panel">
        <h3>① 库存竹篈 <em>长度 mm（向上取整）· 同长自动合并根数 · 合计 {{ stockTotalM() }}m</em></h3>
        <table class="stock">
          <thead>
            <tr><th>料号</th><th class="num">长度 (mm)</th><th class="num">根数</th><th>备注</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in cuttingState.stock" :key="s.code">
              <td class="mono">{{ s.code }}</td>
              <td class="num"><input class="w80 num" type="number" min="1" step="1" :value="s.lengthMm" @change="updateStock(i, { lengthMm: Number(($event.target as HTMLInputElement).value) })" /></td>
              <td class="num"><input class="w60 num" type="number" min="1" step="1" :value="s.qty" @change="updateStock(i, { qty: Number(($event.target as HTMLInputElement).value) })" /></td>
              <td><input class="note-in" :value="s.note || ''" @change="updateStock(i, { note: ($event.target as HTMLInputElement).value })" placeholder="竹种/批次" /></td>
              <td><button class="del" @click="removeStock(i)">删</button></td>
            </tr>
          </tbody>
        </table>
        <div class="addrow">
          <input class="w100 num" type="number" min="1" step="1" v-model.number="newLen" />
          <input class="w60 num" type="number" min="1" step="1" v-model.number="newQty" />
          <input class="note-in" v-model="newNote" placeholder="备注（可空）" />
          <button @click="addStockRow">录入（同长合并）</button>
        </div>
      </section>

      <!-- 订单 + 策略 -->
      <section class="panel">
        <h3>② 订单：几种灯各做几盏</h3>
        <table class="orders">
          <thead>
            <tr><th>灯样</th><th class="num">单灯构件种类</th><th class="num w80">盏数</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="l in lanternStore.lanterns" :key="l.id">
              <td>{{ l.name }} <em class="dim">{{ l.kind }}</em></td>
              <td class="num">{{ (specs.get(l.id)?.members.length) ?? 0 }}</td>
              <td class="num"><input class="w60 num" type="number" min="0" step="1" :value="orderQty(l.id)" @input="onOrder(l.id, l.name, Number(($event.target as HTMLInputElement).value) || 0)" /></td>
              <td><button v-if="orderQty(l.id) > 0" class="del" @click="onOrder(l.id, l.name, 0)">清</button></td>
            </tr>
          </tbody>
        </table>

        <h3 class="mt">③ 两条路只能选一条 <em>省料 vs 省时</em></h3>
        <div class="strategies">
          <label v-for="(meta, id) in STRATEGIES" :key="id" class="strategy" :class="{ on: cuttingState.strategy === id }">
            <input type="radio" name="strategy" :checked="cuttingState.strategy === id" @change="pickStrategy(id as CutStrategyId)" />
            <span><b>{{ meta.name }}</b><em>{{ meta.rule }}</em></span>
          </label>
        </div>
        <div class="recompute">
          <label class="minoff">残料短于
            <input class="w60 num" type="number" min="1" step="1" v-model.number="cuttingState.minOffcutMm" /> mm 即判废料
          </label>
          <button class="primary big" @click="doRecompute">整批重算</button>
        </div>
        <button v-if="draftVersion" class="adopt" @click="adoptDraft">④ 采用当前试算方案（三处清单以此为准）</button>
        <button v-if="adoptedVersion" class="void" @click="voidCurrent">作废当前采用方案（截段退回、旧留用失效）</button>
      </section>
    </div>

    <!-- 试算/采用 状态条 + 让路代价 -->
    <section v-if="shownPlan" class="metrics panel">
      <div class="mstate">
        <span :class="['tag', draftVersion ? 'tag-draft' : 'tag-adopted']">{{ draftVersion ? '以下为试算草稿（未采用，不可导出/存档生效）' : '以下为已采用方案' }}</span>
        <span class="dim">计划 {{ shownPlan.id }} · {{ new Date(shownPlan.generatedAt).toLocaleString() }}</span>
      </div>
      <div class="mgrid">
        <div><span>配出整盏</span><b>{{ shownPlan.metrics.builtLanterns }} 盏</b></div>
        <div><span>动用篾 / 刀数</span><b>{{ shownPlan.metrics.stripsUsed }} 根 / {{ shownPlan.metrics.cuts }} 刀</b></div>
        <div><span>用掉（Σ截取长）</span><b>{{ formatM(shownPlan.metrics.usedLengthMm) }} m</b></div>
        <div><span>留用余料</span><b>{{ formatM(shownPlan.metrics.retainedMm) }} m（{{ shownPlan.metrics.retainedCount }} 根）</b></div>
        <div class="waste"><span>废料（接不上件）</span><b>{{ formatM(shownPlan.metrics.wasteMm) }} m</b></div>
        <div><span>估算工时</span><b>{{ formatLabor(shownPlan.metrics.laborSec) }}</b></div>
      </div>
      <p v-if="concession" class="concession">让路代价：{{ concession.text }}</p>
    </section>

    <!-- 缺料诊断 -->
    <section v-if="shownPlan && shownPlan.shortages.length" class="panel shortage">
      <h3>挑不出全单可行方案：缺料明细</h3>
      <table>
        <thead><tr><th>灯种</th><th>构件</th><th class="num">下料长(mm)</th><th class="num">需求</th><th class="num">已配</th><th class="num">缺</th><th>原因</th><th>建议添料</th></tr></thead>
        <tbody>
          <tr v-for="s in shownPlan.shortages" :key="s.demandKey">
            <td>{{ s.lanternName }}</td><td>{{ s.label }}</td>
            <td class="num mono">{{ s.cutMm }}</td><td class="num mono">{{ s.needQty }}</td><td class="num mono">{{ s.haveQty }}</td><td class="num mono strong">{{ s.shortQty }}</td>
            <td :class="s.reason === 'length' ? 'reason-len' : 'reason-cnt'">
              {{ s.reason === 'length' ? `长度不够：库里最长 ${s.maxStockMm}mm，短于该件 ${s.cutMm}mm` : '根数不够：长度够，但现有根数配不齐' }}
            </td>
            <td class="mono">添 {{ s.buyQty }} 根 × {{ s.buyStripLenMm }}mm</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 重算变化（三处各自变了什么） -->
    <section v-if="diff && draftVersion" class="panel diff">
      <h3>本次整批重算，三处各变了什么 <em>对比旧采用版 {{ diff.fromPlanId }} → {{ diff.toPlanId }}</em></h3>
      <div class="diff-cols">
        <div>
          <h4>构件表：来源段换了的件</h4>
          <p v-if="!diff.memberSourceChanges.length" class="dim">无（各件来源料号/段号不变）</p>
          <ul>
            <li v-for="c in diff.memberSourceChanges" :key="c.demandKey">
              <b>{{ c.label }}</b>：{{ c.before.map((x) => x.stockCode + '(' + x.instanceNo + ')#' + x.segNo).join('、') || '—' }}
              → {{ c.after.map((x) => x.stockCode + '(' + x.instanceNo + ')#' + x.segNo).join('、') || '不配了' }}
            </li>
          </ul>
          <p v-if="diff.membersAdded.length" class="plus">新增配出：{{ diff.membersAdded.map((x) => `${x.label}×${x.qty}`).join('；') }}</p>
          <p v-if="diff.membersRemoved.length" class="minus">减少配出：{{ diff.membersRemoved.map((x) => `${x.label}×${x.qty}`).join('；') }}</p>
        </div>
        <div>
          <h4>材料页：材料项与根数变化</h4>
          <p v-if="!diff.materialChanges.length" class="dim">无</p>
          <ul>
            <li v-for="(c, i) in diff.materialChanges" :key="i">
              <b>{{ c.specMm }}mm 规格</b>：
              <span v-if="c.before && c.after">动用 {{ c.before.usedStripQty }}→{{ c.after.usedStripQty }} 根，用掉 {{ c.before.usedLengthMm }}→{{ c.after.usedLengthMm }}mm，添 {{ c.before.addQty }}→{{ c.after.addQty }} 根</span>
              <span v-else-if="c.after">新增项：动用 {{ c.after.usedStripQty }} 根，添 {{ c.after.addQty }} 根</span>
              <span v-else>本规格不再出现（原动用 {{ c.before?.usedStripQty }} 根）</span>
            </li>
          </ul>
          <p class="dim">总变化：废料 {{ diff.totals.wasteDeltaMm >= 0 ? '+' : '' }}{{ diff.totals.wasteDeltaMm }}mm，用掉 {{ diff.totals.usedDeltaMm >= 0 ? '+' : '' }}{{ diff.totals.usedDeltaMm }}mm，工时 {{ diff.totals.laborDeltaSec >= 0 ? '+' : '' }}{{ diff.totals.laborDeltaSec }} 秒，整盏 {{ diff.totals.builtDelta >= 0 ? '+' : '' }}{{ diff.totals.builtDelta }}</p>
        </div>
        <div>
          <h4>存档：上次留用这次不再留用</h4>
          <p v-if="!diff.retentionRevoked.length" class="dim">无</p>
          <ul>
            <li v-for="o in diff.retentionRevoked" :key="o.offcutCode" class="minus">{{ o.offcutCode }}（来源 {{ o.sourceStockCode }}，{{ o.lengthMm }}mm）留用记录失效</li>
          </ul>
          <p v-if="diff.retentionAdded.length" class="plus">新留用：{{ diff.retentionAdded.map((o) => `${o.offcutCode} ${o.lengthMm}mm`).join('；') }}</p>
        </div>
      </div>
    </section>

    <!-- 三处清单（页签，同一份 shownPlan） -->
    <section v-if="shownPlan" class="panel">
      <div class="tabs no-print">
        <button :class="{ on: tab === 'components' }" @click="tab = 'components'">骨架构件表（逐段）</button>
        <button :class="{ on: tab === 'materials' }" @click="tab = 'materials'">备料统计 / 材料页</button>
        <button :class="{ on: tab === 'archive' }" @click="tab = 'archive'">本机存档台账</button>
        <button class="ghost" @click="exportMerged" :disabled="!adoptedPlan">同件合并视图 CSV</button>
      </div>

      <!-- 构件表 -->
      <div v-show="tab === 'components'">
        <h3>骨架构件表 · 每段取自哪根篾、第几段 <em>（同件合并计数见下表）</em></h3>
        <table class="big-table">
          <thead><tr>
            <th>#</th><th>灯种</th><th>构件</th><th class="num">净长</th><th class="num">余量合计</th><th class="num">截取长(取整)</th>
            <th class="num">取自料号</th><th class="num">第几根</th><th class="num">第几段</th><th class="num">本根剩余(mm)</th><th>残料</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in compRows" :key="r.rowNo">
              <td class="dim">{{ r.rowNo }}</td><td>{{ r.lanternName }}</td><td>{{ r.label }}</td>
              <td class="num mono">{{ r.netMm.toFixed(1) }}</td><td class="num mono">{{ r.allowanceMm }}</td><td class="num mono strong">{{ r.cutMm }}</td>
              <td class="num mono src">{{ r.stockCode }}</td><td class="num mono src">{{ r.instanceNo }}</td><td class="num mono src">{{ r.segNo }}</td>
              <td class="num mono" :class="r.reusable ? 'keep' : 'waste-col'">{{ r.residualMm }}</td>
              <td :class="r.reusable ? 'keep' : 'waste-col'">{{ r.reusable ? `留用 ${r.offcutCode}` : '废料：接不上别的件' }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="6">Σ截取长（本批用掉竹篾总量）</td><td class="num mono strong">{{ shownPlan.metrics.usedLengthMm }} mm</td><td colspan="4" class="dim">= {{ formatM(shownPlan.metrics.usedLengthMm) }}m，与材料页/存档逐毫米一致</td></tr>
          </tfoot>
        </table>

        <h3 class="mt">同一种件合并计数</h3>
        <table class="big-table">
          <thead><tr><th>灯种</th><th>构件</th><th class="num">下料长(mm)</th><th class="num">需求</th><th class="num">已配</th><th class="num">缺</th><th>来源（料号#段号）</th></tr></thead>
          <tbody>
            <tr v-for="r in mergedRows" :key="r.demandKey">
              <td>{{ r.lanternName }}</td><td>{{ r.label }}</td><td class="num mono">{{ r.cutMm }}</td>
              <td class="num mono">{{ r.needQty }}</td><td class="num mono">{{ r.haveQty }}</td>
              <td class="num mono" :class="r.needQty - r.haveQty > 0 ? 'waste-col strong' : ''">{{ Math.max(0, r.needQty - r.haveQty) }}</td>
              <td class="mono small">{{ r.sources.map((s) => s.stockCode + '(' + s.instanceNo + ')#' + s.segNo).join(' ') || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 材料页 -->
      <div v-show="tab === 'materials'">
        <h3>备料统计 / 材料页 <em>按同一份配切结果算还要再添几根、添多长</em></h3>
        <table v-if="mat" class="big-table">
          <thead><tr>
            <th class="num">料长规格(mm)</th><th class="num">库存根数</th><th class="num">动用</th><th class="num">用掉(mm)</th>
            <th class="num">留用根</th><th class="num">留用(mm)</th><th class="num">废料(mm)</th><th class="num">需添根</th><th class="num">添料每根(mm)</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in mat.rows" :key="r.specMm">
              <td class="num mono">{{ r.specMm }}</td><td class="num mono">{{ r.stockQty }}</td><td class="num mono">{{ r.usedStripQty }}</td>
              <td class="num mono">{{ r.usedLengthMm }}</td><td class="num mono">{{ r.retainedQty }}</td><td class="num mono keep">{{ r.retainedMm }}</td>
              <td class="num mono waste-col">{{ r.wasteMm }}</td>
              <td class="num mono" :class="r.addQty > 0 ? 'strong add' : ''">{{ r.addQty }}</td>
              <td class="num mono">{{ r.addQty > 0 ? r.addStripLenMm : '—' }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td>合计</td><td></td><td></td>
              <td class="num mono strong">{{ mat.usedLengthMm }}</td><td></td><td class="num mono keep">{{ mat.retainedMm }}</td>
              <td class="num mono waste-col">{{ mat.wasteMm }}</td><td class="num mono strong add">{{ mat.addQty }}</td><td class="num mono">{{ mat.addLengthMm }}</td>
            </tr>
          </tfoot>
        </table>
        <ul v-if="mat" class="verify">
          <li>动用篾原长合计 <b class="mono">{{ formatM(mat.consumedStockMm) }}m</b> = 用掉 {{ formatM(mat.usedLengthMm) }}m + 留用 {{ formatM(mat.retainedMm) }}m + 废料 {{ formatM(mat.wasteMm) }}m</li>
          <li>需添竹篈合计 <b class="mono">{{ mat.addQty }} 根 / {{ formatM(mat.addLengthMm) }}m</b>（明细见缺料诊断；长度不够的件须添不短于其下料长的篈）</li>
          <li class="dim">构件表逐行截取长合计 {{ shownPlan?.metrics.usedLengthMm }}mm = 材料页用掉 {{ mat.usedLengthMm }}mm，差 1mm 也会在下方守恒检查报红。</li>
        </ul>
      </div>

      <!-- 存档 -->
      <div v-show="tab === 'archive'">
        <h3>本机灯样存档 · 余料留用台账</h3>
        <p :class="['tag', draftVersion ? 'tag-draft' : 'tag-adopted']">
          {{ draftVersion ? '当前为试算草稿：本页留用记录尚未写进本机存档，采用后才生效。' : '已采用：以下留用记录即本机存档，导出三份清单与此同源。' }}
        </p>
        <table class="big-table">
          <thead><tr><th>留用料号</th><th>来源料号</th><th class="num">剩余长度(mm)</th><th>产生计划</th></tr></thead>
          <tbody>
            <tr v-for="o in retained" :key="o.offcutCode">
              <td class="mono src">{{ o.offcutCode }}</td><td class="mono">{{ o.sourceStockCode }}</td><td class="num mono keep">{{ o.lengthMm }}</td><td class="dim">{{ o.planId }}</td>
            </tr>
            <tr v-if="!retained.length"><td colspan="4" class="dim">本方案没有可留用余料（残料都短于 {{ shownPlan?.input.minOffcutMm }}mm，全部记为废料）。</td></tr>
          </tbody>
        </table>
        <h3 class="mt">未动用整篈（原样留着下次再用）</h3>
        <table class="big-table">
          <thead><tr><th>料号</th><th class="num">料长(mm)</th><th class="num">根数</th></tr></thead>
          <tbody>
            <tr v-for="u in shownPlan?.untouched" :key="u.stockCode"><td class="mono">{{ u.stockCode }}</td><td class="num mono">{{ u.lengthMm }}</td><td class="num mono">{{ u.qty }}</td></tr>
          </tbody>
        </table>

        <h3 class="mt">配切版本历史（作废/替代全过程留痕）</h3>
        <table class="big-table hist">
          <thead><tr><th>计划号</th><th>路线</th><th>状态</th><th>生成/采用/作废时间</th><th>原因 / 退回登记</th></tr></thead>
          <tbody>
            <tr v-for="v in cuttingState.versions" :key="v.plan.id">
              <td class="mono">{{ v.plan.id }}</td>
              <td>{{ STRATEGIES[v.plan.strategy].name }}</td>
              <td><span :class="['tag', 'tag-' + v.status]">{{ statusLabel(v.status) }}</span></td>
              <td class="dim small">{{ when(v.plan.generatedAt) }}<br />采用 {{ when(v.adoptedAt) }}<br />失效 {{ when(v.supersededAt) }}</td>
              <td class="small">{{ v.supersedeReason || '—' }}<span v-if="v.restored?.length"><br />退回登记：{{ v.restored.map((r) => r.code + '×' + r.qty + '(' + r.lengthMm + 'mm)').join('，') }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 守恒自检 -->
    <section v-if="checks.length" class="panel">
      <h3>三处同源守恒自检（整数 mm，差 1mm 也报）</h3>
      <ul class="checks">
        <li v-for="c in checks" :key="c.id" :class="c.pass ? 'pass' : 'fail'">
          <b>{{ c.id }} {{ c.pass ? '✓' : '✗' }}</b> {{ c.detail }}
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cutting { display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
h2 { margin: 0 0 6px; font-size: 18px; color: #8f1c19; border-left: 4px solid var(--red); padding-left: 10px; }
.sub { margin: 0; font-size: 12.5px; color: var(--ink-soft); max-width: 900px; }
.ops { display: flex; gap: 8px; }
button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--surface-2); padding: 6px 11px; font-size: 12.5px; }
button:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
button.primary.big { padding: 9px 18px; font-size: 14px; }
button.adopt { width: 100%; margin-top: 8px; background: var(--jade); border-color: var(--jade); color: #fff; font-weight: 700; padding: 9px; }
button.void { width: 100%; margin-top: 8px; background: #fff; border-color: var(--red-soft); color: var(--red); }
button.del { padding: 2px 8px; font-size: 11px; }
button.ghost { background: transparent; }
.banner { padding: 9px 14px; border-radius: 8px; font-size: 12.5px; margin: 0; }
.banner.warn { background: #fbeee2; border: 1px solid #e0b58a; color: #8a4b12; }
.banner.ok { background: #e8f2ec; border: 1px solid #9fc7b2; color: #1f5c46; }

.grid-top { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 14px; }
@media (max-width: 1080px) { .grid-top { grid-template-columns: 1fr; } }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); }
.panel h3 { margin: 0 0 8px; font-size: 13.5px; }
.panel h3 em { font-style: normal; font-weight: 400; color: var(--ink-soft); font-size: 11.5px; margin-left: 6px; }
.mt { margin-top: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; padding: 6px 8px; color: var(--ink-soft); font-weight: 500; font-size: 11.5px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px dashed var(--line); vertical-align: middle; }
tfoot td { border-top: 1px solid var(--line-strong); border-bottom: none; font-size: 12.5px; }
.num { text-align: right; }
.mono { font-family: var(--mono); }
.small { font-size: 11.5px; }
.dim { color: var(--ink-soft); font-size: 11.5px; }
.strong { font-weight: 700; color: #8f1c19; }
.keep { color: var(--jade); }
.waste-col { color: var(--red); }
.add { color: var(--gold); }
.src { color: var(--blue); font-weight: 600; }
.reason-len { color: var(--red); font-weight: 600; }
.reason-cnt { color: var(--gold); font-weight: 600; }
input { font: inherit; border: 1px solid var(--line-strong); border-radius: 5px; padding: 4px 6px; background: #fff; }
input.num { text-align: right; font-family: var(--mono); }
.w60 { width: 60px; } .w80 { width: 80px; } .w100 { width: 100px; }
.note-in { width: 100%; }
.addrow { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.addrow .note-in { flex: 1; }
.strategies { display: grid; grid-template-columns: 1fr; gap: 8px; }
.strategy { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.strategy.on { border-color: var(--red); background: #fdf3ef; }
.strategy span { display: flex; flex-direction: column; }
.strategy em { font-style: normal; font-size: 11.5px; color: var(--ink-soft); }
.recompute { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 10px; flex-wrap: wrap; }
.minoff { font-size: 12px; color: var(--ink-soft); display: flex; align-items: center; gap: 5px; }

.mstate { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.tag { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; }
.tag-draft { background: #fdf0d9; color: #8a5a12; border: 1px solid #e3c184; }
.tag-adopted { background: #e8f2ec; color: #1f5c46; border: 1px solid #9fc7b2; }
.tag-superseded { background: #eee; color: #777; }
.tag-voided { background: #f8e3e1; color: #9c1f1b; }
.mgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.mgrid div { background: var(--surface); padding: 8px 10px; display: flex; flex-direction: column; }
.mgrid span { font-size: 11px; color: var(--ink-soft); }
.mgrid b { font-family: var(--mono); font-size: 14px; }
.concession { margin: 10px 0 0; padding: 8px 10px; background: var(--surface-2); border-radius: 6px; font-size: 12px; }

.tabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.tabs button.on { background: var(--red); border-color: var(--red); color: #fff; }
.big-table { font-size: 12px; }
.verify { margin: 10px 0 0; padding-left: 18px; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px; }
.diff-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
@media (max-width: 1080px) { .diff-cols { grid-template-columns: 1fr; } }
.diff-cols h4 { margin: 0 0 6px; font-size: 12.5px; color: #8f1c19; }
.diff-cols ul { margin: 0; padding-left: 16px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
.plus { color: var(--jade); font-size: 12px; margin: 6px 0 0; }
.minus { color: var(--red); font-size: 12px; margin: 6px 0 0; }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; }
.checks .pass { color: var(--jade); }
.checks .fail { color: var(--red); font-weight: 700; }
.hist td { vertical-align: top; }
</style>
