/**
 * 课表服务：把页面要用的动作映射到 `timetable` 云函数的各 action。
 *
 * **客户端不直连数据库**：全部读写都经 `wx.cloud.callFunction`，由云函数按调用上下文的
 * openid 过滤（见 docs/development-spec.md 的「存储与隔离」）。这里不做任何本地持久化，
 * 页面每次进入都从云端读取，因此退出重进数据仍在。
 */
import { Course, CourseInput, DraftCourse, TimetableDraft } from './types';
import { requireCloud, transportMessage } from '../cloud';

export const FUNCTION_NAME = 'timetable';
/** 与云函数 MAX_FILE_BYTES 一致：上传前先挡一次，避免白传大文件。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.xls', '.xlsx'];
/**
 * 导入引导文案：小程序不能浏览手机本地文件，只能从微信聊天记录里选。
 * 这句话必须让用户一眼看到，否则「选不到文件」会被误当成缺陷。
 */
export const FILE_GUIDE = '小程序不能浏览手机里的文件，只能从微信聊天记录中选择。请先把课表文件发到微信（例如发给「文件传输助手」），再回到这里选择。';
/** 解析在云函数侧进行，导入必须联网。 */
export const OFFLINE_NOTE = '解析在云端进行，导入时需要联网；解析阶段不会写入任何课表数据。';

interface CloudResponse {
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

interface UploadResult {
  cloudPath: string;
  maxBytes: number;
}

/** 上传成功后的定位信息：**只回传 fileID**（`cloud://…`）——下载、删除与 vision 都只认它。 */
export interface UploadedFile {
  fileID: string;
}

/** 调用课表云函数；云函数返回 ok:false 时抛错，页面按错误文案提示。 */
/**
 * 平台/数据库层的技术性错误：这类文本不该原样展示给学生。
 *
 * 例：集合尚未创建时云函数返回 `collection.get:fail -502005 database collection not exists
 * … Db or Table not exist: timetable_courses …`——里面带错误码与文档链接，学生看不懂，
 * 演示时更不该出现。这类错误映射成一句话，原文打到控制台供维护者排查；
 * 业务性错误（例如「只支持 .xls 或 .xlsx」）不受影响，原样透出。
 */
const TECHNICAL_ERROR_PATTERN = /-5\d{5}|database|collection|Db or Table|permission denied|timed out|FUNCTION_NOT_FOUND|cloud\./iu;

/** 把云函数返回的错误文本分成「可直接展示」与「技术性需改写」两类。 */
export function readableCloudError(message: string): { text: string; technical: boolean } {
  if (!TECHNICAL_ERROR_PATTERN.test(message)) return { text: message, technical: false };
  return { text: '课表服务暂时不可用，请稍后重试；已保存的课表不受影响', technical: true };
}

async function callTimetable<T>(data: Record<string, unknown>): Promise<T> {
  requireCloud();
  const response = await wx.cloud.callFunction({ name: FUNCTION_NAME, data });
  const result = (response === null || response === undefined ? undefined : response.result) as CloudResponse | undefined;
  if (result === undefined || result.ok !== true) {
    const raw = result !== undefined && typeof result.error === 'string' && result.error !== ''
      ? result.error
      : '课表服务返回了无法识别的结果';
    const mapped = readableCloudError(raw);
    if (mapped.technical) console.error('课表服务返回技术性错误：', raw);
    throw new Error(mapped.text);
  }
  return result as T;
}

/**
 * 取错误的可读文案；云调用失败时抛出的常是带 errMsg 的普通对象而非 Error 实例。
 * 云端返回的技术性错误（函数未部署、权限、超时）映射成学生能看懂的一句话，
 * 原始错误仍打到控制台，便于排查。映射规则与 AI 封装共用 `services/cloud.ts`；
 * 课表页另外保留「原样展示云函数返回的业务提示」这一兜底策略（fallback 传空串）。
 */
export function messageOf(error: unknown): string {
  return transportMessage(error, {
    service: '课表服务',
    logLabel: '课表操作失败',
    fallback: '',
  });
}

/** 扩展名（小写，含点）。 */
export function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]+$/u.exec(name);
  return match === null ? '' : match[0].toLowerCase();
}

/** 上传前的本地校验：格式与大小。返回空字符串表示可以上传。 */
export function checkChosenFile(file: { name: string; size?: number }): string {
  const extension = extensionOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return `只支持教务系统导出的 .xls 或 .xlsx 文件，当前选择的是「${file.name}」`;
  }
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
    return `文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB，请确认选择的是课表文件`;
  }
  return '';
}

/** 第一步：向云函数申请一个属于本人 openid 的云存储路径。 */
export async function prepareUpload(fileName: string): Promise<UploadResult> {
  return callTimetable<UploadResult>({ action: 'prepareUpload', fileName });
}

/**
 * 第二步：把选中的文件上传到该路径（带进度回调，页面显示上传中）。
 *
 * **必须返回云存储的 `fileID`**：后续的 `importDraft` / `discardUpload` 与 ai 的 `vision`
 * 都把它当文件标识；`uploadFile` 返回的 `cloudPath` 只是相对路径，直接当 fileID 传给
 * `cloud.downloadFile` 会在部署后第一次调用就失败（Ticket 03 的老写法，已一并修正）。
 */
export function uploadFile(cloudPath: string, filePath: string, onProgress?: (percent: number) => void): Promise<UploadedFile> {
  requireCloud();
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (result) => {
        const fileID = result === null || result === undefined ? '' : result.fileID;
        if (typeof fileID !== 'string' || fileID === '') {
          // 拿不到 fileID 就没有可用的文件标识，宁可在这里失败也不把 cloudPath 当 fileID 传下去。
          reject(new Error('上传完成但没有拿到云存储 fileID，请重试'));
          return;
        }
        resolve({ fileID });
      },
      fail: (error) => reject(new Error(`上传失败：${messageOf(error)}`)),
    });
    if (onProgress !== undefined && task !== null && task !== undefined && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((progress) => onProgress(progress.progress));
    }
  });
}

/** 第三步：请云函数下载并解析成草稿；解析阶段不写入任何课表记录。传上传返回的 fileID。 */
export async function importDraft(fileID: string, fileName: string): Promise<TimetableDraft> {
  const result = await callTimetable<{ draft: TimetableDraft }>({ action: 'importDraft', fileID, fileName });
  return result.draft;
}

/** 解析失败且调用未到达云端时，清掉可能残留的临时文件（尽力而为）。传上传返回的 fileID。 */
export async function discardUpload(fileID: string): Promise<void> {
  try {
    await callTimetable<{ deleted: boolean }>({ action: 'discardUpload', fileID });
  } catch {
    // 清理失败不影响用户流程；云函数在每次成功解析后都会删除临时文件。
  }
}

/** 读取本人已保存的课表。 */
export async function listCourses(): Promise<{ courses: Course[]; semester: string; updatedAt: string; count: number }> {
  const result = await callTimetable<{ courses: Course[]; semester: string; updatedAt: string; count: number }>({ action: 'list' });
  return {
    courses: Array.isArray(result.courses) ? result.courses : [],
    semester: typeof result.semester === 'string' ? result.semester : '',
    updatedAt: typeof result.updatedAt === 'string' ? result.updatedAt : '',
    count: typeof result.count === 'number' ? result.count : 0,
  };
}

/** 确认页确认后整份替换本人课表。 */
export async function saveDraft(courses: DraftCourse[], semester: string): Promise<{ saved: number }> {
  return callTimetable<{ saved: number }>({ action: 'saveDraft', courses, semester });
}

/** 手工新增一条课程。 */
export async function createCourse(course: CourseInput, semester: string): Promise<Course> {
  const result = await callTimetable<{ course: Course }>({ action: 'createCourse', course, semester });
  return result.course;
}

/** 修改一条已保存的课程。 */
export async function updateCourse(id: string, course: CourseInput): Promise<void> {
  await callTimetable<{ id: string }>({ action: 'updateCourse', id, course });
}

/** 删除一条已保存的课程，返回剩余条数。 */
export async function deleteCourse(id: string): Promise<number> {
  const result = await callTimetable<{ count: number }>({ action: 'deleteCourse', id });
  return typeof result.count === 'number' ? result.count : 0;
}

/**
 * 截图上传与识别（Ticket 05）：申请本人 openid 下的截图上传路径。
 * 大小上限以服务端返回的 `maxBytes` 为准（客户端先把图压到 `MAX_PHOTO_BYTES` 以内再上传）；
 * 上传后拿 cloudPath 传给 `uploadFile`，并把返回的 fileID 交给 ai 的 vision。
 */
export async function preparePhotoUpload(fileName: string): Promise<UploadResult> {
  return callTimetable<UploadResult>({ action: 'preparePhotoUpload', fileName });
}
