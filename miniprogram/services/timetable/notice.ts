/**
 * 「贴一段班群通知 → AI 识别多处课表变更 → 学生逐条勾选 → 批量应用 → 10 秒内可撤销」的纯逻辑
 * （设计图 02 `docs/design/ai-innovation-2026-11/02-notice-to-changes.html`）。
 *
 * 纪律（比照 06 课表助手，见 `docs/product/spec.md`「AI 功能」）：
 * - **确认前不写入**：这里只产出「提案」，页面把提案放内存；学生点「应用」才走 03 的写入入口。
 * - **不编造**：通知里没写的字段一律留空；对不上课表的数据如实标成「阻塞」并默认不勾选，
 *   绝不假装应用成功。冲突与阻塞都由本模块按当前课表算出来，模型自己说的 `conflict` 不算数。
 * - **一条变更 = 一次写入**：停课/改地点/改时间都是改一条已有课程，补课是新增一条课程记录；
 *   这样每条都能在撤销时精确还原（新增的删除、改动的写回旧值）。
 *
 * 范围：本期只做**文本**解析。通知是截图时不要在这里临时加多模态——
 * 截图识别走课表导入页既有的 vision 链路（`services/timetable/photo.ts`，Ticket 05），
 * 识别成草稿后再由学生逐条确认保存；两条链路各自负责自己的确认与写入。
 *
 * 复用的既有实现（不重复造）：`ProposedCourse`、`buildChangeInput`（字段合并语义）、
 * `summarizeChange`（人读摘要）、`buildTimetableText`（课表快照）、`parseWeekNotation` /
 * `condenseWeeks`（周次写法）、`occursInWeek` / `sectionLabelOf` / `weekdayLabel`（展示口径）。
 */
import { extractJson } from '../ai';
import { Course, CourseInput, SectionRange } from './types';
import { condenseWeeks, parseWeekNotation } from './weeks';
import { SECTION_COUNT, WEEKDAY_SHORT, occursInWeek, sectionLabelOf, weekdayLabel } from './view';
import { ProposedCourse, buildChangeInput, buildTimetableText, summarizeChange } from './assistant';

/** ai 云函数用的 feature 名（`sanitizeFeature` 对未知 feature 不拦截，无需改云函数）。 */
export const NOTICE_FEATURE = 'timetable-notice';

/** 应用之后可以撤销的时间窗（毫秒）：与设计图「应用后 10 秒内可撤销」一致，页面只认这一个来源。 */
export const NOTICE_UNDO_MS = 10000;

/** 防御性上限：单次通知识别的变更条数、各类文本长度。 */
const MAX_CHANGES = 20;
const REPLY_MAX = 4000;
const MAX_QUOTE = 200;
const MAX_NAME = 60;
const MAX_LOCATION = 80;
const MAX_WEEK_TEXT = 40;

/** 通知里能落到课表上的动作。 */
export type NoticeAction =
  /** 停课：把某几周从一条已有课程里去掉。 */
  | 'cancel'
  /** 只改地点。 */
  | 'relocate'
  /** 只改星期或节次。 */
  | 'move'
  /** 补课/临时加一次：新增一条课程记录。 */
  | 'add';

/**
 * 差异行（对应设计图 `.diff`）：旧值划线灰 → 新值品牌墨红加粗。
 * `lead` 是「新增」这类引导词，通常为空；`old` 为空表示没有旧值，`next` 为空表示没有新值。
 * 字段名用 `next` 而不是 `new`，避免 WXML 表达式里出现 JS 保留字。
 */
export interface NoticeDiff {
  lead: string;
  old: string;
  next: string;
  /** 行尾的灰色补充（设计图里「第 11–18 周」那种），没有就留空。 */
  note: string;
}

/**
 * 一条提案变更。`defaultChecked` 由「有阻塞」与「有冲突」共同决定：
 * 模型说的不算，只按当前课表算出来的结果才可信；有冲突/阻塞时一律默认不勾选。
 */
export interface NoticeChange {
  /** 有限定周次时显式展示；原始业务快照保证丢响应后仍用同一提案重试。 */
  scopeLabel?: string;
  unaffectedLabel?: string;
  original?: CourseInput | null;
  action: NoticeAction;
  /** 标题行，如「停课 · 第 12 周 周三全天」；按结构化字段重算，不采用模型标题。 */
  title: string;
  diffs: NoticeDiff[];
  /** 通知原文里的逐字片段（不含「原文：」前缀，页面自己加）。 */
  quote: string;
  /** 「会写进课表的内容」一句话（「逐条核对」展开时显示）。 */
  detail: string;
  /** 周次原文，如「第 12 周」。 */
  weekText: string;
  /** 解析出的周次：停课＝要停掉的周次，补课＝这节补课在的周次，改时间/改地点＝空。 */
  weeks: number[];
  weeksRecognized: boolean;
  /** 停课后剩下的周次（仅 `cancel` 用，其余为空）。 */
  remainingWeeks: number[];
  /** 变更涉及的目标星期（1-7）；改地点沿用当前值。 */
  weekday: number;
  startSection: number;
  endSection: number;
  /** 指向已有课程；补课为空字符串。 */
  courseId: string;
  courseName: string;
  location: string;
  teacher: string;
  /** 软冲突：同一时段已有课。空字符串表示没查到冲突；有冲突仍可勾选（学生坚持要加）。 */
  conflict: string;
  /** 硬阻塞：数据不足以安全写入（找不到课程、周次没识别、与现状一致……）。非空时不允许勾选。 */
  blocked: string;
  /** 是否默认勾选：没有阻塞也没有冲突才默认勾。 */
  defaultChecked: boolean;
}

/** 模型回复 → 类型化结果；`invalid` 表示这次没有生成任何提案（也绝不写入）。 */
export type NoticeReply =
  | { kind: 'changes'; message: string; changes: NoticeChange[] }
  | { kind: 'none'; message: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'out_of_scope'; message: string }
  | { kind: 'invalid'; message: string };

/** 一条可执行的写入：新增走 create，修改走 update（`input` 是写入后的整条内容）。 */
export interface ApplyStep {
  /** 对应传入 `changes` 的下标，跳过的阻塞项不影响对回原提案。 */
  changeIndex: number;
  kind: 'create' | 'update' | 'scoped';
  /** 要修改的课程 id；新增为空字符串（写入后才知道新 id）。 */
  courseId: string;
  input: CourseInput;
  /** 修改前的整条内容（撤销用）；新增为 null。 */
  before: CourseInput | null;
  /** 给人看的一句摘要（来自 `summarizeChange`）。 */
  summary: string;
}

/** 已经真正写入成功的一条：撤销时按它算逆操作。 */
export interface AppliedChange {
  changeIndex: number;
  kind: 'create' | 'update' | 'scoped';
  operationId?: string;
  /** 新建出来的课程 id / 被修改的课程 id。 */
  courseId: string;
  before: CourseInput | null;
  after: CourseInput;
  summary: string;
}

/** 撤销的一步：新增的删除、改动的写回旧值。 */
export interface InvertStep {
  kind: 'delete' | 'update' | 'scoped';
  operationId?: string;
  courseId: string;
  /** update 恢复写入前的整条内容；delete 为 null。 */
  input: CourseInput | null;
  summary: string;
}

/**
 * 空提案：作为 `buildChangeInput` 的入参时，它只表示「这次什么都没指定」，
 * 于是所有字段都从当前课程原样带过来——正好就是当前课程的完整快照。
 */
const EMPTY_PROPOSED: ProposedCourse = {
  name: '',
  teacher: '',
  weekday: 0,
  startSection: 0,
  endSection: 0,
  weekText: '',
  location: '',
};

/** 已在库里的一条课程 → 提交内容快照（撤销时写回旧值；复用 buildChangeInput 的合并口径）。 */
export function snapshotInput(course: Course): CourseInput {
  return buildChangeInput(EMPTY_PROPOSED, course);
}

// —— 取值小工具：与 `assistant.ts` 里的同名私有函数口径一致（那边没导出，这里只复制必要的几行） ——

function asText(value: unknown, max: number): string {
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

/** 课程 id 取值：模型可能把提示词里的 `[id:tc_…]` 连壳抄回来，剥掉外壳只留标识。 */
function asCourseId(value: unknown): string {
  const text = asText(value, 80);
  return text
    .replace(/^[\[［]\s*id\s*[:：]\s*/iu, '')
    .replace(/[\]］]$/u, '')
    .trim()
    .slice(0, 64);
}

/** 有效节次区间：优先 `sectionRanges`；原文只给了首尾节次时退回它（与展示口径同源）。 */
function rangesOf(course: Course): SectionRange[] {
  if (course.sectionRanges.length > 0) return course.sectionRanges;
  if (course.startSection >= 1) return [{ start: course.startSection, end: course.endSection }];
  return [];
}

function sectionsOverlap(left: SectionRange[], right: SectionRange[]): boolean {
  return left.some((a) => right.some((b) => a.start <= b.end && b.start <= a.end));
}

/** 星期展示用短名（设计图标题写「周三」，正文写「星期三」，两种口径各取所需）。 */
function weekdayShort(weekday: number): string {
  return weekday >= 1 && weekday <= 7 ? '周' + WEEKDAY_SHORT[weekday - 1] : '';
}

function sectionText(start: number, end: number): string {
  if (start < 1 || end < start) return '节次待核对';
  return start === end ? '第 ' + start + ' 节' : '第 ' + start + '-' + end + ' 节';
}

/** 星期 + 节次，用于差异行与明细（与 `assistant.ts` 的展示口径一致）。 */
function timeText(weekday: number, start: number, end: number): string {
  const day = weekdayLabel(weekday);
  const section = sectionText(start, end);
  return day === '' ? section : day + ' ' + section;
}

/** 已有课程的当前时间写法（多段节次、待核对原文都原样呈现）。 */
function currentTimeText(course: Course): string {
  const day = weekdayLabel(course.weekday);
  const section = sectionLabelOf(course);
  return day === '' ? section : day + ' ' + section;
}

/** 周次原文 → 展示写法；识别不出的保留原文，不猜。 */
function weekTextLabel(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const parsed = parseWeekNotation(trimmed);
  return parsed.recognized ? '第 ' + condenseWeeks(parsed.weeks) + ' 周' : trimmed;
}

function valueLabel(value: string): string {
  return value === '' ? '（空）' : value;
}

/** 已有课程的周次写法（改地点/改时间这类不动周次的变更，行尾挂它做补充说明）。 */
function courseWeekLabel(course: Course): string {
  if (!course.weeksRecognized) return course.weekText;
  if (course.weeks.length === 0) return '每周';
  return '第 ' + condenseWeeks(course.weeks) + ' 周';
}

/** 模型给出的动作名只认四种；其余一律当作格式问题（不落进任何写入分支）。 */
const ACTIONS: NoticeAction[] = ['cancel', 'relocate', 'move', 'add'];

function readAction(value: unknown): NoticeAction | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return (ACTIONS as string[]).includes(text) ? (text as NoticeAction) : null;
}

/**
 * 在课表里定位这条变更要改的课程：先按 id，再按课程名精确匹配（不做模糊匹配，避免改错课）。
 * 同名多门时用星期、再不行用节次收窄；仍然不唯一就如实标阻塞，绝不猜。
 */
function locate(
  courses: Course[],
  courseId: string,
  courseName: string,
  weekday: number,
  startSection: number,
  endSection: number,
): { course: Course | null; problem: string } {
  if (courseId !== '') {
    const byId = courses.find((course) => course.id === courseId);
    if (byId !== undefined) return { course: byId, problem: '' };
  }
  if (courseName === '') return { course: null, problem: '这门课的课程名' };
  const named = courses.filter((course) => course.name === courseName);
  if (named.length === 0) return { course: null, problem: '课表里没有找到「' + courseName + '」这门课' };
  if (named.length === 1) return { course: named[0], problem: '' };
  const narrowed = weekday >= 1 && weekday <= 7
    ? named.filter((course) => course.weekday === weekday)
    : named;
  if (narrowed.length === 1) return { course: narrowed[0], problem: '' };
  const exact = startSection >= 1
    ? narrowed.filter((course) => rangesOf(course).some((range) => range.start === startSection && range.end === endSection))
    : [];
  if (exact.length === 1) return { course: exact[0], problem: '' };
  return {
    course: null,
    problem: '课表里有 ' + named.length + ' 门都叫「' + courseName + '」，没法确定改哪一门',
  };
}

/** 停课后剩下的周次；`problem` 非空表示不能安全写入。 */
function remainingAfterCancel(
  current: Course,
  removeWeeks: number[],
  totalWeeks: number,
): { remaining: number[]; problem: string } {
  if (!current.weeksRecognized) {
    return {
      remaining: [],
      problem: '这门课的周次是原文「' + (current.weekText === '' ? '未识别' : current.weekText)
        + '」，系统没识别出来，没法只停某几周；请到课程里手动改。',
    };
  }
  const drop = new Set(removeWeeks);
  let all: number[];
  if (current.weeks.length === 0) {
    // 「每周」这门课：要停一周就得先展开成明确周次，需要学期总周数；不知道就不写。
    if (totalWeeks < 1) {
      return { remaining: [], problem: '这门课是每周都上，需要先知道学期总周数才能只停一周；请到课程里手动改。' };
    }
    all = Array.from({ length: totalWeeks }, (_, index) => index + 1);
  } else {
    all = current.weeks;
  }
  const remaining = all.filter((week) => !drop.has(week));
  if (remaining.length === all.length) {
    return {
      remaining,
      problem: '这门课第 ' + condenseWeeks(removeWeeks) + ' 周本来就没有课，这条不用应用。',
    };
  }
  if (remaining.length === 0) {
    return { remaining: [], problem: '这门课只有这几周，停课后就没有剩余周次了；请在课表里直接删除这门课。' };
  }
  return { remaining, problem: '' };
}

/** 冲突文案（设计图 `.warnline`）：默认没勾选，但学生仍可勾选加入。 */
function conflictText(names: string[]): string {
  if (names.length === 0) return '';
  return '与' + names.map((name) => '「' + name + '」').join('') + '冲突，未勾选；可改时段或仍然加入。';
}

/**
 * 新占用的时段与已有课程的冲突：同一 weekday + 节次区间重叠 + 周次有交集。
 * 周次用 `occursInWeek` 口径判断；「每周」这类说不清的按「可能撞」处理——宁可提示，也不静默放行。
 */
function findConflicts(
  courses: Course[],
  weekday: number,
  ranges: SectionRange[],
  targetWeeks: number[],
  everyWeek: boolean,
  skipCourseId: string,
): string[] {
  const names: string[] = [];
  for (const course of courses) {
    if (course.id === skipCourseId) continue;
    if (course.weekday !== weekday) continue;
    if (!sectionsOverlap(ranges, rangesOf(course))) continue;
    const clash = everyWeek ? true : targetWeeks.some((week) => occursInWeek(course, week));
    if (!clash) continue;
    if (!names.includes(course.name)) names.push(course.name);
  }
  return names;
}

/** 结构上就缺字段的变更：整份提案作废（不猜、不半信半疑地应用）。 */
function structuralProblem(problem: string): { ok: false; problem: string } {
  return { ok: false, problem };
}

type BuildResult = { ok: true; change: NoticeChange } | { ok: false; problem: string };

/** 模型给的一条变更 → `NoticeChange`：结构校验 + 定位课程 + 冲突/阻塞判定 + 标题与差异行。 */
function boundedWeeks(text: string, totalWeeks: number, currentWeek: number, courseWeeks: number[] = []) {
  if (text === '' || /^(?:所有周次|全部周次|每周|全学期)$/u.test(text)) return { weeks: [] as number[], recognized: true };
  const from = /^从?第?\s*(\d+)\s*周(?:起|开始)$/u.exec(text);
  if (from !== null) {
    const start = Number(from[1]);
    const known = courseWeeks.length > 0 ? courseWeeks : Array.from({ length: Math.max(0, totalWeeks) }, (_, i) => i + 1);
    const weeks = known.filter((week) => week >= start);
    return { weeks, recognized: start >= 1 && start <= 30 && weeks.length > 0 };
  }
  if (/^(?:本周|这周|下周)$/u.test(text)) {
    const week = currentWeek + (text === '下周' ? 1 : 0);
    return currentWeek > 0 && week <= totalWeeks ? { weeks: [week], recognized: true } : { weeks: [], recognized: false };
  }
  return parseWeekNotation(text);
}

function buildChange(row: Record<string, unknown>, courses: Course[], totalWeeks: number, currentWeek = 0): BuildResult {
  const action = readAction(row.action);
  if (action === null) return structuralProblem('变更类型');
  const courseName = asText(row.courseName, MAX_NAME);
  const courseId = asCourseId(row.courseId);
  const weekday = asInt(row.weekday);
  const startSection = asInt(row.startSection);
  const endSection = asInt(row.endSection);
  const weekText = asText(row.weekText, MAX_WEEK_TEXT);
  const location = asText(row.location, MAX_LOCATION);
  const teacher = asText(row.teacher, MAX_NAME);
  const quote = asText(row.quote, MAX_QUOTE);

  const sectionsGiven = startSection > 0 || endSection > 0;
  const badSections = sectionsGiven
    && (startSection < 1 || endSection < startSection || endSection > SECTION_COUNT);

  // 结构校验：缺了这些字段就没法安全落库，整份提案作废（而不是悄悄少应用一条）。
  if (action !== 'add' && courseName === '' && courseId === '') return structuralProblem('课程名');
  if (action === 'cancel' && weekText === '') return structuralProblem('要停掉的周次');
  if (action === 'relocate' && location === '') return structuralProblem('新地点');
  if (action === 'move' && !sectionsGiven && weekday === 0) return structuralProblem('新的星期或节次');
  if (action === 'add' && courseName === '') return structuralProblem('课程名');
  if ((action === 'add' || action === 'move') && weekday !== 0 && (weekday < 1 || weekday > 7)) {
    return structuralProblem('有效的星期（1-7）');
  }
  if (action === 'add' && weekday < 1) return structuralProblem('星期');
  if (action === 'add' && !sectionsGiven) return structuralProblem('节次');
  if (badSections) return structuralProblem('有效节次');

  const located = action === 'add'
    ? { course: null as Course | null, problem: '' }
    : locate(courses, courseId, courseName, weekday, startSection, endSection);
  const current = located.course;
  let blocked = current === null ? located.problem : '';

  // 有限定范围时走服务端原子拆课；无法核实范围仍阻塞，不扩大为全学期。
  const limitedTime = /第\s*[\d一二三四五六七八九十两]+\s*周|(?:本|这|下|上)周|临时|这次|本次|今天|明天|后天|\d+\s*月\s*\d+\s*[日号]/u;
  let weeks: number[] = [];
  let weeksRecognized = true;
  if (action === 'add' || action === 'cancel') {
    if (weekText === '') {
      // 只有补课允许不写周次：留空＝每周（与手工表单一致）。
      weeks = [];
      weeksRecognized = true;
    } else {
      const parsed = parseWeekNotation(weekText);
      weeks = parsed.weeks;
      weeksRecognized = parsed.recognized;
      if (!parsed.recognized && action === 'cancel' && blocked === '') {
        blocked = '通知里的周次「' + weekText + '」系统没识别出来，没法只停某几周；请到课程里手动改。';
      }
    }
  }

  if (action === 'relocate' || action === 'move') {
    const scope = boundedWeeks(weekText, totalWeeks, currentWeek, current?.weeks);
    weeks = scope.weeks;
    weeksRecognized = scope.recognized;
    if (!scope.recognized || (weekText === '' && limitedTime.test(quote))) {
      blocked = '周次或临时范围还不明确，请补成“第12周”这类可核对的周次后重新识别。';
    } else if (weeks.length > 0 && current !== null) {
      const all = current.weeks.length > 0 ? current.weeks
        : totalWeeks > 0 ? Array.from({ length: totalWeeks }, (_, i) => i + 1) : [];
      if (!current.weeksRecognized || all.length === 0) blocked = '课程原周次未识别或学期总周数未知，请先核对周次。';
      else if (weeks.some((week) => !all.includes(week))) blocked = '指定周次中有这门课不上课的周，请先核对范围。';
    }
  }

  let remainingWeeks: number[] = [];
  if (action === 'cancel' && current !== null && blocked === '' && weeksRecognized) {
    const plan = remainingAfterCancel(current, weeks, totalWeeks);
    remainingWeeks = plan.remaining;
    blocked = plan.problem;
  }

  // 目标位置：改时间用模型给的新值，其余沿用当前值；补课必须有完整位置。
  const targetWeekday = action === 'relocate' && current !== null ? current.weekday : action === 'add'
    ? weekday
    : (weekday >= 1 && weekday <= 7 ? weekday : (current === null ? 0 : current.weekday));
  const targetRanges: SectionRange[] = action === 'add' || (action === 'move' && sectionsGiven)
    ? [{ start: startSection, end: endSection }]
    : (current === null ? [] : rangesOf(current));

  if (action === 'relocate' && current !== null && blocked === '' && current.location === location) {
    blocked = '这条与当前课表一致（地点本来就是「' + valueLabel(location) + '」），不用应用。';
  }
  if (action === 'move' && current !== null && blocked === '') {
    const nextStart = sectionsGiven ? startSection : current.startSection;
    const nextEnd = sectionsGiven ? endSection : current.endSection;
    if (targetWeekday === current.weekday && nextStart === current.startSection && nextEnd === current.endSection
      && (location === '' || location === current.location)) {
      blocked = '这条与当前课表一致（时间没变），不用应用。';
    }
  }

  // 冲突只对「新占一个时段」的动作算：补课与改时间。停课是腾出时段，改地点不动时间。
  let conflict = '';
  if (blocked === '' && (action === 'add' || action === 'move')) {
    const everyWeek = action === 'move' && weeks.length > 0 ? false : action === 'add'
      ? !weeksRecognized || weeks.length === 0
      : !current || !current.weeksRecognized || current.weeks.length === 0;
    const targetWeeks = action === 'add' || weeks.length > 0 ? weeks : (current === null ? [] : current.weeks);
    const skipId = action === 'move' && current !== null ? current.id : '';
    conflict = conflictText(findConflicts(courses, targetWeekday, targetRanges, targetWeeks, everyWeek, skipId));
  }

  const weekLabel = weekTextLabel(weekText);
  const dayShort = weekdayShort(targetWeekday);
  const title = ((): string => {
    if (action === 'cancel') {
      const when = sectionsGiven ? sectionText(startSection, endSection) : '全天';
      return ['停课', [weekLabel, dayShort + when].filter((part) => part !== '').join(' ')].filter((part) => part !== '').join(' · ');
    }
    if (action === 'relocate') return '改地点 · ' + (courseName === '' ? (current === null ? '' : current.name) : courseName);
    if (action === 'move') return '改时间 · ' + (courseName === '' ? (current === null ? '' : current.name) : courseName);
    return '补课 · ' + courseName;
  })();

  const diffs: NoticeDiff[] = [];
  const scoped = (action === 'move' || action === 'relocate') && weeks.length > 0;
  const scopeLabel = scoped ? `仅第 ${condenseWeeks(weeks)} 周` : '';
  let detail = '';
  if (action === 'cancel') {
    const removed = weeksRecognized ? '第 ' + condenseWeeks(weeks) + ' 周不上' : weekText + '不上';
    diffs.push({ lead: '', old: current === null ? '' : current.name, next: removed, note: '' });
    detail = current === null
      ? '写入：停掉这门课在 ' + weekText + ' 的课。'
      : '写入：把「' + current.name + '」第 ' + condenseWeeks(weeks) + ' 周去掉，剩余第 '
        + condenseWeeks(remainingWeeks) + ' 周。';
  } else if (action === 'relocate') {
    const before = current === null ? '' : current.location;
    diffs.push({ lead: '', old: before === '' ? '' : before, next: location, note: scoped ? scopeLabel : current === null ? weekLabel : courseWeekLabel(current) });
    detail = current === null
      ? '写入：把地点改成「' + location + '」。'
      : '写入：「' + current.name + '」地点 ' + valueLabel(before) + ' → ' + location + '。';
  } else if (action === 'move') {
    const nextStart = sectionsGiven ? startSection : (current === null ? 0 : current.startSection);
    const nextEnd = sectionsGiven ? endSection : (current === null ? 0 : current.endSection);
    if (current !== null) diffs.push({ lead: '', old: currentTimeText(current), next: timeText(targetWeekday, nextStart, nextEnd), note: scoped ? scopeLabel : courseWeekLabel(current) });
    else diffs.push({ lead: '', old: '', next: timeText(targetWeekday, nextStart, nextEnd), note: weekLabel });
    detail = current === null
      ? '写入：改成 ' + timeText(targetWeekday, nextStart, nextEnd) + '。'
      : '写入：「' + current.name + '」时间 ' + currentTimeText(current) + ' → ' + timeText(targetWeekday, nextStart, nextEnd) + '。';
    if (location !== '' && current !== null && location !== current.location) {
      diffs.push({ lead: '', old: current.location, next: location, note: scopeLabel });
      detail += `地点 ${valueLabel(current.location)} → ${location}。`;
    }
  } else {
    const place = [weekLabel, dayShort, sectionText(startSection, endSection), location]
      .filter((part) => part !== '')
      .join(' ');
    diffs.push({ lead: '新增', old: '', next: place, note: '' });
    detail = '写入：新增「' + courseName + '」' + place + '。';
  }

  const defaultChecked = blocked === '' && conflict === '';
  if (scoped) detail = `${scopeLabel}：${detail}其他周次保持原样。`;
  return {
    ok: true,
    change: {
      action,
      scopeLabel,
      unaffectedLabel: scoped ? '其他周次保持原时间、原地点；整项保存与撤销。' : '',
      original: scoped && current !== null ? snapshotInput(current) : null,
      title,
      diffs,
      quote,
      detail,
      weekText,
      weeks,
      weeksRecognized,
      remainingWeeks,
      weekday: targetWeekday,
      startSection: action === 'move' && !sectionsGiven ? 0 : startSection,
      endSection: action === 'move' && !sectionsGiven ? 0 : endSection,
      courseId: current === null ? courseId : current.id,
      courseName: current === null
        ? courseName
        : (courseName === '' ? current.name : courseName),
      location,
      teacher,
      conflict,
      blocked,
      defaultChecked,
    },
  };
}

function invalidOf(message: string): NoticeReply {
  return { kind: 'invalid', message };
}

/**
 * 通知识别的系统提示词：独立的纪律 + 四种 JSON 形态 + 当前周次 + 课表数据快照。
 * 复用 `buildTimetableText`，模型看到的课表与 06 助手完全同源（同一份 `[id:…]` 与「本周：上/不上」）。
 */
export function buildNoticePrompt(courses: Course[], semester: string, week: number, totalWeeks: number): string {
  return [
    '你是校园课表助手的「通知识别」模式：学生把一段班群或教务通知整段贴给你，你要找出其中所有需要落到课表上的变更。',
    '只依据这段通知原文和下面的「当前课表数据」；通知里没写的周次、节次、地点、教师一律留空（数字留 0），绝不自己补全或推测。',
    '课表数据每行开头的 [id:…] 是课程 id；能对上某门课时把 id 原样填进 courseId，对不上就留空，courseName 写通知里的课程名。',
    '一门课的一处变更写一条，不要把多门课合并成一条；通知里说「周三全天停课」涉及几门课就写几条。',
    '当前是第 ' + week + ' 周（周次可切换范围共 ' + totalWeeks + ' 周）。',
    '你的每次回复必须是**一个 JSON 对象**，四种形态之一：',
    '1. 有变更：{"kind":"changes","message":"一句话概述识别结果","changes":[{"action":"cancel 或 relocate 或 move 或 add","title":"给学生的短标题","quote":"通知里对应的原话，逐字摘录","courseName":"课程名","courseId":"能对上时填 id，否则留空","weekday":1到7,"startSection":1到12,"endSection":1到12且不小于 startSection,"weekText":"周次写法，如 第12周 / 1-16 / [2-6]周","location":"地点，通知没写就留空","teacher":"教师，通知没写就留空","conflict":"你发现同一时段已有课时写一句提示，否则留空"}]}；',
    '2. 没有变更：{"kind":"none","message":"说明这段通知里没有需要改课表的内容"}；',
    '3. 看不明白：{"kind":"clarify","message":"说明哪一处缺什么信息、需要学生补充什么"}；',
    '4. 超范围：{"kind":"out_of_scope","message":"说明这段内容不在课表能力范围内"}。',
    'action 的含义：cancel＝停课（weekText写被停掉的周次）；relocate＝改地点（location必填）；move＝改星期或节次，若同时改地点，把新地点一并写入location；add＝补课（课程名、星期、节次必填）。move和relocate的weekText必须保留通知限定的周次，支持第12周、12-13、从第11周起、本周、下周；原文没有周次时才留空表示整条课程。缺少可确定的周次要clarify，不猜。相同课程、相同周次的时间与地点调整合成一条move，不要拆成两条。',
    '纪律：quote 必须是通知原文里的逐字片段，不许改写；通知里没说的事一条都不要提；不要声称已经改好课表——你只是给出提案，学生逐条勾选并点「应用」之后才会写入；信息不足以下判断时用第 3 种形态追问，不要猜。冲突由系统按当前课表再核对一遍，你写的 conflict 只作参考。',
    '',
    '当前课表数据：',
    buildTimetableText(courses, semester, week),
  ].join('\n');
}

/**
 * 模型输出 → 类型化提案。严格解析：结构缺字段一律作废（`invalid`），
 * 语义对不上课表的（找不到课程、周次未识别、与现状一致）保留成 `blocked` 条目并默认不勾选。
 *
 * `totalWeeks` 只在「每周都上的课要停某一周」时需要（要先把每周展开成明确周次）；
 * 页面传可切换的周次总数即可，不传时这种变更会被标成阻塞而不是瞎写。
 */
export function parseNoticeReply(text: string, courses: Course[], totalWeeks = 0, currentWeek = 0): NoticeReply {
  const parsed = extractJson(text);
  if (parsed === null) {
    return invalidOf('助手回复没法解析，这次没有生成任何变更，也没有写入课表。请重试，或把通知拆成几段再试。');
  }
  const kind = typeof parsed.kind === 'string' ? parsed.kind.trim() : '';
  const message = asText(parsed.message, REPLY_MAX);
  if (kind === 'none') {
    return { kind: 'none', message: message === '' ? '这段通知里没有识别到需要改课表的内容。' : message };
  }
  if (kind === 'clarify') {
    return message === ''
      ? invalidOf('助手没说清哪里看不明白，请重试。')
      : { kind: 'clarify', message };
  }
  if (kind === 'out_of_scope') {
    return message === ''
      ? invalidOf('助手没有说明这段内容为什么不在能力范围，请重试。')
      : { kind: 'out_of_scope', message };
  }
  if (kind !== 'changes') {
    return invalidOf('助手回复不符合约定格式，这次没有生成任何变更。');
  }

  const raw = parsed.changes;
  if (!Array.isArray(raw)) return invalidOf('助手回复里没有变更列表，这次没有生成任何变更。');
  if (raw.length > MAX_CHANGES) {
    return invalidOf('这次识别到的变更太多（超过 ' + MAX_CHANGES + ' 处），请把通知拆成几段再来。');
  }
  const changes: NoticeChange[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return invalidOf('助手给出的第 ' + (index + 1) + ' 处变更格式不对，这次没有生成任何变更。');
    }
    const built = buildChange(item as Record<string, unknown>, courses, totalWeeks, currentWeek);
    if (!built.ok) {
      return invalidOf(
        '助手给出的第 ' + (index + 1) + ' 处变更缺少「' + built.problem + '」，这次没有生成任何变更。请重试或换个说法。',
      );
    }
    changes.push(built.change);
  }
  // 同课同周次的“改时间＋改地点”合并为一次原子操作；其他重复范围必须先澄清。
  for (let i = 0; i < changes.length; i += 1) {
    for (let j = i + 1; j < changes.length; j += 1) {
      const a = changes[i], b = changes[j];
      if (a.courseId === '' || a.courseId !== b.courseId || (!a.scopeLabel && !b.scopeLabel)) continue;
      if (a.blocked === '' && b.blocked === '' && a.weeks.join(',') === b.weeks.join(',')
        && ((a.action === 'move' && b.action === 'relocate' && (a.location === '' || a.location === b.location))
          || (a.action === 'relocate' && b.action === 'move' && (b.location === '' || b.location === a.location)))) {
        const move = a.action === 'move' ? a : b;
        const relocate = a.action === 'relocate' ? a : b;
        const combined = buildChange({ ...move, action: 'move', location: relocate.location,
          quote: [a.quote, b.quote].filter(Boolean).join('\n') }, courses, totalWeeks, currentWeek);
        if (combined.ok) { changes[i] = combined.change; changes.splice(j, 1); j -= 1; }
      } else {
        a.blocked = b.blocked = '同一门课包含不同范围或重复调整，请分段识别、逐次确认，避免覆盖。';
        a.defaultChecked = b.defaultChecked = false;
      }
    }
  }
  if (changes.length === 0) {
    return { kind: 'none', message: message === '' ? '这段通知里没有识别到需要改课表的内容。' : message };
  }
  return {
    kind: 'changes',
    message: message === '' ? '识别到 ' + changes.length + ' 处变更，请逐条核对后勾选。' : message,
    changes,
  };
}

/**
 * 勾选的提案 → 顺序执行的写入计划（纯函数，不碰云端）。
 *
 * 每条变更对应一次写入：停课/改地点/改时间 → update 一条已有课程；补课 → create 一条新记录。
 * 已被标成阻塞、或课程在解析之后又不见了（比如刚在别处删了）的条目直接跳过，交给页面如实报告。
 */
export function applyPlan(changes: NoticeChange[], courses: Course[], totalWeeks = 0): ApplyStep[] {
  const steps: ApplyStep[] = [];
  // 同一课程可能既停课又改地点；后一步必须继承前一步的字段与撤销快照。
  const working = new Map(courses.map((course) => [course.id, course]));
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change.blocked !== '') continue;
    if (change.action === 'add') {
      const proposed: ProposedCourse = {
        name: change.courseName,
        teacher: change.teacher,
        weekday: change.weekday,
        startSection: change.startSection,
        endSection: change.endSection,
        weekText: change.weekText,
        location: change.location,
      };
      steps.push({
        changeIndex: index,
        kind: 'create',
        courseId: '',
        input: buildChangeInput(proposed, null),
        before: null,
        summary: summarizeChange(proposed, 'add', null).text,
      });
      continue;
    }
    const current = working.get(change.courseId);
    if (current === undefined) continue;
    if ((change.action === 'move' || change.action === 'relocate') && change.weeks.length > 0) {
      const base = change.original === null || change.original === undefined ? current : { ...current, ...change.original };
      const proposed = { ...EMPTY_PROPOSED, weekday: change.action === 'move' ? change.weekday : 0,
        startSection: change.action === 'move' ? change.startSection : 0,
        endSection: change.action === 'move' ? change.endSection : 0,
        location: change.location, weekText: condenseWeeks(change.weeks) };
      steps.push({ changeIndex: index, kind: 'scoped', courseId: current.id,
        input: buildChangeInput(proposed, base), before: snapshotInput(base),
        summary: `${change.scopeLabel}：${change.detail}` });
      continue;
    }
    let proposed: ProposedCourse;
    if (change.action === 'cancel') {
      const plan = remainingAfterCancel(current, change.weeks, totalWeeks);
      if (plan.problem !== '') continue;
      // 只改周次三元组：其余字段由 buildChangeInput 从当前课程原样带过来。
      proposed = { ...EMPTY_PROPOSED, weekText: condenseWeeks(plan.remaining) };
    } else if (change.action === 'relocate') {
      proposed = { ...EMPTY_PROPOSED, location: change.location };
    } else {
      proposed = {
        ...EMPTY_PROPOSED,
        weekday: change.weekday,
        startSection: change.startSection,
        endSection: change.endSection,
        location: change.location,
      };
    }
    const input = buildChangeInput(proposed, current);
    steps.push({
      changeIndex: index,
      kind: 'update',
      courseId: current.id,
      input,
      before: snapshotInput(current),
      summary: summarizeChange(proposed, 'update', current).text,
    });
    working.set(current.id, { ...current, ...input });
  }
  return steps;
}

/** 已写入成功的一批变更 → 逆操作（倒序执行，先把最后一条还原），用于 10 秒内撤销。 */
export function invertPlan(applied: AppliedChange[]): InvertStep[] {
  const steps: InvertStep[] = [];
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const item = applied[index];
    if (item.kind === 'scoped') {
      steps.push({ kind: 'scoped', courseId: item.courseId, operationId: item.operationId,
        input: null, summary: '撤销这次限定周次的调课' });
      continue;
    }
    if (item.kind === 'create') {
      steps.push({ kind: 'delete', courseId: item.courseId, input: null, summary: '删除刚新增的这门课' });
      continue;
    }
    if (item.before === null) continue;
    steps.push({
      kind: 'update',
      courseId: item.courseId,
      input: item.before,
      summary: '还原「' + (item.before.name === '' ? '这门课' : item.before.name) + '」',
    });
  }
  return steps;
}
