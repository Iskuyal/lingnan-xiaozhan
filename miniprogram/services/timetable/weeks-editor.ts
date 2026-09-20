/**
 * 周次编辑器（课程新增 / 修改页，设计图 06）的纯函数层。
 *
 * **为什么要有这一层**：起止周、单双周快捷、自选网格是**同一份周次的三种改法**，
 * 谁改都要落回同一份集合，而这份集合又是最终保存进数据库的 `weeks`。
 * 把「显示状态 → 周次集合」的换算收在这里，页面只负责把事件转发进来、把结果画出去。
 *
 * 三条纪律：
 * 1. **不猜**。起止倒置、越界（教学周是 1-30，与 `weeks.ts` / 云函数一致）、非整数一律
 *    返回空集合并给出可判定的标记（`rangeInvalid`），不钳、不修、不抛异常。
 * 2. **不丢原文**。编辑器只产出「合并写法」（`condenseWeeks`），原始文本的去留由页面决定；
 *    本模块不回写任何原文。
 * 3. **不动没动过的周次**。`editorFromWeeks` 出来的状态里 `weeks` 就是记录里的周次：
 *    即使它不是一段连续区间（如 4-5、7-10），也不按显示参数重算；只有用户真的改了
 *    （`dirty`）才按新参数重算。这条不变量是「打开课程不动编辑器、保存后周次不变」的依据。
 *
 * 与「自选网格」的关系：网格固定 1-20 格（设计图 06 的画法），单/双周按这 20 周展开；
 * 起止周的上限仍是教学周上限 30（导入的课表里出现过 19 周，将来也可能更长）。
 * 网格之外、30 周以内的周次由数据保留在集合里，只是网格上没有格子可点。
 */
import { condenseWeeks, MAX_WEEK } from './weeks';

/** 教学周下限（与 weeks.ts、云函数 MAX_WEEK 的区间一致）。 */
export const MIN_WEEK = 1;
/** 自选网格的格数：设计图 06 画的是 1-20 周。 */
export const WEEK_GRID_SIZE = 20;
/** 单双周与全学期的默认跨度（20 周）。 */
export const DEFAULT_SPAN = WEEK_GRID_SIZE;

export type WeekParity = 'odd' | 'even';
/** 快捷改法：全学期 / 单周 / 双周 / 自选（自选 = 手填的起止周或逐格勾选）。 */
export type WeeksMode = 'all' | 'odd' | 'even' | 'custom';

export interface WeeksEditorState {
  /** 起止周的起始（输入框里的值）；null 表示没填。 */
  start: number | null;
  /** 起止周的结束；null 表示没填。 */
  end: number | null;
  mode: WeeksMode;
  /** 生效的教学周（已去重排序）；空数组表示「每周」。 */
  weeks: number[];
  /** 用户是否改过。false 时 weeks 就是记录里的原集合，不按参数重算。 */
  dirty: boolean;
  /** 起止周填得不完整或起止倒置（填过才为 true），页面据此出琥珀提示。 */
  rangeInvalid: boolean;
}

export interface WeeksGridCell {
  week: number;
  on: boolean;
  /** 在起止周区间之外（设计图 06 的淡显格：区间内未勾选是普通态，区间外才是淡的）。 */
  outside: boolean;
}

export interface WeeksModePill {
  key: WeeksMode;
  label: string;
  on: boolean;
}

/** 快捷 pill 的文案与顺序（设计图 06）。 */
export const WEEKS_MODES: { key: WeeksMode; label: string }[] = [
  { key: 'all', label: '全学期' },
  { key: 'odd', label: '单周' },
  { key: 'even', label: '双周' },
  { key: 'custom', label: '自选' },
];

/** 合法的教学周：1-30 的整数。 */
function isWeek(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_WEEK && value <= MAX_WEEK;
}

/** 跨度：只接受 0-MAX_WEEK 的整数，缺省给 20 周。 */
function spanOf(span: unknown): number {
  if (typeof span !== 'number' || !Number.isInteger(span) || span < 0) return DEFAULT_SPAN;
  return Math.min(span, MAX_WEEK);
}

/** 起止周是否可用：两个 1-30 的整数且起始不大于结束。 */
export function isValidRange(start: unknown, end: unknown): boolean {
  return isWeek(start) && isWeek(end) && start <= end;
}

/** 起止周 → 周次数组；倒置、越界、非整数一律空数组（不钳、不抛）。 */
export function weeksFromRange(start: unknown, end: unknown): number[] {
  if (!isValidRange(start, end)) return [];
  const weeks: number[] = [];
  for (let week = start as number; week <= (end as number); week += 1) weeks.push(week);
  return weeks;
}

/** 单周（1、3、5…）或双周（2、4、6…）；跨度默认 20 周。 */
export function weeksByParity(parity: WeekParity, span: number = DEFAULT_SPAN): number[] {
  const size = spanOf(span);
  const first = parity === 'odd' ? 1 : 2;
  const weeks: number[] = [];
  for (let week = first; week <= size; week += 2) weeks.push(week);
  return weeks;
}

/** 全学期：1 到 span 周（默认 20）。 */
export function weeksAll(span: number = DEFAULT_SPAN): number[] {
  return weeksFromRange(1, spanOf(span));
}

/** 规整任意输入：丢掉非整数与越界值，去重并升序。 */
export function normalizeWeeks(weeks: readonly unknown[]): number[] {
  const list = Array.isArray(weeks) ? weeks : [];
  const seen = new Set<number>();
  for (const week of list) {
    if (isWeek(week)) seen.add(week);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 自选网格勾一格：已勾的取消、未勾的加上；越界格子不动集合。 */
export function toggleWeek(weeks: readonly unknown[], week: unknown): number[] {
  const current = normalizeWeeks(weeks);
  if (!isWeek(week)) return current;
  return current.includes(week) ? current.filter((item) => item !== week) : normalizeWeeks([...current, week]);
}

function sameWeeks(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((week, index) => week === right[index]);
}

/** 从已有周次反推显示状态：起止周取最小 / 最大，整份单双周与全学期认出来，其余是自选。 */
export function editorFromWeeks(weeks: readonly unknown[], span: number = DEFAULT_SPAN): WeeksEditorState {
  const normalized = normalizeWeeks(weeks);
  const start = normalized.length > 0 ? normalized[0] : null;
  const end = normalized.length > 0 ? normalized[normalized.length - 1] : null;
  let mode: WeeksMode = 'custom';
  if (normalized.length > 0) {
    if (sameWeeks(normalized, weeksAll(span))) mode = 'all';
    else if (sameWeeks(normalized, weeksByParity('odd', span))) mode = 'odd';
    else if (sameWeeks(normalized, weeksByParity('even', span))) mode = 'even';
  }
  return { start, end, mode, weeks: normalized, dirty: false, rangeInvalid: false };
}

/** 切换快捷改法。`custom` 只是「接下来手改」，保留已选、不算改动。 */
export function setMode(state: WeeksEditorState, mode: WeeksMode, span: number = DEFAULT_SPAN): WeeksEditorState {
  if (mode === 'custom') return { ...state, mode: 'custom' };
  const weeks = mode === 'all' ? weeksAll(span) : weeksByParity(mode === 'odd' ? 'odd' : 'even', span);
  return {
    start: weeks.length > 0 ? weeks[0] : null,
    end: weeks.length > 0 ? weeks[weeks.length - 1] : null,
    mode,
    weeks,
    dirty: true,
    rangeInvalid: false,
  };
}

/** 起止周（两个输入框）改动：按区间重算。填得不完整或倒置时按空集处理并标记。 */
export function setRange(state: WeeksEditorState, start: unknown, end: unknown): WeeksEditorState {
  const filled = isWeek(start) || isWeek(end);
  return {
    start: isWeek(start) ? start : null,
    end: isWeek(end) ? end : null,
    mode: 'custom',
    weeks: weeksFromRange(start, end),
    dirty: true,
    rangeInvalid: filled && !isValidRange(start, end),
  };
}

/** 自选网格勾一格：在已选之上增删，起止周跟着变成最小 / 最大。 */
export function toggleGridWeek(state: WeeksEditorState, week: unknown, span: number = DEFAULT_SPAN): WeeksEditorState {
  const weeks = toggleWeek(state.weeks, week);
  return {
    start: weeks.length > 0 ? weeks[0] : null,
    end: weeks.length > 0 ? weeks[weeks.length - 1] : null,
    mode: 'custom',
    weeks,
    dirty: true,
    rangeInvalid: false,
  };
}

/** 清空自选：保存后按「每周」显示（与手工表单「周次留空表示每周」一致）。 */
export function clearGrid(state: WeeksEditorState): WeeksEditorState {
  return { start: null, end: null, mode: 'custom', weeks: [], dirty: true, rangeInvalid: false };
}

/** 自选网格的格子（1-span 周），供模板逐格画勾选态与「区间外」的淡显。 */
export function gridCells(state: WeeksEditorState, span: number = DEFAULT_SPAN): WeeksGridCell[] {
  const selected = new Set(state.weeks);
  const hasRange = state.start !== null && state.end !== null;
  return weeksAll(span).map((week) => ({
    week,
    on: selected.has(week),
    outside: hasRange && (week < (state.start as number) || week > (state.end as number)),
  }));
}

/** 快捷 pill 的选中态（设计图 06 的 4 个 pill）。 */
export function modePills(state: WeeksEditorState): WeeksModePill[] {
  return WEEKS_MODES.map((mode) => ({ key: mode.key, label: mode.label, on: state.mode === mode.key }));
}

/** 合并写法（顿号分隔）：`[4,5,7,8]` → `4-5、7-8`；空集是空文本（对应「每周」）。 */
export function weeksTextOf(state: WeeksEditorState): string {
  return condenseWeeks(state.weeks);
}
