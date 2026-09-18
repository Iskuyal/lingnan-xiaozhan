/**
 * 课表 AI 助手的纯逻辑（Ticket 06）：课表数据组装、系统提示纪律、回复解析与变更校验。
 *
 * 纪律（docs/development-spec.md「AI 功能」与 Ticket 06）：
 * - 查阅只依据当前课表数据，数据里没有的绝不编造；
 * - 任何增改都只是「方案」——页面必须弹确认框，学生确认后才调用 03 的写入入口；
 * - 指代不清时模型先澄清，不猜测后直接给方案；超范围问题不强行作答；
 * - 模型回复只认四种 JSON 形态，解析失败一律回退为普通消息，绝不当成变更执行。
 */
import { Course, CourseInput } from './types';
import { parseWeekNotation } from './weeks';
import { sectionLabelOf, weekLabelOf, weekdayLabel } from './view';
import { extractJson } from './photo';

/** 多轮历史上限（与 ai 云函数 MAX_MESSAGES=20 一致，与 07 同口径）。 */
export const MAX_HISTORY = 20;

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 模型提出的结构化课程（变更方案专用；入库前还要过 buildChangeInput 与确认框）。 */
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
  | { kind: 'change'; action: 'add' | 'update'; courseId: string; course: ProposedCourse; message: string }
  | { kind: 'invalid'; message: string };

/** 回复文本展示上限（防御性截断，正常回复远小于此）。 */
const REPLY_MAX = 4000;

function courseLine(course: Course): string {
  const parts = [
    course.name,
    weekdayLabel(course.weekday),
    sectionLabelOf(course),
    weekLabelOf(course),
    course.teacher === '' ? '' : '教师：' + course.teacher,
    course.location === '' ? '' : '地点：' + course.location,
  ].filter((part) => part !== '');
  return '- ' + parts.join(' | ');
}

/** 当前课表数据的文字快照（随每次提问送进提示词，让回答有据可依）。 */
export function buildTimetableText(courses: Course[], semester: string): string {
  const head = semester === '' ? '当前没有学期标注。' : '当前学期：' + semester + '。';
  if (courses.length === 0) return head + ' 当前还没有保存任何课程。';
  return head + '\n' + courses.map(courseLine).join('\n');
}

/** 系统提示词：纪律 + 四种 JSON 形态 + 当前课表数据快照。 */
export function buildSystemPrompt(courses: Course[], semester: string): string {
  return [
    '你是校园课表助手，帮助学生查阅和增改「我的课表」。',
    '只能依据下面「当前课表数据」回答；数据里没有的内容不要猜测，明确说「课表里没有查到」。',
    '你的每次回复必须是**一个 JSON 对象**，四种形态之一：',
    '1. 查阅：{"kind":"query","message":"给学生的回答"}——只依据课表数据作答；',
    '2. 澄清：{"kind":"clarify","message":"需要追问的问题"}——指代不清（哪门课/哪一天/哪个节次）或信息不足时先追问，绝不猜测后直接给方案；',
    '3. 变更方案：{"kind":"change","action":"add"或"update","courseId":"仅 update 时给要改的课程 id，取自课表数据","course":{"name":"课程名","teacher":"教师，可为空","weekday":1到7,"startSection":1到12,"endSection":1到12且不小于 startSection,"weekText":"周次写法如 1-16 或 [2-6,8-17]周，留空表示每周","location":"地点，可为空"},"message":"给学生的方案说明"}——只提出方案，绝不声称已经改好，学生确认后才生效；',
    '4. 超范围：{"kind":"out_of_scope","message":"说明不在能力范围"}——问成绩、选课、放假等课表以外的问题时这样回答。',
    '纪律：数据里没有的课程或字段绝不编造；周次写法保持原样；变更方案的课程字段必须来自学生的原话或课表数据，不能自己补。',
    '',
    '当前课表数据：',
    buildTimetableText(courses, semester),
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
    const action = parsed.action === 'update' ? 'update' : 'add';
    const courseId = asText(parsed.courseId, 64);
    const raw = parsed.course;
    if (raw === null || typeof raw !== 'object') {
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
    const valid = course.name !== ''
      && course.weekday >= 1 && course.weekday <= 7
      && course.startSection >= 1 && course.startSection <= 12
      && course.endSection >= course.startSection && course.endSection <= 12;
    if (!valid) {
      return { kind: 'invalid', message: '助手给出的变更缺少课程名、星期或节次，请换个说法补充。' };
    }
    if (action === 'update' && courseId === '') {
      return { kind: 'invalid', message: '助手没有说明要改哪门课，请指明课程名。' };
    }
    return {
      kind: 'change',
      action,
      courseId,
      course,
      message: message === '' ? '按你确认的内容更新课表。' : message,
    };
  }
  return { kind: 'invalid', message: message === '' ? '助手回复无法解析，请重试或换个说法。' : message };
}

/** 变更方案的确认框文案：讲清课程名、星期、节次、周次、教师与地点。 */
export function describeChange(course: ProposedCourse, action: 'add' | 'update'): string {
  const weekText = course.weekText === '' ? '每周' : course.weekText;
  return [
    (action === 'add' ? '新增课程：' : '修改课程：') + course.name,
    weekdayLabel(course.weekday) + ' '
      + (course.startSection === course.endSection
        ? '第 ' + course.startSection + ' 节'
        : '第 ' + course.startSection + '-' + course.endSection + ' 节'),
    '周次：' + weekText,
    course.teacher === '' ? '' : '教师：' + course.teacher,
    course.location === '' ? '' : '地点：' + course.location,
  ].filter((part) => part !== '').join('\n');
}

/** 变更方案 → 03 的提交数据：周次复用 parseWeekNotation，留空按每周，来源为 manual。 */
export function buildChangeInput(course: ProposedCourse): CourseInput {
  const weekText = course.weekText.trim();
  const warnings: string[] = [];
  let weeks: number[] = [];
  let weeksRecognized = true;
  if (weekText !== '') {
    const parsed = parseWeekNotation(weekText);
    if (parsed.recognized) {
      weeks = parsed.weeks;
    } else {
      weeksRecognized = false;
      warnings.push('周次写法未能识别（原文：' + weekText + '），已保留原文，请核对');
    }
  }
  return {
    name: course.name,
    credits: '',
    teacher: course.teacher,
    weekday: course.weekday,
    startSection: course.startSection,
    endSection: course.endSection,
    sectionRanges: [{ start: course.startSection, end: course.endSection }],
    weeks,
    weeksRecognized,
    weekText,
    location: course.location,
    campus: '',
    siteNumber: '',
    note: '',
    warnings,
    source: 'manual',
  };
}

/** 多轮历史 → ai 云函数消息数组，只保留最近 MAX_HISTORY 条。 */
export function conversationMessages(history: AssistantTurn[]): { role: 'user' | 'assistant'; text: string }[] {
  return history.slice(-MAX_HISTORY).map((turn) => ({ role: turn.role, text: turn.text }));
}
