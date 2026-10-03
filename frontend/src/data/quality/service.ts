import {
  createReport,
  enterResults,
  issueReport,
  saveReviewDraft,
  startReview,
  startTesting,
  submitReview,
} from './engine'
import type { Clock, CreateReportInput, EnterResultsInput } from './engine'
import { commit, getState, listChecks, listReports } from './store'
import type {
  QualityCheckItem,
  QualityReport,
  QualityState,
  StartReviewInput,
  SubmitReviewInput,
} from './types'

// 水质领域服务：页面只调这里，把时钟、持久化、并发版本号都收口在数据层。

const defaultClock: Clock = {
  now: () => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  },
}

export interface ActionResult {
  ok: boolean
  message: string
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

export function qualityState(): QualityState {
  return getState()
}

export function qualityReports(): QualityReport[] {
  return listReports()
}

export function qualityChecks(): QualityCheckItem[] {
  return listChecks()
}

export function getReport(id: number): QualityReport | undefined {
  return listReports().find((report) => report.id === id)
}

export function registerSample(input: CreateReportInput): ActionResult {
  try {
    commit((state) => createReport(state, input, defaultClock))
    return { ok: true, message: `采样登记完成，报告编号 ${input.code}` }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '采样登记失败')
  }
}

export function beginTesting(report: QualityReport): ActionResult {
  try {
    commit((state) => startTesting(state, report.id, report.revision, defaultClock))
    return { ok: true, message: `报告 ${report.code} 已进入检测中` }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '开始检测失败')
  }
}

export function saveResults(input: Omit<EnterResultsInput, 'expectedRevision'> & { revision: number }): ActionResult {
  try {
    commit((state) =>
      enterResults(
        state,
        {
          reportId: input.reportId,
          expectedRevision: input.revision,
          inspector: input.inspector,
          items: input.items,
        },
        defaultClock,
      ),
    )
    return { ok: true, message: '检测读数已暂存（出具报告前可修改）' }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '检测读数保存失败')
  }
}

export function publishReport(report: QualityReport): ActionResult {
  try {
    commit((state) => issueReport(state, report.id, report.revision, defaultClock))
    return { ok: true, message: `报告 ${report.code} 已出具，原始读数已锁定` }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '出具报告失败')
  }
}

export function openReview(report: QualityReport): ActionResult {
  const input: StartReviewInput = { reportId: report.id, expectedRevision: report.revision }
  try {
    commit((state) => startReview(state, input, defaultClock))
    return { ok: true, message: `报告 ${report.code} 已发起复核，原始读数保持锁定` }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '发起复核失败')
  }
}

export function saveDraft(
  report: QualityReport,
  draft: { reviewer: string; opinion: string; findings: SubmitReviewInput['findings'] },
): ActionResult {
  try {
    commit((state) =>
      saveReviewDraft(
        state,
        {
          reportId: report.id,
          expectedRevision: report.revision,
          reviewer: draft.reviewer,
          opinion: draft.opinion,
          findings: draft.findings,
        },
        defaultClock,
      ),
    )
    return { ok: true, message: '复核意见已暂存' }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '复核意见保存失败')
  }
}

export function submitConclusion(
  report: QualityReport,
  draft: { reviewer: string; opinion: string; findings: SubmitReviewInput['findings']; verdict: '通过' | '退回' },
): ActionResult {
  const input: SubmitReviewInput = {
    reportId: report.id,
    expectedRevision: report.revision,
    reviewer: draft.reviewer,
    opinion: draft.opinion,
    findings: draft.findings,
    verdict: draft.verdict,
  }
  try {
    // 报告状态与核查项在引擎里是同一份状态，commit 一次性落库；失败由 store 整体回退。
    commit((state) => submitReview(state, input, defaultClock))
    return draft.verdict === '通过'
      ? { ok: true, message: '复核通过，最终结论已记录，超标核查项同步完成核查' }
      : { ok: true, message: '复核已退回：中间结论已清空，原始读数按当时结果保留，核查项重新待核查' }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '复核提交失败')
  }
}
