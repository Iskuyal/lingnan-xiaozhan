/**
 * 教学周的日期推算：由「第一周的星期一 + 总周数」算出今天是第几周、某一周是几月几号。
 *
 * 为什么单独一个模块：这套换算同时被三处用——课表主页的头部与表头（第 N 周 · 9/21–9/27、今日列）、
 * 设置页的实时预览、以及「今天没课」这类空态判断。放这里就能用 node:test 直接验证，
 * 不必启动小程序运行时。
 *
 * **全部按 UTC 日序号计算**：`new Date('2026-09-21')` 在 iOS 上按 UTC 解析、再按本地时区取
 * 日期会差一天，进而把「今天第几周」算错。这里只用 `Date.UTC` 与整数天差，不碰本地时区。
 *
 * 语义边界（刻意不猜）：
 * - 没设开学日（空字符串）时全部返回空：页面据此**不显示任何日期**，而不是显示「--」；
 * - 今天在学期之前或超出总周数时 `weekIndexOf` 返回 null，不钳到第 1 周或最后一周。
 *   翻周仍可翻到学期外（列表里可能有更长的课），所以 `weekDates` 对超界周照算。
 */
import { Course } from './types';

export interface SemesterConfig {
  /** 第一周的星期一，'YYYY-MM-DD'；空字符串表示未设置。 */
  startDate: string;
  /** 总周数。 */
  totalWeeks: number;
}

/** 与云端契约 MAX_WEEK 对齐（`cloudfunctions/timetable/types.ts`）。 */
export const MAX_TOTAL_WEEKS = 30;
export const DEFAULT_TOTAL_WEEKS = 20;

const DAY_MS = 86400000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期串 → UTC 日序号；非法日期（含 2026-02-30、月份 13）返回 null。 */
function dayNumber(date: string): number | null {
  const matched = DATE_PATTERN.exec(date);
  if (matched === null) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return Math.round(time / DAY_MS);
}

/** UTC 日序号 → 'YYYY-MM-DD'。 */
function dayToDate(value: number): string {
  const at = new Date(value * DAY_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

export function isValidStartDate(date: string): boolean {
  return dayNumber(date) !== null;
}

/** 日期加天数；非法输入返回空字符串（不抛异常，页面按「没有日期」处理）。 */
export function addDays(date: string, days: number): string {
  const base = dayNumber(date);
  if (base === null || !Number.isFinite(days)) return '';
  return dayToDate(base + Math.round(days));
}

/** 星期几：1 = 星期一 … 7 = 星期日；非法日期返回 null。 */
export function weekdayOf(date: string): number | null {
  const value = dayNumber(date);
  if (value === null) return null;
  // 日序号 0 是 1970-01-01（星期四）。
  return ((value + 3) % 7 + 7) % 7 + 1;
}

/** 设置页据此提示「开学日建议取星期一」。 */
export function isMonday(date: string): boolean {
  return weekdayOf(date) === 1;
}

/** 总周数收敛到 1..30；不是整数就按默认跨度（字符串不悄悄当数字用）。 */
export function normalizeTotalWeeks(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return DEFAULT_TOTAL_WEEKS;
  return Math.min(value, MAX_TOTAL_WEEKS);
}

/** 今天在第几周（1 起）。学期前、学期后、或没设开学日都返回 null。 */
export function weekIndexOf(config: SemesterConfig, today: string): number | null {
  const start = dayNumber(config.startDate);
  const at = dayNumber(today);
  if (start === null || at === null) return null;
  const diff = at - start;
  if (diff < 0) return null;
  const week = Math.floor(diff / 7) + 1;
  return week > normalizeTotalWeeks(config.totalWeeks) ? null : week;
}

/** 某一周的周一到周日；没设开学日或周次不是整数时返回 null。 */
export function weekDates(config: SemesterConfig, week: number): { start: string; end: string } | null {
  if (dayNumber(config.startDate) === null) return null;
  if (typeof week !== 'number' || !Number.isInteger(week)) return null;
  const start = addDays(config.startDate, (week - 1) * 7);
  if (start === '') return null;
  return { start, end: addDays(start, 6) };
}

/** 表头用的 7 个「几号」，如 ['21','22',…,'27']；没设开学日时返回空数组（表头就不显示日期）。 */
export function weekDateLabels(config: SemesterConfig, week: number): string[] {
  const dates = weekDates(config, week);
  if (dates === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const day = addDays(dates.start, index);
    labels.push(day === '' ? '' : String(Number(day.slice(8, 10))));
  }
  return labels;
}

/** 头部文案「9/21 – 9/27」；没设开学日时返回空字符串。 */
export function formatWeekRange(config: SemesterConfig, week: number): string {
  const dates = weekDates(config, week);
  if (dates === null) return '';
  const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return `${short(dates.start)} – ${short(dates.end)}`;
}

/** 列表视图用的 7 个完整日期（'2026-09-21'）：表头只有「几号」，列表里的某一天要能单独读懂。 */
export function weekDateFullLabels(config: SemesterConfig, week: number): string[] {
  const dates = weekDates(config, week);
  if (dates === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const day = addDays(dates.start, index);
    if (day === '') return [];
    labels.push(day);
  }
  return labels;
}

/**
 * 与课程数据一起决定翻周范围：数据里最大的教学周、总周数与默认跨度取大者。
 * 比 `view.weekSpan` 多考虑了学期设置：设了 20 周就不必为 19 周的样本缩到 19。
 */
export function weekSpanWithSemester(courses: Course[], config: SemesterConfig): number {
  let max = normalizeTotalWeeks(config.totalWeeks);
  for (const course of courses) {
    if (!course.weeksRecognized) continue;
    for (const week of course.weeks) if (week > max) max = week;
  }
  return max;
}
