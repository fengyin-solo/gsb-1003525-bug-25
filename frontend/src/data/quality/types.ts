// 水质检测领域类型：采样 → 检测 → 复核 → 预警核查 共用这一套结构。
// 设计要点：
// 1. items 是「原始读数」，出具报告时冻结，任何复核动作都不改它（留痕）。
// 2. review 是复核产生的「中间结论」，退回时整段清掉，原始读数不受影响。
// 3. revision 是乐观锁版本号：并发复核只有持有最新版本的一方能落库。

/** 单项检测结果；itemValue/limit 保留原始字符串（如“未检出”），能解析成数字时才参与超标判定。 */
export interface QualityItem {
  /** 检测项目，如 高锰酸盐指数 */
  name: string
  /** 原始读数：采样检测时录入什么就存什么，后续永不覆盖 */
  reading: string
  /** 标准上限的原始值 */
  limit: string
  /** 出具报告当时算出的结论，冻结在条目上；null 表示无法做数值比对 */
  exceeded: boolean | null
}

export type ReviewVerdict = '通过' | '退回'

/** 一次复核结论。退回只清这段，不动 items。 */
export interface QualityReview {
  /** 当前轮次的复核人（提交时落定，起草阶段为空串） */
  reviewer: string
  /** 当前轮次的复核意见 */
  opinion: string
  /** 复核人给出的项目级中间结论：复核弹窗里编辑，退回时随整段一起清空 */
  findings: Record<string, ReviewVerdict>
  submittedAt: string
}

/** 复核留痕：退回后当前 review 被清空，但历史轮次仍可追溯。 */
export interface ReviewHistoryEntry {
  round: number
  verdict: ReviewVerdict
  reviewer: string
  opinion: string
  submittedAt: string
}

/**
 * 报告状态：
 * sampled 已采样 / testing 检测中 / reported 已出报告 / reviewing 复核中 / reviewed 已复核
 * 「超标」不是独立状态：报告出具时若任一项目超标就置 abnormal=true，复核流程不改变这个原始结论。
 */
export type QualityStatus = 'sampled' | 'testing' | 'reported' | 'reviewing' | 'reviewed'

export interface QualityReport {
  id: number
  code: string
  station: string
  sampledAt: string
  /** 检测人（采样检测阶段录入） */
  inspector: string
  status: QualityStatus
  /** 原始检测项目与读数：出具报告后锁定 */
  items: QualityItem[]
  /** 出具报告当时的超标结论，冻结留痕 */
  abnormal: boolean
  /** 当前复核轮次的中间结论；复核通过/退回后按规则清空 */
  review: QualityReview | null
  /** 已经发起过几轮复核（含被退回的） */
  reviewRound: number
  history: ReviewHistoryEntry[]
  /** 乐观锁：每次成功落库 +1 */
  revision: number
  createdAt: string
  updatedAt: string
}

/** 预警核查清单状态：pending 待核查 / verified 已核查（复核通过）/ reopened 退回后重新待核查 */
export type CheckStatus = 'pending' | 'verified' | 'reopened'

export interface QualityCheckItem {
  id: string
  /** 一份超标报告只对应一条核查项，用 reportId 幂等去重 */
  reportId: number
  code: string
  station: string
  /** 快照的超标项目名，列表里直接展示，不再回表拼两份结果 */
  exceededItems: string[]
  status: CheckStatus
  /** 最近一次状态变更说明 */
  note: string
  updatedAt: string
}

export interface QualityState {
  reports: QualityReport[]
  checks: QualityCheckItem[]
  /** 历史 localStorage 数据迁移标记，保证补齐只跑一次 */
  migrated: boolean
}

/** 复核提交参数 */
export interface SubmitReviewInput {
  reportId: number
  /** 调用方读取报告时拿到的版本号，用于并发互斥 */
  expectedRevision: number
  reviewer: string
  opinion: string
  findings: Record<string, ReviewVerdict>
  verdict: ReviewVerdict
}

/** 发起复核参数 */
export interface StartReviewInput {
  reportId: number
  expectedRevision: number
}

/** 落库失败：报告和核查项需要一起回退，用这个错误把信息带回调用方 */
export class QualityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QualityConflictError'
  }
}
