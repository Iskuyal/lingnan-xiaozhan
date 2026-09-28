/**
 * 失物招领 · 帖子数据层。
 *
 * 依赖注入 db(测试传内存桩,生产由入口注入云数据库);
 * 权限校验在数据层内完成(越权由测试锁定),私密特征只在本人读取时返回。
 */
import {
  LostFoundResponse,
  PostInput,
  PostRecord,
  PostPrivateRecord,
} from './types';
import { validatePost } from './validate';
import { canTransitionPost, isPostActive } from './state';
import { ownerHashOf } from './security';
import { record } from './audit';

const POSTS = 'lost_found_posts';
const PRIVATE = 'lost_found_post_private';

interface Db {
  collection(name: string): any;
}

export function ok(data: Record<string, unknown> = {}): LostFoundResponse {
  return { ok: true, failureClass: '', message: '', data };
}

export function fail(
  failureClass: LostFoundResponse['failureClass'],
  message: string,
  data: Record<string, unknown> = {},
): LostFoundResponse {
  return { ok: false, failureClass, message, data };
}

function newId(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 公开视图:strip 掉一切不该外发的字段(私密特征、ownerOpenId 以外的内部字段保留 ownerOpenId 用于本人比对)。 */
function publicView(post: PostRecord): Record<string, unknown> {
  return {
    postId: post.postId,
    type: post.type,
    category: post.category,
    title: post.title,
    description: post.description,
    images: post.images,
    timeRange: post.timeRange,
    locationArea: post.locationArea,
    status: post.status,
    closeReason: post.closeReason,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    closedAt: post.closedAt,
  };
}

async function readPost(db: Db, postId: string): Promise<(PostRecord & { _id: string }) | null> {
  try {
    const doc = await db.collection(POSTS).doc(postId).get();
    return doc.data as PostRecord & { _id: string };
  } catch {
    return null;
  }
}

export async function createPost(
  db: Db,
  openid: string,
  input: PostInput,
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const check = validatePost(input, ownerHashOf(openid));
  if (!check.ok) return fail('invalid_request', check.reason);
  const postId = newId('post', ctx.now);
  const now = ctx.now;
  const post: PostRecord = {
    postId,
    ownerOpenId: openid,
    type: input.type as 'lost' | 'found',
    category: input.category as PostRecord['category'],
    title: (input.title as string).trim(),
    description: (input.description as string).trim(),
    images: (input.images as string[] | undefined) ?? [],
    timeRange: input.timeRange as PostRecord['timeRange'],
    locationArea: (input.locationArea as string).trim(),
    status: 'open',
    closeReason: '',
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  const privateRecord: PostPrivateRecord = {
    postId,
    ownerOpenId: openid,
    verificationTraits: typeof input.verificationTraits === 'string' ? input.verificationTraits.trim() : '',
    consentAt: now,
    deletePlanAt: null,
  };
  await db.collection(POSTS).add({ data: { ...post, _id: postId } });
  await db.collection(PRIVATE).add({ data: { ...privateRecord, _id: postId } });
  await record(db, { actorOpenId: openid, action: 'createPost', postId, summary: `${post.type}·${post.category}` });
  return ok({ postId, post: publicView(post) });
}

export async function updatePost(
  db: Db,
  openid: string,
  postId: string,
  input: { title?: string; description?: string; timeRange?: unknown; locationArea?: string; version?: unknown },
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const post = await readPost(db, postId);
  if (post === null || post.deleted) return fail('not_found', '帖子不存在或已删除');
  if (post.ownerOpenId !== openid) return fail('forbidden', '只能编辑自己的帖子');
  if (!isPostActive(post.status)) return fail('conflict', '当前状态的帖子不可编辑');
  if (typeof input.version !== 'number' || input.version !== post.version) {
    return fail('conflict', '帖子已被修改,请刷新后重试');
  }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.trim().length > 30) {
      return fail('invalid_request', '标题非法');
    }
    post.title = input.title.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.trim() === '' || input.description.trim().length > 500) {
      return fail('invalid_request', '描述非法');
    }
    post.description = input.description.trim();
  }
  post.version += 1;
  post.updatedAt = ctx.now;
  await db.collection(POSTS).doc(postId).update({ data: { title: post.title, description: post.description, version: post.version, updatedAt: post.updatedAt } });
  await record(db, { actorOpenId: openid, action: 'updatePost', postId, summary: '编辑帖子' });
  return ok({ post: publicView(post) });
}

export async function closePost(
  db: Db,
  openid: string,
  postId: string,
  reason: string,
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const post = await readPost(db, postId);
  if (post === null || post.deleted) return fail('not_found', '帖子不存在或已删除');
  if (post.ownerOpenId !== openid) return fail('forbidden', '只能关闭自己的帖子');
  if (!canTransitionPost(post.status, 'closed')) return fail('conflict', '当前状态不可关闭');
  post.status = 'closed';
  post.closeReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 100) : '';
  post.closedAt = ctx.now;
  post.version += 1;
  await db.collection(POSTS).doc(postId).update({
    data: { status: post.status, closeReason: post.closeReason, closedAt: post.closedAt, version: post.version, updatedAt: ctx.now },
  });
  await record(db, { actorOpenId: openid, action: 'closePost', postId, summary: `关闭:${post.closeReason}` });
  return ok({ post: publicView(post) });
}

export async function getPost(db: Db, openid: string, postId: string): Promise<LostFoundResponse> {
  const post = await readPost(db, postId);
  if (post === null || post.deleted) return fail('not_found', '帖子不存在或已删除');
  const view = publicView(post);
  if (post.ownerOpenId === openid) {
    try {
      const privateDoc = await db.collection(PRIVATE).doc(postId).get();
      view.verificationTraits = (privateDoc.data as PostPrivateRecord).verificationTraits;
      view.isOwner = true;
    } catch {
      view.isOwner = true;
      view.verificationTraits = '';
    }
  } else {
    view.isOwner = false;
  }
  return ok({ post: view });
}

export async function getMyPosts(db: Db, openid: string): Promise<LostFoundResponse> {
  const result = await db.collection(POSTS).where({ ownerOpenId: openid }).get();
  const rows = (result.data as (PostRecord & { _id: string })[]).filter((post) => !post.deleted);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return ok({ posts: rows.map(publicView) });
}

export async function listPosts(
  db: Db,
  input: { type?: unknown; category?: unknown; page?: number; pageSize?: number },
): Promise<LostFoundResponse> {
  const type = input.type === 'lost' || input.type === 'found' ? input.type : undefined;
  const category = typeof input.category === 'string' && input.category !== '' ? input.category : undefined;
  const page = typeof input.page === 'number' ? input.page : 0;
  const pageSize = typeof input.pageSize === 'number' ? input.pageSize : 20;
  const result = await db.collection(POSTS).where({ deleted: false }).get();
  let rows = (result.data as (PostRecord & { _id: string })[]).filter((post) => isPostActive(post.status));
  if (type !== undefined) rows = rows.filter((post) => post.type === type);
  if (category !== undefined) rows = rows.filter((post) => post.category === category);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const start = page * pageSize;
  return ok({ posts: rows.slice(start, start + pageSize).map(publicView), total: rows.length });
}
