import type { EntryRow } from '@/data/types'
import type { CheckItemStatus, QualityCheckItem, QualitySnapshot } from './types'

/** 水质检测表、预警核查清单在本地存储里的表名。 */
export const WATER_QUALITY_KEY = 'waterquality'
export const CHECKLIST_KEY = 'waterqualityChecklist'

/** 历史报告缺少复核人时的统一补齐方式：标记为系统补齐并留痕，绝不伪造真实姓名。 */
export const LEGACY_REVIEWER = '系统补齐（历史未登记）'

/** 报告状态流转。 */
export const REPORT_STATUS = {
  sampled: '已采样',
  testing: '检测中',
  reported: '已出报告',
  overProof: '超标',
  reviewing: '复核中',
  reviewed: '已复核',
  returned: '复核退回',
} as const

export const CHECK_STATUS: CheckItemStatus[] = ['待核查', '已核查关闭', '解除预警']

/** 可以发起复核的报告状态：初次出具与退回后重新发起都走同一个入口。 */
export const REVIEWABLE_STATUSES = [
  REPORT_STATUS.reported,
  REPORT_STATUS.overProof,
  REPORT_STATUS.returned,
]

export function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

/** 从字符串里取第一段数字做超标判定，取不到视为无法比较（按不超标处理，由人工复核把关）。 */
export function parseNumber(text: string): number | null {
  const matched = String(text).replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : null
}

export function isOverProof(value: string, limit: string): boolean {
  const current = parseNumber(value)
  const upper = parseNumber(limit)
  if (current === null || upper === null) {
    return false
  }
  return current > upper
}

/** 报告进入哪些状态还需要在看板上挂「待处理」。复核中属于进行中，退回后仍待处理。 */
export function reportPending(status: string): boolean {
  return status !== REPORT_STATUS.reviewed
}

export function reportAbnormal(status: string): boolean {
  return status === REPORT_STATUS.overProof || status === REPORT_STATUS.returned
}

/** 同一份超标报告只保留一条核查项，按报告编号去重，超标报告因此不会在清单里重复出现。 */
export function upsertCheckItem(
  items: QualityCheckItem[],
  incoming: QualityCheckItem,
): QualityCheckItem[] {
  const index = items.findIndex((item) => item.reportId === incoming.reportId)
  if (index < 0) {
    return [...items, incoming]
  }
  const next = [...items]
  next[index] = { ...next[index], ...incoming }
  return next
}

export function snapshotOf(row: EntryRow | null | undefined): QualitySnapshot | null {
  const value = row?.originalSnapshot
  return value && typeof value === 'object' ? (value as QualitySnapshot) : null
}

/** 构造核查项：pending/abnormal 与状态绑定，供看板统一统计。 */
export function makeCheckItem(
  input: Omit<QualityCheckItem, 'id' | 'pending' | 'abnormal'>,
): QualityCheckItem {
  return {
    ...input,
    id: input.reportId,
    pending: input.status === '待核查',
    abnormal: input.status !== '解除预警',
  }
}

export function withCheckStatus(item: QualityCheckItem, status: CheckItemStatus, note: string): QualityCheckItem {
  return makeCheckItem({
    ...item,
    status,
    note,
    updatedAt: nowText(),
  })
}
