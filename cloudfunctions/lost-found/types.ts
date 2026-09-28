/**
 * 失物招领云函数类型契约（LF-3 非 AI 基线）。
 *
 * 状态机与字段口径见 docs/domain/lost-found.md 与 docs/tasks/lost-found-framework.md；
 * 私密核验特征只在 private 集合出现,任何公开返回值都不得携带。
 */

export type PostType = 'lost' | 'found';

export type PostStatus =
  | 'draft'
  | 'open'
  | 'matching'
  | 'verifying'
  | 'resolved'
  | 'closed'
  | 'suspended';

export type ClaimStatus =
  | 'pending'
  | 'needs_more_info'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'completed'
  | 'disputed';

/** 物品类别白名单(待拍板项,与设计图一致)。 */
export const POST_CATEGORIES = ['校园卡', '证件', '电子设备', '钥匙', '其他'] as const;
export type PostCategory = typeof POST_CATEGORIES[number];

/** 公开的模糊时间范围(只到日期,不含时刻)。 */
export interface TimeRange {
  start: string;
  end: string;
}

/** 创建/编辑帖子的输入(未收敛,校验后转成 PostRecord)。 */
export interface PostInput {
  type?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
  timeRange?: unknown;
  locationArea?: unknown;
  images?: unknown;
  verificationTraits?: unknown;
  agree?: unknown;
}

/** 认领申请输入。 */
export interface ClaimInput {
  relation?: unknown;
  evidence?: unknown;
}

/** 帖子公开记录(集合 lost_found_posts)。 */
export interface PostRecord {
  postId: string;
  ownerOpenId: string;
  type: PostType;
  category: PostCategory;
  title: string;
  description: string;
  images: string[];
  timeRange: TimeRange;
  locationArea: string;
  status: PostStatus;
  closeReason: string;
  version: number;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

/** 帖子私密记录(集合 lost_found_post_private,仅发布者与授权云函数访问)。 */
export interface PostPrivateRecord {
  postId: string;
  ownerOpenId: string;
  verificationTraits: string;
  /** 授权记录与删除计划(LF-5 填充;LF-3 只保留字段)。 */
  consentAt: number;
  deletePlanAt: number | null;
}

/** 候选(集合 lost_found_matches):规则召回版本与 AI 解释版本分开存。 */
export interface MatchRecord {
  matchId: string;
  sourcePostId: string;
  candidatePostId: string;
  /** 规则召回(LF-3)与 AI 重排(LF-4)都会写这一行,按版本字段区分。 */
  ruleVersion: string;
  modelVersion: string;
  promptVersion: string;
  rank: number;
  similarities: string[];
  conflicts: string[];
  uncertainties: string[];
  confidenceBand: 'low' | 'medium' | 'high';
  needsHumanVerification: boolean;
  feedback: 'helpful' | 'irrelevant' | 'misleading' | '';
  expiresAt: number;
  createdAt: number;
}

/** 认领申请(集合 lost_found_claims)。 */
export interface ClaimRecord {
  claimId: string;
  postId: string;
  claimantOpenId: string;
  relation: string;
  evidence: string;
  status: ClaimStatus;
  /** 发布者要求补充的内容 / 拒绝原因。 */
  reviewerNote: string;
  version: number;
  claimantConfirmedAt: number | null;
  ownerConfirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 审计事件(集合 lost_found_audit_events,不存图片/提示词/密钥)。 */
export interface AuditEvent {
  eventId: string;
  actorOpenId: string;
  action: string;
  postId: string;
  claimId: string;
  summary: string;
  createdAt: number;
}

/** 云函数支持的动作。 */
export type LostFoundAction =
  | 'createPost'
  | 'updatePost'
  | 'closePost'
  | 'getPost'
  | 'getMyPosts'
  | 'listPosts'
  | 'submitClaim'
  | 'reviewClaim'
  | 'confirmHandover'
  | 'cancelClaim'
  | 'listClaimsForPost'
  | 'listMatches'
  | 'feedbackMatch'
  | 'reportPost'
  | 'deletePost';

/** 统一返回值:不抛裸异常,失败带分类与文案(与 ai/timetable 云函数约定一致)。 */
export interface LostFoundResponse {
  ok: boolean;
  failureClass: 'invalid_request' | 'forbidden' | 'not_found' | 'conflict' | 'internal' | '';
  message: string;
  data: Record<string, unknown>;
}
