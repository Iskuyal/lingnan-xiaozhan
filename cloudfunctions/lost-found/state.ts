/**
 * 失物招领状态机（纯函数,迁移表是 docs/domain/lost-found.md 第 2 节的唯一实现处）。
 */
import { ClaimStatus, PostStatus } from './types';

const POST_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['open', 'closed'],
  open: ['matching', 'verifying', 'closed', 'suspended'],
  matching: ['open', 'verifying', 'closed', 'suspended'],
  verifying: ['open', 'resolved', 'closed', 'suspended'],
  resolved: ['closed'],
  closed: [],
  suspended: ['open', 'closed'],
};

const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  pending: ['needs_more_info', 'accepted', 'rejected', 'cancelled'],
  needs_more_info: ['pending', 'rejected', 'cancelled'],
  accepted: ['completed', 'cancelled', 'disputed'],
  rejected: [],
  cancelled: [],
  completed: [],
  disputed: ['completed', 'cancelled'],
};

const POST_STATUSES: PostStatus[] = Object.keys(POST_TRANSITIONS) as PostStatus[];
const CLAIM_STATUSES: ClaimStatus[] = Object.keys(CLAIM_TRANSITIONS) as ClaimStatus[];

export function isPostStatus(value: string): value is PostStatus {
  return (POST_STATUSES as string[]).includes(value);
}

export function isClaimStatus(value: string): value is ClaimStatus {
  return (CLAIM_STATUSES as string[]).includes(value);
}

export function canTransitionPost(from: string, to: string): boolean {
  if (!isPostStatus(from) || !isPostStatus(to)) return false;
  return POST_TRANSITIONS[from].includes(to);
}

export function canTransitionClaim(from: string, to: string): boolean {
  if (!isClaimStatus(from) || !isClaimStatus(to)) return false;
  return CLAIM_TRANSITIONS[from].includes(to);
}

/** 帖子是否还参与匹配/接受认领(终态与暂停态都不参与)。 */
export function isPostActive(status: PostStatus): boolean {
  return status === 'open' || status === 'matching' || status === 'verifying';
}

/** 认领是否还在流转中(非终态)。 */
export function isClaimActive(status: ClaimStatus): boolean {
  return status === 'pending' || status === 'needs_more_info' || status === 'accepted' || status === 'disputed';
}
