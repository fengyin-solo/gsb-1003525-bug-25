<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <h3>水质检测复核 · {{ report.code }}</h3>
        <button class="modal-close" type="button" @click="$emit('close')">×</button>
      </div>

      <p class="locked-note">
        原始读数在出具报告时已锁定留痕，复核只能形成中间结论，不能改动读数；退回时只清空复核结论，原始读数保留。
      </p>

      <table class="data-table readonly-table">
        <thead>
          <tr><th>检测项目</th><th>原始读数</th><th>标准上限</th><th>当时结论</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in report.items" :key="item.name">
            <td>{{ item.name }}</td>
            <td>{{ item.reading }}</td>
            <td>{{ item.limit }}</td>
            <td>
              <span class="result-tag" :class="item.exceeded === true ? 'abnormal' : item.exceeded === false ? 'normal' : 'none'">
                {{ itemResultText(item) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="form-grid" style="margin-top: 12px;">
        <label>
          <span>复核人</span>
          <input v-model="reviewer" placeholder="请输入复核人姓名" />
        </label>
        <label>
          <span>复核轮次</span>
          <input :value="`第 ${report.reviewRound} 轮`" disabled />
        </label>
      </div>
      <label style="display:block;margin-top:10px;">
        <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:3px;">复核意见（中间结论）</span>
        <textarea v-model="opinion" placeholder="请填写复核意见"></textarea>
      </label>

      <p class="section-title">逐项复核结论（退回后随中间结论一起清空）</p>
      <table class="data-table">
        <thead>
          <tr><th>检测项目</th><th>原始结论</th><th>复核判定</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in report.items" :key="`finding-${item.name}`">
            <td>{{ item.name }}</td>
            <td>{{ itemResultText(item) }}</td>
            <td>
              <select v-model="findings[item.name]">
                <option value="通过">通过</option>
                <option value="退回">退回</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="!!report.history.length" class="section-title">历史复核留痕</p>
      <ul v-if="!!report.history.length" style="margin:0;padding-left:18px;font-size:12px;color:var(--muted);">
        <li v-for="entry in report.history" :key="entry.round">
          第 {{ entry.round }} 轮 · {{ VERDICT_LABEL[entry.verdict] }} · {{ entry.reviewer }} ·
          {{ entry.submittedAt }} · {{ entry.opinion || '无意见' }}
        </li>
      </ul>

      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

      <div class="modal-foot">
        <button class="btn" type="button" @click="$emit('close')">取消</button>
        <button class="btn" type="button" :disabled="submitting" @click="emitVerdict('退回')">退回（保留原始读数）</button>
        <button class="btn primary" type="button" :disabled="submitting" @click="emitVerdict('通过')">复核通过</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

import { itemResultText, VERDICT_LABEL } from '@/data/quality/display'
import { submitConclusion } from '@/data/quality/service'
import type { QualityReport, ReviewVerdict } from '@/data/quality/types'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ report: QualityReport }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', message: string): void
}>()

const session = useSessionStore()
const reviewer = ref(props.report.review?.reviewer || session.operator)
const opinion = ref(props.report.review?.opinion || '')
const findings = reactive<Record<string, ReviewVerdict>>({})
const errorMessage = ref('')
const submitting = ref(false)

// findings 默认按原始结论给出建议判定，复核人可改；这只是中间结论。
watch(
  () => props.report.id,
  () => {
    reviewer.value = props.report.review?.reviewer || session.operator
    opinion.value = props.report.review?.opinion || ''
    for (const key of Object.keys(findings)) {
      delete findings[key]
    }
    for (const item of props.report.items) {
      findings[item.name] = props.report.review?.findings[item.name] ?? (item.exceeded === true ? '退回' : '通过')
    }
    errorMessage.value = ''
  },
  { immediate: true },
)

function emitVerdict(verdict: ReviewVerdict) {
  errorMessage.value = ''
  if (reviewer.value.trim() === '') {
    errorMessage.value = '请填写复核人后再提交'
    return
  }
  submitting.value = true
  const result = submitConclusion(props.report, {
    reviewer: reviewer.value.trim(),
    opinion: opinion.value,
    findings: { ...findings },
    verdict,
  })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  emit('done', result.message)
}
</script>
