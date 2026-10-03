<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>登记水质检测报告（采样）</h3>
        <button class="modal-close" type="button" @click="$emit('close')">×</button>
      </div>
      <p class="locked-note">采样阶段只登记样品与站点；检测读数在「检测中」录入，出具报告时锁定。</p>
      <div class="form-grid">
        <label>
          <span>报告编号</span>
          <input v-model="form.code" :placeholder="`WQ-${placeholderCode}`" />
        </label>
        <label>
          <span>采样站点</span>
          <input v-model="form.station" placeholder="如 沙河闸断面" />
        </label>
        <label>
          <span>采样时间</span>
          <input v-model="form.sampledAt" placeholder="2026-10-03 08:30" />
        </label>
        <label>
          <span>采样人</span>
          <input v-model="form.inspector" placeholder="采样/检测人姓名" />
        </label>
      </div>
      <p v-if="errorMessage" class="error-text" style="margin-top:10px;">{{ errorMessage }}</p>
      <div class="modal-foot">
        <button class="btn" type="button" @click="$emit('close')">取消</button>
        <button class="btn primary" type="button" @click="submit">确认采样登记</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'

import { registerSample } from '@/data/quality/service'
import { useSessionStore } from '@/stores/session'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', message: string): void
}>()

const session = useSessionStore()
const now = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const placeholderCode = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-001`

const form = reactive({
  code: '',
  station: '',
  sampledAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  inspector: session.operator,
})
const errorMessage = ref('')

function submit() {
  errorMessage.value = ''
  if (!form.code.trim() || !form.station.trim()) {
    errorMessage.value = '报告编号和采样站点不能为空'
    return
  }
  const result = registerSample({
    code: form.code.trim(),
    station: form.station.trim(),
    sampledAt: form.sampledAt.trim(),
    inspector: form.inspector.trim() || session.operator,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  emit('done', result.message)
}
</script>
