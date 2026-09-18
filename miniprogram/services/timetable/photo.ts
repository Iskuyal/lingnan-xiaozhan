/**
 * 课表截图识别的纯逻辑（Ticket 05）：格式判定、压缩决策、识别提示词与结果解析（页面只绑定数据）。
 *
 * 识别走 ai 云函数的 vision 动作（图片先过内容安全再送模型，见 cloudfunctions/ai）：
 * 客户端上传截图后只传上传接口返回的 **fileID**（`cloud://…`，不是裸路径）；
 * 模型返回的 JSON 在这里解析成课表草稿（TimetableDraft），复用 03 的确认页与保存链路。
 * 识别不出的字段只标记不猜——与导入解析同一纪律（docs/development-spec.md「课表导入」与 Ticket 03）。
 */
import { DraftCourse, SectionRange, TimetableDraft } from './types';
import { parseWeekNotation } from './weeks';

/** 图片大小上限（字节）：与 ai 云函数 AI_MAX_IMAGE_BYTES 默认值一致（微信官方图片检测接口限制 1MB）。 */
export const MAX_PHOTO_BYTES = 1024 * 1024;

/**
 * 允许上传的图片格式：与 ai 云函数的 MIME 白名单（`image/png` / `image/jpeg`）一致。
 *
 * **格式由真实信息决定，不猜**：优先看文件头（内容是事实），读不到字节时退回文件路径的
 * 扩展名；两者都拿不到就拒绝上传，不替用户假定一个格式——猜错会让 `imgSecCheck` 与模型的
 * `media_type` 与实际内容不符，失败信息还会指错方向（云函数按 fileID 扩展名判定 MIME）。
 */
export interface PhotoFormat {
  /** 上传时写进文件名的扩展名；JPEG 统一用 `.jpg`。 */
  extension: '.png' | '.jpg';
  /** 界面/提示里用的格式名。 */
  label: 'PNG' | 'JPG';
}

export const PHOTO_FORMATS: { png: PhotoFormat; jpg: PhotoFormat } = {
  png: { extension: '.png', label: 'PNG' },
  jpg: { extension: '.jpg', label: 'JPG' },
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** 明确认出但不受支持的头，用来把「不支持」与「认不出」分开说。 */
const OTHER_MAGIC: Array<{ label: string; magic: number[] }> = [
  { label: 'GIF', magic: [0x47, 0x49, 0x46] },
  { label: 'WebP', magic: [0x52, 0x49, 0x46, 0x46] },
  { label: 'BMP', magic: [0x42, 0x4d] },
  { label: 'HEIC', magic: [0x66, 0x74, 0x79, 0x70] },
];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

/** wx 读文件返回的字节（ArrayBuffer 或 TypedArray）→ Uint8Array；其它形状返回 null。 */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** 从文件头判断格式（PNG / JPEG 的魔数）；不是这两种返回 null——不猜。 */
export function sniffPhotoFormat(bytes: Uint8Array | null): PhotoFormat | null {
  if (bytes === null) return null;
  if (startsWith(bytes, PNG_MAGIC)) return PHOTO_FORMATS.png;
  if (startsWith(bytes, JPEG_MAGIC)) return PHOTO_FORMATS.jpg;
  return null;
}

/** 文件头认得出、但本产品不收的格式名（GIF / WebP / BMP / HEIC）；认不出返回空字符串。 */
export function unsupportedFormatLabel(bytes: Uint8Array | null): string {
  if (bytes === null) return '';
  const hit = OTHER_MAGIC.find((entry) => startsWith(bytes, entry.magic));
  return hit === undefined ? '' : hit.label;
}

/** 从文件路径的扩展名判断格式；`.jpeg` 归到 JPG，其余返回 null。 */
export function formatFromPath(path: string): PhotoFormat | null {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path.trim());
  if (match === null) return null;
  const extension = match[1].toLowerCase();
  if (extension === 'png') return PHOTO_FORMATS.png;
  if (extension === 'jpg' || extension === 'jpeg') return PHOTO_FORMATS.jpg;
  return null;
}

/**
 * 真实格式判定：**读到了文件头就只信内容**（内容是事实）——头是 GIF 之类的不支持格式时
 * 直接拒绝，绝不因为路径叫 `.png` 就放行（`wx.compressImage` 会改内容不改路径，路径会骗人）。
 * 只有**读不到字节**时才退回路径扩展名；两条路都拿不到格式就返回 null。
 */
export function resolvePhotoFormat(path: string, header: Uint8Array | null): PhotoFormat | null {
  if (header !== null) return sniffPhotoFormat(header);
  return formatFromPath(path);
}

/** 上传用的文件名：`课表截图` + 真实扩展名；云函数与 ai 都按它判定 MIME（不靠猜）。 */
export function photoFileName(format: PhotoFormat): string {
  return '课表截图' + format.extension;
}

/** 引导文案：拍照/相册两个来源都要写明，识别结果要确认后才保存。 */
export const PHOTO_GUIDE = '也可以直接拍照，或从相册选一张课表截图：AI 会先识别成草稿，你逐条确认后才保存；拍不清的内容会在草稿里标注待核对。';

/** vision 单次最大输出 token：一份课表 JSON 远小于该值，留足余量。 */
export const VISION_MAX_TOKENS = 2048;

/** 识别系统提示词：只输出 JSON、识别不出留空、绝不编造。 */
export const VISION_SYSTEM = [
  '你是课表截图识别器。识别图片中的课程表，只输出一个 JSON 对象，不要输出任何解释或多余文字。',
  'JSON 结构：',
  '{"semester":"学年学期原文，识别不出为空字符串","school":"学校名称原文，识别不出为空字符串","problems":["整张图层面的问题，例如截图不完整、有遮挡"],"courses":[{"name":"课程名，识别不出留空","teacher":"教师，识别不出留空","weekday":1到7的整数，星期一到星期日，识别不出留 0,"startSection":1到12的整数,"endSection":1到12的整数且不小于 startSection，识别不出留 0,"weekText":"周次原文，例如 [1-16]周；截图里没写周次就留空，不要自己补","everyWeek":布尔值，仅当截图里**明确**写着这门课每周都上（如「每周」「全周」）时才填 true；周次没写、看不清或只写到部分周次时一律填 false,"location":"上课地点，识别不出留空","credits":"学分原文，识别不出留空","campus":"校区，识别不出留空","siteNumber":"场地编号，识别不出留空","note":"备注，识别不出留空"}]}',
  '纪律：识别不出的字段一律留空或留 0，绝不编造；周次写法保持原样，不要转换成其它写法。',
  '周次没看清时必须留空并把 everyWeek 填 false——系统会把留空的周次标成「待核对」交给学生确认，不要替学生判断成每周。',
].join('\n');

/** 用户消息：图片由 ai 云函数自动挂到这条消息上。 */
export const VISION_PROMPT = '请识别这张课表截图，按系统提示的 JSON 结构输出。';

/**
 * 与服务端 record.ts 的 LIMITS 一致的字段上限（客户端先截断，服务端再校验兜底）。
 * 改名或改上限必须两边同步。
 */
const LIMITS = {
  name: 60,
  credits: 10,
  teacher: 40,
  location: 80,
  campus: 20,
  siteNumber: 12,
  note: 60,
  weekText: 40,
  warning: 100,
  maxWarnings: 12,
} as const;

/** 压缩步骤：1MB 内不压；超限依次质量 80/60/40，再画布缩放 0.75/0.5，仍超限则 give-up。 */
export type CompressionStep =
  | 'none'
  | 'quality-80'
  | 'quality-60'
  | 'quality-40'
  | 'canvas-0.75'
  | 'canvas-0.5'
  | 'give-up';

/**
 * 压缩阶梯：每一步执行后重新量大小，执行完这 5 步仍超限就放弃（不再降画质，避免截出来的字看不清）。
 * 页面按 `planCompression` 的返回值执行，`give-up` 是**可达**的终点，不是兜底分支。
 */
export const COMPRESSION_LADDER: CompressionStep[] = ['quality-80', 'quality-60', 'quality-40', 'canvas-0.75', 'canvas-0.5'];

/**
 * 按当前大小与已尝试次数决定下一步；纯函数，便于测试。
 * `attemptsSoFar` 是**已执行**的压缩步数：0..4 返回阶梯里对应的下一步，5 及以上返回 `give-up`。
 */
export function planCompression(bytes: number, attemptsSoFar: number): CompressionStep {
  if (bytes <= MAX_PHOTO_BYTES) return 'none';
  const step = COMPRESSION_LADDER[Math.max(0, Math.floor(attemptsSoFar))];
  return step === undefined ? 'give-up' : step;
}

interface RawCourse {
  name?: unknown;
  teacher?: unknown;
  weekday?: unknown;
  startSection?: unknown;
  endSection?: unknown;
  weekText?: unknown;
  /** 模型显式声明的「每周」；只有 `true` 才按每周处理。 */
  everyWeek?: unknown;
  location?: unknown;
  credits?: unknown;
  campus?: unknown;
  siteNumber?: unknown;
  note?: unknown;
}

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function asInt(value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) ? value : 0;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : 0;
  }
  return 0;
}

/** 从模型输出里取出 JSON 对象：先整体解析，失败时截取第一个 { 到最后一个 } 再试。 */
function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const tryParse = (source: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParse(trimmed.slice(start, end + 1));
}

function emptyDraft(problems: string[]): TimetableDraft {
  return {
    meta: {
      sheetName: '',
      fileName: '课表截图',
      origin: 'photo',
      school: '',
      semester: '',
      exportedAt: '',
      department: '',
      grade: '',
      major: '',
      className: '',
    },
    courses: [],
    problems,
    stats: { sheets: 0, cells: 0, entries: 0, courses: 0, duplicates: 0, warnings: 0 },
  };
}

/**
 * 模型输出文本 → 课表草稿。解析失败时 courses 为空、problems 说明原因（不抛异常，
 * 页面把 problems 展示为可理解提示）。识别不出的字段只标记不猜，与导入解析同一纪律。
 */
export function parseVisionText(text: string): TimetableDraft {
  const parsed = extractJson(text);
  if (parsed === null) {
    return emptyDraft(['识别结果无法解析（模型没有返回 JSON），请重试，或改用文件导入。']);
  }

  const problems: string[] = [];
  const rawProblems = parsed.problems;
  if (Array.isArray(rawProblems)) {
    for (const raw of rawProblems) {
      if (typeof raw === 'string' && raw.trim() !== '' && problems.length < 20) {
        problems.push(raw.trim().slice(0, 200));
      }
    }
  }

  const courses: DraftCourse[] = [];
  const rawCourses = parsed.courses;
  if (Array.isArray(rawCourses)) {
    for (const raw of rawCourses) {
      if (raw === null || typeof raw !== 'object') continue;
      const row = raw as RawCourse;
      const warnings: string[] = [];
      const pushWarning = (value: string): void => {
        if (warnings.length < LIMITS.maxWarnings) warnings.push(value.slice(0, LIMITS.warning));
      };

      const name = asString(row.name, LIMITS.name);
      if (name === '') pushWarning('课程名未识别');
      const teacher = asString(row.teacher, LIMITS.teacher);
      if (teacher === '') pushWarning('教师未识别');
      let weekday = asInt(row.weekday);
      if (weekday < 1 || weekday > 7) {
        pushWarning('星期未识别');
        weekday = 0;
      }
      let startSection = asInt(row.startSection);
      let endSection = asInt(row.endSection);
      const sectionRanges: SectionRange[] = [];
      if (startSection >= 1 && startSection <= 12 && endSection >= startSection && endSection <= 12) {
        sectionRanges.push({ start: startSection, end: endSection });
      } else {
        pushWarning('节次未识别');
        startSection = 0;
        endSection = 0;
      }

      // 周次：**留空不等于每周**——截图没写周次时标成待核对交给学生确认。
      // 只有模型按提示词显式给出 everyWeek=true（截图里明确写着「每周」）才按每周处理。
      const weekText = asString(row.weekText, LIMITS.weekText);
      const everyWeek = row.everyWeek === true;
      const notation = weekText === '' ? null : parseWeekNotation(weekText);
      let weeks: number[] = [];
      let weeksRecognized = false;
      if (notation !== null && notation.recognized) {
        // 识别出具体周次（比「每周」更具体，优先采信）。
        weeks = notation.weeks;
        weeksRecognized = true;
      } else if (everyWeek) {
        // 显式「每周」：weeks 为空 + weeksRecognized=true，与手工表单留空表示每周同一口径。
        weeks = [];
        weeksRecognized = true;
      } else if (weekText !== '') {
        pushWarning('周次写法未能识别（原文：' + weekText + '），已保留原文，请核对');
      } else {
        pushWarning('截图里没有周次信息，请核对是否每周上课，或补填周次');
      }

      const location = asString(row.location, LIMITS.location);
      if (location === '') pushWarning('地点未识别');
      const credits = asString(row.credits, LIMITS.credits);
      const campus = asString(row.campus, LIMITS.campus);
      const siteNumber = asString(row.siteNumber, LIMITS.siteNumber);
      const note = asString(row.note, LIMITS.note);

      courses.push({
        draftId: 'photo-' + courses.length,
        name,
        credits,
        teacher,
        weekday,
        startSection,
        endSection,
        sectionRanges,
        weeks,
        weeksRecognized,
        weekText,
        location,
        campus,
        siteNumber,
        note,
        warnings,
        source: 'photo',
        // 截图识别没有「原文」可核对（截图识别后即删除，字段是模型重新表述的）；
        // 这里保持空串，不把字段拼成一句合成文本冒充原文——识别依据由各字段自己呈现。
        rawText: '',
        sourceRowLabel: '',
        sourceWeekdayLabel: '',
      });
    }
  }
  if (rawCourses !== undefined && !Array.isArray(rawCourses)) {
    problems.push('模型返回的 courses 不是列表，已忽略。');
  }

  const warningCount = courses.reduce((sum, course) => sum + (course.warnings.length > 0 ? 1 : 0), 0);
  return {
    meta: {
      sheetName: '',
      fileName: '课表截图',
      origin: 'photo',
      school: asString(parsed.school, 40),
      semester: asString(parsed.semester, 40),
      exportedAt: '',
      department: '',
      grade: '',
      major: '',
      className: '',
    },
    courses,
    problems,
    stats: {
      sheets: 0,
      cells: 0,
      entries: courses.length,
      courses: courses.length,
      duplicates: 0,
      warnings: warningCount,
    },
  };
}
