/**
 * 水质检测领域类型。
 * 调用链：采样(已采样) → 开始检测(检测中) → 出具报告(已出报告/超标) → 发起复核(复核中)
 *        → 复核通过(已复核) / 复核退回(复核退回)，超标报告同步进入预警核查清单。
 *
 * 关键约束：原始读数在出具报告时锁定为快照，复核只能新增结论，任何环节都不得改写快照。
 */

/** 原始读数快照：出具报告那一刻落定，复核通过、退回都只动复核字段，快照永久留痕。 */
export type QualitySnapshot = {
  station: string
  sampledAt: string
  item: string
  value: string
  limit: string
  tester: string
  overProof: boolean
  lockedAt: string
  /** 检测出报告时锁定为正式快照；历史数据补出来的快照单独标记，便于审计区分。 */
  source: '检测出报告' | '历史补齐'
}

export type ReviewConclusion = '超标属实' | '复测合格'

/** 复核中间态：发起复核时写入，复核有终局结论或被退回时必须清掉（退回只清中间结论）。 */
export type QualityReviewDraft = {
  token: string
  reviewer: string
  startedAt: string
  comment: string
}

/** 复核终局记录：一旦形成不可覆盖；再次发起复核会产生新记录前，旧记录仍保留在留痕里。 */
export type QualityReviewRecord = {
  reviewer: string
  finishedAt: string
  conclusion: ReviewConclusion
  reviewValue: string
  comment: string
  source: '复核' | '历史补齐'
}

export type CheckItemStatus = '待核查' | '已核查关闭' | '解除预警'

/** 预警核查清单项：一份超标报告只对应一项，按 reportId 幂等去重。 */
export type QualityCheckItem = {
  /** 清单行的编号与报告编号一致，方便复用本地表存储。 */
  id: number
  status: CheckItemStatus
  pending: boolean
  abnormal: boolean
  reportId: number
  reportNo: string
  station: string
  item: string
  value: string
  limit: string
  note: string
  createdAt: string
  updatedAt: string
  source: '检测出报告' | '历史补齐'
}

export type IssueReportInput = {
  tester: string
  value: string
  limit: string
}

export type SubmitReviewInput = {
  conclusion: ReviewConclusion
  reviewValue: string
  comment: string
}
