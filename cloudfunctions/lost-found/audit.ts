/**
 * 失物招领 · 审计事件数据层。
 *
 * 记录关键状态变更、敏感数据访问与举报;不保存图片、提示词或密钥
 * (框架第 9.5 节)。写入失败只记录日志,不阻断主流程。
 */
interface Db {
  collection(name: string): any;
}

const AUDIT = 'lost_found_audit_events';

export interface AuditInput {
  actorOpenId: string;
  action: string;
  postId?: string;
  claimId?: string;
  summary: string;
}

function newId(now: number): string {
  return `event-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function record(db: Db, input: AuditInput): Promise<void> {
  try {
    const id = newId(Date.now());
    const event = {
      _id: id,
      eventId: id,
      actorOpenId: input.actorOpenId,
      action: input.action,
      postId: input.postId ?? '',
      claimId: input.claimId ?? '',
      summary: String(input.summary).slice(0, 200),
      createdAt: Date.now(),
    };
    await db.collection(AUDIT).add({ data: event });
  } catch (error) {
    // 审计失败不阻断业务(与 ai 云函数「非致命问题告警」同一口径);生产可在告警渠道上报。
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('lost-found 审计写入失败:', error && (error as Error).message);
    }
  }
}
