/**
 * 失物招领云函数入口(LF-3 非 AI 基线)。
 *
 * 唯一可信身份来源:cloud.getWXContext() 的 OPENID,不信任前端提交的任何身份字段
 * (框架第 4 节)。所有动作不抛裸异常,失败带分类与文案;数据层见 posts/claims/matches/audit。
 */
import * as cloud from 'wx-server-sdk';
import { LostFoundAction, LostFoundResponse } from './types';
import * as posts from './posts';
import * as claims from './claims';
import * as matches from './matches';
import { record } from './audit';

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database() as unknown as { collection(name: string): any };

function failInternal(error: unknown): LostFoundResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, failureClass: 'internal', message: `服务开小差了(${message.slice(0, 120)})`, data: {} };
}

/** 入口签名供测试与部署调用(与 timetable/ai 云函数一致的 main 风格)。 */
export async function main(event: Record<string, unknown> = {}): Promise<LostFoundResponse> {
  const now = Date.now();
  const action = typeof event.action === 'string' ? (event.action as LostFoundAction) : '';
  const context = cloud.getWXContext();
  const openid = typeof context.OPENID === 'string' && context.OPENID !== '' ? context.OPENID : '';

  if (openid === '') {
    return { ok: false, failureClass: 'forbidden', message: '无法取得用户身份', data: {} };
  }

  try {
    switch (action) {
      case 'createPost':
        return await posts.createPost(db, openid, (event.input ?? {}) as never, { now });
      case 'updatePost':
        return await posts.updatePost(db, openid, String(event.postId ?? ''), (event.input ?? {}) as never, { now });
      case 'closePost':
        return await posts.closePost(db, openid, String(event.postId ?? ''), String(event.reason ?? ''), { now });
      case 'getPost':
        return await posts.getPost(db, openid, String(event.postId ?? ''));
      case 'getMyPosts':
        return await posts.getMyPosts(db, openid);
      case 'listPosts':
        return await posts.listPosts(db, (event.input ?? {}) as never);
      case 'submitClaim':
        return await claims.submitClaim(db, openid, String(event.postId ?? ''), (event.input ?? {}) as never, { now });
      case 'reviewClaim':
        return await claims.reviewClaim(db, openid, String(event.claimId ?? ''), String(event.toStatus ?? ''), String(event.note ?? ''), { now });
      case 'cancelClaim':
        return await claims.cancelClaim(db, openid, String(event.claimId ?? ''), { now });
      case 'listClaimsForPost':
        return await claims.listClaimsForPost(db, openid, String(event.postId ?? ''));
      case 'confirmHandover':
        return await claims.confirmHandover(db, openid, String(event.postId ?? ''), String(event.claimId ?? ''), { now });
      case 'listMatches':
        return await matches.listMatches(db, String(event.postId ?? ''), { now }, openid);
      case 'feedbackMatch':
        return await matches.feedbackMatch(db, String(event.matchId ?? ''), (event.feedback ?? '') as never, { now });
      case 'reportPost': {
        const postId = String(event.postId ?? '');
        await record(db, { actorOpenId: openid, action: 'reportPost', postId, summary: String(event.summary ?? '').slice(0, 200) });
        return { ok: true, failureClass: '', message: '', data: { postId } };
      }
      case 'deletePost':
        return await posts.deletePost(db, openid, String(event.postId ?? ''), { now });
      default:
        return { ok: false, failureClass: 'invalid_request', message: `未知动作:${action}`, data: {} };
    }
  } catch (error) {
    return failInternal(error);
  }
}
