/**
 * 失物招领 · 候选召回数据层(LF-3 规则版,LF-4 接 AI 重排)。
 *
 * 规则召回:相反类型 + 类别相同 + 区域相同 + 时间窗重叠,按时间邻近度排 rank。
 * 结果落库并带版本字段(modelVersion 为空 = 未经过 AI 比对),解释部分如实标注。
 */
import { MatchRecord, PostRecord, LostFoundResponse } from './types';
import { isPostActive } from './state';
import { fail, ok } from './posts';

const POSTS = 'lost_found_posts';
const MATCHES = 'lost_found_matches';

export const RULE_VERSION = 'rules-v1';

interface Db {
  collection(name: string): any;
}

function newId(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function timeRangesOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** 时间邻近度:两个时间窗中点相差的天数(越小越近)。 */
function timeDistance(a: { start: string; end: string }, b: { start: string; end: string }): number {
  const mid = (range: { start: string; end: string }) =>
    (new Date(`${range.start}T00:00:00Z`).getTime() + new Date(`${range.end}T00:00:00Z`).getTime()) / 2;
  return Math.abs(mid(a) - mid(b)) / 86400000;
}

export async function ruleRecall(
  db: Db,
  postId: string,
  ctx: { now: number },
  ownerOpenId?: string,
): Promise<LostFoundResponse> {
  let source: (PostRecord & { _id: string }) | null = null;
  try {
    const doc = await db.collection(POSTS).doc(postId).get();
    source = doc.data as PostRecord & { _id: string };
  } catch {
    return fail('not_found', '帖子不存在');
  }
  if (ownerOpenId !== undefined && source.ownerOpenId !== ownerOpenId) return fail('forbidden', '只能查看自己帖子的候选');
  if (!isPostActive(source.status)) return fail('conflict', '该帖子已不再参与匹配');

  const opposite = source.type === 'lost' ? 'found' : 'lost';
  const result = await db.collection(POSTS).where({ deleted: false }).get();
  const candidates = (result.data as (PostRecord & { _id: string })[])
    .filter((post) => post.postId !== postId)
    .filter((post) => post.type === opposite)
    .filter((post) => isPostActive(post.status))
    .filter((post) => post.category === source.category)
    .filter((post) => post.locationArea === source.locationArea)
    .filter((post) => timeRangesOverlap(source.timeRange, post.timeRange))
    .map((post) => ({
      post,
      distance: timeDistance(source.timeRange, post.timeRange),
    }))
    .sort((a, b) => a.distance - b.distance);

  const records: MatchRecord[] = candidates.slice(0, 10).map((row, index) => ({
    matchId: newId('match', ctx.now + index),
    sourcePostId: postId,
    candidatePostId: row.post.postId,
    ruleVersion: RULE_VERSION,
    modelVersion: '',
    promptVersion: '',
    rank: index + 1,
    similarities: ['类别一致', '地点区域一致', '时间范围相近'],
    conflicts: [],
    uncertainties: ['未经过 AI 图文比对,请自行核对'],
    confidenceBand: 'low',
    needsHumanVerification: true,
    feedback: '',
    expiresAt: ctx.now + 24 * 3600 * 1000,
    createdAt: ctx.now,
  }));

  for (const match of records) {
    await db.collection(MATCHES).add({ data: { ...match, _id: match.matchId } });
  }
  return ok({ matches: records });
}

export async function listMatches(
  db: Db,
  postId: string,
  ctx: { now: number },
  ownerOpenId?: string,
): Promise<LostFoundResponse> {
  try {
    const doc = await db.collection(POSTS).doc(postId).get();
    const source = doc.data as PostRecord;
    if (ownerOpenId !== undefined && source.ownerOpenId !== ownerOpenId) return fail('forbidden', '只能查看自己帖子的候选');
  } catch {
    return fail('not_found', '帖子不存在');
  }
  const result = await db.collection(MATCHES).where({ sourcePostId: postId }).get();
  const rows = (result.data as MatchRecord[])
    .filter((match) => match.expiresAt > ctx.now)
    .sort((a, b) => a.rank - b.rank);
  return ok({ matches: rows });
}

export async function feedbackMatch(
  db: Db,
  matchId: string,
  feedback: 'helpful' | 'irrelevant' | 'misleading',
  ctx: { now: number },
): Promise<LostFoundResponse> {
  if (feedback !== 'helpful' && feedback !== 'irrelevant' && feedback !== 'misleading') {
    return fail('invalid_request', '反馈类型非法');
  }
  try {
    await db.collection(MATCHES).doc(matchId).update({ data: { feedback } });
  } catch {
    return fail('not_found', '候选不存在');
  }
  return ok({ matchId, feedback });
}
