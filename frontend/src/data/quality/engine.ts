import { QualityConflictError } from './types'
import type {
  CheckStatus,
  QualityCheckItem,
  QualityItem,
  QualityReport,
  QualityState,
  QualityStatus,
  ReviewHistoryEntry,
  StartReviewInput,
  SubmitReviewInput,
} from './types'

// 纯领域引擎：采样 → 检测 → 出具报告 → 发起复核 → 复核通过/退回 → 核查清单同步。
// 所有函数都返回新状态，不修改入参；持久化与时钟由外层注入，方便对并发互斥和失败回退做单测。

export interface Clock {
  now: () => string
}

export interface CreateReportInput {
  code: string
  station: string
  sampledAt: string
  inspector: string
}

export interface EnterResultsInput {
  reportId: number
  expectedRevision: number
  inspector: string
  items: Array<{ name: string; reading: string; limit: string }>
}

const STATUS_LABEL: Record<QualityStatus, string> = {
  sampled: '已采样',
  testing: '检测中',
  reported: '已出报告',
  reviewing: '复核中',
  reviewed: '已复核',
}

/** 原始读数与标准上限的数值比对；无法解析成数字（如“未检出”）时返回 null，不臆断结论。 */
export function compareReading(reading: string, limit: string): boolean | null {
  const value = Number.parseFloat(reading)
  const upper = Number.parseFloat(limit)
  if (Number.isNaN(value) || Number.isNaN(upper)) {
    return null
  }
  return value > upper
}

function assertStatus(report: QualityReport, allowed: QualityStatus[], action: string): void {
  if (!allowed.includes(report.status)) {
    throw new QualityConflictError(
      `报告 ${report.code} 当前状态为「${STATUS_LABEL[report.status]}」，不能执行${action}`,
    )
  }
}

function assertRevision(report: QualityReport, expected: number, action: string): void {
  if (report.revision !== expected) {
    throw new QualityConflictError(
      `报告 ${report.code} 的数据已被其他操作更新（版本 ${report.revision}），${action}未执行，请刷新后重试`,
    )
  }
}

function replaceReport(state: QualityState, report: QualityReport): QualityState {
  return {
    ...state,
    reports: state.reports.map((item) => (item.id === report.id ? report : item)),
  }
}

function upsertCheck(
  state: QualityState,
  report: QualityReport,
  status: CheckStatus,
  note: string,
  now: string,
): QualityState {
  const exceededItems = report.items.filter((item) => item.exceeded === true).map((item) => item.name)
  const next: QualityCheckItem = {
    id: `check-${report.id}`,
    reportId: report.id,
    code: report.code,
    station: report.station,
    exceededItems,
    status,
    note,
    updatedAt: now,
  }
  const rest = state.checks.filter((item) => item.reportId !== report.id)
  return { ...state, checks: [...rest, next] }
}

/** 登记采样：报告从「已采样」起步，此时还没有任何读数。 */
export function createReport(
  state: QualityState,
  input: CreateReportInput,
  clock: Clock,
): QualityState {
  const now = clock.now()
  const id = state.reports.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const report: QualityReport = {
    id,
    code: input.code,
    station: input.station,
    sampledAt: input.sampledAt,
    inspector: input.inspector,
    status: 'sampled',
    items: [],
    abnormal: false,
    review: null,
    reviewRound: 0,
    history: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  return { ...state, reports: [...state.reports, report] }
}

/** 开始检测：已采样 → 检测中。 */
export function startTesting(
  state: QualityState,
  reportId: number,
  expectedRevision: number,
  clock: Clock,
): QualityState {
  const report = state.reports.find((item) => item.id === reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${reportId} 的水质检测报告`)
  }
  assertRevision(report, expectedRevision, '开始检测')
  assertStatus(report, ['sampled'], '开始检测')
  return replaceReport(state, {
    ...report,
    status: 'testing',
    revision: report.revision + 1,
    updatedAt: clock.now(),
  })
}

/**
 * 录入检测读数：检测中可反复修改草稿读数。
 * 注意此时不算超标结论——结论只在「出具报告」当时冻结一次，保证按当时结果留痕。
 */
export function enterResults(state: QualityState, input: EnterResultsInput, clock: Clock): QualityState {
  const report = state.reports.find((item) => item.id === input.reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${input.reportId} 的水质检测报告`)
  }
  assertRevision(report, input.expectedRevision, '保存读数')
  assertStatus(report, ['testing'], '录入检测读数')
  const items: QualityItem[] = input.items.map((entry) => ({
    name: entry.name,
    reading: entry.reading,
    limit: entry.limit,
    exceeded: null,
  }))
  return replaceReport(state, {
    ...report,
    inspector: input.inspector || report.inspector,
    items,
    revision: report.revision + 1,
    updatedAt: clock.now(),
  })
}

/**
 * 出具报告：冻结原始读数与当时的超标判定，检测中 → 已出报告。
 * 只要有任一项目超标，就幂等生成/更新一条待核查项（一份报告在清单里始终只出现一次）。
 */
export function issueReport(
  state: QualityState,
  reportId: number,
  expectedRevision: number,
  clock: Clock,
): QualityState {
  const report = state.reports.find((item) => item.id === reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${reportId} 的水质检测报告`)
  }
  assertRevision(report, expectedRevision, '出具报告')
  assertStatus(report, ['testing'], '出具报告')
  if (report.items.length === 0) {
    throw new QualityConflictError(`报告 ${report.code} 还没有录入检测读数，不能出具报告`)
  }
  const now = clock.now()
  // 按出具当时的读数冻结结论；此后复核流程永不重算、永不覆盖。
  const items: QualityItem[] = report.items.map((item) => ({
    ...item,
    exceeded: compareReading(item.reading, item.limit),
  }))
  const abnormal = items.some((item) => item.exceeded === true)
  const issued: QualityReport = {
    ...report,
    items,
    abnormal,
    status: 'reported',
    revision: report.revision + 1,
    updatedAt: now,
  }
  let next = replaceReport(state, issued)
  if (abnormal) {
    next = upsertCheck(next, issued, 'pending', '报告出具时判定超标，生成待核查项', now)
  }
  return next
}

/**
 * 发起复核：已出报告/已复核 → 复核中。
 * 只创建复核草稿（reviewer/opinion/findings 都属于中间结论），绝不触碰 items 原始读数。
 * 并发第二发会被状态或 revision 拦住，保证一轮复核只落一次。
 */
export function startReview(state: QualityState, input: StartReviewInput, clock: Clock): QualityState {
  const report = state.reports.find((item) => item.id === input.reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${input.reportId} 的水质检测报告`)
  }
  assertRevision(report, input.expectedRevision, '发起复核')
  if (report.status === 'reviewing') {
    throw new QualityConflictError(`报告 ${report.code} 已在复核中，请勿重复发起`)
  }
  assertStatus(report, ['reported', 'reviewed'], '发起复核')
  const round = report.reviewRound + 1
  const reviewing: QualityReport = {
    ...report,
    status: 'reviewing',
    reviewRound: round,
    review: { reviewer: '', opinion: '', findings: {}, submittedAt: '' },
    revision: report.revision + 1,
    updatedAt: clock.now(),
  }
  return replaceReport(state, reviewing)
}

/** 保存复核草稿（复核人、意见、项目级中间结论）；同样走版本号互斥，不覆盖原始读数。 */
export function saveReviewDraft(
  state: QualityState,
  input: Pick<SubmitReviewInput, 'reportId' | 'expectedRevision' | 'reviewer' | 'opinion' | 'findings'>,
  clock: Clock,
): QualityState {
  const report = state.reports.find((item) => item.id === input.reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${input.reportId} 的水质检测报告`)
  }
  assertRevision(report, input.expectedRevision, '保存复核意见')
  assertStatus(report, ['reviewing'], '保存复核意见')
  if (!report.review) {
    throw new QualityConflictError(`报告 ${report.code} 的复核流程不存在，请重新发起复核`)
  }
  return replaceReport(state, {
    ...report,
    review: {
      ...report.review,
      reviewer: input.reviewer,
      opinion: input.opinion,
      findings: { ...input.findings },
    },
    revision: report.revision + 1,
    updatedAt: clock.now(),
  })
}

/**
 * 提交复核结论：
 * - 通过：复核人/意见/项目结论作为最终中间结论保留，状态 → 已复核；超标报告的核查项 → 已核查。
 * - 退回：只清当前轮次的中间结论（review 整段清空），原始读数 items 原样保留并可追溯，
 *   状态回到已出报告；超标报告的核查项重新置为待核查（reopened）。
 * 报告与核查项在同一份状态里一起改，由外层一次性落库；落库失败整体回退。
 */
export function submitReview(state: QualityState, input: SubmitReviewInput, clock: Clock): QualityState {
  const report = state.reports.find((item) => item.id === input.reportId)
  if (!report) {
    throw new QualityConflictError(`没有找到编号为 ${input.reportId} 的水质检测报告`)
  }
  assertRevision(report, input.expectedRevision, '提交复核')
  assertStatus(report, ['reviewing'], '提交复核')
  if (!report.review) {
    throw new QualityConflictError(`报告 ${report.code} 的复核流程不存在，请重新发起复核`)
  }
  if (input.reviewer.trim() === '') {
    throw new QualityConflictError(`报告 ${report.code} 缺少复核人，不能提交复核结论`)
  }
  const now = clock.now()
  const entry: ReviewHistoryEntry = {
    round: report.reviewRound,
    verdict: input.verdict,
    reviewer: input.reviewer,
    opinion: input.opinion,
    submittedAt: now,
  }

  if (input.verdict === '退回') {
    // 关键不变量：退回只清中间结论，items（原始读数）与 abnormal（当时判定）一律不动。
    const returned: QualityReport = {
      ...report,
      items: report.items.map((item) => ({ ...item })),
      status: 'reported',
      review: null,
      history: [...report.history, entry],
      revision: report.revision + 1,
      updatedAt: now,
    }
    let next = replaceReport(state, returned)
    if (returned.abnormal) {
      next = upsertCheck(
        next,
        returned,
        'reopened',
        `第 ${returned.reviewRound} 轮复核退回，重新待核查`,
        now,
      )
    }
    return next
  }

  const approved: QualityReport = {
    ...report,
    status: 'reviewed',
    review: {
      reviewer: input.reviewer,
      opinion: input.opinion,
      findings: { ...input.findings },
      submittedAt: now,
    },
    history: [...report.history, entry],
    revision: report.revision + 1,
    updatedAt: now,
  }
  let next = replaceReport(state, approved)
  if (approved.abnormal) {
    next = upsertCheck(next, approved, 'verified', `第 ${approved.reviewRound} 轮复核通过，完成核查`, now)
  }
  return next
}
