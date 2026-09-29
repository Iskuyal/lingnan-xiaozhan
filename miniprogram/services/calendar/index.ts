/**
 * 校历与考试日期卡的逻辑：把版本化事件算成页面能直接渲染的行。
 *
 * 三条纪律（对应 Issue #91 的验收标准）：
 * 1. **只有官方给了日期的考试才显示倒计时**；「已结束」的批次明确标出，不显示「还有 X 天」。
 * 2. **报名与考试分开两行**：报名截止一律写清归谁定（各考点/省考试院），不与其他日期混算。
 * 3. **没有日期就不编**：待公布、仅外链、以本校为准三类各自有独立文案；不沿用上一年日期。
 *
 * 数据的自检在 `validateEvents()`：它同时被测试用来守住「每条都有来源与核查日」
 * 「没有确定日期的事件不得带日期」这些不变量。
 */
import { CalendarCategory, CalendarEvent, CalendarEventStatus, CATEGORY_LABEL, CATEGORY_ORDER, CALENDAR_EVENTS } from './events';
import { compareText, diffDays, isValidDate, shanghaiToday } from '../dates/index';

export * from './events';

export interface CalendarRow extends CalendarEvent {
  /** 状态徽标文案：「还有 67 天」「已结束」「待公布」「仅官方入口」「以本校通知为准」。 */
  stateLabel: string;
  /** 日期文案：「2026-12-12 09:00–11:20」；没有日期时为空字符串。 */
  dateText: string;
  /** 倒计时天数；只有已公布且未结束的考试才有，其余为 null。 */
  days: number | null;
  /** 分组标题。 */
  categoryLabel: string;
}

/** 状态徽标的默认文案：没有日期可算的那些（`published` 走倒计时分支，不进这张表）。 */
const STATE_LABEL: Record<CalendarEventStatus, string> = {
  published: '',
  pending: '待公布',
  ended: '已结束',
  'per-school': '以本校通知为准',
  'link-only': '仅官方入口',
};

function dateTextOf(event: CalendarEvent): string {
  if (event.date === '') return '';
  return event.timeText === '' ? event.date : `${event.date} ${event.timeText}`;
}

/**
 * 行文案。`now` 由调用方给（测试注入），页面用当前时间。
 *
 * 已公布的事件才天数：`d > 0` 还有 N 天、`d = 0` 就是今天、`d < 0` 已结束——
 * 日期过了就不再说「还有」，也不再显示倒计时。
 */
export function toRow(event: CalendarEvent, now: number = Date.now()): CalendarRow {
  const base = {
    ...event,
    dateText: dateTextOf(event),
    categoryLabel: CATEGORY_LABEL[event.category],
  };
  if (event.status !== 'published' || !isValidDate(event.date)) {
    return { ...base, stateLabel: STATE_LABEL[event.status] ?? '待核实', days: null };
  }
  const diff = diffDays(shanghaiToday(now), event.date);
  if (diff === null) return { ...base, stateLabel: '日期待核对', days: null };
  if (diff > 0) return { ...base, stateLabel: `还有 ${diff} 天`, days: diff };
  if (diff === 0) return { ...base, stateLabel: '就是今天', days: 0 };
  return { ...base, stateLabel: `已结束 ${-diff} 天`, days: null };
}

export interface CalendarGroup {
  category: CalendarCategory;
  label: string;
  rows: CalendarRow[];
}

/** 按类别分组；组内：有日期的按日期由近到远，没日期的排后面（保持数据里的顺序）。 */
export function groupEvents(events: CalendarEvent[], now: number = Date.now()): CalendarGroup[] {
  const rows = events.map((event) => toRow(event, now));
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    rows: rows
      .filter((row) => row.category === category)
      .sort((a, b) => {
        if (a.date === '' && b.date === '') return 0;
        if (a.date === '') return 1;
        if (b.date === '') return -1;
        return compareText(a.date, b.date);
      }),
  })).filter((group) => group.rows.length > 0);
}

/** 页脚用的数据概况：多少条有确定日期、最后核查日。 */
export function dataSummary(events: CalendarEvent[]): { published: number; total: number; verifiedAt: string } {
  const published = events.filter((event) => event.status === 'published' && isValidDate(event.date)).length;
  return { published, total: events.length, verifiedAt: events[0] === undefined ? '' : events[0].verifiedAt };
}

export interface DataProblem {
  id: string;
  problem: string;
}

/**
 * 数据自检（测试与页面都调用）：返回空数组表示这份事件表满足不变量。
 *
 * 这些不变量是这张卡「能被追溯」的全部依据，任何一条被破坏都应该在测试里失败：
 * 1. 每条都有发布主体、原文 URL、'YYYY-MM-DD' 的最后核查日；
 * 2. `published` 必须有合法日期；待公布/以本校为准/仅外链**必须没有日期**（否则会输出没依据的倒计时）；
 *    `ended` 是「已经发生过的确定日期」，可以有日期，但不会显示成倒计时；
 * 3. 适用范围里写了年份时，日期年份必须与之相符（防止沿用上一年日期）。
 */
export function validateEvents(events: CalendarEvent[]): DataProblem[] {
  const problems: DataProblem[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const push = (problem: string) => problems.push({ id: event.id, problem });
    if (event.id === '' || seen.has(event.id)) push('id 为空或重复');
    seen.add(event.id);
    if (event.title.trim() === '') push('缺少标题');
    if (!isValidDate(event.verifiedAt)) push('最后核查日不是合法日期');
    if (!/^https:\/\//.test(event.sourceUrl)) push('原文 URL 必须是 https 链接');
    if (event.sourceLabel.trim() === '') push('缺少发布主体');
    const hasDate = isValidDate(event.date);
    if (event.status === 'published' && !hasDate) push('已公布的事件必须有合法日期');
    if (!hasDate && event.date !== '') push('日期不是合法的 YYYY-MM-DD');
    if (event.status !== 'published' && event.status !== 'ended' && event.date !== '') {
      push('没有确定日期的事件不得带日期');
    }
    if (event.publishedAt !== '' && !isValidDate(event.publishedAt)) push('公告发布日期不合法');
    if (hasDate) {
      const year = event.scope.match(/(\d{4})\s*年/);
      if (year !== null && !event.date.startsWith(year[1])) {
        push(`适用年份 ${year[1]} 与日期 ${event.date} 不一致`);
      }
    }
  }
  return problems;
}

/** 供页面直接使用的一份行数据（含自检结果，出问题时页面显式提示而不是静默显示）。 */
export function loadCalendar(now: number = Date.now()): { groups: CalendarGroup[]; summary: ReturnType<typeof dataSummary>; problems: DataProblem[] } {
  return {
    groups: groupEvents(CALENDAR_EVENTS, now),
    summary: dataSummary(CALENDAR_EVENTS),
    problems: validateEvents(CALENDAR_EVENTS),
  };
}
