/**
 * 课表 AI 助手的纯逻辑（Ticket 06）：课表数据组装、系统提示纪律、回复解析与变更合并。
 *
 * 纪律（docs/development-spec.md「AI 功能」与 Ticket 06）：
 * - 查阅只依据当前课表数据，数据里没有的绝不编造；
 * - 任何增改都只是「方案」——页面必须弹确认框（当前值 → 变更后），学生确认后才调用 03 的写入入口；
 * - 指代不清时模型先澄清，不猜测后直接给方案；超范围问题不强行作答；
 * - 模型回复只认四种 JSON 形态，解析失败一律回退为普通消息，绝不当成变更执行。
 *
 * 变更字段的语义（Ticket 06 两轴复核修复）：`ProposedCourse` 里的空字符串 / 0 表示
 * **这次没有指定**这个字段——新增时按空值落库，修改时由 `buildChangeInput` 从当前课程
 * 原样带过来。只有模型在这次变更里真正给出的字段才会被覆盖，未指定不清空、不改来源。
 */
import { extractJson } from '../ai';
import { Course, CourseInput, SectionRange } from './types';
import { condenseWeeks, parseWeekNotation } from './weeks';
import { occursInWeek, sectionLabelOf, weekLabelOf, weekdayLabel } from './view';
import { extrasOf } from './form';

/** 回复文本展示上限（防御性截断，正常回复远小于此）。 */
const REPLY_MAX = 4000;

/** 模型显式写「每周」时的写法；等价于留空（新增＝每周，修改＝改成每周）。 */
const EVERY_WEEK_TEXT = /^(每周|全周|每周都上)$/u;

/**
 * 只支持「新增」与「修改」两种变更动作；删除或未知动作一律按「不在能力范围」如实告知，
 * 绝不执行写入，也绝不把模型的说法当成已执行。
 */
export const UNSUPPORTED_ACTION_MESSAGE = '这个操作不在我的能力范围内：我只能帮你查阅、新增和修改课程，这次不会执行任何改动。删除课程请在课表列表里点「删除」。';

/** 模型提出的课程变更字段；空字符串 / 0 表示这次没有指定（修改时保留当前值）。 */
export interface ProposedCourse {
  name: string;
  teacher: string;
  weekday: number;
  startSection: number;
  endSection: number;
  weekText: string;
  location: string;
}

export type AssistantReply =
  | { kind: 'query'; message: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'out_of_scope'; message: string }
  | { kind: 'change'; action: 'add' | 'update'; courseId: string; course: ProposedCourse }
  | { kind: 'invalid'; message: string };

function courseLine(course: Course, week: number): string {
  const parts = [
    course.name,
    weekdayLabel(course.weekday),
    sectionLabelOf(course),
    weekLabelOf(course),
    course.teacher === '' ? '' : '教师：' + course.teacher,
    course.location === '' ? '' : '地点：' + course.location,
  ].filter((part) => part !== '');
  // id 必须带进提示词：update 方案要求模型原样回填 `courseId`，页面又拒绝未知 id，
  // 提示词里没有 id 时修改分支永远走不通（两轴复核修复）。
  // 末尾按当前周标注，让「这周有几门课」这类问题不必靠模型自己数周次。
  return '- [id:' + course.id + '] ' + parts.join(' | ')
    + ' | 本周：' + (occursInWeek(course, week) ? '上' : '不上');
}

/** 当前课表数据的文字快照（随每次提问送进提示词，让回答有据可依）；按当前教学周标注。 */
export function buildTimetableText(courses: Course[], semester: string, week: number): string {
  const head = semester === '' ? '当前没有学期标注。' : '当前学期：' + semester + '。';
  if (courses.length === 0) return head + ' 当前还没有保存任何课程。';
  return head + '\n' + courses.map((course) => courseLine(course, week)).join('\n');
}

/**
 * 系统提示词：纪律 + 四种 JSON 形态 + 当前周次 + 当前课表数据快照。
 *
 * `week` 是页面当前选中的教学周，`totalWeeks` 是页面可切换的周次总数；
 * 两者都写进提示词，模型不必猜「这周」是哪一周。
 */
export function buildSystemPrompt(courses: Course[], semester: string, week: number, totalWeeks: number): string {
  return [
    '你是校园课表助手，帮助学生查阅和增改「我的课表」。',
    '只能依据下面「当前课表数据」回答；数据里没有的内容不要猜测，明确说「课表里没有查到」。',
    '当前是第 ' + week + ' 周（周次可切换范围共 ' + totalWeeks + ' 周）；每行末尾的「本周：上/不上」已按当前周算好，回答「这周有几门课」这类问题时以它为准。',
    '你的每次回复必须是**一个 JSON 对象**，四种形态之一：',
    '1. 查阅：{"kind":"query","message":"给学生的回答"}——只依据课表数据作答；',
    '2. 澄清：{"kind":"clarify","message":"需要追问的问题"}——指代不清（哪门课/哪一天/哪个节次）或信息不足时先追问，绝不猜测后直接给方案；',
    '3. 变更方案：{"kind":"change","action":"add"或"update","courseId":"仅 update 时给要改的课程 id，取自课表数据每行开头的 [id:…]，原样照抄","course":{"name":"课程名","teacher":"教师，可为空","weekday":1到7,"startSection":1到12,"endSection":1到12且不小于 startSection,"weekText":"周次写法如 1-16 或 [2-6,8-17]周；新增时留空表示每周，修改时留空表示不改周次，要改成每周请写「每周」","location":"地点，可为空"},"message":"给学生的方案说明"}——只提出方案，绝不声称已经改好，学生确认后才生效。update 时**只填这次真正要改的字段，没提到的字段留空字符串（数字留 0）**，系统会保留原值，不要为了填满而改动其它字段；',
    '4. 超范围：{"kind":"out_of_scope","message":"说明不在能力范围"}——问成绩、选课、放假等课表以外的问题时这样回答。',
    '纪律：数据里没有的课程或字段绝不编造；周次写法保持原样；变更方案的课程字段必须来自学生的原话或课表数据，不能自己补。你只能提出「新增」与「修改」两种变更——学生要求删除课程时用第 4 种形态说明删除不在能力范围，并请他在课表列表里操作，绝不提出删除方案、绝不声称已经删除。',
    '',
    '当前课表数据：',
    buildTimetableText(courses, semester, week),
  ].join('\n');
}

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

/**
 * 课程 id 取值：模型可能把提示词里的 `[id:tc_…]` 连壳抄回来，
 * 这里剥掉方括号与 `id:` 前缀，只留标识本身（不猜、不拼造 id）。
 */
function asCourseId(value: unknown): string {
  const text = asText(value, 80);
  return text
    .replace(/^[\[［]\s*id\s*[:：]\s*/iu, '')
    .replace(/[\]］]$/u, '')
    .trim()
    .slice(0, 64);
}

/** 变更方案本身是否成立；返回空字符串表示通过。 */
function proposedProblem(action: 'add' | 'update', course: ProposedCourse): string {
  const sectionsGiven = course.startSection > 0 || course.endSection > 0;
  if (action === 'add') {
    if (course.name === '') return '助手给出的变更缺少课程名，请换个说法补充。';
    if (course.weekday < 1 || course.weekday > 7) return '助手给出的变更缺少星期，请换个说法补充。';
    if (!sectionsGiven || course.startSection < 1 || course.endSection < course.startSection || course.endSection > 12) {
      return '助手给出的变更缺少有效节次，请换个说法补充。';
    }
    return '';
  }
  const specified = course.name !== '' || course.weekday > 0 || sectionsGiven
    || course.teacher !== '' || course.weekText !== '' || course.location !== '';
  if (!specified) return '助手没有说明要改什么，请补充要修改的字段。';
  if (course.weekday > 7) return '助手给出的星期不合法，请换个说法补充。';
  if (sectionsGiven && (course.startSection < 1 || course.endSection < course.startSection || course.endSection > 12)) {
    return '助手给出的节次不完整或不合法，请换个说法补充。';
  }
  return '';
}

/** 模型输出 → 类型化回复。变更方案经严格校验，非法一律回退 invalid，绝不当成变更。 */
export function parseAssistantReply(text: string): AssistantReply {
  const parsed = extractJson(text);
  if (parsed === null) {
    return { kind: 'invalid', message: '助手回复无法解析，请重试或换个说法。' };
  }
  const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
  const message = asText(parsed.message, REPLY_MAX);
  if (kind === 'query' || kind === 'clarify' || kind === 'out_of_scope') {
    if (message === '') return { kind: 'invalid', message: '助手回复缺少内容，请重试。' };
    return { kind, message };
  }
  if (kind === 'change') {
    // 只认「新增」「修改」两种动作：delete 等未知值一律按能力范围外处理，
    // 绝不落进 add 分支变成一个没人要的新增（两轴复核修复）。
    const rawAction = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    if (rawAction !== 'add' && rawAction !== 'update') {
      return { kind: 'out_of_scope', message: UNSUPPORTED_ACTION_MESSAGE };
    }
    const action = rawAction;
    const courseId = asCourseId(parsed.courseId);
    const raw = parsed.course;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { kind: 'invalid', message: '助手给出的变更不符合格式，请换个说法。' };
    }
    const row = raw as Record<string, unknown>;
    const course: ProposedCourse = {
      name: asText(row.name, 60),
      teacher: asText(row.teacher, 40),
      weekday: asInt(row.weekday),
      startSection: asInt(row.startSection),
      endSection: asInt(row.endSection),
      weekText: asText(row.weekText, 40),
      location: asText(row.location, 80),
    };
    const problem = proposedProblem(action, course);
    if (problem !== '') return { kind: 'invalid', message: problem };
    if (action === 'update' && courseId === '') {
      return { kind: 'invalid', message: '助手没有说明要改哪门课，请指明课程名。' };
    }
    return { kind: 'change', action, courseId, course };
  }
  return { kind: 'invalid', message: message === '' ? '助手回复无法解析，请重试或换个说法。' : message };
}

/** 周次文本 → 落库用的周次三元组；空文本与「每周」都表示每周。 */
function weeksFromText(text: string): { weeks: number[]; weeksRecognized: boolean; weekText: string; warning: string } {
  const trimmed = text.trim();
  if (trimmed === '' || EVERY_WEEK_TEXT.test(trimmed)) {
    // 与手工表单同一口径：weeks 为空 + weeksRecognized=true 表示「每周」。
    return { weeks: [], weeksRecognized: true, weekText: '', warning: '' };
  }
  const parsed = parseWeekNotation(trimmed);
  if (parsed.recognized) {
    return { weeks: parsed.weeks, weeksRecognized: true, weekText: trimmed, warning: '' };
  }
  return {
    weeks: [],
    weeksRecognized: false,
    weekText: trimmed,
    warning: '周次写法未能识别（原文：' + trimmed + '），已保留原文，请核对',
  };
}

/** 周次展示文案：留空或「每周」→ 每周；识别出的压缩显示；不认识保留原文并标注待核对。 */
function proposedWeekLabel(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '' || EVERY_WEEK_TEXT.test(trimmed)) return '每周';
  const parsed = parseWeekNotation(trimmed);
  return parsed.recognized ? '第 ' + condenseWeeks(parsed.weeks) + ' 周' : '原文 ' + trimmed + '（待核对）';
}

function sectionRangeLabel(start: number, end: number): string {
  if (start < 1 || end < start) return '节次待核对';
  return start === end ? '第 ' + start + ' 节' : '第 ' + start + '-' + end + ' 节';
}

function timeLabel(weekday: number, start: number, end: number): string {
  const day = weekdayLabel(weekday);
  const section = sectionRangeLabel(start, end);
  return day === '' ? section : day + ' ' + section;
}

/** 已保存课程的展示口径（可能与新增方案的单段写法不同：多段节次、待核对原文都原样呈现）。 */
function courseTimeLabel(course: Course): string {
  const day = weekdayLabel(course.weekday);
  const section = sectionLabelOf(course);
  return day === '' ? section : day + ' ' + section;
}

function valueLabel(value: string): string {
  return value === '' ? '（空）' : value;
}

/**
 * 变更方案 → 03 的提交数据。
 *
 * - 不传 `current`（新增）：空字段按空值落库，周次留空按每周，来源为 `manual`；
 * - 传 `current`（修改）：读取当前课程，**只应用这次真正指定的字段**，其余（教师、地点、
 *   学分、校区、场地编号、备注、周次、来源、待核对提示）原样保留。未指定周次时连
 *   `weeks / weeksRecognized / weekText` 三元组一起保留；改周次时旧的周次类提示被替换。
 */
export function buildChangeInput(course: ProposedCourse, current?: Course | null): CourseInput {
  const base = current === undefined || current === null ? null : current;
  const name = course.name !== '' ? course.name : (base === null ? '' : base.name);
  const teacher = course.teacher !== '' ? course.teacher : (base === null ? '' : base.teacher);
  const location = course.location !== '' ? course.location : (base === null ? '' : base.location);
  const weekday = course.weekday >= 1 ? course.weekday : (base === null ? 0 : base.weekday);

  let sectionRanges: SectionRange[];
  let startSection: number;
  let endSection: number;
  if (course.startSection >= 1 && course.endSection >= course.startSection) {
    startSection = course.startSection;
    endSection = course.endSection;
    sectionRanges = [{ start: startSection, end: endSection }];
  } else if (base === null) {
    startSection = 0;
    endSection = 0;
    sectionRanges = [];
  } else {
    startSection = base.startSection;
    endSection = base.endSection;
    // 节次没被指定就原样保留，包括多段节次；不静默「修正」待核对的课程。
    sectionRanges = base.sectionRanges.map((range) => ({ start: range.start, end: range.end }));
  }

  let weeks: number[];
  let weeksRecognized: boolean;
  let weekText: string;
  let warnings: string[];
  if (course.weekText.trim() === '') {
    // 未指定周次：新增按每周（与手工表单一致），修改保留原值与原提示。
    weeks = base === null ? [] : base.weeks;
    weeksRecognized = base === null ? true : base.weeksRecognized;
    weekText = base === null ? '' : base.weekText;
    warnings = base === null ? [] : [...base.warnings];
  } else {
    const parsed = weeksFromText(course.weekText);
    weeks = parsed.weeks;
    weeksRecognized = parsed.weeksRecognized;
    weekText = parsed.weekText;
    // 改了周次就重算周次类提示：旧的周次提示不再适用，其余提示原样保留（与手工表单 extrasOf 同口径）。
    const extras = base === null ? null : extrasOf(base);
    warnings = extras === null ? [] : [...extras.warnings];
    if (parsed.warning !== '') warnings.push(parsed.warning);
  }

  return {
    name,
    credits: base === null ? '' : base.credits,
    teacher,
    weekday,
    startSection,
    endSection,
    sectionRanges,
    weeks,
    weeksRecognized,
    weekText,
    location,
    campus: base === null ? '' : base.campus,
    siteNumber: base === null ? '' : base.siteNumber,
    note: base === null ? '' : base.note,
    warnings,
    source: base === null ? 'manual' : base.source,
  };
}

export interface ChangeSummary {
  /** 逐条变更文案（修改时是「当前值 → 变更后」）；没有实际变化时为空数组。 */
  lines: string[];
  /** 是否有实际改动：修改时用于拦截「和现在一模一样」的方案，不弹确认、不写库。 */
  changed: boolean;
  /** 确认框内容。 */
  text: string;
}

/**
 * 变更方案的展示摘要。
 *
 * 修改时只列**会被改动**的字段，每条写成「当前值 → 变更后」；没有变化的字段不展示
 * （也不会被清空，见 `buildChangeInput`）。新增时列出课程名、时间、周次与给出的教师/地点。
 */
export function summarizeChange(course: ProposedCourse, action: 'add' | 'update', current?: Course | null): ChangeSummary {
  const base = current === undefined || current === null ? null : current;
  if (action === 'add' || base === null) {
    const lines = [
      (action === 'add' ? '新增课程：' : '修改课程：') + (course.name === '' ? '（未指定课程名）' : course.name),
      timeLabel(course.weekday, course.startSection, course.endSection),
      '周次：' + proposedWeekLabel(course.weekText),
      course.teacher === '' ? '' : '教师：' + course.teacher,
      course.location === '' ? '' : '地点：' + course.location,
    ].filter((line) => line !== '');
    return { lines, changed: true, text: lines.join('\n') };
  }

  const lines: string[] = [];
  if (course.name !== '' && course.name !== base.name) {
    lines.push('课程名：' + base.name + ' → ' + course.name);
  }
  const sectionsGiven = course.startSection >= 1;
  const nextWeekday = course.weekday >= 1 ? course.weekday : base.weekday;
  const beforeTime = courseTimeLabel(base);
  const afterTime = sectionsGiven
    ? timeLabel(nextWeekday, course.startSection, course.endSection)
    : courseTimeLabel({ ...base, weekday: nextWeekday });
  if (beforeTime !== afterTime) lines.push('时间：' + beforeTime + ' → ' + afterTime);
  if (course.weekText.trim() !== '') {
    const beforeWeek = weekLabelOf(base);
    const afterWeek = proposedWeekLabel(course.weekText);
    if (beforeWeek !== afterWeek) lines.push('周次：' + beforeWeek + ' → ' + afterWeek);
  }
  if (course.teacher !== '' && course.teacher !== base.teacher) {
    lines.push('教师：' + valueLabel(base.teacher) + ' → ' + course.teacher);
  }
  if (course.location !== '' && course.location !== base.location) {
    lines.push('地点：' + valueLabel(base.location) + ' → ' + course.location);
  }
  if (lines.length === 0) {
    return { lines, changed: false, text: '这次改动与当前课表一致，没有需要修改的内容。' };
  }
  // 只改列出的字段，其余字段原样保留——把这件事在确认框里说清楚，避免学生担心「确认=整条覆盖」。
  return { lines, changed: true, text: lines.join('\n') + '\n其余字段保持不变。' };
}

/** 确认框文案（`summarizeChange` 的文本形式，便于单独测试与复用）。 */
export function describeChange(course: ProposedCourse, action: 'add' | 'update', current?: Course | null): string {
  return summarizeChange(course, action, current).text;
}
