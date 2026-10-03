<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <h3>录入检测读数 · {{ report.code }}</h3>
        <button class="modal-close" type="button" @click="$emit('close')">×</button>
      </div>
      <p class="locked-note">
        读数在检测中可反复修改；点击「出具报告」后按当时读数冻结超标结论，原始读数将被锁定，复核也不能改动。
      </p>

      <table class="data-table">
        <thead>
          <tr><th>检测项目</th><th>检测读数</th><th>标准上限</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="index">
            <td><input v-model="row.name" placeholder="如 氨氮" /></td>
            <td><input v-model="row.reading" placeholder="如 1.84" /></td>
            <td><input v-model="row.limit" placeholder="如 1.0" /></td>
            <td><button class="link" type="button" @click="rows.splice(index, 1)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <p style="margin:8px 0 0;">
        <button class="btn" type="button" @click="addRow">添加检测项目</button>
      </p>

      <label style="display:block;margin-top:10px;">
        <span style="display:block;font-size:12px;color:var(--muted);margin-bottom:3px;">检测人</span>
        <input v-model="inspector" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px 8px;" />
      </label>

      <p v-if="errorMessage" class="error-text" style="margin-top:10px;">{{ errorMessage }}</p>

      <div class="modal-foot">
        <button class="btn" type="button" @click="$emit('close')">取消</button>
        <button class="btn" type="button" @click="save(false)">暂存读数</button>
        <button class="btn primary" type="button" @click="save(true)">出具报告并锁定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { getReport, publishReport, saveResults } from '@/data/quality/service'
import type { QualityReport } from '@/data/quality/types'

const props = defineProps<{ report: QualityReport }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', message: string): void
}>()

interface ItemRow {
  name: string
  reading: string
  limit: string
}

const rows = ref<ItemRow[]>(
  props.report.items.length > 0
    ? props.report.items.map((item) => ({ name: item.name, reading: item.reading, limit: item.limit }))
    : [{ name: '', reading: '', limit: '' }],
)
const inspector = ref(props.report.inspector)
const errorMessage = ref('')

function addRow() {
  rows.value.push({ name: '', reading: '', limit: '' })
}

function validRows(): ItemRow[] | null {
  const cleaned = rows.value
    .map((row) => ({ name: row.name.trim(), reading: row.reading.trim(), limit: row.limit.trim() }))
    .filter((row) => row.name !== '' || row.reading !== '' || row.limit !== '')
  if (cleaned.length === 0) {
    errorMessage.value = '请至少录入一项检测读数'
    return null
  }
  if (cleaned.some((row) => row.name === '' || row.reading === '' || row.limit === '')) {
    errorMessage.value = '检测项目、读数和标准上限都需要填写完整'
    return null
  }
  return cleaned
}

function save(issue: boolean) {
  errorMessage.value = ''
  const cleaned = validRows()
  if (!cleaned) {
    return
  }
  // 先按当前 revision 暂存；出具报告需要基于暂存后的新报告重新取版本号。
  const saved = saveResults({
    reportId: props.report.id,
    revision: props.report.revision,
    inspector: inspector.value.trim() || props.report.inspector,
    items: cleaned,
  })
  if (!saved.ok) {
    errorMessage.value = saved.message
    return
  }
  if (!issue) {
    emit('done', saved.message)
    return
  }
  // 暂存会推进版本号，出具报告必须重新取最新报告，避免用旧版本号触发并发冲突。
  const fresh = getReport(props.report.id)
  if (!fresh) {
    errorMessage.value = '暂存后未找到报告，请刷新列表'
    return
  }
  const issued = publishReport(fresh)
  if (!issued.ok) {
    errorMessage.value = issued.message
    return
  }
  emit('done', issued.message)
}
</script>
