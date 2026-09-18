/**
 * 课表截图识别的纯逻辑（Ticket 05）：压缩决策、识别提示词与结果解析（页面只绑定数据）。
 *
 * 识别走 ai 云函数的 vision 动作（图片先过内容安全再送模型，见 cloudfunctions/ai）：
 * 客户端上传截图后只传 fileID；模型返回的 JSON 在这里解析成课表草稿（TimetableDraft），
 * 复用 03 的确认页与保存链路。识别不出的字段只标记不猜——与导入解析同一纪律
 * （docs/development-spec.md「课表导入」与 Ticket 03）。
 */
import { DraftCourse, SectionRange, TimetableDraft } from './types';
import { parseWeekNotation } from './weeks';

/** 图片大小上限（字节）：与 ai 云函数 AI_MAX_IMAGE_BYTES 默认值一致（微信官方图片检测接口限制 1MB）。 */
export const MAX_PHOTO_BYTES = 1024 * 1024;

/** 上传前与服务端一致的扩展名白名单（云函数 preparePhotoUpload 同样校验）。 */
export const PHOTO_ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

/** 引导文案：拍照/相册两个来源都要写明，识别结果要确认后才保存。 */
export const PHOTO_GUIDE = '也可以直接拍照，或从相册选一张课表截图：AI 会先识别成草稿，你逐条确认后才保存；拍不清的内容会在草稿里标注待核对。';

/** vision 单次最大输出 token：一份课表 JSON 远小于该值，留足余量。 */
export const VISION_MAX_TOKENS = 2048;

/** 识别系统提示词：只输出 JSON、识别不出留空、绝不编造。 */
export const VISION_SYSTEM = [
  '你是课表截图识别器。识别图片中的课程表，只输出一个 JSON 对象，不要输出任何解释或多余文字。',
  'JSON 结构：',
  '{"semester":"学年学期原文，识别不出为空字符串","school":"学校名称原文，识别不出为空字符串","problems":["整张图层面的问题，例如截图不完整、有遮挡"],"courses":[{"name":"课程名，识别不出留空","teacher":"教师，识别不出留空","weekday":1到7的整数，星期一到星期日，识别不出留 0,"startSection":1到12的整数,"endSection":1到12的整数且不小于 startSection，识别不出留 0,"weekText":"周次原文，例如 [1-16]周，识别不出留空（留空表示每周）","location":"上课地点，识别不出留空","credits":"学分原文，识别不出留空","campus":"校区，识别不出留空","siteNumber":"场地编号，识别不出留空","note":"备注，识别不出留空"}]}',
  '纪律：识别不出的字段一律留空或留 0，绝不编造；周次写法保持原样，不要转换成其它写法。',
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
  rawText: 300,
  warning: 100,
  maxWarnings: 12,
} as const;

/** 压缩步骤：1MB 内不压；超限依次质量 80/60/40，再画布缩放 0.75/0.5，最后放弃。 */
export type CompressionStep =
  | 'none'
  | 'quality-80'
  | 'quality-60'
  | 'quality-40'
  | 'canvas-0.75'
  | 'canvas-0.5'
  | 'give-up';

/** 按当前大小与已尝试次数决定下一步；纯函数，便于测试。 */
export function planCompression(bytes: number, attemptsSoFar: number): CompressionStep {
  if (bytes <= MAX_PHOTO_BYTES) return 'none';
  if (attemptsSoFar >= 0 && attemptsSoFar < 3) {
    const quality = ['80', '60', '40'][attemptsSoFar];
    return ('quality-' + quality) as CompressionStep;
  }
  if (attemptsSoFar === 3) return 'canvas-0.75';
  if (attemptsSoFar === 4) return 'canvas-0.5';
  return 'give-up';
}

interface RawCourse {
  name?: unknown;
  teacher?: unknown;
  weekday?: unknown;
  startSection?: unknown;
  endSection?: unknown;
  weekText?: unknown;
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

/** 从模型输出里取出 JSON 对象：先整体解析，失败时截取第一个 { 到最后一个 } 再试（06 复用）。 */
export function extractJson(text: string): Record<string, unknown> | null {
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

      const weekText = asString(row.weekText, LIMITS.weekText);
      let weeks: number[] = [];
      let weeksRecognized = false;
      if (weekText === '') {
        // 留空 = 每周（与手工表单口径一致）。
        weeksRecognized = true;
        weeks = [];
      } else {
        const notation = parseWeekNotation(weekText);
        if (notation.recognized) {
          weeks = notation.weeks;
          weeksRecognized = true;
        } else {
          pushWarning('周次写法未能识别（原文：' + weekText + '），已保留原文，请核对');
        }
      }

      const location = asString(row.location, LIMITS.location);
      if (location === '') pushWarning('地点未识别');
      const credits = asString(row.credits, LIMITS.credits);
      const campus = asString(row.campus, LIMITS.campus);
      const siteNumber = asString(row.siteNumber, LIMITS.siteNumber);
      const note = asString(row.note, LIMITS.note);
      const rawText = ('识别：'
        + (weekday === 0 ? '星期待核对' : '星期' + weekday)
        + ' '
        + (sectionRanges.length > 0 ? '第 ' + sectionRanges[0].start + '-' + sectionRanges[0].end + ' 节' : '节次待核对')
        + ' '
        + name).slice(0, LIMITS.rawText);

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
        rawText,
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
