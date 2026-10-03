import type { EntryRow } from '@/data/types'

import {
  CHECKLIST_KEY,
  LEGACY_REVIEWER,
  REPORT_STATUS,
  WATER_QUALITY_KEY,
  isOverProof,
  makeCheckItem,
  nowText,
  reportAbnormal,
  reportPending,
  upsertCheckItem,
} from './domain'
import type { QualityCheckItem, QualityReviewRecord, QualitySnapshot } from './types'

/**
 * 历史数据补齐：
 * 1. 已出报告但缺原始读数快照的，按当时行内读数补一份「历史补齐」快照，原始读数按当时结果留痕；
 * 2. 已复核但缺复核人、复核记录的，用系统补齐身份补终局记录，不伪造真实复核人；
 * 3. 历史超标报告补一条核查项，避免迁移后清单漏项或重复生成。
 */
export function migrateWaterQuality(
  reports: EntryRow[],
  checklist: QualityCheckItem[],
): { reports: EntryRow[]; checklist: QualityCheckItem[] } {
  const timestamp = nowText()
  let nextChecklist = [...checklist]

  const nextReports = reports.map((row) => {
    const status = String(row.status ?? '')
    const afterReport: string[] = [
      REPORT_STATUS.overProof,
      REPORT_STATUS.reviewing,
      REPORT_STATUS.reviewed,
      REPORT_STATUS.returned,
      REPORT_STATUS.reported,
    ]

    const next: EntryRow = { ...row }

    if (afterReport.includes(status) && !next.originalSnapshot) {
      // 快照按当时结果取行内读数，只补这一次，后续任何操作都不会再改它。
      const overProof =
        status === REPORT_STATUS.overProof ||
        isOverProof(String(row['检测值'] ?? ''), String(row['标准上限'] ?? ''))
      const snapshot: QualitySnapshot = {
        station: String(row['采样站点'] ?? ''),
        sampledAt: String(row['采样时间'] ?? ''),
        item: String(row['检测项目'] ?? ''),
        value: String(row['检测值'] ?? ''),
        limit: String(row['标准上限'] ?? ''),
        tester: String(row['检测人'] ?? ''),
        overProof,
        lockedAt: timestamp,
        source: '历史补齐',
      }
      next.originalSnapshot = snapshot
    }

    if (status === REPORT_STATUS.reviewed) {
      const records = Array.isArray(next.reviewRecords)
        ? [...(next.reviewRecords as QualityReviewRecord[])]
        : []
      if (records.length === 0) {
        const snapshot = next.originalSnapshot as QualitySnapshot | undefined
        // 历史已复核报告无法还原当时结论：维持原判定，缺复核人统一记系统补齐，保持审计可辨。
        const overProof = snapshot ? snapshot.overProof : false
        records.push({
          reviewer: LEGACY_REVIEWER,
          finishedAt: timestamp,
          conclusion: overProof ? '超标属实' : '复测合格',
          reviewValue: snapshot ? snapshot.value : String(row['检测值'] ?? ''),
          comment: '历史报告缺少复核记录，系统按报告原结论补齐留痕',
          source: '历史补齐',
        })
      }
      next.reviewRecords = records
      if (!next.reviewRecordsBackfilled && !next['复核人']) {
        next['复核人'] = LEGACY_REVIEWER
        next.reviewRecordsBackfilled = true
      }
    }

    // 中间态不允许作为历史残留：迁移阶段遇到裸「复核中」（无 token）一律视为未发起，
    // 回到出报告时的状态（超标 / 已出报告），原始快照仍在。
    if (status === REPORT_STATUS.reviewing) {
      const draft = next.reviewDraft as { token?: string } | undefined
      if (!draft || !draft.token) {
        const snapshotBeforeReturn = next.originalSnapshot as QualitySnapshot | undefined
        next.status = snapshotBeforeReturn?.overProof
          ? REPORT_STATUS.overProof
          : REPORT_STATUS.reported
      }
    }

    next.pending = reportPending(String(next.status))
    next.abnormal = reportAbnormal(String(next.status))

    const snapshot = next.originalSnapshot as QualitySnapshot | undefined
    if (snapshot?.overProof) {
      const existingIndex = nextChecklist.findIndex((item) => item.reportId === Number(next.id))
      if (existingIndex < 0) {
        // 只补缺失项；已存在的核查项（含用户已解除预警的）保持现状，迁移幂等不回退人工状态。
        const checkStatus: QualityCheckItem['status'] =
          String(next.status) === REPORT_STATUS.reviewed ? '已核查关闭' : '待核查'
        nextChecklist = upsertCheckItem(nextChecklist, makeCheckItem({
          reportId: Number(next.id),
          reportNo: String(next['报告编号'] ?? ''),
          station: snapshot.station,
          item: snapshot.item,
          value: snapshot.value,
          limit: snapshot.limit,
          status: checkStatus,
          note: '历史超标报告，迁移时按报告状态补齐',
          createdAt: timestamp,
          updatedAt: timestamp,
          source: '历史补齐',
        }))
      }
    }

    return next
  })

  return { reports: nextReports, checklist: nextChecklist }
}

/** 读取存储后统一迁移：历史数据在进入缓存前补齐，页面拿到的一定是规范结构。 */
export function migrateTables(
  tables: Record<string, EntryRow[] | QualityCheckItem[]>,
): Record<string, EntryRow[] | QualityCheckItem[]> {
  const reports = (tables[WATER_QUALITY_KEY] ?? []) as EntryRow[]
  const checklist = (tables[CHECKLIST_KEY] ?? []) as QualityCheckItem[]
  const migrated = migrateWaterQuality(reports, checklist)
  return {
    ...tables,
    [WATER_QUALITY_KEY]: migrated.reports,
    [CHECKLIST_KEY]: migrated.checklist,
  }
}
