/**
 * 周课表的纯视图计算：节次文案、周次文案、按周次与节次排布网格。
 *
 * 页面只做数据绑定，排布规则放在这里，便于用 node:test 直接验证（不依赖小程序运行时）。
 * 学校作息表尚未核实，样本只给节次，因此周课表**只按节次展示**，不出现任何具体时刻。
 */
import { Course, SectionRange } from './types';
import { condenseWeeks } from './weeks';

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
  weekdayText: string;
  credits: string;
  needsReview: boolean;
  warningText: string;
  source: 'excel' | 'manual' | 'photo';
  /** 网格底色：按整周课程顺序交替分配，同一门连排课跨大节行保持同色。 */
  tint: 'red' | 'gold';
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
    weekdayText: weekdayLabel(course.weekday),
    credits: course.credits,
    needsReview: course.warnings.length > 0,
    warningText: course.warnings.join('；'),
    source: course.source,
    tint: 'red',
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

export interface WeekView {
  week: number;
  weekLabel: string;
  rows: WeekRow[];
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

/** 组装某一教学周的网格；课程按节次落进对应的大节行。 */
export function buildWeekView(courses: Course[], week: number): WeekView {
  const rows: WeekRow[] = BIG_SECTION_LABELS.map((sectionLabel, index) => ({
    index: index + 1,
    sectionLabel,
    cells: WEEKDAY_LABELS.map((label, cellIndex) => ({ weekday: cellIndex + 1, label, items: [] as CourseCard[] })),
  }));
  const inWeek = coursesForWeek(courses, week);
  const tintOf = new Map<string, CourseCard['tint']>();
  inWeek.forEach((course, index) => {
    tintOf.set(course.id, index % 2 === 0 ? 'red' : 'gold');
  });
  for (const course of inWeek) {
    const card: CourseCard = { ...toCard(course), tint: tintOf.get(course.id) ?? 'red' };
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
