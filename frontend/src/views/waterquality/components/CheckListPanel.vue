<template>
  <section class="check-panel">
    <h3>超标预警核查清单</h3>
    <p class="page-desc" style="margin:0 0 8px;">
      一份超标报告只生成一条核查项；复核通过自动完成核查，复核退回自动重新待核查。状态由水质复核流程驱动，无需手工维护。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>报告编号</th>
          <th>采样站点</th>
          <th>超标项目（按原始读数）</th>
          <th>核查状态</th>
          <th>最近说明</th>
          <th v-if="showReportAction">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td>{{ item.code }}</td>
          <td>{{ item.station }}</td>
          <td>{{ item.exceededItems.join('、') || '—' }}</td>
          <td><span class="badge" :class="checkBadge(item.status)">{{ checkLabel(item.status) }}</span></td>
          <td>{{ item.note }}</td>
          <td v-if="showReportAction">
            <button class="link" type="button" @click="$emit('review', item.reportId)">前往复核</button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="showReportAction ? 6 : 5" class="empty-state">暂无超标报告核查项</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type { CheckStatus } from '@/data/quality/types'

defineProps<{
  items: import('@/data/quality/types').QualityCheckItem[]
  showReportAction?: boolean
}>()

defineEmits<{
  (e: 'review', reportId: number): void
}>()

function checkLabel(status: CheckStatus): string {
  return status === 'verified' ? '已核查' : status === 'reopened' ? '重新待核查' : '待核查'
}

function checkBadge(status: CheckStatus): string {
  return status === 'verified' ? 'normal' : status === 'reopened' ? 'reopened' : 'pending'
}
</script>
