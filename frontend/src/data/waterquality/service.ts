import { commitTables, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

import {
  CHECKLIST_KEY,
  REPORT_STATUS,
  REVIEWABLE_STATUSES,
  WATER_QUALITY_KEY,
  isOverProof,
  makeCheckItem,
  nowText,
  parseNumber,
  reportAbnormal,
  reportPending,
  snapshotOf,
  upsertCheckItem,
  withCheckStatus,
} from './domain'
import type {
  IssueReportInput,
  QualityCheckItem,
  QualityReviewDraft,
  QualityReviewRecord,
  QualitySnapshot,
  SubmitReviewInput,
} from './types'

function reports(): EntryRow[] {
  return listRows(WATER_QUALITY_KEY)
}

function checklist(): QualityCheckItem[] {
  return listRows(CHECKLIST_KEY) as QualityCheckItem[]
}

/**
 * 多表原子提交：报告与核查清单一起进事务。
 * 落库（序列化 / localStorage 写入）失败时 commitRows 不会更新缓存，
 * 调用方无需补救——报告状态和核查项一起停留在操作前。
 */
function commit(reportRows: EntryRow[], checkItems: QualityCheckItem[]): void {
  commitTables({ [WATER_QUALITY_KEY]: reportRows, [CHECKLIST_KEY]: checkItems })
}

function findReport(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

/** 行内展示字段始终取自锁定快照；快照未落定（采样/检测中）才回退行内登记值。 */
function fieldOf(row: EntryRow, snapshotKey: keyof QualitySnapshot, field: string): string {
  const snapshot = snapshotOf(row)
  if (snapshot) {
    return String(snapshot[snapshotKey] ?? '')
  }
  return String(row[field] ?? '')
}

/* ---------------- 采样 / 检测 / 出报告 ---------------- */

export type CreateSampleInput = {
  reportNo: string
  station: string
  sampledAt: string
  item: string
  limit: string
}

/**
 * 复核并发锁：一张报告同时只允许一个复核会话。
 * 锁只存在于当前页面内存；真正防并发的依据是落库的 reviewDraft（token），
 * 页面刷新或别的标签页进来，只要落库草稿的 token 与提交者不一致就拒绝提交。
 */
const reviewLocks = new Map<number, string>()

function makeToken(): string {
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function listWaterQuality(): EntryRow[] {
  // 展示字段与锁定快照对齐：原始读数在列表里只有一份，复核结论另列，绝不出现两份检测项目/读数。
  return reports().map((row) => displayRow(row))
}

export function listChecklist(): QualityCheckItem[] {
  return checklist()
}

export function createSample(input: CreateSampleInput): ActionResult {
  if (!input.reportNo.trim() || !input.station.trim() || !input.item.trim()) {
    return { ok: false, message: '报告编号、采样站点、检测项目不能为空' }
  }
  const rows = reports()
  if (rows.some((row) => String(row['报告编号']) === input.reportNo.trim())) {
    return { ok: false, message: `报告编号 ${input.reportNo} 已存在` }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: REPORT_STATUS.sampled,
    pending: true,
    abnormal: false,
    报告编号: input.reportNo.trim(),
    采样站点: input.station.trim(),
    采样时间: input.sampledAt.trim() || nowText(),
    检测项目: input.item.trim(),
    检测值: '待检测',
    标准上限: input.limit.trim(),
    检测人: '',
    报告状态: REPORT_STATUS.sampled,
  }
  try {
    commit([...rows, row], checklist())
  } catch {
    return { ok: false, message: '采样登记落库失败，已回退，请重试' }
  }
  return { ok: true, message: `采样报告 ${input.reportNo} 已登记` }
}

export function startTesting(id: number, tester: string): ActionResult {
  if (!tester.trim()) {
    return { ok: false, message: '请填写检测人后再开始检测' }
  }
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  if (String(rows[index].status) !== REPORT_STATUS.sampled) {
    return { ok: false, message: '只有「已采样」的报告能开始检测' }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: REPORT_STATUS.testing,
    pending: true,
    abnormal: false,
    检测人: tester.trim(),
    检测值: '检测中',
    报告状态: REPORT_STATUS.testing,
  }
  try {
    commit(next, checklist())
  } catch {
    return { ok: false, message: '开始检测落库失败，已回退，请重试' }
  }
  return { ok: true, message: '报告已进入检测，检测人：' + tester.trim() }
}

/**
 * 出具报告：此时锁定原始读数快照。
 * 快照一旦写入不再被任何后续动作改写；超标则同步往核查清单补一项（按报告幂等去重）。
 */
export function issueReport(id: number, input: IssueReportInput): ActionResult {
  if (!input.tester.trim()) {
    return { ok: false, message: '请填写检测人' }
  }
  if (parseNumber(input.value) === null) {
    return { ok: false, message: '检测值需填写可比较的数字' }
  }
  if (parseNumber(input.limit) === null) {
    return { ok: false, message: '标准上限需填写可比较的数字' }
  }
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  const current = rows[index]
  if (String(current.status) !== REPORT_STATUS.testing) {
    return { ok: false, message: '只有「检测中」的报告能出具报告' }
  }

  const overProof = isOverProof(input.value, input.limit)
  const status = overProof ? REPORT_STATUS.overProof : REPORT_STATUS.reported
  // 原始读数只在此时落定一次，此后全程只读。
  const snapshot: QualitySnapshot = {
    station: String(current['采样站点'] ?? ''),
    sampledAt: String(current['采样时间'] ?? ''),
    item: String(current['检测项目'] ?? ''),
    value: input.value.trim(),
    limit: input.limit.trim(),
    tester: input.tester.trim(),
    overProof,
    lockedAt: nowText(),
    source: '检测出报告',
  }
  const updated: EntryRow = {
    ...current,
    status,
    pending: reportPending(status),
    abnormal: reportAbnormal(status),
    检测人: input.tester.trim(),
    检测值: snapshot.value,
    标准上限: snapshot.limit,
    报告状态: status,
    originalSnapshot: snapshot,
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  let nextChecklist = checklist()
  if (overProof) {
    // 一份超标报告一项待核查：reportId 相同则覆盖更新而不是新增，超标报告不会重复挂「待核查」。
    nextChecklist = upsertCheckItem(
      nextChecklist,
      makeCheckItem({
        reportId: id,
        reportNo: String(current['报告编号'] ?? ''),
        station: snapshot.station,
        item: snapshot.item,
        value: snapshot.value,
        limit: snapshot.limit,
        status: '待核查',
        note: '检测出报告，判定超标，待核查',
        createdAt: nowText(),
        updatedAt: nowText(),
        source: '检测出报告',
      }),
    )
  }

  try {
    commit(nextRows, nextChecklist)
  } catch {
    return { ok: false, message: '报告落库失败，报告与核查清单已一起回退，请重试' }
  }
  return {
    ok: true,
    message: overProof ? '报告已出具并判定超标，已进入预警核查清单' : '报告已出具，结果合格',
  }
}

/* ---------------- 复核：发起 / 提交 / 退回 ---------------- */

/** 页面刷新后按落库草稿接续复核会话；锁只恢复给草稿上的复核人。 */
export function resumeReviewSession(id: number): StartReviewResult {
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  const current = rows[index]
  if (String(current.status) !== REPORT_STATUS.reviewing) {
    return { ok: false, message: '报告当前不在复核中' }
  }
  const draft = current.reviewDraft as QualityReviewDraft | undefined
  if (!draft?.token) {
    return { ok: false, message: '在途复核草稿缺失，请退回后重新发起' }
  }
  reviewLocks.set(id, draft.token)
  return { ok: true, message: `接续 ${draft.reviewer} 的复核会话`, token: draft.token, draft }
}

export type StartReviewResult = ActionResult & { token?: string; draft?: QualityReviewDraft }

/**
 * 发起复核：只在报告上挂复核中间态草稿，绝不覆盖检测项目与原始读数。
 * 已有在途草稿时返回原草稿（同一复核人继续填），第二个人重复发起直接拒绝——并发复核只落一次。
 */
export function startReview(id: number, reviewer: string, comment = ''): StartReviewResult {
  if (!reviewer.trim()) {
    return { ok: false, message: '请填写复核人' }
  }
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  const current = rows[index]
  const status = String(current.status)

  const existing = current.reviewDraft as QualityReviewDraft | undefined
  if (existing?.token) {
    if (existing.reviewer === reviewer.trim()) {
      reviewLocks.set(id, existing.token)
      return { ok: true, message: '复核仍在进行中，继续上次填写', token: existing.token, draft: existing }
    }
    return {
      ok: false,
      message: `该报告已由「${existing.reviewer}」发起复核，并发复核只落一次，请等待其结论或退回`,
    }
  }

  if (!REVIEWABLE_STATUSES.includes(status as (typeof REVIEWABLE_STATUSES)[number])) {
    return { ok: false, message: `当前状态「${status}」不能发起复核` }
  }
  // 报告必须已有锁定原始读数，没有快照说明数据不完整，禁止进入复核。
  if (!snapshotOf(current)) {
    return { ok: false, message: '报告缺少原始读数留痕，不能发起复核' }
  }

  if (reviewLocks.has(id)) {
    return { ok: false, message: '该报告已有复核会话正在进行，请勿重复发起' }
  }

  const token = makeToken()
  const draft: QualityReviewDraft = {
    token,
    reviewer: reviewer.trim(),
    startedAt: nowText(),
    comment,
  }
  const next = [...rows]
  // 复核中沿用以报告锁定快照的超标定性，abnormal 由快照决定而不是由动作名决定。
  next[index] = {
    ...current,
    status: REPORT_STATUS.reviewing,
    pending: true,
    abnormal: snapshotOf(current)?.overProof ?? false,
    报告状态: REPORT_STATUS.reviewing,
    reviewDraft: draft,
  }
  reviewLocks.set(id, token)
  try {
    commit(next, checklist())
  } catch {
    reviewLocks.delete(id)
    return { ok: false, message: '发起复核落库失败，已回退，请重试' }
  }
  return { ok: true, message: '复核已发起，原始读数已锁定，仅可填写复核结论', token, draft }
}

/**
 * 提交复核终局：
 * - token 必须与在途草稿一致，防止并发第二个人把结论也落进去（并发复核只落一次）；
 * - 只写复核结论（reviewRecords）和复核值，原始快照一行不动；
 * - 中间结论草稿清空；核查项随终局结论联动：维持超标→关闭，改判合格→解除预警。
 */
export function submitReview(id: number, token: string, input: SubmitReviewInput): ActionResult {
  if (!token) {
    return { ok: false, message: '复核会话已失效，请重新发起复核' }
  }
  if (parseNumber(input.reviewValue) === null) {
    return { ok: false, message: '复核读数需填写可比较的数字' }
  }
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  const current = rows[index]
  if (String(current.status) !== REPORT_STATUS.reviewing) {
    return { ok: false, message: '报告当前不在复核中，不能提交复核结论' }
  }
  const draft = current.reviewDraft as QualityReviewDraft | undefined
  if (!draft?.token) {
    return { ok: false, message: '在途复核草稿缺失，请退回后重新发起' }
  }
  if (draft.token !== token || reviewLocks.get(id) !== token) {
    return { ok: false, message: '复核会话与在途复核不一致（可能已有他人提交），本次结论不予落库' }
  }

  const snapshot = snapshotOf(current)
  if (!snapshot) {
    return { ok: false, message: '原始读数留痕缺失，不能提交复核' }
  }

  const record: QualityReviewRecord = {
    reviewer: draft.reviewer,
    finishedAt: nowText(),
    conclusion: input.conclusion,
    reviewValue: input.reviewValue.trim(),
    comment: input.comment.trim(),
    source: '复核',
  }
  const records = [
    ...((current.reviewRecords as QualityReviewRecord[] | undefined) ?? []),
    record,
  ]

  const updated: EntryRow = {
    ...current,
    status: REPORT_STATUS.reviewed,
    pending: false,
    abnormal: false,
    复核人: draft.reviewer,
    报告状态: REPORT_STATUS.reviewed,
    reviewRecords: records,
    reviewDraft: null,
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 核查清单只在「确有超标留痕」的报告上存在；按终局结论更新对应状态，其它入口读到的就是新状态。
  let nextChecklist = checklist()
  const checkIndex = nextChecklist.findIndex((item) => item.reportId === id)
  if (input.conclusion === '超标属实') {
    if (checkIndex >= 0) {
      const items = [...nextChecklist]
      items[checkIndex] = withCheckStatus(
        items[checkIndex],
        '已核查关闭',
        `复核维持超标（复核人：${draft.reviewer}），核查关闭`,
      )
      nextChecklist = items
    }
  } else {
    // 复测合格：预警解除；若该报告历史上挂过核查项则更新，未挂过不新增。
    if (checkIndex >= 0) {
      const items = [...nextChecklist]
      items[checkIndex] = withCheckStatus(
        items[checkIndex],
        '解除预警',
        `复核改判合格（复核人：${draft.reviewer}），预警解除`,
      )
      nextChecklist = items
    }
  }

  try {
    commit(nextRows, nextChecklist)
  } catch {
    // 锁保持在途草稿对应的 token：没落库的复核不算数，复核人可凭原会话重试。
    return { ok: false, message: '复核结论落库失败，报告与核查项已一起回退，请重试提交' }
  }
  reviewLocks.delete(id)
  return { ok: true, message: `复核完成：${input.conclusion}` }
}

/**
 * 复核退回：只清中间结论（草稿），报告回到出报告时的原状态（超标 / 已出报告），
 * 原始读数快照原样保留；超标报告的核查项回到「待核查」。
 */
export function returnReview(id: number, token: string, reason: string): ActionResult {
  if (!reason.trim()) {
    return { ok: false, message: '请填写退回原因' }
  }
  const rows = reports()
  const index = findReport(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的报告` }
  }
  const current = rows[index]
  if (String(current.status) !== REPORT_STATUS.reviewing) {
    return { ok: false, message: '报告当前不在复核中，不能退回' }
  }
  const draft = current.reviewDraft as QualityReviewDraft | undefined
  if (!draft?.token || draft.token !== token || reviewLocks.get(id) !== token) {
    return { ok: false, message: '复核会话与在途复核不一致，不能代为退回' }
  }
  const snapshot = snapshotOf(current)
  if (!snapshot) {
    return { ok: false, message: '原始读数留痕缺失，不能退回' }
  }

  // 退回后的报告状态必须与当初出报告的结果一致，而不是笼统退回「检测中」覆盖原检测项目。
  const restoredStatus = snapshot.overProof ? REPORT_STATUS.overProof : REPORT_STATUS.reported
  const updated: EntryRow = {
    ...current,
    status: restoredStatus,
    pending: reportPending(restoredStatus),
    abnormal: reportAbnormal(restoredStatus),
    报告状态: `${restoredStatus}（复核退回）`,
    reviewDraft: null,
    reviewReturnedAt: nowText(),
    reviewReturnReason: reason.trim(),
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  let nextChecklist = checklist()
  if (snapshot.overProof) {
    const checkIndex = nextChecklist.findIndex((item) => item.reportId === id)
    if (checkIndex >= 0) {
      const items = [...nextChecklist]
      items[checkIndex] = withCheckStatus(items[checkIndex], '待核查', '复核退回，恢复待核查')
      nextChecklist = items
    } else {
      // 异常数据修复：理论上超标报告必有核查项，缺失则按锁定快照补回。
      nextChecklist = upsertCheckItem(
        nextChecklist,
        makeCheckItem({
          reportId: id,
          reportNo: String(current['报告编号'] ?? ''),
          station: snapshot.station,
          item: snapshot.item,
          value: snapshot.value,
          limit: snapshot.limit,
          status: '待核查',
          createdAt: nowText(),
          updatedAt: nowText(),
          source: snapshot.source,
          note: '复核退回时按原始留痕补回核查项',
        }),
      )
    }
  }

  try {
    commit(nextRows, nextChecklist)
  } catch {
    return { ok: false, message: '退回操作落库失败，已回退，请重试' }
  }
  reviewLocks.delete(id)
  return { ok: true, message: '已退回：中间复核结论已清除，原始读数保留，报告恢复出报告状态' }
}

/* ---------------- 核查清单（其它入口：预警等） ---------------- */

function updateCheckItem(
  reportId: number,
  status: QualityCheckItem['status'],
  note: string,
): ActionResult {
  const items = checklist()
  const index = items.findIndex((item) => item.reportId === reportId)
  if (index < 0) {
    return { ok: false, message: '核查清单项不存在或已被移除' }
  }
  if (items[index].status === status) {
    return { ok: false, message: `核查项已经是「${status}」，不用重复操作` }
  }
  const next = [...items]
  next[index] = withCheckStatus(next[index], status, note)
  try {
    commit(reports(), next)
  } catch {
    return { ok: false, message: '核查状态落库失败，已回退，请重试' }
  }
  return { ok: true, message: `核查项已更新为「${status}」` }
}

/** 核查关闭：现场/人工确认超标，确认处置完毕。只动核查项，报告原始结论不变。 */
export function closeCheckItem(reportId: number): ActionResult {
  return updateCheckItem(reportId, '已核查关闭', `人工核查关闭于 ${nowText()}`)
}

/** 解除预警：核查后确认无需预警（如复测合格、阈值调整）。 */
export function releaseCheckItem(reportId: number): ActionResult {
  return updateCheckItem(reportId, '解除预警', `核查解除预警于 ${nowText()}`)
}

/* ---------------- 展示辅助 ---------------- */

export function displayRow(row: EntryRow): EntryRow {
  const snapshot = snapshotOf(row)
  if (!snapshot) {
    return { ...row }
  }
  // 列表/弹窗/清单三处统一口径：检测项目与读数只显示锁定快照这一份。
  return {
    ...row,
    采样站点: snapshot.station,
    采样时间: snapshot.sampledAt,
    检测项目: snapshot.item,
    检测值: snapshot.value,
    标准上限: snapshot.limit,
    检测人: snapshot.tester,
  }
}

export { fieldOf }
