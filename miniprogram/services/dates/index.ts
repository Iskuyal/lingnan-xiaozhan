/**
 * 日期工具：本项目所有「日历日」判断的单一来源（目标日、校历与考试日期都用它）。
 *
 * 为什么单独一个模块：日期差直接决定学生看到的「还有几天」，而它最容易在跨月、跨年、闰日、
 * 设备时区上出错。两处各写一份「今天怎么算」是最容易出的错，所以只留这一份，由测试钉住。
 *
 * 约定：日期一律按 **Asia/Shanghai 的日历日**计算，与设备时区无关。中国大陆自 1991 年起
 * 不再使用夏令时，因此用固定偏移而不是 `Intl` 时区库（小程序端也没有可靠的时区数据库）。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 只认 `YYYY-MM-DD`：宁可拒绝，也不去猜 `2026/9/29` 或 `2026-9-29` 这类写法。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * 解析 `YYYY-MM-DD`：格式与真实日历都合法才返回年月日，否则 null。
 * `2026-02-30`、`2025-02-29`（平年）这类「格式对但没有这一天」的写法一律拒绝。
 */
export function parseDate(text: unknown): DateParts | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!DATE_PATTERN.test(trimmed)) return null;
  const year = Number(trimmed.slice(0, 4));
  const month = Number(trimmed.slice(5, 7));
  const day = Number(trimmed.slice(8, 10));
  if (year < 1900 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidDate(text: unknown): boolean {
  return parseDate(text) !== null;
}

/** 日期 → 从 1970-01-01 起的天序号。用 UTC 构造，避免本机时区把日期推前或推后一天。 */
export function dayNumber(parts: DateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 今天（Asia/Shanghai）的 'YYYY-MM-DD'。设备在其他时区时结论也不变。 */
export function shanghaiToday(now: number = Date.now()): string {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 两个日期相差的日历日数（`to − from`）；任一非法返回 null。 */
export function diffDays(fromText: string, toText: string): number | null {
  const from = parseDate(fromText);
  const to = parseDate(toText);
  if (from === null || to === null) return null;
  return dayNumber(to) - dayNumber(from);
}

/** 把 'YYYY-MM-DD' 转成「北京时间当天正午」的时间戳：测试注入「今天」用，避免落在日界线上。 */
export function noonOf(dateText: string): number | null {
  const parts = parseDate(dateText);
  if (parts === null) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day) - SHANGHAI_OFFSET_MS + 12 * 60 * 60 * 1000;
}
