<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质检测管理</h2>
        <p class="page-desc">采样 → 检测 → 出具报告（锁定原始读数）→ 复核 → 超标核查，原始读数全程留痕不可改写。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记采样</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>报告编号</span>
        <input v-model="filterNo" placeholder="按报告编号检索" />
      </label>
      <label class="filter-item">
        <span>采样站点</span>
        <input v-model="filterStation" placeholder="按采样站点检索" />
      </label>
      <label class="filter-item">
        <span>检测项目</span>
        <input v-model="filterItem" placeholder="按检测项目检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>报告编号</th>
          <th>采样站点</th>
          <th>采样时间</th>
          <th>检测项目</th>
          <th>原始读数</th>
          <th>标准上限</th>
          <th>检测人</th>
          <th>复核结论</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td>{{ row['报告编号'] }}</td>
          <td>{{ row['采样站点'] }}</td>
          <td>{{ row['采样时间'] }}</td>
          <td>{{ row['检测项目'] }}</td>
          <td :class="{ 'over-proof': isLockedOverProof(row) }">{{ row['检测值'] }}</td>
          <td>{{ row['标准上限'] }}</td>
          <td>{{ row['检测人'] || '—' }}</td>
          <td>
            <template v-if="lastReview(row)">
              <span :class="lastReview(row)?.conclusion === '超标属实' ? 'over-proof' : 'ok-text'">
                {{ lastReview(row)?.conclusion }}（{{ lastReview(row)?.reviewValue }}）
              </span>
              <span v-if="lastReview(row)?.source === '历史补齐'" class="tag tag-backfill">历史补齐</span>
            </template>
            <span v-else-if="backfilledReviewer(row)" class="tag tag-backfill">复核人历史补齐</span>
            <span v-else>—</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.reviewDraft" class="tag tag-reviewing">复核中</span>
          </td>
          <td class="row-actions">
            <button v-if="row.status === '已采样'" class="link" type="button" @click="openTesting(row)">开始检测</button>
            <button v-if="row.status === '检测中'" class="link" type="button" @click="openIssue(row)">出具报告</button>
            <button
              v-if="canReview(row)"
              class="link"
              type="button"
              :disabled="busy"
              @click="openReview(row)"
            >
              {{ row.status === '复核退回' ? '重新发起复核' : '发起复核' }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="10" class="empty-state">暂无符合条件的水质检测报告，可先登记采样</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条报告 · 原始读数在出具报告时锁定，复核退回仅清中间结论</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="check-block">
      <h3>预警核查清单（超标报告）</h3>
      <p class="page-desc">一份超标报告对应一项，按报告编号去重；复核结论或人工核查后状态在这里同步更新，其它入口共享同一份。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>报告编号</th><th>采样站点</th><th>检测项目</th><th>原始读数</th><th>标准上限</th>
            <th>状态</th><th>备注</th><th>更新时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in checkItems" :key="String(item.reportId)">
            <td>{{ item.reportNo }}</td>
            <td>{{ item.station }}</td>
            <td>{{ item.item }}</td>
            <td class="over-proof">{{ item.value }}</td>
            <td>{{ item.limit }}</td>
            <td :class="checkStatusClass(item.status)">{{ item.status }}</td>
            <td>{{ item.note || '—' }}</td>
            <td>{{ item.updatedAt }}</td>
            <td class="row-actions">
              <button v-if="item.status === '待核查'" class="link" type="button" @click="closeItem(item)">核查关闭</button>
              <button v-if="item.status === '待核查'" class="link" type="button" @click="releaseItem(item)">解除预警</button>
              <span v-if="item.source === '历史补齐'" class="tag tag-backfill">历史补齐</span>
            </td>
          </tr>
          <tr v-if="!checkItems.length">
            <td colspan="9" class="empty-state">暂无超标报告，核查清单为空</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 登记采样 -->
    <div v-if="dialog === 'create'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>登记采样</h3>
        <label class="form-item"><span>报告编号</span><input v-model="form.reportNo" placeholder="如 WQ-2026-1101" /></label>
        <label class="form-item"><span>采样站点</span><input v-model="form.station" /></label>
        <label class="form-item"><span>采样时间</span><input v-model="form.sampledAt" :placeholder="nowPlaceholder" /></label>
        <label class="form-item"><span>检测项目</span><input v-model="form.item" placeholder="如 氨氮(mg/L)" /></label>
        <label class="form-item"><span>标准上限</span><input v-model="form.limit" placeholder="如 1.0" /></label>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">登记</button>
        </div>
      </div>
    </div>

    <!-- 开始检测 -->
    <div v-if="dialog === 'testing'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>开始检测 · {{ activeRow?.['报告编号'] }}</h3>
        <p class="page-desc">站点：{{ activeRow?.['采样站点'] }} ｜ 项目：{{ activeRow?.['检测项目'] }}</p>
        <label class="form-item"><span>检测人</span><input v-model="form.tester" placeholder="检测人姓名" /></label>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitTesting">开始检测</button>
        </div>
      </div>
    </div>

    <!-- 出具报告：此处锁定原始读数 -->
    <div v-if="dialog === 'issue'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>出具报告 · {{ activeRow?.['报告编号'] }}</h3>
        <p class="page-desc">检测值与标准上限确认后将锁定为原始读数，后续复核只增结论、不改读数。</p>
        <label class="form-item"><span>检测人</span><input v-model="form.tester" /></label>
        <label class="form-item"><span>检测值</span><input v-model="form.value" placeholder="本次检测读数（数字）" /></label>
        <label class="form-item"><span>标准上限</span><input v-model="form.limit" /></label>
        <p class="page-desc">据填写值预判：<strong :class="previewOver ? 'over-proof' : 'ok-text'">{{ previewOver ? '超标，将进入核查清单' : '合格' }}</strong></p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitIssue">出具报告并锁定读数</button>
        </div>
      </div>
    </div>

    <!-- 复核弹窗：发起后填写复核读数与结论，可提交或退回 -->
    <div v-if="dialog === 'review'" class="modal-mask" @click.self="closeDialog">
      <div class="modal modal-wide">
        <h3>复核 · {{ activeRow?.['报告编号'] }}</h3>
        <div class="review-grid">
          <div class="review-col">
            <h4>原始检测（已锁定留痕）</h4>
            <p>站点：{{ activeRow?.['采样站点'] }}</p>
            <p>采样时间：{{ activeRow?.['采样时间'] }}</p>
            <p>检测项目：{{ activeRow?.['检测项目'] }}</p>
            <p>原始读数：<strong class="over-proof">{{ activeRow?.['检测值'] }}</strong></p>
            <p>标准上限：{{ activeRow?.['标准上限'] }}</p>
            <p>检测人：{{ activeRow?.['检测人'] }}</p>
            <p class="page-desc">锁定时间：{{ lockedSnapshot(activeRow)?.lockedAt }}（{{ lockedSnapshot(activeRow)?.source }}）</p>
          </div>
          <div class="review-col">
            <template v-if="!reviewStarted">
              <h4>发起复核</h4>
              <p class="page-desc">发起后仅可填写复核读数与结论，检测项目与原始读数不会被覆盖。</p>
              <label class="form-item"><span>复核人</span><input v-model="form.reviewer" /></label>
              <label class="form-item"><span>发起说明</span><textarea v-model="form.comment" rows="2"></textarea></label>
            </template>
            <template v-else>
              <h4>复核结论（复核人：{{ reviewDraft?.reviewer }}）</h4>
              <label class="form-item"><span>复核读数</span><input v-model="form.reviewValue" placeholder="复测读数（数字）" /></label>
              <label class="form-item">
                <span>复核结论</span>
                <select v-model="form.conclusion">
                  <option value="超标属实">超标属实（维持原检测，核查关闭）</option>
                  <option value="复测合格">复测合格（改判，解除预警）</option>
                </select>
              </label>
              <label class="form-item"><span>复核意见</span><textarea v-model="form.comment" rows="2"></textarea></label>
              <label class="form-item"><span>退回原因（仅退回时填写）</span><textarea v-model="form.returnReason" rows="2"></textarea></label>
            </template>
          </div>
        </div>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">关闭</button>
          <template v-if="!reviewStarted">
            <button class="btn primary" type="button" :disabled="busy" @click="submitStartReview">发起复核</button>
          </template>
          <template v-else>
            <button class="btn" type="button" :disabled="busy" @click="submitReturn">复核退回（只清中间结论）</button>
            <button class="btn primary" type="button" :disabled="busy" @click="submitReview">提交复核结论</button>
          </template>
        </div>
      </div>
    </div>

    <!-- 报告详情：完整留痕 -->
    <div v-if="dialog === 'detail'" class="modal-mask" @click.self="closeDialog">
      <div class="modal modal-wide">
        <h3>报告详情 · {{ activeRow?.['报告编号'] }}</h3>
        <div class="review-grid">
          <div class="review-col">
            <h4>原始检测留痕</h4>
            <p v-if="lockedSnapshot(activeRow)">
              {{ activeRow?.['采样站点'] }} ｜ {{ activeRow?.['检测项目'] }}<br />
              原始读数：<strong class="over-proof">{{ activeRow?.['检测值'] }}</strong> ／ 上限：{{ activeRow?.['标准上限'] }}<br />
              检测人：{{ activeRow?.['检测人'] }} ｜ 锁定：{{ lockedSnapshot(activeRow)?.lockedAt }}
            </p>
            <p v-else class="page-desc">尚未出具报告，原始读数未落定。</p>
          </div>
          <div class="review-col">
            <h4>复核留痕</h4>
            <ul v-if="reviewRecords(activeRow).length" class="trace-list">
              <li v-for="(record, i) in reviewRecords(activeRow)" :key="i">
                {{ record.finishedAt }} ｜ {{ record.reviewer }} ｜
                <span :class="record.conclusion === '超标属实' ? 'over-proof' : 'ok-text'">{{ record.conclusion }}</span>
                ｜ 复核读数 {{ record.reviewValue }}
                <span v-if="record.source === '历史补齐'" class="tag tag-backfill">历史补齐</span>
                <br /><span class="page-desc">{{ record.comment }}</span>
              </li>
            </ul>
            <p v-else class="page-desc">暂无复核记录。</p>
            <p v-if="activeRow?.reviewReturnedAt" class="page-desc">
              最近退回：{{ activeRow.reviewReturnedAt }} ｜ {{ activeRow.reviewReturnReason }}
            </p>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeDialog">知道了</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import type { EntryRow } from '@/data/types'
import {
  closeCheckItem,
  createSample,
  displayRow,
  issueReport,
  listChecklist,
  listWaterQuality,
  releaseCheckItem,
  resumeReviewSession,
  returnReview as returnReviewAction,
  startReview,
  startTesting,
  submitReview as submitReviewAction,
} from '@/data/waterquality/service'
import type {
  QualityCheckItem,
  QualityReviewDraft,
  QualityReviewRecord,
  QualitySnapshot,
  ReviewConclusion,
} from '@/data/waterquality/types'
import { isOverProof } from '@/data/waterquality/domain'

const statuses = ['已采样', '检测中', '已出报告', '超标', '复核中', '复核退回', '已复核']

const rows = ref<EntryRow[]>([])
const checkItems = ref<QualityCheckItem[]>([])
const errorMessage = ref('')
const dialogError = ref('')
const busy = ref(false)

const filterNo = ref('')
const filterStation = ref('')
const filterItem = ref('')

type DialogKind = '' | 'create' | 'testing' | 'issue' | 'review' | 'detail'
const dialog = ref<DialogKind>('')
const activeRow = ref<EntryRow | null>(null)
const reviewStarted = ref(false)
const reviewDraft = ref<QualityReviewDraft | null>(null)

const emptyForm = () => ({
  reportNo: '', station: '', sampledAt: '', item: '', limit: '',
  tester: '', value: '',
  reviewer: '', reviewValue: '', comment: '', returnReason: '',
  conclusion: '超标属实' as ReviewConclusion,
})
const form = reactive(emptyForm())
const nowPlaceholder = new Date().toLocaleString('zh-CN', { hour12: false })

const filteredRows = computed(() =>
  rows.value.filter((row) =>
    String(row['报告编号'] ?? '').includes(filterNo.value.trim())
    && String(row['采样站点'] ?? '').includes(filterStation.value.trim())
    && String(row['检测项目'] ?? '').includes(filterItem.value.trim()),
  ),
)

const stats = computed(() => [
  { label: '本月检测次数', value: rows.value.filter((r) => String(r['采样时间']).startsWith('2026-10')).length },
  { label: '超标报告数', value: checkItems.value.length },
  { label: '检测中样本', value: rows.value.filter((r) => r.status === '检测中').length },
  { label: '待核查', value: checkItems.value.filter((i) => i.status === '待核查').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length })),
)

const previewOver = computed(() => isOverProof(form.value, form.limit))

function resetFilters() {
  filterNo.value = ''
  filterStation.value = ''
  filterItem.value = ''
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listWaterQuality()
    checkItems.value = listChecklist()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水质检测列表读取失败'
  }
}

function closeDialog() {
  dialog.value = ''
  dialogError.value = ''
  activeRow.value = null
  reviewStarted.value = false
  reviewDraft.value = null
  Object.assign(form, emptyForm())
}

function fillFromRow(row: EntryRow) {
  activeRow.value = displayRow(row)
  form.tester = String(row['检测人'] ?? '')
  form.limit = String(row['标准上限'] ?? '')
  // 复核读数默认带出原始读数方便核对，但它写入的是复核字段，原始读数不受影响。
  form.reviewValue = String(row['检测值'] ?? '')
}

function openCreate() {
  Object.assign(form, emptyForm())
  activeRow.value = null
  dialogError.value = ''
  dialog.value = 'create'
}

function openTesting(row: EntryRow) {
  fillFromRow(row)
  dialog.value = 'testing'
}

function openIssue(row: EntryRow) {
  fillFromRow(row)
  form.value = ''
  dialog.value = 'issue'
}

function canReview(row: EntryRow): boolean {
  return ['已出报告', '超标', '复核退回', '复核中'].includes(String(row.status))
}

function openReview(row: EntryRow) {
  fillFromRow(row)
  reviewStarted.value = false
  reviewDraft.value = null
  // 已在复核中的报告（含刷新后续接）直接进入填写态，落库草稿仍是唯一在途复核。
  if (String(row.status) === '复核中') {
    const resumed = resumeReviewSession(Number(row.id))
    if (!resumed.ok || !resumed.token || !resumed.draft) {
      errorMessage.value = resumed.message
      return
    }
    reviewDraft.value = resumed.draft
    form.reviewer = resumed.draft.reviewer
    form.comment = resumed.draft.comment
    reviewStarted.value = true
  }
  dialog.value = 'review'
}

function openDetail(row: EntryRow) {
  fillFromRow(row)
  dialog.value = 'detail'
}

function submitCreate() {
  dialogError.value = ''
  const result = createSample({
    reportNo: form.reportNo,
    station: form.station,
    sampledAt: form.sampledAt,
    item: form.item,
    limit: form.limit,
  })
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  reload()
}

function submitTesting() {
  if (!activeRow.value) return
  const result = startTesting(Number(activeRow.value.id), form.tester)
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  reload()
}

function submitIssue() {
  if (!activeRow.value) return
  const result = issueReport(Number(activeRow.value.id), {
    tester: form.tester,
    value: form.value,
    limit: form.limit,
  })
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  reload()
}

async function submitStartReview() {
  if (!activeRow.value || busy.value) return
  busy.value = true
  try {
    const result = startReview(Number(activeRow.value.id), form.reviewer, form.comment)
    if (!result.ok || !result.token || !result.draft) {
      dialogError.value = result.message
      return
    }
    reviewDraft.value = result.draft
    reviewStarted.value = true
    dialogError.value = ''
  } finally {
    busy.value = false
  }
}

async function submitReview() {
  if (!activeRow.value || !reviewDraft.value || busy.value) return
  busy.value = true
  try {
    const result = submitReviewAction(Number(activeRow.value.id), reviewDraft.value.token, {
      conclusion: form.conclusion,
      reviewValue: form.reviewValue,
      comment: form.comment,
    })
    if (!result.ok) {
      dialogError.value = result.message
      return
    }
    closeDialog()
    reload()
  } finally {
    busy.value = false
  }
}

async function submitReturn() {
  if (!activeRow.value || !reviewDraft.value || busy.value) return
  busy.value = true
  try {
    const result = returnReviewAction(
      Number(activeRow.value.id),
      reviewDraft.value.token,
      form.returnReason || form.comment,
    )
    if (!result.ok) {
      dialogError.value = result.message
      return
    }
    closeDialog()
    reload()
  } finally {
    busy.value = false
  }
}

function closeItem(item: QualityCheckItem) {
  const result = closeCheckItem(item.reportId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function releaseItem(item: QualityCheckItem) {
  const result = releaseCheckItem(item.reportId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function isLockedOverProof(row: EntryRow | null): boolean {
  return Boolean(row && lockedSnapshot(row)?.overProof)
}

function lockedSnapshot(row: EntryRow | null): QualitySnapshot | null {
  return (row?.originalSnapshot as QualitySnapshot | undefined) ?? null
}

function lastReview(row: EntryRow | null): QualityReviewRecord | null {
  const records = reviewRecords(row)
  return records.length ? records[records.length - 1] : null
}

function reviewRecords(row: EntryRow | null): QualityReviewRecord[] {
  return ((row?.reviewRecords as QualityReviewRecord[] | undefined) ?? [])
}

function backfilledReviewer(row: EntryRow | null): string {
  return row?.reviewRecordsBackfilled ? String(row['复核人'] ?? '') : ''
}

function checkStatusClass(status: string): string {
  if (status === '待核查') return 'over-proof'
  if (status === '解除预警') return 'ok-text'
  return ''
}

onMounted(reload)
</script>
