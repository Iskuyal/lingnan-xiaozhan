/**
 * 今日简报与今日时间线：首页「今天」区块的全部数据来源。
 *
 * 为什么是纯函数、而且**不调用模型**：
 * 1. 首页每次打开都要显示。调模型意味着成本随打开次数增长，断网或超时就会空一块；
 * 2. 这几句话只是把「已保存的课表 + 本机目标日 + 作息设置」翻译成人话，
 *    规则能算准的事实没必要再让模型猜一遍；
 * 3. 所以界面标签写「今日简报」而不是「AI 简报」——AI 的真实落点在通知解析、
 *    课表问答与备考计划，不替它多认领一份功劳（见 docs/design/ai-innovation-2026-11/README.md）。
 *
 * 「没填作息就不出现具体时刻」沿用 now.ts 的约定：宁可少说，也不给半截时刻。
 */
import { diffDays } from '../dates/index';
import { Course } from './types';
import { SectionTime, TimetableSettings, minutesOfClock, sectionTimeAt } from './settings';
import { TodayItem, TodaySummary, hasSectionTimes, sectionTextOf, summarizeToday } from './now';
import { occursInWeek, shortLocation } from './view';
import { weekIndexOf, weekdayOf } from './semester';

/** 只依赖目标日的两个字段；页面直接传 GoalDay[] 也满足这个形状。 */
export interface BriefGoal {
  name: string;
  date: string;
}

export interface BriefInput {
  courses: Course[];
  settings: TimetableSettings;
  /** 今天，'YYYY-MM-DD'（页面用 shanghaiToday()）。 */
  today: string;
  /** 现在几点几分（0..1439），由页面给出，测试可固定。 */
  clockMinutes: number;
  goals: BriefGoal[];
}

/** 两节课之间至少空这么久才值得单独列一行「空闲」。 */
export const MIN_FREE_MINUTES = 45;

export const WEEKDAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

/** 输入框下面的三个建议问题：都是课表助手能回答的，不做「猜你喜欢」。 */
export const DEFAULT_SUGGESTIONS = ['明天几点出门？', '贴一段调课通知', '这周哪天最空？'];

export type TimelineKind = 'course' | 'free';

export interface TimelineRow {
  key: string;
  kind: TimelineKind;
  /** 左列粗体时刻 '08:30'；没填作息时为空字符串。 */
  timeText: string;
  /** 左列细字：'1–2 节' 或 '空闲 2 小时 20 分'。 */
  sectionText: string;
  title: string;
  detail: string;
  /** 正在上；与 isNext 互斥（判定统一交给 summarizeToday，避免两套口径）。 */
  isNow: boolean;
  /** 下一节；同一时刻最多一个。 */
  isNext: boolean;
}

export interface TodayBrief {
  /** 抬头第一行：'11月11日 星期二 · 第 11 周'；没设开学日时不带周次。 */
  dateLine: string;
  greeting: string;
  /** '早上好，今天 3 节课' 的后半句。 */
  headline: string;
  /** 1～3 句简报正文。 */
  sentences: string[];
  /** 依据条：只用真实用到的数据源。 */
  sources: string[];
  suggestions: string[];
  rows: TimelineRow[];
  week: number | null;
  hasCourses: boolean;
  hasTimes: boolean;
  /** 今天排到的段数（同一门课上下午两段就算两节课）。 */
  blockCount: number;
}

interface Slot {
  key: string;
  course: Course;
  start: number;
  end: number;
  from: SectionTime | null;
  to: SectionTime | null;
  startMinutes: number | null;
  endMinutes: number | null;
}

interface Gap {
  startMinutes: number;
  endMinutes: number;
  startClock: string;
  endClock: string;
  minutes: number;
}

function clampMinutes(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 1439) return 1439;
  return rounded;
}

/** 时长说人话：'2 小时 20 分' / '45 分钟' / '1 小时'。 */
export function durationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分`;
}

export function greetingOf(clockMinutes: number): string {
  const minutes = clampMinutes(clockMinutes);
  if (minutes < 11 * 60) return '早上好';
  if (minutes < 13 * 60) return '中午好';
  if (minutes < 18 * 60) return '下午好';
  return '晚上好';
}

export function headlineOf(blockCount: number): string {
  return blockCount === 0 ? '今天没有课' : `今天 ${blockCount} 节课`;
}

/** 不知道周次（没设开学日、或今天不在学期内）时不按周次过滤：宁可多显示，不把今天的课藏起来。 */
function inWeek(course: Course, week: number | null): boolean {
  return week === null ? true : occursInWeek(course, week);
}

function rangesOf(course: Course): { start: number; end: number }[] {
  const ranges = course.sectionRanges.length > 0
    ? course.sectionRanges
    : [{ start: course.startSection, end: course.endSection }];
  return ranges.filter((range) => Number.isInteger(range.start) && range.start > 0 && range.end >= range.start);
}

function weekOf(input: BriefInput): number | null {
  return weekIndexOf({ startDate: input.settings.startDate, totalWeeks: input.settings.totalWeeks }, input.today);
}

/**
 * 同一天、同一时段、同一门课的多条记录合成一行。
 *
 * 导入时一门课被断周拆成多条很常见（实测云端就有「低代码平台应用开发 1-4 节」
 * 一条是第 4-16 周、另一条是第 17 周）。周次未知时两条都命中，
 * 首页就会把同一节课印两遍。它们对学生看到的内容完全一样，所以只留一条。
 */
function mergeSameSlot(slots: Slot[]): Slot[] {
  const seen = new Set<string>();
  const merged: Slot[] = [];
  for (const slot of slots) {
    const signature = [slot.course.name, slot.start, slot.end, slot.course.location, slot.course.teacher].join('\u0000');
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(slot);
  }
  return merged;
}

function slotsOf(input: BriefInput, week: number | null): Slot[] {
  const weekday = weekdayOf(input.today);
  const slots: Slot[] = [];
  if (weekday === null) return slots;
  for (const course of input.courses) {
    if (course.weekday !== weekday) continue;
    if (!inWeek(course, week)) continue;
    for (const range of rangesOf(course)) {
      const from = sectionTimeAt(input.settings, range.start);
      const to = sectionTimeAt(input.settings, range.end);
      slots.push({
        key: `${course.id}:${range.start}`,
        course,
        start: range.start,
        end: range.end,
        from,
        to,
        startMinutes: from === null ? null : minutesOfClock(from.start),
        endMinutes: to === null ? null : minutesOfClock(to.end),
      });
    }
  }
  return mergeSameSlot(slots.sort((a, b) => a.start - b.start || a.end - b.end || a.course.name.localeCompare(b.course.name, 'zh-Hans-CN')));
}

function itemOf(slot: Slot): TodayItem {
  return {
    key: slot.key,
    courseId: slot.course.id,
    name: slot.course.name,
    location: slot.course.location,
    teacher: slot.course.teacher,
    start: slot.start,
    end: slot.end,
  };
}

/**
 * 相邻两节之间够长、且两端时刻都齐全的空隙。
 * 返回值与 slots 下标对齐：`gaps[i]` 是 `slots[i]` 与 `slots[i + 1]` 之间的空档，
 * 没有空档（或时刻不全）就是 null —— 这样插入空闲行时不用再猜下标对应关系。
 */
function gapsOf(slots: Slot[]): (Gap | null)[] {
  const gaps: (Gap | null)[] = [];
  for (let index = 0; index + 1 < slots.length; index += 1) {
    const previous = slots[index];
    const next = slots[index + 1];
    if (previous.endMinutes === null || next.startMinutes === null || previous.to === null || next.from === null) {
      gaps.push(null);
      continue;
    }
    const minutes = next.startMinutes - previous.endMinutes;
    gaps.push(minutes < MIN_FREE_MINUTES ? null : {
      startMinutes: previous.endMinutes,
      endMinutes: next.startMinutes,
      startClock: previous.to.end,
      endClock: next.from.start,
      minutes,
    });
  }
  return gaps;
}

/** 有空档的那些，按原顺序（用于「最长的一段」与详情）。 */
function realGaps(slots: Slot[]): Gap[] {
  return gapsOf(slots).filter((gap): gap is Gap => gap !== null);
}

function courseRowOf(slot: Slot, summary: TodaySummary): TimelineRow {
  const detail = [shortLocation(slot.course.location), slot.course.teacher].filter((part) => part !== '').join(' · ');
  return {
    key: slot.key,
    kind: 'course',
    timeText: slot.from === null ? '' : slot.from.start,
    sectionText: sectionTextOf(slot.start, slot.end),
    title: slot.course.name,
    detail,
    isNow: summary.kind === 'current' && summary.key === slot.key,
    isNext: summary.kind === 'next' && summary.key === slot.key,
  };
}

function freeRowOf(gap: Gap, next: Slot, goal: { name: string; days: number } | null): TimelineRow {
  return {
    key: `free:${next.key}`,
    kind: 'free',
    timeText: gap.startClock,
    sectionText: `空闲 ${durationLabel(gap.minutes)}`,
    title: goal === null ? '这段时间空着' : `可安排：${goal.name}`,
    detail: goal === null ? '' : goal.days === 0 ? '就是今天' : `还剩 ${goal.days} 天`,
    isNow: false,
    isNext: false,
  };
}

/** 今日时间线：课程行与空闲行按时间穿插，正在上/下一节的标记只落一行。 */
export function buildTimeline(input: BriefInput): TimelineRow[] {
  const week = weekOf(input);
  const slots = slotsOf(input, week);
  const summary = summarizeToday(slots.map(itemOf), input.settings, clampMinutes(input.clockMinutes));
  // gaps[i] 是 slots[i] 与 slots[i + 1] 之间的空档，所以空闲行排在「这一节之后」。
  const gaps = gapsOf(slots);
  const rows: TimelineRow[] = [];
  slots.forEach((slot, index) => {
    rows.push(courseRowOf(slot, summary));
    const gap = gaps[index];
    if (gap !== undefined && gap !== null && slots[index + 1] !== undefined) {
      rows.push(freeRowOf(gap, slots[index + 1], null));
    }
  });
  return rows;
}

/** 今天最近的一个未过期目标日：倒计时用它，不用已过去的日子。 */
function nearestGoalOf(goals: BriefGoal[], today: string): { name: string; date: string; days: number } | null {
  let best: { name: string; date: string; days: number } | null = null;
  for (const goal of goals) {
    const days = diffDays(today, goal.date);
    if (days === null || days < 0) continue;
    if (best === null || days < best.days) best = { name: goal.name, date: goal.date, days };
  }
  return best;
}

function dateLineOf(today: string, week: number | null): string {
  const parts = today.split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const head = parts.length === 3 && Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : today;
  const weekday = weekdayOf(today);
  const name = weekday === null ? '' : WEEKDAY_NAMES[weekday - 1] ?? '';
  const line = name === '' ? head : `${head} ${name}`;
  return week === null ? line : `${line} · 第 ${week} 周`;
}

/**
 * 今日简报。返回抬头、正文、依据条、时间线与建议问题；
 * 页面只负责排版，不再自己算一遍时间，避免「简报说 8:30、时间线写 08:00」。
 */
export function buildTodayBrief(input: BriefInput): TodayBrief {
  const clock = clampMinutes(input.clockMinutes);
  const settings = input.settings;
  const hasTimes = hasSectionTimes(settings);
  const week = weekOf(input);
  const slots = slotsOf(input, week);
  const summary = summarizeToday(slots.map(itemOf), settings, clock);
  const summarySlot = slots.find((slot) => slot.key === summary.key) ?? null;
  const goal = nearestGoalOf(input.goals, input.today);
  const rows = buildTimeline(input);
  const gaps = realGaps(slots);

  const sentences: string[] = [];

  // 第 1 句：正在上 / 下一节 / 上完了 / 今天没课。
  if (slots.length === 0) {
    sentences.push('今天没有安排课程。');
  } else if (summary.kind === 'current' && summarySlot !== null) {
    const place = shortLocation(summarySlot.course.location);
    sentences.push(`现在在上「${summarySlot.course.name}」${summary.sectionLabel}${place === '' ? '' : `，在 ${place}。`}`);
  } else if (summary.kind === 'next' && summarySlot !== null) {
    const first = summarySlot.key === slots[0].key;
    const startText = summarySlot.from === null ? '' : ` ${summarySlot.from.start}`;
    const place = shortLocation(summarySlot.course.location);
    const delta = summarySlot.startMinutes === null ? null : summarySlot.startMinutes - clock;
    const timing = delta === null || delta < 0 ? '' : delta === 0 ? '，就是现在' : `，离现在 ${durationLabel(delta)}`;
    sentences.push(
      `${first ? '第一节课' : '下一节'}${startText}${place === '' ? '' : ` 在 ${place}`}${timing}。`,
    );
  } else if (!hasTimes) {
    // 没填作息时不知道现在是第几节，说「上完了」就是编答案：
    // 早上 7:50 打开首页却看到「今天的课已经上完」，比不给结论更糟。
    // 如实说「今天有课、节次如下」，把判断交给学生自己看。
    const firstSlot = slots[0];
    const place = shortLocation(firstSlot.course.location);
    sentences.push(`今天的课从${sectionTextOf(firstSlot.start, firstSlot.end)}开始${place === '' ? '' : `，在 ${place}`}。`);
  } else {
    sentences.push('今天的课已经上完，剩下的时间自己安排。');
  }

  // 第 2 句：最长的一段空闲；没填作息就说「填了才看得到」而不是瞎猜。
  let longest: Gap | null = null;
  for (const gap of gaps) {
    if (longest === null || gap.minutes > longest.minutes) longest = gap;
  }
  if (!hasTimes) {
    sentences.push('填好作息时间，就能看到几点上课、哪一段空着。');
  } else if (longest !== null) {
    sentences.push(`今天 ${longest.startClock}–${longest.endClock} 空出 ${durationLabel(longest.minutes)}。`);
  } else if (slots.length > 0) {
    sentences.push('课与课之间没有大段空闲。');
  }

  // 第 3 句：最近的目标日倒计时。
  if (goal !== null) {
    sentences.push(goal.days === 0 ? `今天就是「${goal.name}」的日子。` : `距「${goal.name}」还有 ${goal.days} 天。`);
  } else if (slots.length > 0) {
    sentences.push('记一个目标日，这里会替你数着还剩多少天。');
  }

  const sources: string[] = [];
  if (slots.length > 0) sources.push('已保存课表');
  if (goal !== null) sources.push('目标日');
  if (hasTimes) sources.push('作息设置');

  return {
    dateLine: dateLineOf(input.today, week),
    greeting: greetingOf(clock),
    headline: headlineOf(slots.length),
    sentences: sentences.slice(0, 3),
    sources,
    suggestions: DEFAULT_SUGGESTIONS.slice(),
    rows,
    week,
    hasCourses: slots.length > 0,
    hasTimes,
    blockCount: slots.length,
  };
}
