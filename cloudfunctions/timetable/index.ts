/**
 * 个人课表云函数（Ticket 03）。
 *
 * 职责（全部按调用上下文的 openid 隔离，客户端不直连数据库）：
 * - `prepareUpload`：给本次调用者分配一个属于自己 openid 的云存储路径；
 * - `importDraft`：下载该路径下的文件 → 用 `xlsx` 解析成草稿返回 → **删除临时文件**；解析阶段不写任何课表记录；
 * - `list`：读取本人已保存的课表；
 * - `saveDraft`：确认页确认后整份替换本人课表（先写新批次，成功后再删旧批次，失败回滚本次写入）；
 * - `createCourse` / `updateCourse` / `deleteCourse`：独立于导入的手工新增、修改、删除。
 *
 * 集合 `timetable_courses` 的权限取最严格预设（所有用户不可读写）：读写都只发生在这里。
 * 函数本身需要允许客户端调用（与 `newsSync` 不同），见 docs/cloud-development.md 的控制台步骤。
 */
import * as cloud from 'wx-server-sdk';
import * as crypto from 'crypto';
import { parseWorkbook } from './parse';
import { makeCourseId, normalizeCourseFields, sanitizeSemester } from './record';
import { CourseFields, StoredCourse, UPLOAD_ROOT } from './types';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database();
const command = db.command;
const COLLECTION = 'timetable_courses';
const PAGE_SIZE = 100;
/** 单份课表最多保存的课程数：真实班级课表 50 条上下，留足余量同时挡住异常输入。 */
const MAX_COURSES = 300;
/** 上传文件大小上限（客户端先按同样数值拦截，服务端再兜一次）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.xls', '.xlsx'];

interface CloudEvent {
  action?: unknown;
  [key: string]: unknown;
}

/** 调用者专属的上传路径前缀：用 openid 哈希，路径里不出现原始 openid。 */
function ownerPrefix(openid: string): string {
  const digest = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `${UPLOAD_ROOT}/${digest}/`;
}

/** 取扩展名（小写，含点）；没有扩展名时返回空字符串。 */
function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]+$/u.exec(name);
  return match === null ? '' : match[0].toLowerCase();
}

/**
 * wx-server-sdk 4.0.2 把 get() 声明为联合类型（历史遗留），运行时始终返回查询结果。
 * 这里集中收窄一次，避免在每个调用点断言。
 */
async function queryData<T>(query: { get(): unknown }): Promise<T[]> {
  const result = (await query.get()) as { data: T[] };
  return result.data;
}

/** 读本人全部课程：云函数端单次最多 100 条，按页读取后由调用方排序。 */
async function readOwnCourses(openid: string): Promise<StoredCourse[]> {
  const rows: StoredCourse[] = [];
  for (let skip = 0; skip < MAX_COURSES; skip += PAGE_SIZE) {
    const page = await queryData<StoredCourse>(
      db.collection(COLLECTION).where({ owner: openid }).skip(skip).limit(PAGE_SIZE),
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/** 删除本人符合条件的记录（批次回滚与导入替换都用它）。 */
async function removeWhere(condition: Record<string, unknown>): Promise<void> {
  await (db.collection(COLLECTION).where(condition) as unknown as { remove(): Promise<unknown> }).remove();
}

/** 客户端只需要业务字段与 id，不回传 owner。 */
function toClientCourse(row: StoredCourse): StoredCourse {
  return { ...row, owner: '' };
}

function sortedCourses(rows: StoredCourse[]): StoredCourse[] {
  return [...rows].sort((a, b) => a.weekday - b.weekday
    || (a.sectionRanges[0]?.start ?? 99) - (b.sectionRanges[0]?.start ?? 99)
    || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 已保存课表的学期标注：取出现次数最多的非空值；没有任何标注时为空字符串。 */
function summarizeSemester(rows: StoredCourse[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const semester = sanitizeSemester(row.semester);
    if (semester === '') continue;
    counts.set(semester, (counts.get(semester) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [semester, count] of counts) {
    if (count > bestCount) {
      best = semester;
      bestCount = count;
    }
  }
  return best;
}

/** 组装一条待写入的记录；`semester` 统一在此截断。 */
function buildRecord(
  fields: CourseFields,
  owner: string,
  semester: string,
  id: string,
  rawText: string,
  now: string,
  batch: string,
): StoredCourse & { batch: string } {
  return {
    ...fields,
    id,
    owner,
    semester: sanitizeSemester(semester),
    rawText,
    createdAt: now,
    updatedAt: now,
    batch,
  };
}

/** 删除云存储里的临时文件；失败只返回 false，不影响解析结果。 */
async function deleteStoredFile(fileID: string): Promise<boolean> {
  try {
    await cloud.deleteFile({ fileList: [fileID] });
    return true;
  } catch {
    return false;
  }
}

async function handlePrepareUpload(event: CloudEvent, openid: string) {
  const fileName = typeof event.fileName === 'string' ? event.fileName : '';
  const extension = extensionOf(fileName);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return { ok: false, error: '只支持教务系统导出的 .xls 或 .xlsx 课表文件' };
  }
  const cloudPath = `${ownerPrefix(openid)}${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${extension}`;
  return { ok: true, cloudPath, maxBytes: MAX_FILE_BYTES };
}

async function handleImportDraft(event: CloudEvent, openid: string) {
  const cloudPath = typeof event.cloudPath === 'string' ? event.cloudPath : '';
  const prefix = ownerPrefix(openid);
  if (cloudPath === '' || !cloudPath.startsWith(prefix) || cloudPath.includes('..')) {
    return { ok: false, error: '文件路径不属于当前微信身份，已拒绝解析' };
  }
  const fileName = typeof event.fileName === 'string' ? event.fileName : '';
  if (fileName !== '' && !ALLOWED_EXTENSIONS.includes(extensionOf(fileName))) {
    return { ok: false, error: '只支持教务系统导出的 .xls 或 .xlsx 课表文件' };
  }

  let buffer: Buffer;
  try {
    const downloaded = await cloud.downloadFile({ fileID: cloudPath });
    buffer = downloaded.fileContent as Buffer;
  } catch (error) {
    // 下载失败也要清掉临时文件，避免用户云存储里堆积。
    await deleteStoredFile(cloudPath);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法从云存储读取所选文件：${message}` };
  }
  // 先删后解析：解析失败时同样不会留下临时文件；解析只用内存里的字节。
  const tempFileDeleted = await deleteStoredFile(cloudPath);
  const draft = parseWorkbook(buffer, fileName === '' ? cloudPath : fileName);
  return {
    ok: true,
    draft,
    tempFileDeleted,
    note: '本次只做解析，未写入任何课表记录；确认页确认后才会保存',
  };
}

async function handleList(openid: string) {
  const rows = await readOwnCourses(openid);
  const courses = sortedCourses(rows);
  const updatedAt = rows.reduce((latest, row) => (row.updatedAt > latest ? row.updatedAt : latest), '');
  return {
    ok: true,
    count: courses.length,
    semester: summarizeSemester(rows),
    updatedAt,
    courses: courses.map(toClientCourse),
  };
}

async function handleSaveDraft(event: CloudEvent, openid: string) {
  if (!Array.isArray(event.courses)) return { ok: false, error: '缺少要保存的课表数据' };
  const input = event.courses as unknown[];
  if (input.length === 0) return { ok: false, error: '草稿里没有课程，没有可保存的内容' };
  if (input.length > MAX_COURSES) return { ok: false, error: `一次最多保存 ${MAX_COURSES} 条课程` };

  const now = new Date().toISOString();
  const batch = makeCourseId();
  const records: Array<StoredCourse & { batch: string }> = [];
  for (let index = 0; index < input.length; index += 1) {
    const normalized = normalizeCourseFields(input[index]);
    if (!normalized.ok) {
      // 整批拒绝：不做部分写入，学生修正后再保存。
      return { ok: false, error: `第 ${index + 1} 项无法保存：${normalized.error}` };
    }
    records.push(buildRecord(normalized.value, openid, sanitizeSemester(event.semester), makeCourseId(), String((input[index] as { rawText?: unknown }).rawText ?? ''), now, batch));
  }

  try {
    for (const record of records) {
      await db.collection(COLLECTION).add({ data: record });
    }
  } catch (error) {
    // 回滚本次写入，保留学生原来的课表。
    await removeWhere({ owner: openid, batch }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `保存失败，已回滚本次写入：${message}` };
  }
  // 新批次写成功后再删旧记录（导入＝整份替换）。
  await removeWhere({ owner: openid, batch: command.neq(batch) });
  return { ok: true, saved: records.length, semester: sanitizeSemester(event.semester), updatedAt: now };
}

async function handleCreateCourse(event: CloudEvent, openid: string) {
  const normalized = normalizeCourseFields(event.course);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const existing = await readOwnCourses(openid);
  if (existing.length >= MAX_COURSES) return { ok: false, error: `课表最多保存 ${MAX_COURSES} 条课程` };
  const semester = sanitizeSemester(event.semester) !== '' ? sanitizeSemester(event.semester) : summarizeSemester(existing);
  const now = new Date().toISOString();
  // 手工入口写入的记录一律标记为 manual（来源由服务端决定，不接受客户端传入）。
  const record = buildRecord({ ...normalized.value, source: 'manual' }, openid, semester, makeCourseId(), '', now, '');
  await db.collection(COLLECTION).add({ data: record });
  return { ok: true, course: toClientCourse(record), count: existing.length + 1 };
}

async function handleUpdateCourse(event: CloudEvent, openid: string) {
  const id = typeof event.id === 'string' ? event.id : '';
  if (id === '') return { ok: false, error: '缺少要修改的课程标识' };
  const normalized = normalizeCourseFields(event.course);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const rows = await queryData<{ _id: string }>(db.collection(COLLECTION).where({ owner: openid, id }).limit(1));
  if (rows.length === 0) return { ok: false, error: '未找到要修改的课程，可能已被删除' };
  const now = new Date().toISOString();
  // 只改课程字段与更新时间；semester 由服务端保留，不受客户端影响。
  await db.collection(COLLECTION).doc(rows[0]._id).update({ data: { ...normalized.value, updatedAt: now } });
  return { ok: true, id, updatedAt: now };
}

async function handleDeleteCourse(event: CloudEvent, openid: string) {
  const id = typeof event.id === 'string' ? event.id : '';
  if (id === '') return { ok: false, error: '缺少要删除的课程标识' };
  const rows = await queryData<{ _id: string }>(db.collection(COLLECTION).where({ owner: openid, id }).limit(1));
  if (rows.length === 0) return { ok: false, error: '未找到要删除的课程，可能已被删除' };
  await db.collection(COLLECTION).doc(rows[0]._id).remove();
  const remaining = await readOwnCourses(openid);
  return { ok: true, id, count: remaining.length };
}

export async function main(event: CloudEvent = {}) {
  const context = cloud.getWXContext();
  const openid = typeof context.OPENID === 'string' ? context.OPENID : '';
  if (openid === '') {
    return { ok: false, error: '未能获取微信身份（openid），无法读写个人课表' };
  }
  const action = typeof event.action === 'string' ? event.action : '';
  try {
    switch (action) {
      case 'prepareUpload':
        return await handlePrepareUpload(event, openid);
      case 'importDraft':
        return await handleImportDraft(event, openid);
      case 'list':
        return await handleList(openid);
      case 'saveDraft':
        return await handleSaveDraft(event, openid);
      case 'createCourse':
        return await handleCreateCourse(event, openid);
      case 'updateCourse':
        return await handleUpdateCourse(event, openid);
      case 'deleteCourse':
        return await handleDeleteCourse(event, openid);
      default:
        return { ok: false, error: `不支持的操作：${action === '' ? '(空)' : action}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `课表操作失败：${message}` };
  }
}
