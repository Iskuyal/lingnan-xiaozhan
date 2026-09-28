/**
 * 失物招领 · 小程序端类型(与 cloudfunctions/lost-found/types.ts 的公开契约同步)。
 *
 * 小程序不引用云函数目录,这里复制公开形状;私密核验特征只在
 * `isOwner` 视图中出现,任何页面渲染前不得把它放进列表/卡片。
 */

export type PostType = 'lost' | 'found';

export type PostStatus =
  | 'draft' | 'open' | 'matching' | 'verifying' | 'resolved' | 'closed' | 'suspended';

export type ClaimStatus =
  | 'pending' | 'needs_more_info' | 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'disputed';

export const POST_CATEGORIES = ['校园卡', '证件', '电子设备', '钥匙', '其他'] as const;

export interface TimeRange {
  start: string;
  end: string;
}

/** 公开帖子视图(服务端 publicView 的形状)。 */
export interface PostView {
  postId: string;
  /** 乐观锁版本,编辑时回传。 */
  version: number;
  type: PostType;
  category: string;
  title: string;
  description: string;
  images: string[];
  timeRange: TimeRange;
  locationArea: string;
  status: PostStatus;
  closeReason: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** 仅本人视图存在;私密核验特征,页面只在「我的帖子」标注「仅你可见」时展示。 */
  verificationTraits?: string;
  isOwner?: boolean;
}

export interface ClaimView {
  claimId: string;
  postId: string;
  status: ClaimStatus;
  relation: string;
  evidence: string;
  reviewerNote: string;
  createdAt: number;
  updatedAt: number;
  claimantConfirmedAt: number | null;
  ownerConfirmedAt: number | null;
}

export interface MatchView {
  matchId: string;
  sourcePostId: string;
  candidatePostId: string;
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

/** 云函数统一返回(与 lost-found/index.ts 的 LostFoundResponse 对齐)。 */
export interface LostFoundResult {
  ok: boolean;
  failureClass: 'invalid_request' | 'forbidden' | 'not_found' | 'conflict' | 'internal' | '';
  message: string;
  data: Record<string, unknown>;
}
