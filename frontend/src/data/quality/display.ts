import type { QualityItem, QualityReport, QualityStatus, ReviewVerdict } from './types'

// 水质领域展示口径：三个入口（报告列表 / 复核弹窗 / 核查清单）共用同一套文案，
// 避免同一结论在不同地方各算一遍、出现两份结果。

export const STATUS_LABEL: Record<QualityStatus, string> = {
  sampled: '已采样',
  testing: '检测中',
  reported: '已出报告',
  reviewing: '复核中',
  reviewed: '已复核',
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  通过: '复核通过',
  退回: '复核退回',
}

/** 单项超标判定的展示文字：严格按出具报告当时冻结的 exceeded，不现场重算。 */
export function itemResultText(item: QualityItem): string {
  if (item.exceeded === true) {
    return '超标'
  }
  if (item.exceeded === false) {
    return '合格'
  }
  return '未判定'
}

export type ResultKind = 'none' | 'normal' | 'abnormal'

/** 报告级原始结论：未出报告(none) / 合格(normal) / 超标(abnormal)。 */
export function reportResultKind(report: QualityReport): ResultKind {
  if (report.status === 'sampled' || report.status === 'testing') {
    return 'none'
  }
  return report.abnormal ? 'abnormal' : 'normal'
}

export function resultLabel(report: QualityReport): string {
  const kind = reportResultKind(report)
  if (kind === 'none') {
    return '未出报告'
  }
  if (kind === 'normal') {
    return '合格'
  }
  const count = report.items.filter((item) => item.exceeded === true).length
  return count > 0 ? `超标（${count}项）` : '超标'
}

export function itemsSummary(report: QualityReport): string {
  if (report.items.length === 0) {
    return '尚未录入读数'
  }
  return report.items.map((item) => `${item.name} ${item.reading}/${item.limit}`).join('；')
}

export function exceededNames(report: QualityReport): string[] {
  return report.items.filter((item) => item.exceeded === true).map((item) => item.name)
}

export function reviewerText(report: QualityReport): string {
  if (report.status === 'reviewed' && report.review) {
    return report.review.reviewer
  }
  if (report.status === 'reviewing' && report.review && report.review.reviewer) {
    return `${report.review.reviewer}（复核中）`
  }
  return '—'
}
