import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createReport,
  enterResults,
  issueReport,
  startReview,
  startTesting,
  submitReview,
} from '../engine'
import {
  LEGACY_REVIEWER_PLACEHOLDER,
  configureQualityStore,
  commit,
  failNextPersistence,
  getState,
  normalizeReport,
  storageKey,
} from '../store'
import { SEED_QUALITY_STATE } from '../seed'
import type { QualityState } from '../types'
import { fixedClock, memoryStorage } from './helpers'

function setup(): ReturnType<typeof memoryStorage> {
  const storage = memoryStorage()
  configureQualityStore({ persistence: storage, seed: SEED_QUALITY_STATE })
  return storage
}

function reportFlowToIssued(
  state: QualityState,
  items: Array<{ name: string; reading: string; limit: string }>,
): QualityState {
  let next = createReport(
    state,
    { code: 'WQ-TEST', station: '测试断面', sampledAt: '2026-10-03 08:00', inspector: '检测员' },
    fixedClock,
  )
  const id = next.reports[next.reports.length - 1].id
  const rev1 = next.reports[next.reports.length - 1].revision
  next = startTesting(next, id, rev1, fixedClock)
  const rev2 = next.reports[next.reports.length - 1].revision
  next = enterResults(next, { reportId: id, expectedRevision: rev2, inspector: '检测员', items }, fixedClock)
  const rev3 = next.reports[next.reports.length - 1].revision
  next = issueReport(next, id, rev3, fixedClock)
  return next
}

test('出具报告时冻结原始读数与超标结论，复核退回后读数仍按当时结果留痕', () => {
  const storage = setup()
  // 用临时状态跑一份超标报告，再灌进 store，验证端到端链路。
  const issued = reportFlowToIssued(
    { reports: [], checks: [], migrated: true },
    [
      { name: '氨氮', reading: '1.84', limit: '1.0' },
      { name: '总磷', reading: '0.15', limit: '0.2' },
    ],
  )
  const report = issued.reports[issued.reports.length - 1]
  assert.equal(report.abnormal, true)
  assert.deepEqual(
    report.items.map((i) => i.exceeded),
    [true, false],
  )
  // 出具后生成且只生成一条待核查项。
  assert.equal(issued.checks.length, 1)
  assert.equal(issued.checks[0].status, 'pending')
  assert.deepEqual(issued.checks[0].exceededItems, ['氨氮'])

  configureQualityStore({ persistence: storage, seed: issued })
  const id = report.id
  const revIssued = getState().reports.find((r) => r.id === id)!.revision

  // 发起复核 → 退回。
  commit((s) => startReview(s, { reportId: id, expectedRevision: revIssued }, fixedClock))
  const reviewing = getState().reports.find((r) => r.id === id)!
  assert.equal(reviewing.status, 'reviewing')
  // 复核中的原始读数必须与出具当时完全一致。
  assert.deepEqual(JSON.stringify(reviewing.items), JSON.stringify(report.items))

  commit((s) =>
    submitReview(
      s,
      {
        reportId: id,
        expectedRevision: reviewing.revision,
        reviewer: '复核员',
        opinion: '样品存疑',
        findings: { 氨氮: '退回', 总磷: '退回' },
        verdict: '退回',
      },
      fixedClock,
    ),
  )

  const after = getState().reports.find((r) => r.id === id)!
  // 中间结论被清空。
  assert.equal(after.review, null)
  assert.equal(after.status, 'reported')
  // 原始读数与当时超标结论原样保留。
  assert.equal(after.abnormal, true)
  assert.deepEqual(
    after.items.map((i) => [i.name, i.reading, i.limit, i.exceeded]),
    [
      ['氨氮', '1.84', '1.0', true],
      ['总磷', '0.15', '0.2', false],
    ],
  )
  // 退回留痕。
  assert.equal(after.history.length, 1)
  assert.equal(after.history[0].verdict, '退回')
  // 核查项重新待核查，且仍只有一条（不重复出现）。
  const check = getState().checks.filter((c) => c.reportId === id)
  assert.equal(check.length, 1)
  assert.equal(check[0].status, 'reopened')
})

test('复核通过：最终结论保留、核查项变已核查，原始读数不变', () => {
  const storage = setup()
  const issued = reportFlowToIssued(
    { reports: [], checks: [], migrated: true },
    [{ name: '氨氮', reading: '1.84', limit: '1.0' }],
  )
  configureQualityStore({ persistence: storage, seed: issued })
  const id = issued.reports[issued.reports.length - 1].id
  const rev = getState().reports.find((r) => r.id === id)!.revision

  commit((s) => startReview(s, { reportId: id, expectedRevision: rev }, fixedClock))
  const reviewing = getState().reports.find((r) => r.id === id)!
  commit((s) =>
    submitReview(
      s,
      {
        reportId: id,
        expectedRevision: reviewing.revision,
        reviewer: '复核员',
        opinion: '认可',
        findings: { 氨氮: '通过' },
        verdict: '通过',
      },
      fixedClock,
    ),
  )

  const done = getState().reports.find((r) => r.id === id)!
  assert.equal(done.status, 'reviewed')
  assert.equal(done.review?.reviewer, '复核员')
  assert.equal(done.review?.findings.氨氮, '通过')
  assert.equal(done.items[0].exceeded, true) // 原始超标结论未被复核通过“洗白”
  const check = getState().checks.find((c) => c.reportId === id)!
  assert.equal(check.status, 'verified')
})

test('并发复核：旧版本号提交被拒，一轮复核只落一次', () => {
  const storage = setup()
  const issued = reportFlowToIssued(
    { reports: [], checks: [], migrated: true },
    [{ name: '氨氮', reading: '0.4', limit: '1.0' }],
  )
  configureQualityStore({ persistence: storage, seed: issued })
  const id = issued.reports[issued.reports.length - 1].id
  const rev = getState().reports.find((r) => r.id === id)!.revision

  // A、B 几乎同时发起复核：A 成功，B 持旧版本号应失败。
  const a = commit((s) => startReview(s, { reportId: id, expectedRevision: rev }, fixedClock))
  assert.equal(a.reports.find((r) => r.id === id)!.status, 'reviewing')
  assert.throws(
    () => commit((s) => startReview(s, { reportId: id, expectedRevision: rev }, fixedClock)),
    /已被其他操作更新|已在复核中/,
  )

  // A 提交通过后，B 再拿旧版本号提交同样被拒。
  const reviewing = getState().reports.find((r) => r.id === id)!
  const staleRev = reviewing.revision
  commit((s) =>
    submitReview(
      s,
      { reportId: id, expectedRevision: staleRev, reviewer: 'A', opinion: '', findings: {}, verdict: '通过' },
      fixedClock,
    ),
  )
  assert.throws(
    () =>
      commit((s) =>
        submitReview(
          s,
          { reportId: id, expectedRevision: staleRev, reviewer: 'B', opinion: '', findings: {}, verdict: '通过' },
          fixedClock,
        ),
      ),
    /已被其他操作更新|不能执行提交复核/,
  )
  // 最终只有 A 的一轮结论。
  const final = getState().reports.find((r) => r.id === id)!
  assert.equal(final.review?.reviewer, 'A')
  assert.equal(final.history.length, 1)
  assert.equal(final.reviewRound, 1)
})

test('落库失败时报告与核查项一起回退，storage 中不残留半写结果', () => {
  const storage = setup()
  const issued = reportFlowToIssued(
    { reports: [], checks: [], migrated: true },
    [{ name: '氨氮', reading: '1.84', limit: '1.0' }],
  )
  configureQualityStore({ persistence: storage, seed: issued })
  const id = issued.reports[issued.reports.length - 1].id
  const rev = getState().reports.find((r) => r.id === id)!.revision
  commit((s) => startReview(s, { reportId: id, expectedRevision: rev }, fixedClock))
  const reviewing = getState().reports.find((r) => r.id === id)!
  const checkBefore = getState().checks.find((c) => c.reportId === id)!
  assert.equal(checkBefore.status, 'pending')

  // 让下一次写入失败。
  failNextPersistence()
  assert.throws(
    () =>
      commit((s) =>
        submitReview(
          s,
          {
            reportId: id,
            expectedRevision: reviewing.revision,
            reviewer: '复核员',
            opinion: '认可',
            findings: { 氨氮: '通过' },
            verdict: '通过',
          },
          fixedClock,
        ),
      ),
    /整体回退/,
  )

  // 内存状态：仍是复核中、版本号未推进、核查项仍待核查。
  const mem = getState().reports.find((r) => r.id === id)!
  assert.equal(mem.status, 'reviewing')
  assert.equal(mem.revision, reviewing.revision)
  assert.equal(getState().checks.find((c) => c.reportId === id)!.status, 'pending')

  // storage 落盘状态同样回退，没有半写。
  const persisted = storage.dump(storageKey()) as QualityState
  const persistedReport = persisted.reports.find((r) => r.id === id)!
  assert.equal(persistedReport.status, 'reviewing')
  assert.equal(persistedReport.revision, reviewing.revision)
  assert.equal(persisted.checks.find((c) => c.reportId === id)!.status, 'pending')
})

test('历史已复核报告缺复核人时补齐占位，且不改最终结论与原始读数', () => {
  const storage = setup()
  const historical = getState().reports.find((r) => r.id === 6)!
  assert.equal(historical.status, 'reviewed')
  assert.equal(historical.review?.reviewer, LEGACY_REVIEWER_PLACEHOLDER)
  // 最终结论字段不被伪造：findings 仍为空（历史缺失），原始超标结论保留。
  assert.deepEqual(historical.review?.findings, {})
  assert.equal(historical.abnormal, true)
  assert.equal(historical.items.find((i) => i.name === '氨氮')?.exceeded, true)
  // 核查项保持已核查。
  assert.equal(getState().checks.find((c) => c.reportId === 6)?.status, 'verified')
})

test('normalizeReport 只补缺复核人，不改动有复核人的报告', () => {
  const reviewed = getState().reports.find((r) => r.id === 5)!
  const normalized = normalizeReport(reviewed)
  assert.equal(normalized, reviewed)
})
