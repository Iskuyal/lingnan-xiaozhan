import crypto from 'node:crypto';
import { AiFailure, fail } from './errors';
import { UsageDb, USAGE_MONTH_COLLECTION, isMissingDocumentError, updatedCount } from './usage';

/** 与 timetable 的上传目录规则保持一致：路径只放 openid 的哈希前缀。 */
export function photoOwnerPrefix(openid: string): string {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
}

/** openid 是高熵平台标识；存用量和限流时只保留单向摘要。 */
export function userKey(openid: string): string {
  return crypto.createHash('sha256').update(openid).digest('hex');
}

export function requireOpenid(openid: string): void {
  if (openid === '') fail('invalid_request', '无法确认当前微信身份，已拒绝 AI 调用');
}

/** 维护者白名单只读服务端环境变量，事件里的身份字段一律不参与判断。 */
export function isAdmin(openid: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (openid === '') return false;
  const list = env.AI_ADMIN_OPENIDS;
  if (typeof list !== 'string' || list.trim() === '') return false;
  return list.split(',').some((candidate) => candidate.trim() === openid);
}

export function assertAdmin(openid: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isAdmin(openid, env)) fail('invalid_request', '这项 AI 维护操作仅向维护者开放');
}

/**
 * 云函数以管理端权限下载文件，客户端存储规则不会限制它。
 * 因此必须在 downloadFile 前验证当前调用者、路径和由 preparePhotoUpload 生成的文件名。
 */
export function assertOwnPhotoFile(fileID: string, openid: string): void {
  if (openid === '') fail('invalid_request', '无法确认当前微信身份，已拒绝读取图片');
  const matched = /^cloud:\/\/[^/?#\\\s]+\/timetable-imports\/([a-f0-9]{16})\/[a-z0-9]+-[a-f0-9]{8}\.(?:png|jpg|jpeg)$/u.exec(fileID);
  if (matched === null || matched[1] !== photoOwnerPrefix(openid)) {
    fail('invalid_request', '图片文件不属于当前微信身份，已拒绝读取');
  }
}

function positiveLimit(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const value = Number(env[key]);
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : defaultValue;
}

function isDuplicate(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const source = error as { errCode?: unknown; message?: unknown; errMsg?: unknown };
  const message = String(source.errMsg ?? source.message ?? '');
  return /already exists|duplicate/i.test(message);
}

/**
 * 固定窗口计数复用已有的受限用量集合，避免部署前还要新建集合。
 * update 用数据库原子自增；读不到计数或数据库故障时一律拒绝，不降级为放行。
 */
async function consumeCounter(db: UsageDb, id: string, limit: number, now: Date, label: string): Promise<void> {
  const collection = db.collection(USAGE_MONTH_COLLECTION);
  const doc = collection.doc(id);
  const delta = { count: db.command.inc(1), updatedAt: now.toISOString() };
  let missing = false;
  try {
    missing = updatedCount(await doc.update({ data: delta })) === 0;
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    missing = true;
  }
  if (missing) {
    try {
      await collection.add({ data: { _id: id, count: 1, updatedAt: now.toISOString() } });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      await doc.update({ data: delta });
    }
  }
  const result = await doc.get();
  const count = (result.data as { count?: unknown } | undefined)?.count;
  if (!Number.isInteger(count) || (count as number) < 1) fail('internal', 'AI 调用计数无法确认');
  if ((count as number) > limit) {
    throw new AiFailure('quota_exhausted', `${label}调用次数超过 ${limit} 次`, {
      message: `${label} AI 调用次数已达上限，请稍后再试。`,
    });
  }
}

/** 每次业务请求消耗一次额度，失败请求也计数以阻断刷接口。 */
export async function consumeUserLimits(db: UsageDb, openid: string, now: Date, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireOpenid(openid);
  const key = userKey(openid);
  const minute = Math.floor(now.getTime() / 60000);
  const day = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  await consumeCounter(db, `limit:minute:${key}:${minute}`, positiveLimit(env, 'AI_USER_MINUTE_LIMIT', 6), now, '本分钟');
  await consumeCounter(db, `limit:day:${key}:${day}`, positiveLimit(env, 'AI_USER_DAILY_LIMIT', 30), now, '今日');
}

/** 探测每 10 分钟至多一次（所有维护者共用），先占窗口再调用微信接口。 */
export async function consumeProbeWindow(db: UsageDb, now: Date): Promise<void> {
  const id = `probe:${Math.floor(now.getTime() / (10 * 60000))}`;
  try {
    await db.collection(USAGE_MONTH_COLLECTION).add({ data: { _id: id, createdAt: now.toISOString() } });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    throw new AiFailure('quota_exhausted', '维护者探测在当前十分钟窗口已执行', {
      message: '内容安全探测刚执行过，请十分钟后再试。',
    });
  }
}
