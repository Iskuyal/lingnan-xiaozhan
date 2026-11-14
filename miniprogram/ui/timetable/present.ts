/**
 * 岭南红课表页的展示层（B 维护，设计图 02 / 51 / 67 / 71）。
 *
 * 领域排布仍在 `services/timetable/view.ts`（只读）：这里只把它的 `GridLayout` / 课程
 * 投影成设计稿的几何量（74px 星期列、56px/节、节次轴在滚动区之外），并算好
 * 日视图的时刻文案。页面只做数据绑定，模板里不做算术。
 *
 * 两条与业务无关、但必须守住的规则：
 * 1. **3–8 节只是紧凑窗口，不是数据范围**：当前周只要有 1–2 或 9–12 节的课，
 *    紧凑窗口自动扩到覆盖它们；「看完整 12 节」始终给出 1–12。
 * 2. **时刻只来自用户填写的作息**：`sectionTimeAt` 返回 null 时只显示节次，
 *    不补 `--:--`，也不从别处推断。
 */
import { Course, SectionRange } from '../../services/timetable/types';
import { GridLayout, WEEKDAY_SHORT, coursesForWeek, sectionLabelOf, weekdayLabel } from '../../services/timetable/view';
import { TimetableSettings, sectionTimeAt } from '../../services/timetable/settings';
import { weekDateFullLabels, weekDateLabels } from '../../services/timetable/semester';

/** 设计稿 02/51 的尺寸：7 列 × 74px、节次轴 36px、每个大节（两小节）112px。 */
export const WEEK_COLUMN_PX = 74;
export const WEEK_AXIS_PX = 36;
export const WEEK_ROW_PX = 112;
export const WEEK_SECTION_PX = WEEK_ROW_PX / 2;
/** 课块之间留 4px，避免相邻两块的圆角贴在一起。 */
const BLOCK_GAP_PX = 4;
/** 紧凑窗口的样例范围：3–8 节；有早晚课时按实际覆盖扩。 */
const COMPACT_START = 3;
const COMPACT_END = 8;

export interface PresentedBlock {
  ids: string[];
  primaryId: string;
  name: string;
  meta: string;
  teacher: string;
  tier: 'full' | 'medium' | 'name';
  count: number;
  solid: string;
  tint: string;
  lineColor: string;
  topPx: number;
  heightPx: number;
  laneLeftPercent: number;
  laneWidthPercent: number;
  changed: boolean;
  flag: string;
  now: boolean;
}

export interface PresentedColumn {
  weekday: number;
  shortLabel: string;
  dateLabel: string;
  today: boolean;
  blocks: PresentedBlock[];
}

export interface PresentedAxisRow {
  label: string;
  heightPx: number;
  start: number;
  end: number;
}

export interface PresentedGrid {
  columns: PresentedColumn[];
  axisRows: PresentedAxisRow[];
  widthPx: number;
  gridHeightPx: number;
  headerPx: number;
  axisWidthPx: number;
  windowStart: number;
  windowEnd: number;
  expanded: boolean;
  canExpand: boolean;
  compactLabel: string;
  fullLabel: string;
  /** 网格加上表头后的总高度：scroll-view 必须有确定高度。 */
  totalHeightPx: number;
}

function occupiedBounds(grid: GridLayout): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const column of grid.columns) {
    for (const block of column.blocks) {
      if (min === 0 || block.start < min) min = block.start;
      if (block.end > max) max = block.end;
    }
  }
  return { min, max };
}

function oddFloor(value: number): number {
  const number = Math.floor(value);
  return number % 2 === 0 ? Math.max(1, number - 1) : number;
}

function evenCeil(value: number): number {
  const number = Math.ceil(value);
  return number % 2 === 0 ? number : Math.min(12, number + 1);
}

/** 紧凑窗口：3–8 打底，向早晚课扩到覆盖实际存在的节次；绝不把实际课程留在窗口外。 */
export function compactWindow(grid: GridLayout): { start: number; end: number } {
  const { min, max } = occupiedBounds(grid);
  const start = min > 0 ? Math.min(COMPACT_START, oddFloor(min)) : COMPACT_START;
  const end = max > 0 ? Math.max(COMPACT_END, evenCeil(max)) : COMPACT_END;
  return { start, end: Math.min(12, end) };
}

function axisRows(start: number, end: number): PresentedAxisRow[] {
  const rows: PresentedAxisRow[] = [];
  for (let section = start; section <= end; section += 2) {
    const last = Math.min(end, section + 1);
    rows.push({
      label: last === section ? `${section}` : `${section}–${last}`,
      heightPx: WEEK_ROW_PX,
      start: section,
      end: last,
    });
  }
  return rows;
}

/**
 * `highlightIds` 是本页面刚写入/撤销的目标课程：块上给一个独立标记，不用颜色暗示
 * （设计图 71 的「本次调整」）。同格多门时只要有一门被标就标整块，点开仍能逐门核对。
 */
export function presentWeekGrid(grid: GridLayout, options: {
  expanded?: boolean;
  highlightIds?: string[];
} = {}): PresentedGrid {
  const expanded = options.expanded === true;
  const highlight = new Set(options.highlightIds ?? []);
  const window = expanded ? { start: 1, end: 12 } : compactWindow(grid);
  const rows = axisRows(window.start, window.end);
  const columns: PresentedColumn[] = grid.columns.map((column) => ({
    weekday: column.weekday,
    shortLabel: column.shortLabel,
    dateLabel: column.dateLabel,
    today: column.today,
    blocks: column.blocks
      .filter((block) => block.end >= window.start && block.start <= window.end)
      .map((block) => {
        const start = Math.max(block.start, window.start);
        const end = Math.min(block.end, window.end);
        const changed = block.ids.some((id) => highlight.has(id));
        return {
          ids: block.ids,
          primaryId: block.primaryId,
          name: block.name,
          meta: block.meta,
          teacher: block.teacher,
          tier: block.tier,
          count: block.count,
          solid: block.solid,
          tint: block.tint,
          lineColor: block.lineColor,
          topPx: (start - window.start) * WEEK_SECTION_PX,
          heightPx: (end - start + 1) * WEEK_SECTION_PX - BLOCK_GAP_PX,
          laneLeftPercent: block.laneLeftPercent,
          laneWidthPercent: block.laneWidthPercent,
          changed,
          flag: changed ? '本次调整' : '',
          now: block.now,
        };
      }),
  }));
  const gridHeightPx = (window.end - window.start + 1) * WEEK_SECTION_PX;
  return {
    columns,
    axisRows: rows,
    widthPx: 7 * WEEK_COLUMN_PX,
    gridHeightPx,
    headerPx: 44,
    axisWidthPx: WEEK_AXIS_PX,
    windowStart: window.start,
    windowEnd: window.end,
    expanded,
    canExpand: window.start > 1 || window.end < 12,
    compactLabel: `第 ${window.start}–${window.end} 节`,
    fullLabel: '第 1–12 节',
    totalHeightPx: 44 + gridHeightPx,
  };
}

/** 目标星期横向定位：让周五这类靠后的列进入可视区；值会夹在 0..最大滚动量。 */
export function scrollLeftForWeekday(weekday: number, viewportPx = 300): number {
  const max = Math.max(0, 7 * WEEK_COLUMN_PX - Math.max(1, viewportPx));
  const raw = Math.max(0, (weekday - 1) * WEEK_COLUMN_PX - 8);
  return Math.min(raw, max);
}

export interface AgendaRow {
  key: string;
  courseId: string;
  name: string;
  /** 来自用户作息的「10:10 – 11:45」；未填时为空字符串，只显示节次。 */
  timeLabel: string;
  sectionLabel: string;
  /** 该段起始节，仅用于排序，不直接展示。 */
  start: number;
  location: string;
  teacher: string;
  solid: string;
  changed: boolean;
}

export interface DayView {
  weekday: number;
  label: string;
  shortLabel: string;
  dateLabel: string;
  today: boolean;
  rows: AgendaRow[];
  emptyText: string;
  timeHint: string;
}

export interface DayChip {
  weekday: number;
  label: string;
  dateLabel: string;
  today: boolean;
  hasCourse: boolean;
}

function rangesOf(course: Course): SectionRange[] {
  if (course.sectionRanges.length > 0) return course.sectionRanges;
  if (course.startSection >= 1) return [{ start: course.startSection, end: course.endSection }];
  return [];
}

/** 作息时刻：起止两节都填了才显示，否则空字符串（不编造钟点）。 */
function timeLabelOf(settings: TimetableSettings, range: SectionRange): string {
  const from = sectionTimeAt(settings, range.start);
  const to = sectionTimeAt(settings, range.end);
  if (from === null || to === null) return '';
  return `${from.start} – ${to.end}`;
}

export function presentDayChips(courses: Course[], week: number, settings: TimetableSettings, todayWeekday: number): DayChip[] {
  const labels = weekDateLabels({ startDate: settings.startDate, totalWeeks: settings.totalWeeks }, week);
  const inWeek = coursesForWeek(courses, week);
  return WEEKDAY_SHORT.map((short, index) => ({
    weekday: index + 1,
    label: `周${short}`,
    dateLabel: labels[index] ?? '',
    today: todayWeekday === index + 1,
    hasCourse: inWeek.some((course) => course.weekday === index + 1),
  }));
}

/** 某一天的安排：时间取自用户作息，节次始终给出；空白天给出明确空态而不是空白。 */
export function presentDayView(
  courses: Course[],
  week: number,
  weekday: number,
  settings: TimetableSettings,
  options: { highlightIds?: string[]; todayWeekday?: number } = {},
): DayView {
  const highlight = new Set(options.highlightIds ?? []);
  const labels = weekDateLabels({ startDate: settings.startDate, totalWeeks: settings.totalWeeks }, week);
  const inWeek = coursesForWeek(courses, week);
  const rows: AgendaRow[] = [];
  for (const course of inWeek) {
    if (course.weekday !== weekday) continue;
    const ranges = rangesOf(course);
    if (ranges.length === 0) {
      rows.push({
        key: `${course.id}:0`,
        courseId: course.id,
        name: course.name,
        timeLabel: '',
        sectionLabel: sectionLabelOf(course),
        start: 0,
        location: course.location,
        teacher: course.teacher,
        solid: '',
        changed: highlight.has(course.id),
      });
      continue;
    }
    for (const range of ranges) {
      rows.push({
        key: `${course.id}:${range.start}`,
        courseId: course.id,
        name: course.name,
        timeLabel: timeLabelOf(settings, range),
        sectionLabel: range.start === range.end ? `第 ${range.start} 节` : `第 ${range.start}-${range.end} 节`,
        start: range.start,
        location: course.location,
        teacher: course.teacher,
        solid: '',
        changed: highlight.has(course.id),
      });
    }
  }
  rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const label = weekdayLabel(weekday);
  return {
    weekday,
    label: label === '' ? '未选择日期' : label,
    shortLabel: weekday >= 1 && weekday <= 7 ? `周${WEEKDAY_SHORT[weekday - 1]}` : '',
    dateLabel: labels[weekday - 1] ?? '',
    today: options.todayWeekday === weekday,
    rows,
    emptyText: inWeek.length === 0 ? '本周没有安排课程' : '这一天没有安排课程',
    timeHint: rows.some((row) => row.timeLabel !== '')
      ? '具体时刻来自你填写的作息。'
      : '还没填这些节次的作息，只显示节次。',
  };
}

/** 详情弹层用的「11月20日 · 星期五」；没有学期设置时只写星期。 */
export function dateTextOf(settings: TimetableSettings, week: number, weekday: number): string {
  const labels = weekDateFullLabels({ startDate: settings.startDate, totalWeeks: settings.totalWeeks }, week);
  const full = labels[weekday - 1] ?? '';
  const label = weekdayLabel(weekday);
  if (full === '') return label;
  const parts = full.split('-');
  return `${Number(parts[1])}月${Number(parts[2])}日 · ${label}`;
}
