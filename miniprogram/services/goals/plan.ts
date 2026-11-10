/**
 * 目标倒排计划：把「目标日 + 学生的一句话约束 + 课表空闲格」算成每周学习块。
 *
 * **这里不调用任何模型**（也不 import `services/ai`），原因三条：
 * 1. 约束是有限说法（时长、周末上午、晚上、每周几段、哪个最弱），规则匹配可测、零成本、不产生费用；
 * 2. 每条依据都必须来自已保存的课表与作息——模型只能「说得像」，规则才能保证每个数字都能对上；
 * 3. 计划只存在本机、不进云端、不进 AI 请求，纯函数才能在 node:test 里把边界逐条钉住。
 *
 * 代价：只听得懂上面那几类说法。**听不出来的原话不猜**：`readConstraints().dropped` 会把它列出来，
 * 页面照实显示「这几句没看懂，按默认排」，不假装理解。
 *
 * 与设计图 03（`docs/design/ai-innovation-2026-11/03-goal-planner.html`）的对应关系：
 * - 只排周一到周五的网格见 `planGrid`（列 = 周一至周五，行 = 节次对 1-2 / 3-4 / …）；
 * - 周末不是不能排：`buildPlan` 在所有 7 天里找空档，只是「周末上午不排」时跳过第 1-4 节；
 *   落在周六、周日的块不在 5 列网格里，页面单独列出来，不让它凭空消失。
 */
import { Course, SectionRange } from '../timetable/types';
import { SECTION_COUNT, TimetableSettings, minutesOfClock, sectionTimeAt } from '../timetable/settings';
import { WEEKDAY_SHORT, occursInWeek } from '../timetable/view';
import { colorIndexFor } from '../timetable/palette';
import { diffDays } from '../dates/index';
import { weekIndexOf } from '../timetable/semester';

/** 本机存储 key：与 `goal-days/v1` 同一套约定，结构变化时换 key，不原地迁移未知格式。 */
const STORAGE_KEY = 'study-plan/v1';

/** 默认约束：与设计图 03 的例子一致（每次不超过 1 小时、每周 4 段）。 */
const DEFAULT_MAX_MINUTES = 60;
const DEFAULT_BLOCKS_PER_WEEK = 4;
/** 每段时长的合理区间：低于 15 分钟记不住东西，高于 3 小时也就不叫「一段」了。 */
const MIN_MAX_MINUTES = 15;
const MAX_MAX_MINUTES = 180;
/** 每周段数上限：再多就不是计划，是一张课表了。 */
const MIN_BLOCKS_PER_WEEK = 1;
const MAX_BLOCKS_PER_WEEK = 14;
/** 上午 = 第 1-4 节；晚上 = 第 9 节起（设计图 03 里「晚上不排」的含义）。 */
export const MORNING_LAST_SECTION = 4;
export const EVENING_FIRST_SECTION = 9;
/**
 * 作息没填时的单节时长。学校作息表可以不填（`settings.sectionTimes` 全为空），
 * 这时**不猜具体时刻**，只按每节 45 分钟估一段的长度，并在依据里写明「按每节 45 分钟估」。
 */
export const DEFAULT_SECTION_MINUTES = 45;
/** 迷你网格的行：与 `view.BIG_SECTION_LABELS` 同一套节次对，只是画得更短。 */
export const GRID_PAIR_LABELS = ['1–2', '3–4', '5–6', '7–8', '9–10', '11–12'];
/** 迷你网格的列：设计图 03 只画周一到周五。 */
export const GRID_WEEKDAYS = ['一', '二', '三', '四', '五'];
/** 即使只有很少内容，网格也至少留 5 行（设计图 03 的高度），免得看起来像被截断。 */
export const MIN_GRID_ROWS = 5;

export interface PlanConstraints {
  /** 每段最多多少分钟。 */
  maxMinutesPerBlock: number;
  /** 周末上午（第 1-4 节）不排。 */
  noWeekendMorning: boolean;
  /** 晚上（第 9 节起）不排。 */
  noEvening: boolean;
  /** 每周排几段。 */
  blocksPerWeek: number;
  /** 学生说最弱的那一项（如「听力」）；空字符串表示没提到。 */
  focus: string;
}

/** 一次约束解析的完整结果：能照做的写进 `constraints`，听不懂的原话进 `dropped`。 */
export interface ConstraintReadout {
  constraints: PlanConstraints;
  /** 直接展示给学生的约束回显，一行一句。 */
  lines: string[];
  /** 没听懂的原话：只说明按默认处理，不假装理解。 */
  dropped: string[];
  /** 哪些字段是从原话里读出来的（其余是默认值）。页面据此区分「按你说的」与「按默认」。 */
  recognized: {
    maxMinutesPerBlock: boolean;
    noWeekendMorning: boolean;
    noEvening: boolean;
    blocksPerWeek: boolean;
    focus: boolean;
  };
}

/** 一条学习段。**它不是课程**：不参与「本周 N 门课」统计，也不影响导入时的整份替换。 */
export interface PlanBlock {
  id: string;
  /** 1-7，对应星期一到星期日。 */
  weekday: number;
  /** 起始节（含），1-12。 */
  startSection: number;
  /** 结束节（含），总是 startSection + 1（一段 = 一个大节）。 */
  endSection: number;
  /** 这一段真正安排的学习分钟数，不超过 `PlanConstraints.maxMinutesPerBlock`。 */
  minutes: number;
  /** 这一段做什么，如「听力」「真题」；页面显示时拼上分钟数。 */
  topic: string;
  /** 教学周。 */
  week: number;
}

export interface StudyPlan {
  goalName: string;
  goalDate: string;
  /** 生成时的「今天」，重新打开旧计划时用来判断它是否已经过期。 */
  today: string;
  /** 距目标日还有几天（不含已过期，已过期时为负数）。 */
  remainingDays: number;
  /** 计划落在第几教学周；没设开学日或超出学期时是 1，同时 weekKnown=false。 */
  week: number;
  weekKnown: boolean;
  /** 「第 11 周」或「本周」。 */
  weekLabel: string;
  blocks: PlanBlock[];
  totalMinutes: number;
  weeklyCount: number;
  headline: string;
  rationale: string[];
  constraintLines: string[];
  dropped: string[];
  /** 生成时间（毫秒），只用于本机显示「什么时候排的」。 */
  createdAt: number;
}

export interface BuildPlanInput {
  goalName: string;
  /** 'YYYY-MM-DD'。 */
  goalDate: string;
  /** 'YYYY-MM-DD'，当前日历日（北京时间）。 */
  today: string;
  courses: Course[];
  settings: TimetableSettings;
  constraints: PlanConstraints;
  /**
   * 学生原话（可选）。给了就在这里重新读一遍，把没听懂的部分如实写进 `dropped`；
   * 传了它就以它的解析结果为准（页面就是这么用的，避免两处各解析一次又对不上）。
   */
  constraintText?: string;
  /** 「换一种排法」：>0 时换一个起点重算，结果不同但同样合法。 */
  variant?: number;
  /** 生成时间戳，缺省取当前时间；只影响 `createdAt`，测试里注入固定值。 */
  now?: number;
}

/** 默认约束。每次返回新对象，不共享引用。 */
export function emptyConstraints(): PlanConstraints {
  return {
    maxMinutesPerBlock: DEFAULT_MAX_MINUTES,
    noWeekendMorning: false,
    noEvening: false,
    blocksPerWeek: DEFAULT_BLOCKS_PER_WEEK,
    focus: '',
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ *
 * 一、约束解析（有限模式匹配，不调模型）
 * ------------------------------------------------------------------ */

/** 一句一段：按中文/英文标点切，保留句内的空格（「别超过 1 小时」不能被空格切开）。 */
const CLAUSE_SPLIT = /[，,。；;！!？?、]/u;
/** 时长：`1 小时` / `1.5 小时`；`45 分钟` / `45 分`。 */
const HOUR_MINUTES = /(\d+(?:\.\d+)?)\s*(?:个)?\s*小时/u;
const MINUTE_COUNT = /(\d+)\s*(?:分钟|分)/u;
/** 每周几段：`每周 4 段` / `一周 4 次`。中文数字（每周四段）不认，会进 dropped。 */
const PER_WEEK_COUNT = /(?:每\s*周|一周|周内)\s*(\d+)\s*(?:次|段|回|个)/u;
/** 周末上午：必须同时说出「周末上午」与一个不排的说法，否则不敢当成约束。 */
const WEEKEND_MORNING = /(?:周末|周六|星期六)[^。；;]{0,12}?(?:上午|早上|清早)/u;
const EXCLUSION_WORDS = /(?:不排|别排|不要排|不安排|没空|不方便|有课|有事)/u;
/** 晚上不排：`晚上不排` / `不排晚上`。 */
const EVENING_EXCLUDE = /(?:晚上|晚间|夜里)[^。；;]{0,10}?(?:不排|别排|不要排|不安排|没空|不方便|有课|有事)/u;
const EVENING_EXCLUDE_REVERSE = /(?:不排|别排|不要排|不要安排)[^。；;]{0,6}?(?:晚上|晚间|夜里)/u;
/** 「最弱」在前的写法（听力最弱 / 我的听力最弱）；「最弱的是听力」由下一个模式兜住。 */
const FOCUS_BEFORE = /([\u4e00-\u9fa5]{1,6}?)(?:最弱|最差)/u;
const FOCUS_AFTER = /(?:最弱|最差)(?:的)?(?:是|在|算)?\s*([\u4e00-\u9fa5]{2,6})/u;
/** 这些词不是科目：学生说「精力最差」时不能把它当成要排的科目。 */
const FOCUS_STOP_WORDS = ['时间', '精力', '状态', '心情', '身体', '睡眠', '成绩', '分数', '效率', '基础'];

function focusWord(raw: string): string {
  let text = raw.trim();
  // 「我的听力最弱」→「听力」：只剥人称与助词，不改学生说的科目本身。
  text = text.replace(/^(?:我的|我|的|是|在|比较|最)/u, '').trim();
  if (text === '' || text.length > 4) return '';
  for (const word of FOCUS_STOP_WORDS) {
    if (text === word || text.startsWith(word)) return '';
  }
  return text;
}

function minutesFromText(text: string): number {
  const candidates: number[] = [];
  const hours = HOUR_MINUTES.exec(text);
  if (hours !== null) {
    const value = Number(hours[1]);
    if (Number.isFinite(value) && value > 0) candidates.push(Math.round(value * 60));
  }
  const minutes = MINUTE_COUNT.exec(text);
  if (minutes !== null) {
    const value = Number(minutes[1]);
    if (Number.isFinite(value) && value > 0) candidates.push(value);
  }
  if (candidates.length === 0) return 0;
  // 两种都写了就取小的那个：说「60 分钟，最多 1 小时」时按更保守的来。
  return Math.min(...candidates);
}

function focusFromText(text: string): string {
  const before = FOCUS_BEFORE.exec(text);
  if (before !== null) {
    const word = focusWord(before[1]);
    if (word !== '') return word;
  }
  const after = FOCUS_AFTER.exec(text);
  if (after !== null) {
    const word = focusWord(after[1]);
    if (word !== '') return word;
  }
  return '';
}

function isWeekendMorningBan(text: string): boolean {
  if (!WEEKEND_MORNING.test(text)) return false;
  return EXCLUSION_WORDS.test(text);
}

function isEveningBan(text: string): boolean {
  return EVENING_EXCLUDE.test(text) || EVENING_EXCLUDE_REVERSE.test(text);
}

function perWeekFromText(text: string): number {
  const matched = PER_WEEK_COUNT.exec(text);
  if (matched === null) return 0;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? value : 0;
}

/** 这句原话是不是被某个规则认出来了（用于把听不懂的句子挑出来）。 */
function clauseRecognized(clause: string): boolean {
  return minutesFromText(clause) > 0
    || perWeekFromText(clause) > 0
    || isWeekendMorningBan(clause)
    || isEveningBan(clause)
    || focusFromText(clause) !== '';
}

/** 约束回显：只写读出来的那几条；一条都没读出来时明说按默认。 */
function linesOf(constraints: PlanConstraints, recognized: ConstraintReadout['recognized']): string[] {
  const lines: string[] = [];
  if (recognized.maxMinutesPerBlock) lines.push(`每段不超过 ${constraints.maxMinutesPerBlock} 分钟`);
  if (recognized.blocksPerWeek) lines.push(`每周 ${constraints.blocksPerWeek} 段`);
  if (recognized.focus) lines.push(`最弱的是${constraints.focus}`);
  if (recognized.noWeekendMorning) lines.push('周末上午不排');
  if (recognized.noEvening) lines.push('晚上不排');
  if (lines.length === 0) {
    lines.push(
      `没写清具体约束，按默认排：每段不超过 ${DEFAULT_MAX_MINUTES} 分钟、每周 ${DEFAULT_BLOCKS_PER_WEEK} 段`,
    );
  }
  return lines;
}

/**
 * 读学生的一句话约束。
 *
 * 只认这几类说法：`每次别超过 1 小时 / 不超过 45 分钟`、`每周 4 段`、`周末上午不排`、
 * `晚上不排`、`听力最弱`。**其余原话一概不猜**，原句进 `dropped`，页面照实说「按默认排」。
 */
export function readConstraints(text: string): ConstraintReadout {
  const normalized = String(text === null || text === undefined ? '' : text)
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const constraints = emptyConstraints();
  const recognized: ConstraintReadout['recognized'] = {
    maxMinutesPerBlock: false,
    noWeekendMorning: false,
    noEvening: false,
    blocksPerWeek: false,
    focus: false,
  };
  const dropped: string[] = [];
  if (normalized === '') {
    return { constraints, lines: linesOf(constraints, recognized), dropped, recognized };
  }

  // 字段在整句上取，避免「时长」被标点或空格切断；听不懂的句子再回原句里认一遍。
  const minutes = minutesFromText(normalized);
  if (minutes > 0) {
    constraints.maxMinutesPerBlock = clamp(minutes, MIN_MAX_MINUTES, MAX_MAX_MINUTES);
    recognized.maxMinutesPerBlock = true;
  }
  const perWeek = perWeekFromText(normalized);
  if (perWeek > 0) {
    constraints.blocksPerWeek = clamp(perWeek, MIN_BLOCKS_PER_WEEK, MAX_BLOCKS_PER_WEEK);
    recognized.blocksPerWeek = true;
  }
  if (isWeekendMorningBan(normalized)) {
    constraints.noWeekendMorning = true;
    recognized.noWeekendMorning = true;
  }
  if (isEveningBan(normalized)) {
    constraints.noEvening = true;
    recognized.noEvening = true;
  }
  const focus = focusFromText(normalized);
  if (focus !== '') {
    constraints.focus = focus;
    recognized.focus = true;
  }

  for (const raw of normalized.split(CLAUSE_SPLIT)) {
    const clause = raw.trim();
    if (clause.length < 2) continue;
    if (clauseRecognized(clause)) continue;
    dropped.push(`「${clause}」没听懂，按默认排`);
  }

  return { constraints, lines: linesOf(constraints, recognized), dropped, recognized };
}

/** 只要约束本体时的简版；需要知道「哪句没听懂」时用 `readConstraints`。 */
export function parseConstraints(text: string): PlanConstraints {
  return readConstraints(text).constraints;
}

/* ------------------------------------------------------------------ *
 * 二、排法：先算空档，再按「越早越优先」填
 * ------------------------------------------------------------------ */

interface Slot {
  weekday: number;
  startSection: number;
  endSection: number;
  minutes: number;
}

/** 一节的上课时长：作息填了就用真实起止，没填按 `DEFAULT_SECTION_MINUTES` 估。 */
function sectionMinutes(settings: TimetableSettings, section: number): number {
  const time = sectionTimeAt(settings, section);
  if (time === null) return DEFAULT_SECTION_MINUTES;
  const start = minutesOfClock(time.start);
  const end = minutesOfClock(time.end);
  if (start === null || end === null || end <= start) return DEFAULT_SECTION_MINUTES;
  return end - start;
}

/** 一节课在上课时间之外还夹着课间，这里只算上课时间，不替学校补课间长度。 */
function pairMinutes(settings: TimetableSettings, startSection: number, endSection: number): number {
  let total = 0;
  for (let section = startSection; section <= endSection; section += 1) {
    total += sectionMinutes(settings, section);
  }
  return total;
}

/** 课程真正占掉的节次：以 `sectionRanges` 为准；只有起止节时按起止节，倒置或越界的画不出来。 */
function courseRanges(course: Course): SectionRange[] {
  const valid = course.sectionRanges.filter(
    (range) => range.start >= 1 && range.end <= SECTION_COUNT && range.start <= range.end,
  );
  if (valid.length > 0) return valid;
  if (course.startSection >= 1 && course.endSection <= SECTION_COUNT && course.startSection <= course.endSection) {
    return [{ start: course.startSection, end: course.endSection }];
  }
  return [];
}

function overlaps(ranges: SectionRange[], startSection: number, endSection: number): boolean {
  for (const range of ranges) {
    if (range.start <= endSection && startSection <= range.end) return true;
  }
  return false;
}

/** 这一格（星期 + 大节）是否有课。`weekKnown=false` 时按「每周都有」保守避开，不赌它这周没课。 */
function blockedByCourse(
  courses: Course[],
  weekday: number,
  startSection: number,
  endSection: number,
  week: number,
  weekKnown: boolean,
): boolean {
  for (const course of courses) {
    if (course.weekday !== weekday) continue;
    if (weekKnown && !occursInWeek(course, week)) continue;
    if (overlaps(courseRanges(course), startSection, endSection)) return true;
  }
  return false;
}

function pairSlots(constraints: PlanConstraints, settings: TimetableSettings): { start: number; end: number }[] {
  const pairs: { start: number; end: number }[] = [];
  for (let start = 1; start + 1 <= SECTION_COUNT; start += 2) {
    const end = start + 1;
    if (constraints.noEvening && start >= EVENING_FIRST_SECTION) continue;
    pairs.push({ start, end });
  }
  return pairs;
}

/** 找出一周里所有能排的空档，按星期、节次升序。 */
function freeSlots(
  input: BuildPlanInput,
  constraints: PlanConstraints,
  week: number,
  weekKnown: boolean,
): Map<number, Slot[]> {
  const byDay = new Map<number, Slot[]>();
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const slots: Slot[] = [];
    for (const pair of pairSlots(constraints, input.settings)) {
      // 周末上午 = 第 1-4 节；下午与晚上仍可以排（设计图 03 的例子就只排除上午）。
      if (constraints.noWeekendMorning && weekday >= 6 && pair.start <= MORNING_LAST_SECTION) continue;
      if (blockedByCourse(input.courses, weekday, pair.start, pair.end, week, weekKnown)) continue;
      const minutes = Math.min(constraints.maxMinutesPerBlock, pairMinutes(input.settings, pair.start, pair.end));
      if (minutes <= 0) continue;
      slots.push({ weekday, startSection: pair.start, endSection: pair.end, minutes });
    }
    byDay.set(weekday, slots);
  }
  return byDay;
}

/** 「换一种排法」的起点轮换：v=0 用周一到周日，v=1 从周二开始……结果同样合法，只是换一天。 */
function rotateDays(days: number[], variant: number): number[] {
  if (days.length === 0) return [];
  const offset = ((Math.round(variant) % days.length) + days.length) % days.length;
  return days.slice(offset).concat(days.slice(0, offset));
}

/** 同一天的两段之间至少空出一个大节，避免「连排」成 4 节连上。 */
function tooClose(placed: Slot[], candidate: Slot): boolean {
  for (const slot of placed) {
    if (slot.weekday !== candidate.weekday) continue;
    const gap = Math.abs(candidate.startSection - slot.endSection);
    const gap2 = Math.abs(slot.startSection - candidate.endSection);
    if (Math.min(gap, gap2) < 2) return true;
  }
  return false;
}

/**
 * 填段：先每天最多 1 段（设计图 03 的样子：周一、周二、周三、周四各一段）；
 * 空档不够时放宽到每天 2 段（仍不连排），最后才允许相邻，**绝不超过一周的总空档数**。
 */
function fillSlots(byDay: Map<number, Slot[]>, weeklyCount: number, variant: number): Slot[] {
  const placed: Slot[] = [];
  const dayOrder = rotateDays([1, 2, 3, 4, 5, 6, 7], variant);
  const perDay = new Map<number, number>();
  const used = new Set<string>();
  const keyOf = (slot: Slot) => `${slot.weekday}-${slot.startSection}`;

  for (const cap of [1, 2, 6]) {
    let progressed = true;
    while (progressed && placed.length < weeklyCount) {
      progressed = false;
      for (const weekday of dayOrder) {
        if (placed.length >= weeklyCount) break;
        if ((perDay.get(weekday) ?? 0) >= cap) continue;
        const candidates = byDay.get(weekday) ?? [];
        let chosen: Slot | null = null;
        for (const slot of candidates) {
          if (used.has(keyOf(slot))) continue;
          if (cap < 6 && tooClose(placed, slot)) continue;
          chosen = slot;
          break;
        }
        if (chosen === null) continue;
        used.add(keyOf(chosen));
        placed.push(chosen);
        perDay.set(weekday, (perDay.get(weekday) ?? 0) + 1);
        progressed = true;
      }
    }
    if (placed.length >= weeklyCount) break;
  }
  return placed;
}

/** 语言类目标常见「真题 + 词汇」；其他目标用「真题 + 错题」，不对科目做假设。 */
const LANGUAGE_FOCUS = /(?:听力|口语|阅读|写作|翻译|词汇|单词|语法|英语|四级|六级)/u;

function shortGoalName(goalName: string): string {
  const text = goalName.trim();
  if (text === '') return '复习';
  return text.length > 6 ? text.slice(0, 6) : text;
}

/** 每段做什么：前两段给学生说的最弱项，之后按「真题 / 词汇（或错题）」轮换。 */
function topicFor(index: number, focus: string, goalName: string): string {
  const base = focus === '' ? shortGoalName(goalName) : focus;
  if (index < 2) return base;
  const variety = LANGUAGE_FOCUS.test(`${focus}${goalName}`) ? ['真题', '词汇'] : ['真题', '错题'];
  return variety[(index - 2) % variety.length];
}

function blockLineText(block: PlanBlock): string {
  const weekday = WEEKDAY_SHORT[block.weekday - 1] ?? '';
  return `周${weekday} ${block.startSection}-${block.endSection} 节 · ${block.topic} ${block.minutes}′`;
}

/** 一段在页面上的短标签，如「听力 45′」。 */
export function blockLabel(block: PlanBlock): string {
  return `${block.topic} ${block.minutes}′`;
}

/** 一段的完整一行，如「周一 5-6 节 · 听力 45′」（周末的段落不进 5 列网格，用这一行补出来）。 */
export function blockDescribe(block: PlanBlock): string {
  return blockLineText(block);
}

/** 「共 3.5 小时」：整小时不带小数，半小时保留一位，其余按分钟说清楚。 */
export function hoursLabel(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '共 0 分钟';
  if (totalMinutes % 60 === 0) return `共 ${totalMinutes / 60} 小时`;
  const hours = totalMinutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  if (rounded * 60 === totalMinutes) return `共 ${rounded} 小时`;
  const whole = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return whole === 0 ? `共 ${totalMinutes} 分钟` : `共 ${whole} 小时 ${rest} 分钟`;
}

function emptyPlan(
  input: BuildPlanInput,
  constraints: PlanConstraints,
  readout: { lines: string[]; dropped: string[] },
  remainingDays: number,
  week: number,
  weekKnown: boolean,
  headline: string,
  rationale: string[],
): StudyPlan {
  return {
    goalName: input.goalName.trim(),
    goalDate: input.goalDate,
    today: input.today,
    remainingDays,
    week,
    weekKnown,
    weekLabel: weekKnown ? `第 ${week} 周` : '本周',
    blocks: [],
    totalMinutes: 0,
    weeklyCount: constraints.blocksPerWeek,
    headline,
    rationale,
    constraintLines: readout.lines,
    dropped: readout.dropped,
    createdAt: typeof input.now === 'number' ? input.now : Date.now(),
  };
}

/**
 * 生成一份每周计划。**排不下就说排不下**：`blocks` 会是空的，`headline` 说明原因，
 * 不会为了凑够 `blocksPerWeek` 把学习块硬塞进有课或已被约束排除的时段。
 */
export function buildPlan(input: BuildPlanInput): StudyPlan {
  const readout = typeof input.constraintText === 'string'
    ? readConstraints(input.constraintText)
    : { constraints: input.constraints, lines: [] as string[], dropped: [] as string[], recognized: null };
  const constraints = readout.constraints;
  if (readout.lines.length === 0) {
    readout.lines = linesOf(constraints, {
      maxMinutesPerBlock: true,
      noWeekendMorning: constraints.noWeekendMorning,
      noEvening: constraints.noEvening,
      blocksPerWeek: true,
      focus: constraints.focus !== '',
    });
  }

  const remainingDays = diffDays(input.today, input.goalDate);
  const week = weekIndexOf(input.settings, input.today);
  const weekKnown = week !== null;
  const targetWeek = week === null ? 1 : week;

  if (remainingDays === null) {
    return emptyPlan(input, constraints, readout, 0, targetWeek, weekKnown,
      '目标日不是合法日期，先回去改一下日期再排',
      ['目标日期读不出来，这里不猜它还剩几天。改好日期后重新生成即可。']);
  }
  if (remainingDays < 0) {
    return emptyPlan(input, constraints, readout, remainingDays, targetWeek, weekKnown,
      `目标日已经过了 ${-remainingDays} 天，先改一个还没到的日期`,
      ['计划只往前排，不从已经过去的日期倒推。']);
  }

  const byDay = freeSlots(input, constraints, targetWeek, weekKnown);
  const placed = fillSlots(byDay, constraints.blocksPerWeek, input.variant ?? 0);

  if (placed.length === 0) {
    return emptyPlan(input, constraints, readout, remainingDays, targetWeek, weekKnown,
      '这周没有能排的空档，先不排——不硬塞进有课的时段',
      [
        `距 ${input.goalDate} 还有 ${remainingDays} 天，但${weekKnown ? `第 ${targetWeek} 周` : '本周'}的课表里找不到同时避开已有课程与你的约束的空档。`,
        '把课表补全后重新生成，或者放宽一条约束（例如允许晚上排），再试一次。',
      ]);
  }

  // 输出按「星期 → 节次」排序（页面从上往下读），主题按这个顺序编：最早的几段给最弱项。
  const ordered = [...placed].sort(
    (a, b) => a.weekday - b.weekday || a.startSection - b.startSection,
  );

  const blocks: PlanBlock[] = ordered.map((slot, index) => ({
    id: `plan-${targetWeek}-${slot.weekday}-${slot.startSection}`,
    weekday: slot.weekday,
    startSection: slot.startSection,
    endSection: slot.endSection,
    minutes: slot.minutes,
    topic: topicFor(index, constraints.focus, input.goalName),
    week: targetWeek,
  }));

  const totalMinutes = blocks.reduce((sum, block) => sum + block.minutes, 0);
  const weekText = weekKnown ? `第 ${targetWeek} 周` : '本周';
  const headline = placed.length < constraints.blocksPerWeek
    ? `还剩 ${remainingDays} 天，${weekText}只排得下 ${placed.length} 段（你想每周 ${constraints.blocksPerWeek} 段）`
    : `还剩 ${remainingDays} 天，每周 ${constraints.blocksPerWeek} 段`;

  const rationale = buildRationale(input, constraints, blocks, placed.length, remainingDays, weekText);

  return {
    goalName: input.goalName.trim(),
    goalDate: input.goalDate,
    today: input.today,
    remainingDays,
    week: targetWeek,
    weekKnown,
    weekLabel: weekText,
    blocks,
    totalMinutes,
    weeklyCount: constraints.blocksPerWeek,
    headline,
    rationale,
    constraintLines: readout.lines,
    dropped: readout.dropped,
    createdAt: typeof input.now === 'number' ? input.now : Date.now(),
  };
}

/** 依据只写能用数据核对的事：哪一周、哪几天、多少分钟、对应哪条约束。 */
function buildRationale(
  input: BuildPlanInput,
  constraints: PlanConstraints,
  blocks: PlanBlock[],
  placedCount: number,
  remainingDays: number,
  weekText: string,
): string[] {
  const lines: string[] = [];
  const spots = blocks.map((block) => `周${WEEKDAY_SHORT[block.weekday - 1]} ${block.startSection}-${block.endSection} 节`);
  const shown = spots.slice(0, 4).join('、');
  const more = spots.length > 4 ? ` 等 ${spots.length} 段` : '';
  lines.push(
    `距 ${input.goalDate} 还有 ${remainingDays} 天；${weekText}的空档里排了 ${placedCount} 段：${shown}${more}。`,
  );

  const minutesSet = [...new Set(blocks.map((block) => block.minutes))].sort((a, b) => a - b);
  const minutesText = minutesSet.join('/');
  const filled = blocks.some((block) => sectionTimeAt(input.settings, block.startSection) !== null);
  const source = filled ? '按你填的作息算' : `课表没填作息时间，按每节 ${DEFAULT_SECTION_MINUTES} 分钟估`;
  lines.push(
    `每段 ${minutesText} 分钟，都在你说的「每段不超过 ${constraints.maxMinutesPerBlock} 分钟」以内（${source}）。`,
  );

  const policies: string[] = [];
  if (constraints.focus !== '') {
    const focusBlocks = blocks.filter((block) => block.topic === constraints.focus);
    if (focusBlocks.length > 0) {
      const days = focusBlocks.slice(0, 2).map((block) => `周${WEEKDAY_SHORT[block.weekday - 1]}`).join('、');
      policies.push(`你说${constraints.focus}最弱，前 ${focusBlocks.length} 段排的都是${constraints.focus}（${days}）`);
    }
  }
  if (constraints.noWeekendMorning) {
    const weekend = blocks.filter((block) => block.weekday >= 6);
    policies.push(weekend.length === 0
      ? '周末上午按你说的不排，这几天也没占到周末'
      : `周末上午按你说的不排，只用了周末的 ${weekend.map((block) => `第 ${block.startSection}-${block.endSection} 节`).join('、')}`);
  }
  if (constraints.noEvening) {
    policies.push(`晚上按你说的不排（第 ${EVENING_FIRST_SECTION} 节起都没用）`);
  }
  if (policies.length === 0) {
    policies.push('没有别的限制，就按「越早越优先」填进这周最早的空档');
  }
  lines.push(`${policies.join('；')}。`);
  return lines;
}

/** 某一周的计划段：以后周课表要叠金色虚线时从这里取。 */
export function planBlocksForWeek(plan: StudyPlan, week: number): PlanBlock[] {
  return plan.blocks.filter((block) => block.week === week);
}

/* ------------------------------------------------------------------ *
 * 三、迷你网格（设计图 03：5 列 × 节次对）
 * ------------------------------------------------------------------ */

export interface PlanCell {
  /** busy/busy2 是已有课程（两种色系区分不同课），plan 是 AI 计划，free 是空闲。 */
  kind: 'busy' | 'busy2' | 'free' | 'plan';
  /** 直接显示的文字：课名或「听力 45′」。 */
  label: string;
  /** 1 = 正常一格；>1 表示这门课跨了几个大节、合并成一格；0 = 被上面的合并格盖住，不渲染。 */
  rowSpan: number;
}

/** 课程按名字稳定分到两种底色：同一门课永远同色，不同课大概率不同色，不随机。 */
function courseKind(name: string): 'busy' | 'busy2' {
  return colorIndexFor(name) % 2 === 0 ? 'busy' : 'busy2';
}

function rowIndexOfSection(section: number): number {
  return Math.ceil(section / 2) - 1;
}

/**
 * 迷你周网格的数据：行 = 节次对（1-2、3-4……），列 = 周一至周五。
 *
 * 跨节次的课合并成一格（`rowSpan` > 1），被合并盖住的下一行给 `rowSpan` 0、不渲染；
 * WXML 用它拼 `grid-row:span N`。计划段只画 `week` 那一周的。
 * 行数取「有内容的最后一行」与 5 行的较大值，避免网格看起来被截断。
 */
export function planGrid(
  plan: StudyPlan,
  courses: Course[],
  settings: TimetableSettings,
  week: number,
): PlanCell[][] {
  const weekKnown = plan.weekKnown !== false;
  const gridCourses = courses.filter((course) => {
    if (course.weekday < 1 || course.weekday > GRID_WEEKDAYS.length) return false;
    // 没设开学日时算不出教学周，宁可把课都画上（显示偏满），也不假装那周没课。
    return weekKnown ? occursInWeek(course, week) : true;
  });
  const plans = planBlocksForWeek(plan, week);

  const rows: PlanCell[][] = [];
  for (let row = 0; row < GRID_PAIR_LABELS.length; row += 1) {
    const start = row * 2 + 1;
    const end = start + 1;
    const cells: PlanCell[] = [];
    for (let weekday = 1; weekday <= GRID_WEEKDAYS.length; weekday += 1) {
      const owner = gridCourses.find(
        (course) => course.weekday === weekday && overlaps(courseRanges(course), start, end),
      );
      if (owner !== undefined) {
        const ranges = courseRanges(owner);
        const first = ranges.reduce((min, range) => (overlaps([range], start, end) ? Math.min(min, range.start) : min), SECTION_COUNT);
        const last = ranges.reduce((max, range) => (overlaps([range], start, end) ? Math.max(max, range.end) : max), 1);
        if (first < start) {
          // 这门课从上一行就开始了：这一格已被上面的合并格覆盖。
          cells.push({ kind: courseKind(owner.name), label: owner.name, rowSpan: 0 });
          continue;
        }
        const span = Math.min(rowIndexOfSection(last) - row + 1, GRID_PAIR_LABELS.length - row);
        cells.push({ kind: courseKind(owner.name), label: owner.name, rowSpan: span < 1 ? 1 : span });
        continue;
      }
      const planned = plans.find((block) => block.weekday === weekday && block.startSection === start);
      if (planned !== undefined) {
        cells.push({ kind: 'plan', label: blockLabel(planned), rowSpan: 1 });
        continue;
      }
      cells.push({ kind: 'free', label: '', rowSpan: 1 });
    }
    rows.push(cells);
  }

  let lastContent = MIN_GRID_ROWS;
  rows.forEach((cells, index) => {
    if (cells.some((cell) => cell.kind !== 'free')) lastContent = Math.max(lastContent, index + 1);
  });
  return rows.slice(0, Math.min(lastContent, GRID_PAIR_LABELS.length));
}

/* ------------------------------------------------------------------ *
 * 四、本机存储（与 goal-days/v1 同一套约定：读脏数据丢弃、写失败抛出）
 * ------------------------------------------------------------------ */

function storageAvailable(): boolean {
  return typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' && typeof wx.setStorageSync === 'function';
}

function intIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function normalizeBlock(raw: unknown): PlanBlock | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const weekday = intIn(source.weekday, 1, 7);
  const startSection = intIn(source.startSection, 1, SECTION_COUNT);
  const endSection = intIn(source.endSection, 1, SECTION_COUNT);
  const week = intIn(source.week, 1, 30);
  if (weekday === null || startSection === null || endSection === null || week === null) return null;
  if (endSection < startSection) return null;
  if (typeof source.minutes !== 'number' || !Number.isFinite(source.minutes) || source.minutes <= 0) return null;
  const topic = typeof source.topic === 'string' ? source.topic.trim() : '';
  if (topic === '') return null;
  const id = typeof source.id === 'string' && source.id !== ''
    ? source.id
    : `plan-${week}-${weekday}-${startSection}`;
  return { id, weekday, startSection, endSection, minutes: Math.round(source.minutes), topic, week };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * 把本机读到的东西收敛成一份计划；结构不对返回 null（整条丢弃）。
 * **不修补、不猜**：一段的星期或节次读不出来，说明这份数据已经不可信，宁可不要它。
 */
export function normalizePlan(raw: unknown): StudyPlan | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.blocks)) return null;
  const blocks: PlanBlock[] = [];
  for (const item of source.blocks) {
    const block = normalizeBlock(item);
    if (block === null) return null;
    blocks.push(block);
  }
  const goalName = typeof source.goalName === 'string' ? source.goalName.trim() : '';
  const goalDate = typeof source.goalDate === 'string' ? source.goalDate.trim() : '';
  const today = typeof source.today === 'string' ? source.today.trim() : '';
  if (goalDate === '' || today === '') return null;
  const week = intIn(source.week, 1, 30) ?? 1;
  const weekKnown = source.weekKnown !== false;
  const totalMinutes = blocks.reduce((sum, block) => sum + block.minutes, 0);
  const weeklyCount = intIn(source.weeklyCount, 1, MAX_BLOCKS_PER_WEEK) ?? Math.max(1, blocks.length);
  const remainingDays = typeof source.remainingDays === 'number' && Number.isFinite(source.remainingDays)
    ? Math.round(source.remainingDays)
    : 0;
  const createdAt = typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
    ? source.createdAt
    : 0;
  return {
    goalName,
    goalDate,
    today,
    remainingDays,
    week,
    weekKnown,
    weekLabel: typeof source.weekLabel === 'string' && source.weekLabel !== ''
      ? source.weekLabel
      : (weekKnown ? `第 ${week} 周` : '本周'),
    blocks,
    totalMinutes,
    weeklyCount,
    headline: typeof source.headline === 'string' ? source.headline : '',
    rationale: stringList(source.rationale),
    constraintLines: stringList(source.constraintLines),
    dropped: stringList(source.dropped),
    createdAt,
  };
}

/** 读取本机计划。**不会有第二条**（同时只保留最近排的一次），读到坏数据只丢这一条并返回 null。 */
export function loadPlan(): StudyPlan | null {
  if (!storageAvailable()) return null;
  let raw: unknown;
  try {
    raw = wx.getStorageSync(STORAGE_KEY);
  } catch (error) {
    console.error('读取备考计划失败，按没有计划处理：', error);
    return null;
  }
  if (raw === '' || raw === null || raw === undefined) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error('本机备考计划不是合法 JSON，已丢弃：', error);
      return null;
    }
  }
  const plan = normalizePlan(parsed);
  if (plan === null) console.error('本机备考计划结构不对，已丢弃');
  return plan;
}

/**
 * 保存计划到本机。**只写本机**：计划不是课程，不进云端课表，也不进任何 AI 请求
 * （云函数的 `source` 只认 excel/manual/photo，写「计划课」会污染真实课表）。
 */
export function savePlan(plan: StudyPlan): void {
  if (!storageAvailable()) throw new Error('当前环境无法保存到本机');
  if (normalizePlan(plan) === null) throw new Error('计划数据不完整，无法保存');
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(plan));
  } catch (error) {
    console.error('保存备考计划失败：', error);
    throw new Error('保存失败：本机存储不可写');
  }
}

/** 删掉本机计划；本来就没有也算成功。 */
export function removePlan(): void {
  if (!storageAvailable()) throw new Error('当前环境无法保存到本机');
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (error) {
    console.error('删除备考计划失败：', error);
    throw new Error('删除失败：本机存储不可写');
  }
}
