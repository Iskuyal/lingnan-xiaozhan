/**
 * 课程表单到提交数据的转换（手工新增与修改共用）。
 *
 * 表单只暴露学生能确定的字段：课程名、教师、地点、学分、星期、起止节、周次。
 * 校区、场地编号、备注、原文这些来自导入的字段在编辑时原样保留，不在表单里让用户重填。
 * 校验失败时返回错误文案，页面直接展示，不做静默修正。
 */
import { Course, CourseInput, DraftCourse, SectionRange } from './types';
import { condenseWeeks, parseWeekNotation } from './weeks';

export interface CourseForm {
  name: string;
  teacher: string;
  location: string;
  credits: string;
  /** 选择器下标：0 对应星期一。 */
  weekdayIndex: number;
  /** 选择器下标：0 对应第 1 节。 */
  startIndex: number;
  endIndex: number;
  /** 周次输入，如 `1-16`、`2-6,8-17`；留空表示每周。 */
  weeksText: string;
}

/** 表单之外的字段：来自导入或上一次保存，编辑时原样保留。 */
export interface CourseExtras {
  campus: string;
  siteNumber: string;
  note: string;
  rawText: string;
  warnings: string[];
  source: 'excel' | 'manual';
}

export interface CourseFormSource {
  name: string;
  teacher: string;
  location: string;
  credits: string;
  weekday: number;
  startSection: number;
  endSection: number;
  sectionRanges: SectionRange[];
  weeks: number[];
  weeksRecognized: boolean;
  weekText: string;
  campus: string;
  siteNumber: string;
  note: string;
  rawText: string;
  warnings: string[];
  source: 'excel' | 'manual';
}

export const EMPTY_FORM: CourseForm = {
  name: '',
  teacher: '',
  location: '',
  credits: '',
  weekdayIndex: 0,
  startIndex: 0,
  endIndex: 1,
  weeksText: '',
};

/** 周次提示类警告：编辑周次后由本模块重新生成，不保留旧的那条。 */
const WEEK_WARNING = /周次/u;

export function extrasOf(source: CourseFormSource): CourseExtras {
  return {
    campus: source.campus,
    siteNumber: source.siteNumber,
    note: source.note,
    rawText: source.rawText,
    warnings: source.warnings.filter((warning) => !WEEK_WARNING.test(warning)),
    source: source.source,
  };
}

/** 已保存课程或导入草稿 → 表单初值。 */
export function formOf(source: CourseFormSource): CourseForm {
  const first = source.sectionRanges[0];
  const start = first?.start ?? (source.startSection > 0 ? source.startSection : 1);
  const end = first?.end ?? (source.endSection >= start ? source.endSection : start + 1);
  return {
    name: source.name,
    teacher: source.teacher,
    location: source.location,
    credits: source.credits,
    weekdayIndex: Math.min(Math.max(source.weekday - 1, 0), 6),
    startIndex: Math.min(Math.max(start - 1, 0), 11),
    endIndex: Math.min(Math.max(end - 1, 0), 11),
    weeksText: source.weeksRecognized ? condenseWeeks(source.weeks) : source.weekText,
  };
}

export function formFromCourse(course: Course): { form: CourseForm; extras: CourseExtras } {
  return { form: formOf(course), extras: extrasOf(course) };
}

export function formFromDraft(course: DraftCourse): { form: CourseForm; extras: CourseExtras } {
  return { form: formOf(course), extras: extrasOf(course) };
}

/** 新增课程的空表单（可带默认星期下标）。 */
export function emptyForm(weekdayIndex = 0): CourseForm {
  return { ...EMPTY_FORM, weekdayIndex };
}

export type FormBuildResult = { ok: true; value: CourseInput } | { ok: false; error: string };

/**
 * 表单 → 提交数据。周次留空表示每周；写得不认识时保留原文并标记待核对，
 * 与导入解析的纪律一致（识别不出的只标记不猜）。
 */
export function buildCourseInput(form: CourseForm, extras: CourseExtras): FormBuildResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, error: '请填写课程名' };
  const weekday = form.weekdayIndex + 1;
  if (weekday < 1 || weekday > 7) return { ok: false, error: '请选择星期' };
  const start = form.startIndex + 1;
  const end = form.endIndex + 1;
  if (start < 1 || start > 12 || end < 1 || end > 12) return { ok: false, error: '节次需要在第 1-12 节之间' };
  if (end < start) return { ok: false, error: '结束节不能小于起始节' };

  const weeksText = form.weeksText.trim();
  const warnings = [...extras.warnings];
  let weeks: number[] = [];
  let weeksRecognized = true;
  let weekText = '';
  if (weeksText !== '') {
    const parsed = parseWeekNotation(weeksText);
    weekText = weeksText;
    if (parsed.recognized) {
      weeks = parsed.weeks;
    } else {
      weeksRecognized = false;
      warnings.push(`周次写法未能识别（原文：${weeksText}），已保留原文；该课程会在每个教学周显示并标注待核对`);
    }
  }

  return {
    ok: true,
    value: {
      name,
      credits: form.credits.trim(),
      teacher: form.teacher.trim(),
      weekday,
      startSection: start,
      endSection: end,
      sectionRanges: [{ start, end }],
      weeks,
      weeksRecognized,
      weekText,
      location: form.location.trim(),
      campus: extras.campus,
      siteNumber: extras.siteNumber,
      note: extras.note,
      warnings,
      source: extras.source,
    },
  };
}

/** 把编辑结果写回导入草稿：原文与来源位置保留，不改动。 */
export function draftFromInput(course: DraftCourse, input: CourseInput): DraftCourse {
  return {
    ...course,
    ...input,
    source: 'excel',
    rawText: course.rawText,
    sourceRowLabel: course.sourceRowLabel,
    sourceWeekdayLabel: course.sourceWeekdayLabel,
  };
}
