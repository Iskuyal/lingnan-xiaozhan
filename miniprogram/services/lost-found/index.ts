/**
 * 失物招领 · 小程序端服务封装。
 *
 * 只经 cloudfunctions/lost-found 云函数访问;身份由服务端取(不传任何身份字段);
 * 失败文案以服务端 message 为准,传输失败走 services/cloud.ts 的约定。
 */
import { requireCloud, transportMessage as sharedTransportMessage } from '../cloud';
import {
  ClaimView,
  LostFoundResult,
  MatchView,
  PostType,
  PostView,
  TimeRange,
} from './types';

export { POST_CATEGORIES } from './types';

export const LOST_FOUND_FUNCTION = 'lost-found';

const FAILURE_FALLBACK: Record<string, string> = {
  invalid_request: '信息填写不完整或格式不对，请检查后重试',
  forbidden: '没有权限执行这个操作',
  not_found: '内容不存在或已被删除',
  conflict: '状态已变化，请刷新后重试',
  internal: '服务开小差了，请稍后重试',
};

/** 云函数返回的业务结果;调用未到达云端时抛错,由 transportMessage 转文案。 */
async function call(action: string, data: Record<string, unknown>): Promise<LostFoundResult> {
  requireCloud();
  const response = await wx.cloud.callFunction({ name: LOST_FOUND_FUNCTION, data: { action, ...data } });
  const result = response === null || response === undefined ? undefined : response.result;
  if (result === null || result === undefined || typeof result !== 'object') {
    throw new Error('失物招领服务返回了无法识别的结果');
  }
  const source = result as Record<string, unknown>;
  return {
    ok: source.ok === true,
    failureClass: typeof source.failureClass === 'string'
      ? (source.failureClass as LostFoundResult['failureClass'])
      : '',
    message: typeof source.message === 'string' ? source.message : '',
    data: source.data !== null && source.data !== undefined && typeof source.data === 'object'
      ? source.data as Record<string, unknown>
      : {},
  };
}

export function userMessage(result: LostFoundResult): string {
  if (result.ok) return '';
  if (result.message !== '') return result.message;
  const known = FAILURE_FALLBACK[result.failureClass];
  return known !== undefined ? known : FAILURE_FALLBACK.internal;
}

export function transportMessage(error: unknown): string {
  return sharedTransportMessage(error, {
    service: '失物招领服务',
    logLabel: '失物招领调用失败',
    fallback: '失物招领服务暂时不可用，请稍后重试',
  });
}

/** 读取数组形状的数据字段(服务端没给/形状不对时给空数组,不让页面崩)。 */
function asArray<T>(value: unknown, shape: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const rows: T[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const row = shape(item as Record<string, unknown>);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function asPost(item: Record<string, unknown>): PostView | null {
  if (typeof item.postId !== 'string' || typeof item.title !== 'string') return null;
  return {
    postId: item.postId,
    version: typeof item.version === 'number' ? item.version : 1,
    type: item.type === 'lost' || item.type === 'found' ? item.type : 'lost',
    category: typeof item.category === 'string' ? item.category : '',
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    images: Array.isArray(item.images) ? item.images.filter((one): one is string => typeof one === 'string') : [],
    timeRange: item.timeRange !== null && typeof item.timeRange === 'object'
      ? item.timeRange as TimeRange
      : { start: '', end: '' },
    locationArea: typeof item.locationArea === 'string' ? item.locationArea : '',
    status: typeof item.status === 'string' ? item.status as PostView['status'] : 'open',
    closeReason: typeof item.closeReason === 'string' ? item.closeReason : '',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    closedAt: typeof item.closedAt === 'number' ? item.closedAt : null,
    verificationTraits: typeof item.verificationTraits === 'string' ? item.verificationTraits : undefined,
    isOwner: item.isOwner === true,
  };
}

function asClaim(item: Record<string, unknown>): ClaimView | null {
  if (typeof item.claimId !== 'string') return null;
  return {
    claimId: item.claimId,
    postId: typeof item.postId === 'string' ? item.postId : '',
    status: typeof item.status === 'string' ? item.status as ClaimView['status'] : 'pending',
    relation: typeof item.relation === 'string' ? item.relation : '',
    evidence: typeof item.evidence === 'string' ? item.evidence : '',
    reviewerNote: typeof item.reviewerNote === 'string' ? item.reviewerNote : '',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    claimantConfirmedAt: typeof item.claimantConfirmedAt === 'number' ? item.claimantConfirmedAt : null,
    ownerConfirmedAt: typeof item.ownerConfirmedAt === 'number' ? item.ownerConfirmedAt : null,
  };
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asMatch(item: Record<string, unknown>): MatchView | null {
  if (typeof item.matchId !== 'string') return null;
  return {
    matchId: item.matchId,
    sourcePostId: typeof item.sourcePostId === 'string' ? item.sourcePostId : '',
    candidatePostId: typeof item.candidatePostId === 'string' ? item.candidatePostId : '',
    ruleVersion: typeof item.ruleVersion === 'string' ? item.ruleVersion : '',
    modelVersion: typeof item.modelVersion === 'string' ? item.modelVersion : '',
    promptVersion: typeof item.promptVersion === 'string' ? item.promptVersion : '',
    rank: typeof item.rank === 'number' ? item.rank : 0,
    similarities: asStrings(item.similarities),
    conflicts: asStrings(item.conflicts),
    uncertainties: asStrings(item.uncertainties),
    confidenceBand: item.confidenceBand === 'low' || item.confidenceBand === 'medium' || item.confidenceBand === 'high'
      ? item.confidenceBand
      : 'low',
    needsHumanVerification: item.needsHumanVerification === true,
    feedback: item.feedback === 'helpful' || item.feedback === 'irrelevant' || item.feedback === 'misleading'
      ? item.feedback
      : '',
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
  };
}

export interface PostInput {
  type: PostType;
  category: string;
  title: string;
  description: string;
  timeRange: TimeRange;
  locationArea: string;
  images: string[];
  verificationTraits: string;
  agree: boolean;
  /** 发布(open)或存草稿(draft);默认发布。 */
  status?: 'open' | 'draft';
}

export async function createPost(input: PostInput): Promise<LostFoundResult> {
  return call('createPost', { input, status: input.status ?? 'open' });
}

export interface PostUpdateInput {
  title: string;
  description: string;
  timeRange: TimeRange;
  locationArea: string;
  version: number;
  /** 草稿转发布时传 open。 */
  status?: 'open';
}

export async function updatePost(postId: string, input: PostUpdateInput): Promise<LostFoundResult> {
  return call('updatePost', { postId, input });
}

export async function feedbackMatch(matchId: string, feedback: 'helpful' | 'irrelevant' | 'misleading'): Promise<LostFoundResult> {
  return call('feedbackMatch', { matchId, feedback });
}

export async function closePost(postId: string, reason: string): Promise<LostFoundResult> {
  return call('closePost', { postId, reason });
}

export async function getPost(postId: string): Promise<LostFoundResult> {
  return call('getPost', { postId });
}

export async function getMyPosts(): Promise<LostFoundResult> {
  return call('getMyPosts', {});
}

export async function listPosts(input: { type?: PostType; category?: string; page?: number; pageSize?: number }): Promise<LostFoundResult> {
  return call('listPosts', { input });
}

export async function submitClaim(postId: string, input: { relation: string; evidence: string }): Promise<LostFoundResult> {
  return call('submitClaim', { postId, input });
}

export async function reviewClaim(claimId: string, toStatus: string, note: string): Promise<LostFoundResult> {
  return call('reviewClaim', { claimId, toStatus, note });
}

export async function confirmHandover(postId: string, claimId: string): Promise<LostFoundResult> {
  return call('confirmHandover', { postId, claimId });
}

export async function listMatches(postId: string): Promise<LostFoundResult> {
  return call('listMatches', { postId });
}

export async function listClaimsForPost(postId: string): Promise<LostFoundResult> {
  return call('listClaimsForPost', { postId });
}

export async function deletePost(postId: string): Promise<LostFoundResult> {
  return call('deletePost', { postId });
}

/** 取 data.posts(列表接口)。 */
export function postsOf(result: LostFoundResult): PostView[] {
  return asArray(result.data.posts, asPost);
}

/** 取 data.post(详情接口)。 */
export function postOf(result: LostFoundResult): PostView | null {
  const item = result.data.post;
  if (item === null || typeof item !== 'object') return null;
  return asPost(item as Record<string, unknown>);
}

export function claimsOf(result: LostFoundResult): ClaimView[] {
  return asArray(result.data.claims, asClaim);
}

export function matchesOf(result: LostFoundResult): MatchView[] {
  return asArray(result.data.matches, asMatch);
}

/** 展示用:帖子类型文案与徽标。 */
export const POST_TYPE_LABEL: Record<PostType, string> = { lost: '丢失', found: '拾获' };

export const POST_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  open: '待匹配',
  matching: '匹配中',
  verifying: '待核验',
  resolved: '已结案',
  closed: '已关闭',
  suspended: '已暂停',
};

export const CLAIM_STATUS_LABEL: Record<string, string> = {
  pending: '待核验',
  needs_more_info: '需补充',
  accepted: '已通过',
  rejected: '已拒绝',
  cancelled: '已取消',
  completed: '已完成',
  disputed: '争议中',
};
