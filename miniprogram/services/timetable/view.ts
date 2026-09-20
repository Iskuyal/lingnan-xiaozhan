/**
 * 周课表的纯视图计算：节次文案、周次文案、按周次与节次排布网格。
 *
 * 页面只做数据绑定，排布规则放在这里，便于用 node:test 直接验证（不依赖小程序运行时）。
 * 学校作息表尚未核实，样本只给节次，因此周课表**只按节次展示**，不出现任何具体时刻。
 */
import { Course, SectionRange } from './types';
import { condenseWeeks } from './weeks';
import { colorIndexFor, colorIndexFromKey } from './palette';

export const WEEKDAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
/** 大节行：真实样本的行标「一~六」，对应 1-2 … 11-12 节。 */
export const BIG_SECTION_LABELS = ['第 1-2 节', '第 3-4 节', '第 5-6 节', '第 7-8 节', '第 9-10 节', '第 11-12 节'];
/** 周次切换的默认跨度：样本最大 19 周，留到 20 周便于查看全学期。 */
export const DEFAULT_WEEK_SPAN = 20;

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? '';
}

/** 节次文案：`第 1-2 节、第 3-4 节`；无有效节次时说明待补全。 */
export function formatSectionText(ranges: SectionRange[]): string {
  return ranges
    .map((range) => (range.start === range.end ? `第 ${range.start} 节` : `第 ${range.start}-${range.end} 节`))
    .join('、');
}

interface SectionLike {
  sectionRanges: SectionRange[];
  startSection: number;
  endSection: number;
}

/** 节次展示：有效区间优先；原文倒置或越界时显示原文并标注待核对，不擅自修复。 */
export function sectionLabelOf(course: SectionLike): string {
  if (course.sectionRanges.length > 0) return formatSectionText(course.sectionRanges);
  if (course.startSection > 0) return `原文 ${course.startSection}-${course.endSection} 节（待核对）`;
  return '节次待核对';
}

interface WeekLike {
  weeks: number[];
  weeksRecognized: boolean;
  weekText: string;
}

/** 周次展示：识别出的按压缩写法；未识别的保留原文并标注待核对。 */
export function weekLabelOf(course: WeekLike): string {
  if (course.weeksRecognized) {
    if (course.weeks.length === 0) return '每周';
    return `第 ${condenseWeeks(course.weeks)} 周`;
  }
  return course.weekText === '' ? '周次待核对' : `原文 ${course.weekText}（待核对）`;
}

/**
 * 某门课是否出现在指定教学周：
 * - 已识别且列出周次：按周次判断；
 * - 已识别但未列周次（学生填了「每周」）：每周都出现；
 * - 未识别：无法判断，按每周展示并保留待核对标记，学生的原文不会被丢掉。
 */
export function occursInWeek(course: WeekLike, week: number): boolean {
  if (!course.weeksRecognized || course.weeks.length === 0) return true;
  return course.weeks.includes(week);
}

/** 周次切换范围：数据里最大的教学周与 20 周取大者。 */
export function weekSpan(courses: WeekLike[]): number {
  let max = 0;
  for (const course of courses) {
    if (!course.weeksRecognized) continue;
    for (const week of course.weeks) {
      if (week > max) max = week;
    }
  }
  return Math.max(DEFAULT_WEEK_SPAN, max);
}

export interface CourseCard {
  id: string;
  name: string;
  teacher: string;
  location: string;
  campus: string;
  siteNumber: string;
  note: string;
  sectionLabel: string;
  weekLabel: string;
  needsReview: boolean;
  warningText: string;
  source: 'excel' | 'manual' | 'photo';
}

export function toCard(course: Course): CourseCard {
  return {
    id: course.id,
    name: course.name,
    teacher: course.teacher,
    location: course.location,
    campus: course.campus,
    siteNumber: course.siteNumber,
    note: course.note,
    sectionLabel: sectionLabelOf(course),
    weekLabel: weekLabelOf(course),
    needsReview: course.warnings.length > 0,
    warningText: course.warnings.join('；'),
    source: course.source,
  };
}

export interface WeekCell {
  weekday: number;
  label: string;
  items: CourseCard[];
}

export interface WeekRow {
  index: number;
  sectionLabel: string;
  cells: WeekCell[];
}

export interface WeekDay {
  weekday: number;
  label: string;
  items: CourseCard[];
}

export interface WeekView {
  week: number;
  weekLabel: string;
  rows: WeekRow[];
  days: WeekDay[];
  /** 本周课程数（同一门课只算一次）。 */
  total: number;
}

/** 本周课程：按星期、首个节次、课程名排序，同一门课只出现一次。 */
export function coursesForWeek(courses: Course[], week: number): Course[] {
  return courses
    .filter((course) => occursInWeek(course, week))
    .sort((a, b) => a.weekday - b.weekday
      || (a.sectionRanges[0]?.start ?? 99) - (b.sectionRanges[0]?.start ?? 99)
      || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 组装某一教学周的网格与按天列表；课程按节次落进对应的大节行。 */
export function buildWeekView(courses: Course[], week: number): WeekView {
  const rows: WeekRow[] = BIG_SECTION_LABELS.map((sectionLabel, index) => ({
    index: index + 1,
    sectionLabel,
    cells: WEEKDAY_LABELS.map((label, cellIndex) => ({ weekday: cellIndex + 1, label, items: [] as CourseCard[] })),
  }));
  const days: WeekDay[] = WEEKDAY_LABELS.map((label, index) => ({ weekday: index + 1, label, items: [] as CourseCard[] }));
  const inWeek = coursesForWeek(courses, week);
  for (const course of inWeek) {
    days[course.weekday - 1].items.push(toCard(course));
    const card = toCard(course);
    for (const range of course.sectionRanges) {
      const firstRow = Math.ceil(range.start / 2);
      const lastRow = Math.ceil(range.end / 2);
      for (let row = firstRow; row <= lastRow; row += 1) {
        const target = rows[row - 1]?.cells[course.weekday - 1];
        if (target === undefined) continue;
        if (!target.items.some((item) => item.id === card.id)) target.items.push(card);
      }
    }
  }
  for (const row of rows) {
    for (const cell of row.cells) {
      cell.items.sort((a, b) => a.sectionLabel.localeCompare(b.sectionLabel, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
  }
  return {
    week,
    weekLabel: `第 ${week} 周`,
    rows,
    days: days.filter((day) => day.items.length > 0),
    total: inWeek.length,
  };
}

/** 学期展示文案：未标注时明确写出来，不猜学期。 */
export function semesterLabel(semester: string): string {
  return semester === '' ? '未标注学期' : semester;
}

/**
 * 保存前的硬性检查：课程名、星期、节次缺一不可（周次允许待核对，原文会保留）。
 * 返回空字符串表示这条课程可以保存。
 */
export function blockingReason(course: { name: string; weekday: number; sectionRanges: SectionRange[] }): string {
  if (course.name.trim() === '') return '缺少课程名，请修正或删除';
  if (course.weekday < 1 || course.weekday > 7) return '星期未识别，请修正或删除';
  if (course.sectionRanges.length === 0) return '节次待补全，请修正或删除';
  return '';
}

/** 保存时间格式化；空值或非法值返回空字符串，页面据此隐藏该行。 */
export function formatUpdatedAt(iso: string): string {
  if (iso === '') return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 周网格排布（设计图 01 的尺寸依据）。规则见 docs/design/timetable/README.md 的「版式规则」1–4：
 *
 * 1. **列宽自适应**：有课的天均分剩余宽度，没课的天收窄（`narrow`）。7 列均分在 390px 屏上只有
 *    41px，课名两行就折行，这是本版最关键的取舍。
 * 2. **课块按高度分级给信息**：≥3 节给名称+地点+教师，2 节给名称+地点，1 节只给名称。
 * 3. **同格多门折叠**：节次完全相同的课折叠成一块并带门数角标；只**部分**重叠的走泳道并排，
 *    不折叠也不互相压住。
 * 4. **不擅自修复**：节次越界或倒置（`sectionRanges` 为空）的课画不出来，但仍算进本周课程数。
 *
 * 时间相关的推导（今天是第几周、本周几号、当前节次）**不在这里**：那些要学期设置与作息时间，
 * 由页面算好后经 `GridOptions` 传进来，因此本函数保持纯函数、可直接用 node:test 验证。
 */
export const SECTION_COUNT = 12;

export interface GridBlock {
  /** 同格多门课时是全部课程 id，第一项是代表课。 */
  ids: string[];
  primaryId: string;
  name: string;
  colorIndex: number;
  start: number;
  end: number;
  span: number;
  /** 信息层级：≥3 节给名称+地点+教师，2 节给名称+地点，1 节只给名称。 */
  tier: 'full' | 'medium' | 'name';
  meta: string;
  teacher: string;
  needsReview: boolean;
  /** 同格门数，>1 时画角标。 */
  count: number;
  /** 部分重叠时的并排泳道；laneCount > 1 时块宽按泳道分。 */
  lane: number;
  laneCount: number;
  /** 正在上（页面按作息算出当前节次后传入）。 */
  now: boolean;
}

export interface GridColumn {
  weekday: number;
  label: string;
  /** 表头日期数字（没设开学日时为空字符串）。 */
  dateLabel: string;
  /** 本周没课的天收窄，把宽度让给有课的天。 */
  narrow: boolean;
  today: boolean;
  blocks: GridBlock[];
}

export interface GridLayout {
  week: number;
  weekLabel: string;
  rows: number;
  columns: GridColumn[];
  /** 本周有课的天（1-7）。 */
  hasCourseWeekdays: number[];
  /** 本周课程数（与列表口径一致，画不出节次的也算）。 */
  total: number;
  /** 真正落到网格上的课程数。 */
  placed: number;
}

export interface GridOptions {
  /** 本周 7 天的日期文案，由学期设置算出；缺省或缺项时表头不显示日期。 */
  dateLabels?: string[];
  /** 今天对应的星期（1-7）；缺省时不高亮任何列。 */
  todayWeekday?: number;
  /** 当前节次（1-12）；只有页面确认「显示的就是本周」时才传。 */
  nowSection?: number;
}

/** 能画进网格的节次区间：必须落在 1-12 节内且不倒置。不修原文，画不出来就是画不出来。 */
function placeableRanges(course: Course): SectionRange[] {
  return course.sectionRanges.filter((range) => range.start >= 1 && range.end <= SECTION_COUNT && range.start <= range.end);
}

/** 同一天、节次完全相同的课合成一个候选块；只有部分重叠的各自保留，交给泳道。 */
interface Candidate {
  start: number;
  end: number;
  members: Course[];
}

function collectCandidates(weekCourses: Course[]): Candidate[][] {
  const byDay: Candidate[][] = WEEKDAY_LABELS.map(() => []);
  for (const course of weekCourses) {
    if (course.weekday < 1 || course.weekday > 7) continue;
    for (const range of placeableRanges(course)) {
      const day = byDay[course.weekday - 1];
      const merged = day.find((item) => item.start === range.start && item.end === range.end);
      if (merged === undefined) day.push({ start: range.start, end: range.end, members: [course] });
      else merged.members.push(course);
    }
  }
  return byDay;
}

/** 贪心分泳道：同一段时间互相重叠的块并排，互不重叠的各自占满整列。 */
function assignLanes(candidates: Candidate[]): { candidate: Candidate; lane: number; laneCount: number }[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed: { candidate: Candidate; lane: number; laneCount: number }[] = [];
  let cluster: Candidate[] = [];
  let clusterEnd = 0;
  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assigned: { candidate: Candidate; lane: number }[] = [];
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end < item.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      assigned.push({ candidate: item, lane });
    }
    for (const item of assigned) placed.push({ ...item, laneCount: laneEnds.length });
    cluster = [];
    clusterEnd = 0;
  };
  for (const item of sorted) {
    if (cluster.length > 0 && item.start > clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return placed;
}

/** 课程颜色：显式指定优先，否则按课程名。显式字段还没进类型契约，这里按可选字段读取。 */
function colorIndexOf(course: Course): number {
  const explicit = colorIndexFromKey((course as Course & { color?: string }).color ?? '');
  return explicit >= 0 ? explicit : colorIndexFor(course.name);
}

function tierFor(span: number): GridBlock['tier'] {
  if (span >= 3) return 'full';
  if (span === 2) return 'medium';
  return 'name';
}

export function buildGrid(courses: Course[], week: number, options: GridOptions = {}): GridLayout {
  const inWeek = coursesForWeek(courses, week);
  const dateLabels = options.dateLabels ?? [];
  const byDay = collectCandidates(inWeek);

  const columns: GridColumn[] = WEEKDAY_LABELS.map((label, index) => {
    const weekday = index + 1;
    const laid = assignLanes(byDay[index]);
    const blocks: GridBlock[] = laid.map(({ candidate, lane, laneCount }) => {
      const primary = candidate.members[0];
      const start = candidate.start;
      const end = candidate.end;
      const span = end - start + 1;
      const tier = tierFor(span);
      return {
        ids: candidate.members.map((member) => member.id),
        primaryId: primary.id,
        name: primary.name,
        colorIndex: colorIndexOf(primary),
        start,
        end,
        span,
        tier,
        meta: tier === 'name' ? '' : primary.location,
        teacher: tier === 'full' ? primary.teacher : '',
        needsReview: candidate.members.some((member) => member.warnings.length > 0),
        count: candidate.members.length,
        lane,
        laneCount,
        now: options.nowSection !== undefined && options.nowSection >= start && options.nowSection <= end,
      };
    }).sort((a, b) => a.start - b.start || a.lane - b.lane);
    return {
      weekday,
      label,
      dateLabel: dateLabels[index] ?? '',
      narrow: blocks.length === 0,
      today: options.todayWeekday === weekday,
      blocks,
    };
  });

  const placedIds = new Set<string>();
  for (const day of byDay) for (const candidate of day) for (const member of candidate.members) placedIds.add(member.id);

  return {
    week,
    weekLabel: `第 ${week} 周`,
    rows: SECTION_COUNT,
    columns,
    hasCourseWeekdays: columns.filter((column) => column.blocks.length > 0).map((column) => column.weekday),
    total: inWeek.length,
    placed: placedIds.size,
  };
}
