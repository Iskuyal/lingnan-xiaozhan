/**
 * 课程记录的规范化与校验（云函数侧）。
 *
 * 导入草稿与手工录入走同一套校验：**不合格的整批不写**，避免把半成品写进数据库。
 * 学生自己确认过的记录允许带 warnings（例如周次写法未识别、原文保留），
 * 但课程名、星期、节次必须有确定值，否则无法在周课表里定位。
 */
import * as crypto from 'crypto';
import { COURSE_COLOR_KEYS, CourseFields, SectionRange, MAX_SECTION, MAX_WEEK } from './types';

const LIMITS = {
  name: 60,
  credits: 10,
  teacher: 40,
  location: 80,
  campus: 20,
  siteNumber: 12,
  note: 60,
  weekText: 40,
  rawText: 300,
  warning: 100,
  maxWarnings: 12,
} as const;

export type NormalizedCourse = { ok: true; value: CourseFields } | { ok: false; error: string };

function text(value: unknown, label: string, max: number, required = false): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return required ? { ok: false, error: `缺少${label}` } : { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false, error: `${label}必须是文本` };
  const trimmed = value.trim();
  if (required && trimmed === '') return { ok: false, error: `${label}不能为空` };
  if (trimmed.length > max) return { ok: false, error: `${label}超过 ${max} 字` };
  return { ok: true, value: trimmed };
}

function integerInRange(value: unknown, label: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, error: `${label}必须是 ${min}-${max} 之间的整数` };
  }
  return { ok: true, value: parsed };
}

/**
 * 课程色：只接受 8 个合法 key 或空。
 *
 * 不合法时**归为空而不是报错**：颜色是纯装饰字段，旧数据里的拼写错误不该让整条课程存不进去；
 * 归空即「按课程名自动取色」，与小程序侧 `palette.ts` 的静默回落同一口径。
 */
function colorKey(value: unknown): string {
  return typeof value === 'string' && (COURSE_COLOR_KEYS as readonly string[]).includes(value) ? value : '';
}

/** 校验并规范化一条课程（导入草稿或手工录入）。失败时不返回任何半成品字段。 */
export function normalizeCourseFields(input: unknown): NormalizedCourse {
  if (input === null || typeof input !== 'object') return { ok: false, error: '课程数据格式不正确' };
  const source = input as Record<string, unknown>;

  const name = text(source.name, '课程名', LIMITS.name, true);
  if (!name.ok) return name;
  const credits = text(source.credits, '学分', LIMITS.credits);
  if (!credits.ok) return credits;
  const teacher = text(source.teacher, '教师', LIMITS.teacher);
  if (!teacher.ok) return teacher;
  const location = text(source.location, '上课地点', LIMITS.location);
  if (!location.ok) return location;
  const campus = text(source.campus, '校区', LIMITS.campus);
  if (!campus.ok) return campus;
  const siteNumber = text(source.siteNumber, '场地编号', LIMITS.siteNumber);
  if (!siteNumber.ok) return siteNumber;
  const note = text(source.note, '备注', LIMITS.note);
  if (!note.ok) return note;
  const weekText = text(source.weekText, '周次原文', LIMITS.weekText);
  if (!weekText.ok) return weekText;
  const rawText = text(source.rawText, '原文', LIMITS.rawText);
  if (!rawText.ok) return rawText;

  const weekday = integerInRange(source.weekday, '星期', 1, 7);
  if (!weekday.ok) return weekday;

  if (!Array.isArray(source.sectionRanges) || source.sectionRanges.length === 0) {
    return { ok: false, error: '缺少节次，请先补全节次再保存' };
  }
  const sectionRanges: SectionRange[] = [];
  for (const raw of source.sectionRanges) {
    if (raw === null || typeof raw !== 'object') return { ok: false, error: '节次格式不正确' };
    const range = raw as Record<string, unknown>;
    const start = integerInRange(range.start, '起始节', 1, MAX_SECTION);
    if (!start.ok) return start;
    const end = integerInRange(range.end, '结束节', 1, MAX_SECTION);
    if (!end.ok) return end;
    if (end.value < start.value) return { ok: false, error: '结束节不能小于起始节' };
    sectionRanges.push({ start: start.value, end: end.value });
  }

  const weeks: number[] = [];
  if (source.weeks !== undefined && source.weeks !== null) {
    if (!Array.isArray(source.weeks)) return { ok: false, error: '周次格式不正确' };
    for (const raw of source.weeks) {
      const week = integerInRange(raw, '周次', 1, MAX_WEEK);
      if (!week.ok) return week;
      weeks.push(week.value);
    }
  }
  const weeksRecognized = source.weeksRecognized === true;

  const warnings: string[] = [];
  if (source.warnings !== undefined && source.warnings !== null) {
    if (!Array.isArray(source.warnings)) return { ok: false, error: '待核对提示格式不正确' };
    for (const raw of source.warnings.slice(0, LIMITS.maxWarnings)) {
      if (typeof raw !== 'string') return { ok: false, error: '待核对提示格式不正确' };
      const trimmed = raw.trim();
      if (trimmed !== '') warnings.push(trimmed.slice(0, LIMITS.warning));
    }
  }

  const kind: 'manual' | 'excel' | 'photo' =
    source.source === 'manual' ? 'manual' : source.source === 'photo' ? 'photo' : 'excel';
  const first = sectionRanges[0];
  return {
    ok: true,
    value: {
      name: name.value,
      credits: credits.value,
      teacher: teacher.value,
      weekday: weekday.value,
      startSection: first.start,
      endSection: sectionRanges.reduce((max, range) => Math.max(max, range.end), first.end),
      sectionRanges,
      // 未识别的周次保留原文、不填周次；「每周」也用它表示（weeksRecognized 为 true 且 weeks 为空）。
      weeks: weeksRecognized ? [...new Set(weeks)].sort((a, b) => a - b) : [],
      weeksRecognized,
      weekText: weekText.value,
      location: location.value,
      campus: campus.value,
      siteNumber: siteNumber.value,
      note: note.value,
      warnings,
      source: kind,
      color: colorKey(source.color),
    },
  };
}

/** 记录 id：客户端用它定位课程，因此要短且不可猜。 */
export function makeCourseId(): string {
  return `tc_${crypto.randomBytes(8).toString('hex')}`;
}

/** 学期标注：来自文件元信息或当前课表，长度受限，空值允许（页面会显示「未标注学期」）。 */
export function sanitizeSemester(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 40);
}
