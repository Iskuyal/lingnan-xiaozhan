/**
 * 失物招领 · 认领与交接数据层。
 *
 * 归属永远由发布者人工判断;这里的「受控比较」只提示核验回答是否与
 * 发布者的私密特征相符,不下定论、不回传特征原文(框架第 11.2 节)。
 */
import { ClaimInput, ClaimRecord, LostFoundResponse } from './types';
import { validateClaim } from './validate';
import { canTransitionClaim, isClaimActive, isPostActive } from './state';
import { record } from './audit';
import { fail, ok } from './posts';

const CLAIMS = 'lost_found_claims';
const POSTS = 'lost_found_posts';
const PRIVATE = 'lost_found_post_private';

interface Db {
  collection(name: string): any;
}

function newId(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readClaim(db: Db, claimId: string): Promise<(ClaimRecord & { _id: string }) | null> {
  try {
    const doc = await db.collection(CLAIMS).doc(claimId).get();
    return doc.data as ClaimRecord & { _id: string };
  } catch {
    return null;
  }
}

async function readPost(db: Db, postId: string): Promise<Record<string, unknown> | null> {
  try {
    const doc = await db.collection(POSTS).doc(postId).get();
    return doc.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function claimView(claim: ClaimRecord, includeEvidence = false): Record<string, unknown> {
  return {
    claimId: claim.claimId,
    postId: claim.postId,
    status: claim.status,
    relation: claim.relation,
    // 核验回答是私密原文:只在发布者视角返回(他要靠它核验),认领人视角清空。
    evidence: includeEvidence ? claim.evidence : '',
    reviewerNote: claim.reviewerNote,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    claimantConfirmedAt: claim.claimantConfirmedAt,
    ownerConfirmedAt: claim.ownerConfirmedAt,
  };
}

export async function submitClaim(
  db: Db,
  openid: string,
  postId: string,
  input: ClaimInput,
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const check = validateClaim(input);
  if (!check.ok) return fail('invalid_request', check.reason);
  const post = await readPost(db, postId);
  if (post === null || post.deleted === true) return fail('not_found', '帖子不存在或已删除');
  if (post.ownerOpenId === openid) return fail('forbidden', '不能认领自己的帖子');
  if (!isPostActive(post.status as never)) return fail('conflict', '该帖子已不再接受认领');

  // 防重复:同帖同人只允许一条活跃申请。
  const existing = await db.collection(CLAIMS).where({ postId, claimantOpenId: openid }).get();
  const active = (existing.data as ClaimRecord[]).filter((claim) => isClaimActive(claim.status));
  if (active.length > 0) return fail('conflict', '你已有一条进行中的认领申请');

  // 受控比较:只比对「证据是否包含私密特征原文」,结果只有相符/不相符,不回传原文。
  let traitsMatched = false;
  try {
    const privateDoc = await db.collection(PRIVATE).doc(postId).get();
    const traits = String((privateDoc.data as Record<string, unknown>).verificationTraits ?? '');
    const evidence = (input.evidence as string).trim();
    traitsMatched = traits !== '' && evidence.includes(traits);
  } catch {
    traitsMatched = false;
  }

  const claimId = newId('claim', ctx.now);
  const claim: ClaimRecord = {
    claimId,
    postId,
    claimantOpenId: openid,
    relation: (input.relation as string).trim(),
    evidence: (input.evidence as string).trim(),
    status: 'pending',
    reviewerNote: '',
    version: 1,
    claimantConfirmedAt: null,
    ownerConfirmedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await db.collection(CLAIMS).add({ data: { ...claim, _id: claimId } });
  await db.collection(POSTS).doc(postId).update({ data: { status: 'verifying', updatedAt: ctx.now } });
  await record(db, { actorOpenId: openid, action: 'submitClaim', postId, claimId, summary: `申请:${traitsMatched ? '特征相符' : '特征未命中'}` });
  return ok({ claimId, traitsMatched, claim: claimView(claim, false) });
}

export async function reviewClaim(
  db: Db,
  openid: string,
  claimId: string,
  toStatus: string,
  note: string,
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const claim = await readClaim(db, claimId);
  if (claim === null) return fail('not_found', '申请不存在');
  const post = await readPost(db, claim.postId);
  if (post === null || post.ownerOpenId !== openid) return fail('forbidden', '只有发布者可以处理认领申请');
  if (!canTransitionClaim(claim.status, toStatus)) return fail('conflict', `申请状态不允许从 ${claim.status} 变为 ${toStatus}`);
  claim.status = toStatus as ClaimRecord['status'];
  claim.reviewerNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';
  claim.updatedAt = ctx.now;
  await db.collection(CLAIMS).doc(claimId).update({ data: { status: claim.status, reviewerNote: claim.reviewerNote, updatedAt: claim.updatedAt } });
  if (toStatus === 'accepted' || toStatus === 'needs_more_info') {
    await db.collection(POSTS).doc(claim.postId).update({ data: { status: 'verifying', updatedAt: ctx.now } });
  }
  await record(db, { actorOpenId: openid, action: 'reviewClaim', postId: claim.postId, claimId, summary: `处理:${toStatus}` });
  return ok({ claim: claimView(claim, true) });
}

export async function cancelClaim(db: Db, openid: string, claimId: string, ctx: { now: number }): Promise<LostFoundResponse> {
  const claim = await readClaim(db, claimId);
  if (claim === null) return fail('not_found', '申请不存在');
  const post = await readPost(db, claim.postId);
  const isParty = claim.claimantOpenId === openid || (post !== null && post.ownerOpenId === openid);
  if (!isParty) return fail('forbidden', '只有申请双方可以取消');
  if (!canTransitionClaim(claim.status, 'cancelled')) return fail('conflict', '当前状态不可取消');
  claim.status = 'cancelled';
  claim.updatedAt = ctx.now;
  await db.collection(CLAIMS).doc(claimId).update({ data: { status: 'cancelled', updatedAt: ctx.now } });
  await record(db, { actorOpenId: openid, action: 'cancelClaim', postId: claim.postId, claimId, summary: '取消申请' });
  const ownerView = post !== null && post.ownerOpenId === openid;
  return ok({ claim: claimView(claim, ownerView) });
}

export async function confirmHandover(
  db: Db,
  openid: string,
  postId: string,
  claimId: string,
  ctx: { now: number },
): Promise<LostFoundResponse> {
  const claim = await readClaim(db, claimId);
  if (claim === null || claim.postId !== postId) return fail('not_found', '申请不存在');
  if (claim.status !== 'accepted') return fail('conflict', '只有已通过的申请可以确认交接');
  const post = await readPost(db, postId);
  if (post === null) return fail('not_found', '帖子不存在');
  if (claim.claimantOpenId !== openid && post.ownerOpenId !== openid) return fail('forbidden', '只有申请双方可以确认交接');

  const patch: Record<string, unknown> = {};
  if (openid === post.ownerOpenId) {
    patch.ownerConfirmedAt = ctx.now;
  } else {
    patch.claimantConfirmedAt = ctx.now;
  }
  claim.ownerConfirmedAt = openid === post.ownerOpenId ? ctx.now : claim.ownerConfirmedAt;
  claim.claimantConfirmedAt = openid === claim.claimantOpenId ? ctx.now : claim.claimantConfirmedAt;

  if (claim.ownerConfirmedAt !== null && claim.claimantConfirmedAt !== null) {
    claim.status = 'completed';
    patch.status = 'completed';
    await db.collection(POSTS).doc(postId).update({ data: { status: 'resolved', updatedAt: ctx.now } });
    await record(db, { actorOpenId: openid, action: 'confirmHandover', postId, claimId, summary: '双方确认,结案' });
  } else {
    await record(db, { actorOpenId: openid, action: 'confirmHandover', postId, claimId, summary: '单方确认交接' });
  }
  await db.collection(CLAIMS).doc(claimId).update({ data: { ...patch, updatedAt: ctx.now } });
  return ok({ claim: claimView(claim, openid === post.ownerOpenId) });
}

export async function listClaimsForPost(db: Db, openid: string, postId: string): Promise<LostFoundResponse> {
  const post = await readPost(db, postId);
  if (post === null) return fail('not_found', '帖子不存在');
  if (post.ownerOpenId !== openid) return fail('forbidden', '只有发布者可以查看认领申请');
  const result = await db.collection(CLAIMS).where({ postId }).get();
  const rows = (result.data as ClaimRecord[]).sort((a, b) => b.createdAt - a.createdAt);
  return ok({ claims: rows.map((row) => claimView(row, true)) });
}
