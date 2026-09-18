/**
 * 周次写法的识别（小程序侧，手工录入用）。
 *
 * 云函数侧 `cloudfunctions/timetable/parse.ts` 有一份等价的实现，用于解析单元格原文；
 * 小程序包不能引用云函数模块（会把 Excel 库带进包），所以两份实现各自存在。
 * 两者的语法与结果由 `tests/timetable-view.test.cjs` 用真实样本里的全部周次写法对比锁定。
 *
 * 手工输入接受 `1-16`、`1-16周`、`[2-6,8-17]周` 这类写法（单元格原文必须有「周」结尾，
 * 手工表单的字段本身就叫周次，因此不强制）；不认识的写法一律返回 recognized=false，
 * 由页面保留原文并标记，不替学生猜。
 */

const WEEK_TEXT = /^[\[［]?\s*(\d+(?:\s*-\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*-\s*\d+)?)*)\s*[\]］]?\s*周?$/u;
/** 周次列表的分隔符：半角逗号、全角逗号与顿号（顿号是本模块压缩输出用的写法）。 */
const WEEK_SEPARATOR = /[,，、]/u;
/** 教学周上限，与云函数 MAX_WEEK 一致。 */
export const MAX_WEEK = 30;

export interface WeekParseResult {
  weeks: number[];
  recognized: boolean;
}

/** 把 `2-6,8-17` 这类写法展开成周次数组；不认识的写法返回 recognized=false。 */
export function parseWeekNotation(text: string): WeekParseResult {
  const match = WEEK_TEXT.exec(String(text).replace(/\u3000/g, ' ').trim());
  if (match === null) return { weeks: [], recognized: false };
  const weeks: number[] = [];
  for (const part of match[1].split(WEEK_SEPARATOR)) {
    const bounds = part.split('-');
    const start = Number(bounds[0]);
    const end = bounds.length > 1 ? Number(bounds[1]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > MAX_WEEK || end < start) {
      return { weeks: [], recognized: false };
    }
    for (let week = start; week <= end; week += 1) weeks.push(week);
  }
  if (weeks.length === 0) return { weeks: [], recognized: false };
  return { weeks: [...new Set(weeks)].sort((a, b) => a - b), recognized: true };
}

/** 把周次数组压缩成便于阅读的写法：`[2,3,4,6,7]` → `2-4、6-7`。 */
export function condenseWeeks(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  let previous = 0;
  for (const week of sorted) {
    if (start === 0) {
      start = week;
      previous = week;
      continue;
    }
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = week;
    previous = week;
  }
  if (start !== 0) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join('、');
}
