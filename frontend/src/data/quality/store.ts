import { SEED_QUALITY_STATE } from './seed'
import { QualityConflictError } from './types'
import type { QualityCheckItem, QualityReport, QualityState } from './types'

// 水质领域存储：
// - 独立 localStorage 键，与通用模块的演示数据互不影响。
// - normalizeAll 在每次读取时补齐「已复核却缺复核人」的历史报告（只补复核人，不碰最终结论）。
// - reconcileChecks 依据报告超标结论重建核查清单，保证一份超标报告只有一条核查项、不重复。
// - commit 采用「先在快照上算 → 一次性写入 → 写失败回滚内存与 storage」的事务语义，
//   报告和核查项同生共死，不会出现一边改了一边没改。

export const QUALITY_STORAGE_KEY = 'hydrology-monitor-station:waterquality-v2'

/** 历史报告缺少复核人时的补齐方式：统一标记为系统补齐，不伪造具体人名、不改最终结论。 */
export const LEGACY_REVIEWER_PLACEHOLDER = '系统补齐（历史报告）'

export interface Persistence {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserPersistence(): Persistence | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    removeItem: (key) => window.localStorage.removeItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 为已复核却没有复核人的历史报告补齐标记；其它字段（含最终结论、原始读数）保持原样。 */
export function normalizeReport(report: QualityReport): QualityReport {
  if (report.status !== 'reviewed' || !report.review || report.review.reviewer.trim() !== '') {
    return report
  }
  const review = { ...report.review, reviewer: LEGACY_REVIEWER_PLACEHOLDER }
  const history =
    report.history.length > 0
      ? report.history.map((entry) =>
          entry.reviewer.trim() === '' ? { ...entry, reviewer: LEGACY_REVIEWER_PLACEHOLDER } : entry,
        )
      : [
          {
            round: report.reviewRound || 1,
            verdict: '通过' as const,
            reviewer: LEGACY_REVIEWER_PLACEHOLDER,
            opinion: review.opinion || '历史数据补齐',
            submittedAt: review.submittedAt || report.updatedAt,
          },
        ]
  return { ...report, review, history }
}

/** 依据规范化后的报告重建核查清单：只认报告的超标结论，一份报告一条，避免重复待核查。 */
export function reconcileChecks(state: QualityState, stamp: string): QualityCheckItem[] {
  const byReport = new Map(state.checks.map((item) => [item.reportId, item]))
  const result: QualityCheckItem[] = []
  for (const report of state.reports) {
    if (!report.abnormal) {
      continue
    }
    const existed = byReport.get(report.id)
    const exceededItems = report.items.filter((item) => item.exceeded === true).map((item) => item.name)
    let status = existed?.status
    if (!status) {
      status = report.status === 'reviewed' ? 'verified' : 'pending'
    }
    if (status === 'verified' && report.status !== 'reviewed') {
      status = report.status === 'reviewing' ? 'pending' : 'reopened'
    }
    result.push({
      id: `check-${report.id}`,
      reportId: report.id,
      code: report.code,
      station: report.station,
      exceededItems: exceededItems.length > 0 ? exceededItems : (existed?.exceededItems ?? []),
      status,
      note: existed?.note ?? '历史超标报告补齐核查项',
      updatedAt: existed?.updatedAt ?? stamp,
    })
  }
  return result
}

let persistenceRef: Persistence | null | undefined
let cache: QualityState | null = null
let seedRef: QualityState = clone(SEED_QUALITY_STATE)

/** 测试钩子：注入持久化实现与种子数据，隔离浏览器 localStorage。 */
export function configureQualityStore(options: { persistence?: Persistence | null; seed?: QualityState }): void {
  if (options.seed) {
    seedRef = clone(options.seed)
  }
  persistenceRef = options.persistence === undefined ? persistenceRef : options.persistence
  cache = null
}

function persistence(): Persistence | null {
  if (persistenceRef === undefined) {
    persistenceRef = browserPersistence()
  }
  return persistenceRef
}

function normalizeAll(state: QualityState): QualityState {
  const reports = state.reports.map(normalizeReport)
  const withReports: QualityState = { ...state, reports, checks: state.checks ?? [] }
  return { ...withReports, checks: reconcileChecks(withReports, new Date(0).toISOString()) }
}

function initialState(): QualityState {
  const storage = persistence()
  if (!storage) {
    return normalizeAll(clone(seedRef))
  }
  const raw = storage.getItem(QUALITY_STORAGE_KEY)
  if (raw) {
    try {
      return normalizeAll(JSON.parse(raw) as QualityState)
    } catch {
      // 落库内容损坏时回到种子，不让脏数据卡死页面。
    }
  }
  const state = normalizeAll(clone(seedRef))
  storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(state))
  return state
}

export function getState(): QualityState {
  if (!cache) {
    cache = initialState()
  }
  return cache
}

export function listReports(): QualityReport[] {
  return getState().reports
}

export function listChecks(): QualityCheckItem[] {
  return getState().checks
}

/** 测试钩子：模拟下一次落库抛错，验证报告与核查项一起回退。 */
let failNextWrite = false
export function failNextPersistence(): void {
  failNextWrite = true
}

/**
 * 在当前快照上执行一次领域变更并原子落库。
 * mutate 必须返回引擎算出的新状态；任何一步抛错都恢复原快照（内存 + storage 都不残留半写结果）。
 */
export function commit(mutate: (state: QualityState) => QualityState): QualityState {
  const snapshot = getState()
  const backup = clone(snapshot)
  let next: QualityState
  try {
    next = mutate(snapshot)
  } catch (error) {
    cache = backup
    throw error
  }
  const storage = persistence()
  try {
    if (storage) {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('模拟落库失败（磁盘不可用）')
      }
      storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    // 落库失败：报告和核查项一起回退到提交前快照。
    cache = backup
    if (storage) {
      try {
        storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(backup))
      } catch {
        // 回滚写也失败时至少保证内存仍是旧快照，storage 由下次操作覆盖。
      }
    }
    throw new QualityConflictError(
      `复核结果落库失败，报告与核查项已整体回退：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  cache = next
  return next
}

export function resetQualityState(): QualityState {
  const fresh = normalizeAll(clone(seedRef))
  const storage = persistence()
  if (storage) {
    storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(fresh))
  }
  cache = fresh
  return fresh
}

export function storageKey(): string {
  return QUALITY_STORAGE_KEY
}
