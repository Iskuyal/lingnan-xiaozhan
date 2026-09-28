/**
 * 失物招领输入校验（纯函数,node:test 直接验证）。
 *
 * 校验基线见 docs/domain/lost-found.md 第 6 节:字段白名单、长度、枚举、
 * 时间范围、图片 fileID、联系方式记号。返回结构化的失败原因,不抛异常。
 */
import { POST_CATEGORIES, PostCategory, PostInput, TimeRange } from './types';
import { hasContactToken } from './security';

export interface ValidateResult {
  ok: boolean;
  /** 第一条失败原因(给调用方拼用户文案)。 */
  reason: string;
}

const MAX_TITLE = 30;
const MAX_DESCRIPTION = 500;
const MAX_TRAITS = 200;
const MAX_IMAGES = 3;
const MAX_EVIDENCE = 500;
const MAX_LIST_PAGE_SIZE = 20;

function ok(): ValidateResult {
  return { ok: true, reason: '' };
}

function bad(reason: string): ValidateResult {
  return { ok: false, reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** YYYY-MM-DD,且是合法日期。 */
function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 今天(本地时区,与校验口径「不晚于今天」一致)。 */
export function todayString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validTimeRange(value: unknown): value is TimeRange {
  if (value === null || typeof value !== 'object') return false;
  const range = value as Record<string, unknown>;
  if (!isDateString(range.start) || !isDateString(range.end)) return false;
  const { start, end } = range as { start: string; end: string };
  if (start > end) return false;
  if (end > todayString()) return false;
  return true;
}

function validImages(value: unknown, ownerHash: string): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_IMAGES) return false;
  return value.every((item) => typeof item === 'string' && isOwnImageShape(item, ownerHash));
}

/** 图片 fileID 必须形如 cloud://<env>.<bucket>/lost-found/<ownerHash>/<name>.<png|jpg|jpeg>。 */
function isOwnImageShape(fileId: string, ownerHash: string): boolean {
  const match = /^cloud:\/\/[^/]+\/lost-found\/([^/]+)\/[^/]+\.(png|jpe?g)$/i.exec(fileId);
  return match !== null && match[1] === ownerHash;
}

export function validatePost(input: PostInput, ownerHash = ''): ValidateResult {
  if (!isNonEmptyString(input.title)) return bad('标题不能为空');
  if (input.title!.trim().length > MAX_TITLE) return bad(`标题最多 ${MAX_TITLE} 字`);
  if (!isNonEmptyString(input.description)) return bad('描述不能为空');
  if (input.description!.trim().length > MAX_DESCRIPTION) return bad(`描述最多 ${MAX_DESCRIPTION} 字`);
  if (input.type !== 'lost' && input.type !== 'found') return bad('类型非法');
  if (!isNonEmptyString(input.category) || !(POST_CATEGORIES as readonly string[]).includes(input.category)) {
    return bad('类别不在白名单内');
  }
  if (!validTimeRange(input.timeRange)) return bad('时间范围非法(倒置或晚于今天)');
  if (!isNonEmptyString(input.locationArea) || input.locationArea!.trim().length > 60) return bad('地点区域非法');
  if (!validImages(input.images, ownerHash)) return bad('图片非法(数量、归属或格式)');
  if (typeof input.verificationTraits === 'string' && input.verificationTraits.length > MAX_TRAITS) {
    return bad(`核验特征最多 ${MAX_TRAITS} 字`);
  }
  if (input.agree !== true) return bad('未同意授权说明');
  if (hasContactToken(input.description!)) return bad('描述中包含联系方式,请勿公开');
  return ok();
}

export function validateClaim(input: { relation?: unknown; evidence?: unknown }): ValidateResult {
  if (!isNonEmptyString(input.relation) || input.relation!.trim().length > 100) return bad('关系说明非法');
  if (!isNonEmptyString(input.evidence)) return bad('核验信息不能为空');
  if (input.evidence!.trim().length > MAX_EVIDENCE) return bad(`核验信息最多 ${MAX_EVIDENCE} 字`);
  return ok();
}

export function validateList(input: { page?: unknown; pageSize?: unknown }): ValidateResult {
  const page = input.page;
  const pageSize = input.pageSize;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) return bad('分页参数非法');
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_PAGE_SIZE) {
    return bad(`每页最多 ${MAX_LIST_PAGE_SIZE} 条`);
  }
  return ok();
}

export type { PostCategory };
