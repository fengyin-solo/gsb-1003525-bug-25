<template>
  <section class="check-block">
    <h3>预警核查清单（水质超标）</h3>
    <p class="page-desc">
      与水质检测模块共享同一份清单：一份超标报告一项，复核结论或人工核查后的状态在此实时联动。
    </p>
    <div class="check-summary">
      <span v-for="item in summary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>报告编号</th><th>采样站点</th><th>检测项目</th><th>原始读数</th><th>标准上限</th>
          <th>核查状态</th><th>备注</th><th>更新时间</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="String(item.reportId)">
          <td>{{ item.reportNo }}</td>
          <td>{{ item.station }}</td>
          <td>{{ item.item }}</td>
          <td class="over-proof">{{ item.value }}</td>
          <td>{{ item.limit }}</td>
          <td :class="statusClass(item.status)">{{ item.status }}</td>
          <td>{{ item.note || '—' }}</td>
          <td>{{ item.updatedAt }}</td>
          <td class="row-actions">
            <button v-if="item.status === '待核查'" class="link" type="button" @click="close(item)">核查关闭</button>
            <button v-if="item.status === '待核查'" class="link" type="button" @click="release(item)">解除预警</button>
            <span v-if="item.source === '历史补齐'" class="tag tag-backfill">历史补齐</span>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="9" class="empty-state">暂无超标报告待核查</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <button class="btn ghost" type="button" @click="reload">刷新核查状态</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  closeCheckItem,
  listChecklist,
  releaseCheckItem,
} from '@/data/waterquality/service'
import type { QualityCheckItem } from '@/data/waterquality/types'
import { CHECK_STATUS } from '@/data/waterquality/domain'

const items = ref<QualityCheckItem[]>([])
const errorMessage = ref('')

const summary = computed(() =>
  CHECK_STATUS.map((status) => ({
    status,
    count: items.value.filter((item) => item.status === status).length,
  })),
)

function reload() {
  errorMessage.value = ''
  try {
    items.value = listChecklist()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '核查清单读取失败'
  }
}

function close(item: QualityCheckItem) {
  const result = closeCheckItem(item.reportId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function release(item: QualityCheckItem) {
  const result = releaseCheckItem(item.reportId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function statusClass(status: string): string {
  if (status === '待核查') return 'over-proof'
  if (status === '解除预警') return 'ok-text'
  return ''
}

// 每次进入预警入口都重新拉取，确保水质侧复核/核查改了状态，这里看到的是最新值。
onMounted(reload)
defineExpose({ reload })
</script>
