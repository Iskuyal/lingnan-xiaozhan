/** 指定周次的调课：原课程、拆出的课程和重试凭据在同一事务内提交。 */
import * as crypto from 'crypto';
import { normalizeCourseFields } from './record';
import { CourseFields, StoredCourse } from './types';

interface Doc {
  get(): Promise<{ data?: unknown }>;
  set(value: { data: Record<string, unknown> }): Promise<unknown>;
  remove(): Promise<unknown>;
}
interface Transaction { collection(name: string): { doc(id: string): Doc } }
export interface ScopedDatabase extends Transaction {
  runTransaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
}
type RecordCourse = StoredCourse & { _id?: string; batch?: string };
interface State { courses: RecordCourse[]; batch: string | null; totalWeeks: number }
export interface ScopedContext {
  db: ScopedDatabase;
  collection: string;
  headId(owner: string): string;
  load(owner: string): Promise<State>;
}
interface Receipt {
  kind: 'scoped-change'; receiptOwner: string; receiptCreatedAt: string;
  fingerprint: string; batch: string | null; originalDocId: string;
  before: Record<string, unknown>; after: Record<string, unknown>;
  createdDocId: string; created: Record<string, unknown> | null; reverted: boolean;
}

export function scopedWeeks(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 30
    || raw.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 30)) {
    throw new Error('周次必须是1至30的整数，且至少选择一周');
  }
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}
function fields(raw: unknown): CourseFields {
  const parsed = normalizeCourseFields(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
/** 1..30的任意周次集合压缩后不超过字段40字上限，不能直接 join 写满学期。 */
function weekText(weeks: number[]): string {
  const chunks: string[] = [];
  for (let i = 0; i < weeks.length; i += 1) {
    const start = weeks[i]; let end = start;
    while (weeks[i + 1] === end + 1) { i += 1; end = weeks[i]; }
    chunks.push(start === end ? String(start) : `${start}-${end}`);
  }
  return chunks.join('、');
}
/** 已识别的周次按集合比较；不同的等价 weekText 不构成业务变更。 */
function business(raw: unknown): Record<string, unknown> {
  const value = fields(raw);
  return { ...value, weekText: value.weeksRecognized ? '' : value.weekText };
}
function stamp(raw: Record<string, unknown>): string {
  return JSON.stringify({ fields: business(raw), owner: raw.owner, semester: raw.semester,
    rawText: raw.rawText, createdAt: raw.createdAt, updatedAt: raw.updatedAt, batch: raw.batch });
}
function clean(raw: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = raw;
  return rest;
}
async function maybe(doc: Doc): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await doc.get();
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch (error) {
    const detail = error !== null && typeof error === 'object' ? error as { message?: unknown; errMsg?: unknown; code?: unknown } : {};
    const message = [detail.message, detail.errMsg, detail.code, String(error)].filter((part) => typeof part === 'string').join(' ');
    if (/not exist|doesn't exist|DOCUMENT_NOT_EXIST|non-exists/iu.test(message)) return null;
    throw error;
  }
}
function tokenOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(value)) throw new Error('缺少有效的操作编号，请重新识别通知');
  return value;
}
function digest(owner: string, token: string): string {
  return crypto.createHash('sha256').update(owner + '\n' + token).digest('hex');
}
async function checkBatch(tx: Transaction, context: ScopedContext, owner: string, expected: string | null) {
  const head = await maybe(tx.collection(context.collection).doc(context.headId(owner)));
  if ((head === null ? null : head.activeBatch) !== expected) throw new Error('课表已重新导入，请刷新后重新识别通知');
  return head;
}
function receiptOf(raw: Record<string, unknown>, owner: string): Receipt {
  if (raw.kind !== 'scoped-change' || raw.receiptOwner !== owner) throw new Error('未找到属于本人的调课操作');
  // 查询返回的顶层_id属于数据库，不能随凭据快照写回set(data)。
  return clean(raw) as unknown as Receipt;
}
async function unchanged(tx: Transaction, context: ScopedContext, receipt: Receipt) {
  const original = await maybe(tx.collection(context.collection).doc(receipt.originalDocId));
  if (original === null || stamp(original) !== stamp(receipt.after)) throw new Error('课程在调课后又发生变化，请重新核对；不会覆盖后续修改');
  if (receipt.created !== null) {
    const created = await maybe(tx.collection(context.collection).doc(receipt.createdDocId));
    if (created === null || stamp(created) !== stamp(receipt.created)) throw new Error('拆出的课程又发生变化，请重新核对；不会覆盖后续修改');
  }
}

export async function applyScopedChange(context: ScopedContext, owner: string, event: Record<string, unknown>) {
  const weeks = scopedWeeks(event.weeks);
  const token = tokenOf(event.requestId);
  const id = typeof event.id === 'string' ? event.id : '';
  if (id === '') throw new Error('缺少要调课的课程标识');
  const expected = fields(event.expected);
  if (event.course === null || typeof event.course !== 'object' || Array.isArray(event.course)) throw new Error('缺少调课后的时间或地点');
  const supplied = event.course as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of ['weekday', 'startSection', 'endSection', 'sectionRanges', 'location']) {
    if (Object.prototype.hasOwnProperty.call(supplied, key)) patch[key] = supplied[key];
  }
  const target = fields({ ...expected, ...patch, weeks, weeksRecognized: true, weekText: weekText(weeks) });
  if (target.weekday === expected.weekday && target.location === expected.location
    && JSON.stringify(target.sectionRanges) === JSON.stringify(expected.sectionRanges)) throw new Error('时间和地点没有变化，无需应用');
  const fingerprint = JSON.stringify({ id, weeks, expected: business(expected), target: business(target) });
  const key = digest(owner, token);
  const state = await context.load(owner);
  const selected = state.courses.find((course) => course.id === id);
  if (selected === undefined || typeof selected._id !== 'string') throw new Error('未找到本人的课程，请刷新后核对');
  const now = new Date().toISOString();
  const result = await context.db.runTransaction(async (tx) => {
    const receiptDoc = tx.collection(context.collection).doc('notice-receipt-' + key);
    const previous = await maybe(receiptDoc);
    if (previous !== null) {
      const receipt = receiptOf(previous, owner);
      if (receipt.fingerprint !== fingerprint) throw new Error('操作编号对应另一份提案，请重新识别通知');
      if (receipt.reverted) throw new Error('这次调课已经撤销，请重新识别通知');
      await checkBatch(tx, context, owner, receipt.batch);
      await unchanged(tx, context, receipt);
      return { ok: true, id, operationId: token, repeated: true };
    }
    const head = await checkBatch(tx, context, owner, state.batch);
    const originalDoc = tx.collection(context.collection).doc(selected._id as string);
    const current = await maybe(originalDoc);
    if (current === null || current.owner !== owner || current.id !== id) throw new Error('课程已删除或不属于本人');
    if (JSON.stringify(business(current)) !== JSON.stringify(business(expected))) throw new Error('课程已发生变化，请重新识别通知后确认');
    const currentFields = fields(current);
    if (!currentFields.weeksRecognized) throw new Error('课程原周次未识别，不能确定只修改哪些周');
    const all = currentFields.weeks.length > 0 ? currentFields.weeks
      : state.totalWeeks >= 1 ? Array.from({ length: state.totalWeeks }, (_, i) => i + 1) : [];
    if (all.length === 0) throw new Error('每周课程需要先保存学期总周数，才能限定周次调课');
    if (weeks.some((week) => !all.includes(week))) throw new Error('指定周次中有这门课不上课的周，请核对范围');
    const kept = all.filter((week) => !weeks.includes(week));
    if (kept.length > 0 && state.courses.length >= 300) throw new Error('拆分后超过300条课程上限，请先整理课表');
    const before = clean(current);
    const after = kept.length === 0
      ? { ...before, ...target, updatedAt: now }
      : { ...before, weeks: kept, weeksRecognized: true, weekText: weekText(kept), updatedAt: now };
    const createdDocId = kept.length > 0 ? 'notice-course-' + key : '';
    const created = kept.length > 0 ? { ...before, ...target, id: 'tc_' + key.slice(0, 24), createdAt: now, updatedAt: now } : null;
    // 与导入切换写同一标记文档，利用事务写冲突避免覆盖并发的新批次。
    if (head !== null) await tx.collection(context.collection).doc(context.headId(owner)).set({ data: { ...clean(head), scopedRevision: token } });
    await originalDoc.set({ data: after });
    if (created !== null) await tx.collection(context.collection).doc(createdDocId).set({ data: created });
    const receipt: Receipt = { kind: 'scoped-change', receiptOwner: owner, receiptCreatedAt: now,
      fingerprint, batch: state.batch, originalDocId: selected._id as string, before, after, createdDocId, created, reverted: false };
    await receiptDoc.set({ data: { ...receipt } });
    return { ok: true, id, operationId: token, repeated: false };
  });
  const latest = await maybe(context.db.collection(context.collection).doc(context.headId(owner)));
  if ((latest?.activeBatch ?? null) !== state.batch) throw new Error('课表同时被重新导入，本次调整已被新课表覆盖；请刷新重新核对');
  return result;
}

export async function undoScopedChange(context: ScopedContext, owner: string, event: Record<string, unknown>) {
  const token = tokenOf(event.requestId);
  const result = await context.db.runTransaction(async (tx) => {
    const doc = tx.collection(context.collection).doc('notice-receipt-' + digest(owner, token));
    const raw = await maybe(doc);
    if (raw === null) throw new Error('调课记录已过期或不属于本人，无法撤销');
    const receipt = receiptOf(raw, owner);
    if (receipt.reverted) return { ok: true, operationId: token, repeated: true, batch: receipt.batch };
    const head = await checkBatch(tx, context, owner, receipt.batch);
    await unchanged(tx, context, receipt);
    if (head !== null) await tx.collection(context.collection).doc(context.headId(owner)).set({ data: { ...clean(head), scopedRevision: token } });
    await tx.collection(context.collection).doc(receipt.originalDocId).set({ data: receipt.before });
    if (receipt.created !== null) await tx.collection(context.collection).doc(receipt.createdDocId).remove();
    await doc.set({ data: { ...receipt, reverted: true } });
    return { ok: true, operationId: token, repeated: false, batch: receipt.batch };
  });
  if (!result.repeated) {
    const latest = await maybe(context.db.collection(context.collection).doc(context.headId(owner)));
    if ((latest?.activeBatch ?? null) !== result.batch) throw new Error('课表同时被重新导入，请刷新核对；不会修改新导入的课程');
  }
  return { ok: result.ok, operationId: result.operationId, repeated: result.repeated };
}
