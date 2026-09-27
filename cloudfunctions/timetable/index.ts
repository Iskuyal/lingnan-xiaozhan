/**
 * 个人课表云函数（Ticket 03）。
 *
 * 职责（全部按调用上下文的 openid 隔离，客户端不直连数据库）：
 * - `prepareUpload`：给本次调用者分配一个属于自己 openid 的云存储路径；
 * - `importDraft`：下载该路径下的文件 → 用 `xlsx` 解析成草稿返回 → **删除临时文件**；解析阶段不写任何课表记录；
 * - `list`：读取本人已保存的课表；
 * - `saveDraft`：确认页确认后整份替换本人课表（先写不可见批次，再用单个标记切换可见批次，旧记录清理可重试）；
 * - `createCourse` / `updateCourse` / `deleteCourse`：独立于导入的手工新增、修改、删除。
 * - `getSettings` / `saveSettings`：学期设置与作息时间（集合 `timetable_settings`，一条记录一个用户）。
 *   作息时刻全部由学生自填，服务端不预置任何默认值；倒置与重叠在写入前拒绝。
 *
 * 文件标识统一用 `wx.cloud.uploadFile` 返回的 **fileID**（`cloud://…`）：
 * `cloud.downloadFile` / `cloud.deleteFile` 只认 fileID，把 `prepareUpload` 给的裸
 * cloudPath 当 fileID 传下去会直接失败。归属校验因此改为**从 fileID 解析出云存储路径**，
 * 再要求它落在调用者自己的 openid 前缀下（fileID 前的环境信息不参与比较）。
 *
 * 集合 `timetable_courses` 与 `timetable_settings` 的权限都取最严格预设（所有用户不可读写）：
 * 读写都只发生在这里。函数本身需要允许客户端调用（与 `newsSync` 不同），
 * 见 docs/cloud-development.md 的控制台步骤。
 */
import * as cloud from 'wx-server-sdk';
import * as crypto from 'crypto';
import { parseWorkbook } from './parse';
import { makeCourseId, normalizeCourseFields, sanitizeSemester } from './record';
import { SETTINGS_COLLECTION, emptySettings, normalizeSettingsFields, readStoredSettings } from './settings';
import { CourseFields, StoredCourse, StoredSettings, UPLOAD_ROOT } from './types';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database();
const command = db.command;
const COLLECTION = 'timetable_courses';
const PAGE_SIZE = 100;
/** 单份课表最多保存的课程数：真实班级课表 50 条上下，留足余量同时挡住异常输入。 */
const MAX_COURSES = 300;
/** 与课程放在同一集合，单文档切换可见批次；旧数据没有此文档时按原记录读取。 */
interface CourseHead {
  activeBatch: string;
  cleanupPending: boolean;
  cleanupLegacy: boolean;
  cleanupBatch: string;
}
/** 上传文件大小上限（客户端先按同样数值拦截，服务端再兜一次）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.xls', '.xlsx'];
/** 截图上传（Ticket 05）：只放行 png/jpg，上限 2MB（客户端会先压到 1MB 以内再上传）。 */
const PHOTO_ALLOWED_EXTENSIONS = ['.png', '.jpg'];
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** fileID 的固定前缀；不是这个形状的一律按「传错标识」处理，不去猜。 */
const FILE_ID_PREFIX = 'cloud://';

interface CloudEvent {
  action?: unknown;
  [key: string]: unknown;
}

/** 调用者专属的上传路径前缀：用 openid 哈希，路径里不出现原始 openid。 */
function ownerPrefix(openid: string): string {
  const digest = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `${UPLOAD_ROOT}/${digest}/`;
}

function headId(openid: string): string {
  return `timetable-head-${crypto.createHash('sha256').update(openid).digest('hex')}`;
}

async function readHead(openid: string): Promise<CourseHead | null> {
  try {
    const result = await db.collection(COLLECTION).doc(headId(openid)).get() as { data?: unknown } | null | undefined;
    const data = result?.data as Partial<CourseHead> | null | undefined;
    if (data === undefined || data === null) return null;
    if (typeof data.activeBatch !== 'string' || data.activeBatch === '') {
      throw new Error('课表批次标记损坏，已停止读写以保护原数据');
    }
    return {
      activeBatch: data.activeBatch,
      cleanupPending: data.cleanupPending === true,
      cleanupLegacy: data.cleanupLegacy === true,
      cleanupBatch: typeof data.cleanupBatch === 'string' ? data.cleanupBatch : '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not exist|does not exist|doesn't exist|DOCUMENT_NOT_EXIST|non-exists/iu.test(message)) return null;
    throw error;
  }
}

function visibleCourseCondition(openid: string, head: CourseHead | null, id?: string): Record<string, unknown> {
  const condition: Record<string, unknown> = head === null
    ? { owner: openid, staged: command.neq(true) }
    : { owner: openid, batch: head.activeBatch };
  if (id !== undefined) condition.id = id;
  return condition;
}

function sameActiveBatch(left: CourseHead | null, right: CourseHead | null): boolean {
  return left?.activeBatch === right?.activeBatch;
}

/** 取扩展名（小写，含点）；没有扩展名时返回空字符串。 */
function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]+$/u.exec(name);
  return match === null ? '' : match[0].toLowerCase();
}

/**
 * fileID → 云存储相对路径：
 * `cloud://环境.桶/timetable-imports/<hash>/x.xls` → `timetable-imports/<hash>/x.xls`。
 * 不是 fileID 形状（例如裸 cloudPath）或解析不出路径时返回空字符串，由调用方拒绝。
 */
function storagePathOf(fileID: string): string {
  if (!fileID.startsWith(FILE_ID_PREFIX)) return '';
  const rest = fileID.slice(FILE_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return '';
  return rest.slice(slash + 1);
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * 归属校验：**从 fileID 解析出云存储路径**，要求它落在调用者自己的 openid 前缀下。
 * 传裸路径（Ticket 03 的老写法）在这里被明确挡下——它不是合法 fileID，
 * 传下去只会在 `downloadFile` 处得到一个指错方向的失败。
 */
function ownFilePath(fileID: string, openid: string, actionLabel: string): { ok: true; path: string } | { ok: false; error: string } {
  if (fileID === '' || !fileID.startsWith(FILE_ID_PREFIX)) {
    return { ok: false, error: '请传入上传成功后返回的 fileID（cloud:// 开头），不要传裸路径' };
  }
  const path = storagePathOf(fileID);
  if (path === '' || !path.startsWith(ownerPrefix(openid)) || path.includes('..')) {
    return { ok: false, error: `文件不属于当前微信身份，已拒绝${actionLabel}` };
  }
  return { ok: true, path };
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
async function readOwnCourses(openid: string, selectedHead?: CourseHead | null): Promise<StoredCourse[]> {
  const head = selectedHead === undefined ? await readHead(openid) : selectedHead;
  const condition = visibleCourseCondition(openid, head);
  const rows: StoredCourse[] = [];
  for (let skip = 0; skip < MAX_COURSES; skip += PAGE_SIZE) {
    const page = await queryData<StoredCourse>(
      db.collection(COLLECTION).where(condition).skip(skip).limit(PAGE_SIZE),
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

/** 清理旧批次失败时保留标记，下次读取再试；可见批次不受清理结果影响。 */
async function finishOldBatchCleanup(openid: string, head: CourseHead): Promise<boolean> {
  try {
    const condition = head.cleanupLegacy
      ? { owner: openid, staged: command.neq(true), headBound: command.neq(true) }
      : { owner: openid, batch: head.cleanupBatch };
    await removeWhere(condition);
    // 旧请求不能清除后续导入的待清理标记。
    const result = await db.collection(COLLECTION)
      .where({ _id: headId(openid), activeBatch: head.activeBatch })
      .update({ data: { cleanupPending: false } });
    return (result as { stats?: { updated?: number } }).stats?.updated !== 0;
  } catch {
    return false;
  }
}

/** 只清理超过一次云函数最长运行时间的隐藏批次，避免误删正在写入的导入。 */
async function cleanupAbandonedStages(openid: string, head: CourseHead | null): Promise<void> {
  const olderThan = new Date(Date.now() - 60_000).toISOString();
  const condition: Record<string, unknown> = {
    owner: openid,
    staged: true,
    createdAt: command.lt(olderThan),
  };
  if (head !== null) condition.batch = command.neq(head.activeBatch);
  await removeWhere(condition);
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

/** 截图识别（Ticket 05）：给本人 openid 分配截图上传路径；识别由 ai 云函数完成，这里只管路径。 */
async function handlePreparePhotoUpload(event: CloudEvent, openid: string) {
  const fileName = typeof event.fileName === 'string' ? event.fileName : '';
  const extension = extensionOf(fileName);
  if (!PHOTO_ALLOWED_EXTENSIONS.includes(extension)) {
    return { ok: false, error: '只支持 .png 或 .jpg 的课表截图' };
  }
  const cloudPath = `${ownerPrefix(openid)}${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${extension}`;
  return { ok: true, cloudPath, maxBytes: PHOTO_MAX_BYTES };
}

async function handleImportDraft(event: CloudEvent, openid: string) {
  const fileID = typeof event.fileID === 'string' ? event.fileID.trim() : '';
  const own = ownFilePath(fileID, openid, '解析');
  if (!own.ok) return { ok: false, error: own.error };
  const fileName = typeof event.fileName === 'string' ? event.fileName : '';
  if (fileName !== '' && !ALLOWED_EXTENSIONS.includes(extensionOf(fileName))) {
    return { ok: false, error: '只支持教务系统导出的 .xls 或 .xlsx 课表文件' };
  }

  let buffer: Buffer;
  try {
    const downloaded = await cloud.downloadFile({ fileID });
    buffer = downloaded.fileContent as Buffer;
  } catch (error) {
    // 下载失败也要清掉临时文件，避免用户云存储里堆积。
    await deleteStoredFile(fileID);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法从云存储读取所选文件：${message}` };
  }
  // 先删后解析：解析失败时同样不会留下临时文件；解析只用内存里的字节。
  const tempFileDeleted = await deleteStoredFile(fileID);
  const draft = parseWorkbook(buffer, fileName === '' ? baseName(own.path) : fileName);
  return {
    ok: true,
    draft,
    tempFileDeleted,
    note: '本次只做解析，未写入任何课表记录；确认页确认后才会保存',
  };
}

/** 清理未能进入解析阶段的临时文件（例如上传成功但解析调用没到达云端）。 */
async function handleDiscardUpload(event: CloudEvent, openid: string) {
  const fileID = typeof event.fileID === 'string' ? event.fileID.trim() : '';
  const own = ownFilePath(fileID, openid, '删除');
  if (!own.ok) return { ok: false, error: own.error };
  const deleted = await deleteStoredFile(fileID);
  return { ok: true, deleted };
}

async function handleList(openid: string) {
  const head = await readHead(openid);
  if (head?.cleanupPending) await finishOldBatchCleanup(openid, head);
  await cleanupAbandonedStages(openid, head).catch(() => undefined);
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
  const oldHead = await readHead(openid);
  const records: Array<StoredCourse & { batch: string; staged: boolean }> = [];
  for (let index = 0; index < input.length; index += 1) {
    const normalized = normalizeCourseFields(input[index]);
    if (!normalized.ok) {
      // 整批拒绝：不做部分写入，学生修正后再保存。
      return { ok: false, error: `第 ${index + 1} 项无法保存：${normalized.error}` };
    }
    records.push({
      ...buildRecord(normalized.value, openid, sanitizeSemester(event.semester), makeCourseId(), String((input[index] as { rawText?: unknown }).rawText ?? ''), now, batch),
      staged: true,
    });
  }

  try {
    for (const record of records) {
      await db.collection(COLLECTION).add({ data: record });
    }
  } catch (error) {
    // 新批次尚未成为可见批次；即使清理失败，旧课表仍是唯一可见内容。
    const cleared = await removeWhere({ owner: openid, batch }).then(() => true, () => false);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `保存失败，${cleared ? '已清理未生效的新批次' : '未生效的新批次待清理'}：${message}` };
  }
  try {
    // 单文档提交可见批次；旧批次清理失败也不会混入列表。
    await db.collection(COLLECTION).doc(headId(openid)).set({
      data: {
        activeBatch: batch,
        cleanupPending: true,
        cleanupLegacy: oldHead === null,
        cleanupBatch: oldHead?.activeBatch ?? '',
        updatedAt: now,
      },
    });
  } catch (error) {
    // set 的应答可能在服务端提交后丢失。先读回标记，不能盲目删除已生效课程。
    let observed: CourseHead | null;
    try {
      observed = await readHead(openid);
    } catch {
      return { ok: false, error: '保存状态暂时无法确认，请刷新课表查看；未删除任何可能已生效的课程' };
    }
    if (observed?.activeBatch !== batch) {
      await removeWhere({ owner: openid, batch }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `保存失败，新课表未生效；请刷新后重试：${message}` };
    }
  }
  const cleaned = await finishOldBatchCleanup(openid, {
    activeBatch: batch,
    cleanupPending: true,
    cleanupLegacy: oldHead === null,
    cleanupBatch: oldHead?.activeBatch ?? '',
  });
  return { ok: true, saved: records.length, semester: sanitizeSemester(event.semester), updatedAt: now, cleanupPending: !cleaned };
}

async function handleCreateCourse(event: CloudEvent, openid: string) {
  const normalized = normalizeCourseFields(event.course);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const head = await readHead(openid);
  const existing = await readOwnCourses(openid, head);
  if (existing.length >= MAX_COURSES) return { ok: false, error: `课表最多保存 ${MAX_COURSES} 条课程` };
  const semester = sanitizeSemester(event.semester) !== '' ? sanitizeSemester(event.semester) : summarizeSemester(existing);
  const now = new Date().toISOString();
  // 手工入口写入的记录一律标记为 manual（来源由服务端决定，不接受客户端传入）。
  const record = {
    ...buildRecord({ ...normalized.value, source: 'manual' }, openid, semester, makeCourseId(), '', now, head?.activeBatch ?? ''),
    ...(head === null ? {} : { headBound: true }),
  };
  await db.collection(COLLECTION).add({ data: record });
  if (!sameActiveBatch(head, await readHead(openid))) {
    await removeWhere({ owner: openid, id: record.id, batch: record.batch }).catch(() => undefined);
    return { ok: false, error: '课表同时被重新导入，本次新增未确认保存；请刷新课表后重试' };
  }
  return { ok: true, course: toClientCourse(record), count: existing.length + 1 };
}

/**
 * `updateCourse` 允许被覆盖的课程字段白名单（顺序无关）。
 *
 * 白名单之外的一律不碰：`id` / `owner` / `semester` / `rawText` / `createdAt` / `batch`
 * 与 `source` 都由服务端掌握——来源在新增时定为 `manual`、导入时由 `saveDraft` 决定，
 * 修改课程不改变它，客户端即使传了也不生效。
 */
const COURSE_FIELD_KEYS = [
  'name',
  'credits',
  'teacher',
  'weekday',
  'startSection',
  'endSection',
  'sectionRanges',
  'weeks',
  'weeksRecognized',
  'weekText',
  'location',
  'campus',
  'siteNumber',
  'note',
  'warnings',
  // 课程色：客户端显式给出才覆盖（空字符串 = 回到按课程名自动取色）。
  'color',
] as const;

async function handleUpdateCourse(event: CloudEvent, openid: string) {
  const id = typeof event.id === 'string' ? event.id : '';
  if (id === '') return { ok: false, error: '缺少要修改的课程标识' };
  if (event.course === null || typeof event.course !== 'object' || Array.isArray(event.course)) {
    return { ok: false, error: '缺少要修改的课程数据' };
  }
  const patch = event.course as Record<string, unknown>;
  const head = await readHead(openid);
  const condition = visibleCourseCondition(openid, head, id);
  const rows = await queryData<StoredCourse & { _id: string }>(
    db.collection(COLLECTION).where(condition).limit(1),
  );
  if (rows.length === 0) return { ok: false, error: '未找到要修改的课程，可能已被删除' };

  // **部分更新**：只应用客户端显式给出的字段，未给出的字段保持原值。
  // 「只改时间」不得把教师/地点/学分/周次/备注等一起清空（Ticket 03 的表单外字段保留契约，
  // Ticket 06 的助手改动也按这条提交）；要清空某个字段必须在请求里显式给空字符串。
  const merged: Record<string, unknown> = { ...rows[0] };
  for (const key of COURSE_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
  }
  const normalized = normalizeCourseFields(merged);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const now = new Date().toISOString();
  // semester 由服务端保留，不受客户端影响；只写规范化后的课程字段与更新时间。
  await db.collection(COLLECTION).doc(rows[0]._id).update({ data: { ...normalized.value, updatedAt: now } });
  if (!sameActiveBatch(head, await readHead(openid))) {
    return { ok: false, error: '课表同时被重新导入，本次修改可能已被覆盖；请刷新课表后重试' };
  }
  return { ok: true, id, updatedAt: now };
}

async function handleDeleteCourse(event: CloudEvent, openid: string) {
  const id = typeof event.id === 'string' ? event.id : '';
  if (id === '') return { ok: false, error: '缺少要删除的课程标识' };
  const head = await readHead(openid);
  const condition = visibleCourseCondition(openid, head, id);
  const rows = await queryData<{ _id: string }>(db.collection(COLLECTION).where(condition).limit(1));
  if (rows.length === 0) return { ok: false, error: '未找到要删除的课程，可能已被删除' };
  await db.collection(COLLECTION).doc(rows[0]._id).remove();
  if (!sameActiveBatch(head, await readHead(openid))) {
    return { ok: false, error: '课表同时被重新导入，本次删除可能已被覆盖；请刷新课表后重试' };
  }
  const remaining = await readOwnCourses(openid);
  return { ok: true, id, count: remaining.length };
}

/**
 * 读本人的学期设置与作息时间。
 *
 * 还没有记录时返回**空设置**（`saved: false`）：这不是错误，学生第一次进来就是这样。
 * 集合未创建/无权限这类技术性失败**不在这里吞掉**——照常抛给 main 的兜底，
 * 由小程序侧的降级路径处理（页面照常可用，同时把原因显示出来，便于发现「集合还没建」）。
 */
async function handleGetSettings(openid: string) {
  const rows = await queryData<StoredSettings>(db.collection(SETTINGS_COLLECTION).where({ owner: openid }).limit(1));
  if (rows.length === 0) return { ok: true, saved: false, settings: emptySettings() };
  return { ok: true, saved: true, settings: readStoredSettings(rows[0]) };
}

/**
 * 写本人的设置：一条记录一个用户，第一次插入、之后更新同一条。
 *
 * 校验在 `settings.ts`（倒置、重叠、格式、范围），失败整份拒绝并给可理解的原因；
 * `owner` / `createdAt` / `updatedAt` 由服务端掌握，不接受客户端传入。
 */
async function handleSaveSettings(event: CloudEvent, openid: string) {
  const normalized = normalizeSettingsFields(event.settings);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const now = new Date().toISOString();
  const rows = await queryData<StoredSettings & { _id: string }>(
    db.collection(SETTINGS_COLLECTION).where({ owner: openid }).limit(1),
  );
  if (rows.length === 0) {
    const record: StoredSettings = { ...normalized.value, owner: openid, createdAt: now, updatedAt: now };
    await db.collection(SETTINGS_COLLECTION).add({ data: record });
  } else {
    await db.collection(SETTINGS_COLLECTION).doc(rows[0]._id).update({ data: { ...normalized.value, updatedAt: now } });
  }
  return { ok: true, saved: true, settings: normalized.value, updatedAt: now };
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
      case 'preparePhotoUpload':
        return await handlePreparePhotoUpload(event, openid);
      case 'importDraft':
        return await handleImportDraft(event, openid);
      case 'discardUpload':
        return await handleDiscardUpload(event, openid);
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
      case 'getSettings':
        return await handleGetSettings(openid);
      case 'saveSettings':
        return await handleSaveSettings(event, openid);
      default:
        return { ok: false, error: `不支持的操作：${action === '' ? '(空)' : action}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `课表操作失败：${message}` };
  }
}
