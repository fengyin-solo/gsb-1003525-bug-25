<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质检测管理</h2>
        <p class="page-desc">采样 → 检测 → 出具报告（锁定原始读数）→ 发起复核 → 预警核查，全链路留痕。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="registerOpen = true">登记采样</button>
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
        <span>报告编号/站点</span>
        <input v-model="keyword" placeholder="按报告编号或采样站点检索" />
      </label>
      <label class="filter-item">
        <span>报告状态</span>
        <input v-model="statusKeyword" placeholder="如 复核中 / 已复核" />
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
          <th>检测项目与原始读数</th>
          <th>原始结论（出具当时）</th>
          <th>检测人</th>
          <th>复核人</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.id">
          <td>{{ row.code }}</td>
          <td>{{ row.station }}</td>
          <td>{{ row.sampledAt }}</td>
          <td>{{ itemsSummary(row) }}</td>
          <td>
            <span class="result-tag" :class="reportResultKind(row)">
              {{ row.status === 'sampled' || row.status === 'testing' ? '—' : resultLabel(row) }}
            </span>
          </td>
          <td>{{ row.inspector || '—' }}</td>
          <td>{{ reviewerText(row) }}</td>
          <td><span class="badge" :class="statusBadge(row)">{{ STATUS_LABEL[row.status] }}</span></td>
          <td class="row-actions">
            <button v-if="row.status === 'sampled'" class="link" type="button" @click="doBeginTesting(row)">开始检测</button>
            <button v-if="row.status === 'testing'" class="link" type="button" @click="openResults(row)">录入读数/出报告</button>
            <button
              v-if="row.status === 'reported' || row.status === 'reviewed'"
              class="link"
              type="button"
              @click="doOpenReview(row)"
            >
              发起复核
            </button>
            <button v-if="row.status === 'reviewing'" class="link" type="button" @click="openReviewDialog(row)">继续复核</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="9" class="empty-state">暂无符合条件的水质检测报告，可先登记采样</td>
        </tr>
      </tbody>
    </table>

    <CheckListPanel :items="checks" show-report-action @review="goReview" />

    <footer class="page-foot">
      <span>共 {{ reports.length }} 份水质检测报告</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" style="color:#027a48;">{{ noticeMessage }}</span>
    </footer>

    <RegisterDialog v-if="registerOpen" @close="registerOpen = false" @done="onDone" />
    <ResultsDialog v-if="resultsTarget" :report="resultsTarget" @close="resultsTarget = null" @done="onDone" />
    <ReviewDialog v-if="reviewTarget" :report="reviewTarget" @close="reviewTarget = null" @done="onDone" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import CheckListPanel from './components/CheckListPanel.vue'
import RegisterDialog from './components/RegisterDialog.vue'
import ResultsDialog from './components/ResultsDialog.vue'
import ReviewDialog from './components/ReviewDialog.vue'
import {
  STATUS_LABEL,
  itemsSummary,
  reportResultKind,
  resultLabel,
  reviewerText,
} from '@/data/quality/display'
import { beginTesting, getReport, openReview, qualityChecks, qualityReports } from '@/data/quality/service'
import type { QualityCheckItem, QualityReport, QualityStatus } from '@/data/quality/types'

const reports = ref<QualityReport[]>([])
const checks = ref<QualityCheckItem[]>([])
const keyword = ref('')
const statusKeyword = ref('')
const errorMessage = ref('')
const noticeMessage = ref('')

const registerOpen = ref(false)
const resultsTarget = ref<QualityReport | null>(null)
const reviewTarget = ref<QualityReport | null>(null)

const statusLegend: Array<{ key: QualityStatus; label: string }> = [
  { key: 'sampled', label: '已采样' },
  { key: 'testing', label: '检测中' },
  { key: 'reported', label: '已出报告' },
  { key: 'reviewing', label: '复核中' },
  { key: 'reviewed', label: '已复核' },
]

const statusSummary = computed(() =>
  statusLegend.map((item) => ({
    status: item.label,
    count: reports.value.filter((row) => row.status === item.key).length,
  })),
)

const stats = computed(() => [
  { label: '本月检测次数', value: reports.value.filter((row) => row.status !== 'sampled').length },
  { label: '超标报告数', value: new Set(checks.value.map((item) => item.reportId)).size },
  { label: '检测中样本', value: reports.value.filter((row) => row.status === 'testing').length },
])

const filteredRows = computed(() => {
  const word = keyword.value.trim()
  const statusWord = statusKeyword.value.trim()
  return reports.value.filter((row) => {
    const hitWord = !word || row.code.includes(word) || row.station.includes(word)
    const hitStatus = !statusWord || STATUS_LABEL[row.status].includes(statusWord) || row.status.includes(statusWord)
    return hitWord && hitStatus
  })
})

function reload() {
  errorMessage.value = ''
  reports.value = qualityReports()
  checks.value = qualityChecks()
}

function resetFilters() {
  keyword.value = ''
  statusKeyword.value = ''
  reload()
}

function onDone(message: string) {
  registerOpen.value = false
  resultsTarget.value = null
  reviewTarget.value = null
  reload()
  noticeMessage.value = message
  errorMessage.value = ''
}

function doBeginTesting(row: QualityReport) {
  const result = beginTesting(row)
  applyResult(result)
}

function openResults(row: QualityReport) {
  errorMessage.value = ''
  resultsTarget.value = getReport(row.id) ?? row
}

function doOpenReview(row: QualityReport) {
  // 发起复核只建立复核草稿（中间结论），不触碰原始读数。
  const result = openReview(row)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  const fresh = getReport(row.id)
  if (fresh) {
    reviewTarget.value = fresh
  }
  reload()
}

function openReviewDialog(row: QualityReport) {
  errorMessage.value = ''
  reviewTarget.value = getReport(row.id) ?? row
}

function goReview(reportId: number) {
  const report = getReport(reportId)
  if (report) {
    reviewTarget.value = report
  }
}

function applyResult(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    noticeMessage.value = ''
    errorMessage.value = result.message
    return
  }
  reload()
  noticeMessage.value = result.message
}

function statusBadge(row: QualityReport): string {
  if (row.status === 'reviewed') {
    return 'normal'
  }
  if (row.status === 'reviewing') {
    return 'pending'
  }
  if (row.abnormal && (row.status === 'reported')) {
    return 'abnormal'
  }
  return 'neutral'
}

onMounted(reload)
</script>
