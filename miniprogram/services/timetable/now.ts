/**
 * 今日速查：回答「正在上什么 / 下一节什么 / 今天还有没有课 / 今天上完了」。
 *
 * 之所以是纯函数：这套判断直接决定学生看到的结论，而它的输入又五花八门
 * （今天没课、此刻在课间、连堂、同一门课一天上两次、作息只填了一半），
 * 必须能用 node:test 把每一种都钉住。
 *
 * **只在用户自己填了作息时才有意义**：没填作息时页面就不显示这条速查（设计图 03），
 * 所以这里不猜时刻、也不给「大概在上课」这类含糊结论——`sectionTimes` 缺失的节次直接跳过。
 */
import { SectionTime, TimetableSettings, minutesOfClock, currentSectionAt, nextSectionAt, sectionTimeAt } from './settings';

export interface TodayItem {
  /** 同一天同一门课可能有多段（如第 1-2 节与第 11-12 节），所以 key 到「课程 + 起始节」。 */
  key: string;
  courseId: string;
  name: string;
  location: string;
  teacher: string;
  start: number;
  end: number;
}

export interface TodaySummary {
  kind: 'current' | 'next' | 'done' | 'none';
  key: string;
  courseId: string;
  name: string;
  /** 「第 5-6 节」；没有节次信息时为空字符串。 */
  sectionLabel: string;
  /** 「13:00 – 14:35」；**只有起止时刻都填了才有**，否则空字符串。 */
  timeLabel: string;
  /** 「崇礼楼 306 · 林加燕」，缺的字段不补占位。 */
  detail: string;
  /** 一句话状态，直接给页面当小标题用。 */
  note: string;
}

/** 用户到底填没填作息：只要有一节起止都合法就算填了。 */
export function hasSectionTimes(settings: TimetableSettings): boolean {
  return settings.sectionTimes.some((slot) => minutesOfClock(slot.start) !== null && minutesOfClock(slot.end) !== null);
}

export function sectionTextOf(start: number, end: number): string {
  if (!Number.isInteger(start) || start <= 0) return '';
  if (!Number.isInteger(end) || end < start) return `第 ${start} 节`;
  return start === end ? `第 ${start} 节` : `第 ${start}-${end} 节`;
}

/** 一块时间区间从作息里取起止文案；任一时刻缺失就返回空（不显示半截时刻）。 */
function timeTextOf(settings: TimetableSettings, start: number, end: number): string {
  const from: SectionTime | null = sectionTimeAt(settings, start);
  const to: SectionTime | null = sectionTimeAt(settings, end);
  if (from === null || to === null) return '';
  const fromMinutes = minutesOfClock(from.start);
  const toMinutes = minutesOfClock(to.end);
  if (fromMinutes === null || toMinutes === null) return '';
  return `${from.start} – ${to.end}`;
}

function detailOf(item: TodayItem): string {
  return [item.location, item.teacher].filter((part) => part !== '').join(' · ');
}

function emptySummary(kind: 'done' | 'none', note: string): TodaySummary {
  return { kind, key: '', courseId: '', name: '', sectionLabel: '', timeLabel: '', detail: '', note };
}

function summaryOf(kind: 'current' | 'next', item: TodayItem, settings: TimetableSettings, note: string): TodaySummary {
  return {
    kind,
    key: item.key,
    courseId: item.courseId,
    name: item.name,
    sectionLabel: sectionTextOf(item.start, item.end),
    timeLabel: timeTextOf(settings, item.start, item.end),
    detail: detailOf(item),
    note,
  };
}

/**
 * 今日速查。`minutes` 是「现在」的分钟数（由页面给出，测试可固定）。
 *
 * 判定顺序：正在上 → 下一节 → 今天上完了 → 今天没课。
 * 「正在上」以**课程区间**为准（不只看节次边界）：此刻落在哪门课的节次区间内就是哪门课；
 * 课间（没有任何课正在进行）时给出下一节。
 */
export function summarizeToday(items: TodayItem[], settings: TimetableSettings, minutes: number): TodaySummary {
  if (items.length === 0) return emptySummary('none', '今天没有安排课程');

  const ordered = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const current = currentSectionAt(settings, minutes);
  if (current !== null) {
    const running = ordered.find((item) => item.start <= current && current <= item.end);
    if (running !== undefined) return summaryOf('current', running, settings, '正在上');
  }

  // 课间或还没开始：下一节就从「下一个还没开始的节次」往后找，找不到就是今天上完了。
  const from = current !== null ? current + 1 : nextSectionAt(settings, minutes);
  if (from === null) return emptySummary('done', '今天的课已经上完');
  const upcoming = ordered.find((item) => item.start >= from);
  if (upcoming === undefined) return emptySummary('done', '今天的课已经上完');
  return summaryOf('next', upcoming, settings, '下一节');
}
