/**
 * 学期设置与作息时间的规范化与校验（云函数侧）。
 *
 * 与小程序侧 `miniprogram/services/timetable/settings.ts` 是**同一条契约的两份实现**
 * （云函数按目录整体部署，没有跨目录共享模块的机制，与 types.ts 同样各存一份）：
 * 字段名、取值范围与拒绝文案逐条保持一致，改一处要一起改。
 *
 * 两条纪律落在这里：
 * - **不预置任何默认时刻**：空字符串是合法值（这一节没填），服务端不替学生编出时刻；
 * - **倒置与重叠一律拒绝**：同一时刻只能有一节在上课，错了要说清是哪两节，而不是笼统地「参数不合法」。
 */
import { DEFAULT_TOTAL_WEEKS, MAX_SECTION, MAX_WEEK, SectionTime, TimetableSettingsFields } from './types';

/** 学期设置所在的集合：一条记录一个用户，按调用上下文的 openid 读写。 */
export const SETTINGS_COLLECTION = 'timetable_settings';

/** 学期名称上限：与 `record.ts` 的 `sanitizeSemester`（40 字）一致。 */
const MAX_SEMESTER_NAME = 40;

/** 24 小时制的 HH:MM；只认两位小时、两位分钟，不去猜 8:5 这类写法。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 开学日合法性：与 `miniprogram/services/timetable/semester.ts` 的 `isValidStartDate` 同规则
 * （同一份实现无法跨目录共享，这里是同步的一份）：必须是 'YYYY-MM-DD' 且是真实存在的日期。
 * 只按 UTC 日序号判断，不碰本地时区。
 */
export function isValidStartDate(date: string): boolean {
  const matched = DATE_PATTERN.exec(date);
  if (matched === null) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day;
}

function emptySectionTimes(): SectionTime[] {
  const sectionTimes: SectionTime[] = [];
  for (let index = 0; index < MAX_SECTION; index += 1) sectionTimes.push({ start: '', end: '' });
  return sectionTimes;
}

/** 一份空设置：给「还没有记录」的读取用。每次调用返回新对象，不共享数组。 */
export function emptySettings(): TimetableSettingsFields {
  return { semesterName: '', startDate: '', totalWeeks: DEFAULT_TOTAL_WEEKS, sectionTimes: emptySectionTimes() };
}

/** 一条已填且合法的节次区间（分钟数），用于重叠检查。 */
interface Interval {
  section: number;
  start: number;
  end: number;
}

function minutesOfClock(text: string): number | null {
  if (!CLOCK_PATTERN.test(text)) return null;
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
}

function clockText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 单个时刻字段：空串合法（这一节没填），非空必须是 HH:MM。 */
function checkClock(value: string, section: number, label: string): string {
  if (value === '') return '';
  if (minutesOfClock(value) === null) return `第 ${section} 节的${label}要用 24 小时制的 HH:MM`;
  return '';
}

/** 云端在客户端之外再挡一次；`owner` 不在可写字段里，只由调用上下文决定。 */
export type NormalizedSettings =
  | { ok: true; value: TimetableSettingsFields }
  | { ok: false; error: string };

/** 校验并规范化一份设置；失败时不返回任何半成品字段（整份拒绝，不做部分写入）。 */
export function normalizeSettingsFields(input: unknown): NormalizedSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '设置数据格式不正确' };
  }
  const source = input as Record<string, unknown>;

  const semesterName = clockText(source.semesterName);
  if (semesterName.length > MAX_SEMESTER_NAME) return { ok: false, error: `学期名称最多 ${MAX_SEMESTER_NAME} 字` };

  const startDate = clockText(source.startDate);
  if (startDate !== '' && !isValidStartDate(startDate)) {
    return { ok: false, error: '开学日要用 YYYY-MM-DD 的合法日期' };
  }

  const totalWeeks = source.totalWeeks;
  if (typeof totalWeeks !== 'number' || !Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_WEEK) {
    return { ok: false, error: `总周数要是 1-${MAX_WEEK} 之间的整数` };
  }

  if (!Array.isArray(source.sectionTimes) || source.sectionTimes.length !== MAX_SECTION) {
    return { ok: false, error: `作息时间要正好 ${MAX_SECTION} 条（第 1-${MAX_SECTION} 节）` };
  }

  const sectionTimes: SectionTime[] = [];
  const filled: Interval[] = [];
  for (let section = 1; section <= MAX_SECTION; section += 1) {
    const raw: unknown = source.sectionTimes[section - 1];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `第 ${section} 节的作息格式不正确` };
    }
    const item = raw as { start?: unknown; end?: unknown };
    const start = clockText(item.start);
    const end = clockText(item.end);
    const startProblem = checkClock(start, section, '起始时刻');
    if (startProblem !== '') return { ok: false, error: startProblem };
    const endProblem = checkClock(end, section, '结束时刻');
    if (endProblem !== '') return { ok: false, error: endProblem };
    const startMinutes = minutesOfClock(start);
    const endMinutes = minutesOfClock(end);
    // 只填了一半：合法，那一节按「没填」处理，不猜另一半。
    if (startMinutes !== null && endMinutes !== null) {
      if (startMinutes >= endMinutes) return { ok: false, error: `第 ${section} 节的结束时刻要晚于起始时刻` };
      filled.push({ section, start: startMinutes, end: endMinutes });
    }
    sectionTimes.push({ start, end });
  }

  // 重叠：按起始时刻排序后只要有一对相邻区间相交就存在重叠（含不相邻的两节跨过未填的节）。
  const ordered = [...filled].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.start < previous.end) {
      return {
        ok: false,
        error: `第 ${previous.section} 节与第 ${current.section} 节的作息时间重叠了，同一时刻只能有一节在上课`,
      };
    }
  }

  return { ok: true, value: { semesterName, startDate, totalWeeks, sectionTimes } };
}

/**
 * 读出来的一条记录 → 客户端契约：脏数据（非法日期、坏时刻、条数不对）按「没填 / 默认」处理，
 * 不让一条历史记录把整个页面打挂。
 */
export function readStoredSettings(input: unknown): TimetableSettingsFields {
  const source = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const times: unknown[] = Array.isArray(source.sectionTimes) ? source.sectionTimes : [];
  const sectionTimes: SectionTime[] = [];
  for (let index = 0; index < MAX_SECTION; index += 1) {
    const raw: unknown = times[index];
    const item = raw !== null && typeof raw === 'object' ? (raw as { start?: unknown; end?: unknown }) : {};
    sectionTimes.push({ start: clockText(item.start), end: clockText(item.end) });
  }
  const startDate = clockText(source.startDate);
  const totalWeeks = typeof source.totalWeeks === 'number' && Number.isInteger(source.totalWeeks) && source.totalWeeks >= 1
    ? Math.min(source.totalWeeks, MAX_WEEK)
    : DEFAULT_TOTAL_WEEKS;
  return {
    semesterName: clockText(source.semesterName).slice(0, MAX_SEMESTER_NAME),
    startDate: isValidStartDate(startDate) ? startDate : '',
    totalWeeks,
    sectionTimes,
  };
}
