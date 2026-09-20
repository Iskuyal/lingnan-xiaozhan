/**
 * 学期设置与作息时间：数据契约、云端读写，以及由「学生自己填的时刻」推出的此刻在上 / 下一节。
 *
 * 设计图 07。两件事各自解决一个问题：
 * - 学期三项（名称 / 第一周的星期一 / 总周数）决定课表能不能显示「今天是第几周」与日期区间
 *   （日期怎么算交给 `semester.ts`，这里只管存取）；
 * - 作息时间**不预置任何默认时刻**（学校作息表尚未核实）：某节没填就跳过它、不猜，
 *   于是「正在上 / 下一节」只可能来自学生自己填过的那几节，页面也永远不会显示臆造的时刻。
 *
 * 存储：经 `timetable` 云函数的 `getSettings` / `saveSettings` 读写集合 `timetable_settings`，
 * 由云函数按调用上下文的 openid 隔离（客户端不直连数据库）。
 *
 * **读失败一律降级为 `emptySettings()`**：云函数尚未部署、集合尚未创建、断网都走这条路径，
 * 页面照常可用、不白屏。为了不让调用方用「字段是不是空的」去猜，`loadSettings` 的返回值在
 * 降级时多一个 `loadError`（见 `LoadedSettings`）——**有它才是读失败，没有它就是真的还没设置**。
 */
import { requireCloud } from '../cloud';
import { FUNCTION_NAME, messageOf, readableCloudError } from './index';
import { DEFAULT_TOTAL_WEEKS, MAX_TOTAL_WEEKS, isValidStartDate, normalizeTotalWeeks } from './semester';

/** 一天 12 节：与云端契约 `MAX_SECTION` 一致（`cloudfunctions/timetable/types.ts`）。 */
export const SECTION_COUNT = 12;

/** 学期名称上限：与云端 `sanitizeSemester` 的 40 字一致。 */
const MAX_SEMESTER_NAME = 40;

/** 24 小时制的 HH:MM；只认两位小时、两位分钟，宁可拒绝也不去猜 8:5 这类写法。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 一节的上课时刻。空字符串表示这一节没填——**填一半是合法状态**，只影响那一节。 */
export interface SectionTime {
  start: string;
  end: string;
}

export interface TimetableSettings {
  /** 如「2026-2027学年第一学期」；空字符串表示未命名。 */
  semesterName: string;
  /** 第一周的星期一，'YYYY-MM-DD'；空字符串表示未设置（课表按第 1 周显示）。 */
  startDate: string;
  /** 总周数，1..30（取 `normalizeTotalWeeks` 的语义）。 */
  totalWeeks: number;
  /** 固定 12 条，顺序即第 1..12 节。 */
  sectionTimes: SectionTime[];
}

/**
 * `loadSettings` 的返回值：设置本体 + 可选的读失败原因。
 *
 * 需要 `loadError` 才分得清「云端说没有设置」（读成功、字段为空）与「根本没读到」
 * （云函数未部署、集合未建、断网）。类型上它仍是 `TimetableSettings`，调用方按需读。
 */
export interface LoadedSettings extends TimetableSettings {
  loadError?: string;
}

/** 保存失败的分类：`invalid` 是填写有误（业务校验拒绝），`unavailable` 是云函数/集合未就绪等技术性失败。 */
export type SettingsFailureKind = 'invalid' | 'unavailable';

export interface SettingsFailure {
  kind: SettingsFailureKind;
  /** 可直接展示给学生的文案（技术性失败已在传输层换成人话）。 */
  text: string;
}

class SettingsError extends Error {
  readonly settingsKind: SettingsFailureKind;

  constructor(kind: SettingsFailureKind, message: string) {
    super(message);
    this.settingsKind = kind;
  }
}

/** 一份空设置：总周数用默认跨度，12 节全部未填。每次调用都返回新对象，不共享数组。 */
export function emptySettings(): TimetableSettings {
  const sectionTimes: SectionTime[] = [];
  for (let index = 0; index < SECTION_COUNT; index += 1) sectionTimes.push({ start: '', end: '' });
  return { semesterName: '', startDate: '', totalWeeks: DEFAULT_TOTAL_WEEKS, sectionTimes };
}

/** 'HH:MM' → 当天的第几分钟（'13:00' → 780）；空串、格式不对、越界一律 null。 */
export function minutesOfClock(text: string): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!CLOCK_PATTERN.test(trimmed)) return null;
  return Number(trimmed.slice(0, 2)) * 60 + Number(trimmed.slice(3, 5));
}

/** 取第 index 条（0 起）作息；缺失或不是文本时返回 undefined，字段不是字符串时按空处理。 */
function timeOf(settings: TimetableSettings, index: number): SectionTime | undefined {
  const times: unknown = settings === null || settings === undefined ? undefined : settings.sectionTimes;
  if (!Array.isArray(times)) return undefined;
  const raw: unknown = times[index];
  if (raw === null || typeof raw !== 'object') return undefined;
  const item = raw as { start?: unknown; end?: unknown };
  return {
    start: typeof item.start === 'string' ? item.start.trim() : '',
    end: typeof item.end === 'string' ? item.end.trim() : '',
  };
}

/**
 * 第 section 节（1..12）的作息；**没填或非法返回 null**。
 * 「非法」按每条自己判断：起止任一为空、格式不是 HH:MM、结束不晚于起始，都当作没填——
 * 这样的条目不会参与「正在上 / 下一节」，也不会在页面上被当成一个区间使用。
 */
export function sectionTimeAt(settings: TimetableSettings, section: number): SectionTime | null {
  if (!Number.isInteger(section) || section < 1 || section > SECTION_COUNT) return null;
  const raw = timeOf(settings, section - 1);
  if (raw === undefined) return null;
  const start = minutesOfClock(raw.start);
  const end = minutesOfClock(raw.end);
  if (start === null || end === null || start >= end) return null;
  return { start: raw.start, end: raw.end };
}

interface FilledSection {
  section: number;
  start: number;
  end: number;
}

/** 已填且合法的节次区间，按节次升序。没填的节不在列表里——这就是「跳过、不猜」。 */
function filledSections(settings: TimetableSettings): FilledSection[] {
  const filled: FilledSection[] = [];
  for (let section = 1; section <= SECTION_COUNT; section += 1) {
    const time = sectionTimeAt(settings, section);
    if (time === null) continue;
    const start = minutesOfClock(time.start);
    const end = minutesOfClock(time.end);
    if (start === null || end === null) continue;
    filled.push({ section, start, end });
  }
  return filled;
}

/**
 * 此刻正在上的节次；不在任何已填区间内（含课间、没填的节、全部未填）返回 null。
 * 判定用 `start <= minutes < end`：**下课的那一分钟已经算下课**。
 * 只返回一个节次：即使数据被手工改成互相重叠，也只会给出靠前的那一节。
 */
export function currentSectionAt(settings: TimetableSettings, minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null;
  for (const item of filledSections(settings)) {
    if (minutes >= item.start && minutes < item.end) return item.section;
  }
  return null;
}

/**
 * 下一个**还没结束**的节的节号（已经上完的节不算）。
 *
 * 语义要点（调用方按这条用）：
 * - 课间 → 给下一节；一整天的课都上完了 → null；全部未填 → null；上课前 → 第 1 个已填的节；
 * - 正在上课时 → **返回正在上的这一节本身**（它还没结束），因为它确实还没结束；
 *   如果调用方只想要「严格排在后面的那一节」，先判 `currentSectionAt`，非 null 时不要用本函数。
 */
export function nextSectionAt(settings: TimetableSettings, minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null;
  for (const item of filledSections(settings)) {
    if (minutes < item.end) return item.section;
  }
  return null;
}

/** 单个时刻字段的校验：空串合法（这一节没填），非空必须是 HH:MM。 */
function checkClock(value: string, section: number, label: string): string {
  if (value === '') return '';
  if (minutesOfClock(value) === null) return `第 ${section} 节的${label}要用 24 小时制的 HH:MM`;
  return '';
}

/**
 * 校验一份设置，返回空字符串表示可以保存，否则是可直接展示的原因。
 * 规则与云函数侧（`cloudfunctions/timetable/settings.ts`）逐条一致：客户端先挡一次省一次往返，
 * 云端再挡一次才是权威。
 */
export function validateSettings(next: TimetableSettings): string {
  const source: unknown = next;
  if (source === null || typeof source !== 'object') return '设置数据格式不正确';
  const semesterName = typeof next.semesterName === 'string' ? next.semesterName.trim() : '';
  if (semesterName.length > MAX_SEMESTER_NAME) return `学期名称最多 ${MAX_SEMESTER_NAME} 字`;

  const startDate = typeof next.startDate === 'string' ? next.startDate.trim() : '';
  if (startDate !== '' && !isValidStartDate(startDate)) return '开学日要用 YYYY-MM-DD 的合法日期';

  if (!Number.isInteger(next.totalWeeks) || next.totalWeeks < 1 || next.totalWeeks > MAX_TOTAL_WEEKS) {
    return `总周数要是 1-${MAX_TOTAL_WEEKS} 之间的整数`;
  }
  if (!Array.isArray(next.sectionTimes) || next.sectionTimes.length !== SECTION_COUNT) {
    return `作息时间要正好 ${SECTION_COUNT} 条（第 1-${SECTION_COUNT} 节）`;
  }

  const filled: FilledSection[] = [];
  for (let section = 1; section <= SECTION_COUNT; section += 1) {
    const raw = timeOf(next, section - 1);
    if (raw === undefined) return `第 ${section} 节的作息格式不正确`;
    const startProblem = checkClock(raw.start, section, '起始时刻');
    if (startProblem !== '') return startProblem;
    const endProblem = checkClock(raw.end, section, '结束时刻');
    if (endProblem !== '') return endProblem;
    const start = minutesOfClock(raw.start);
    const end = minutesOfClock(raw.end);
    // 只填了一半：合法，那一节按「没填」处理，不报错也不猜另一半。
    if (start === null || end === null) continue;
    if (start >= end) return `第 ${section} 节的结束时刻要晚于起始时刻`;
    filled.push({ section, start, end });
  }

  // 重叠：按起始时刻排序后只要有一对相邻区间相交，就存在重叠（含不相邻的两节跨过未填的节）。
  const ordered = [...filled].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.start < previous.end) {
      return `第 ${previous.section} 节与第 ${current.section} 节的作息时间重叠了，同一时刻只能有一节在上课`;
    }
  }
  return '';
}

/** 把云端（或本地）来的任意值收敛成一份合法设置：缺字段按空值处理，不抛异常、不做类型断言。 */
export function normalizeSettings(input: unknown): TimetableSettings {
  const source = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const times: unknown[] = Array.isArray(source.sectionTimes) ? source.sectionTimes : [];
  const sectionTimes: SectionTime[] = [];
  for (let index = 0; index < SECTION_COUNT; index += 1) {
    const raw: unknown = times[index];
    const item = raw !== null && typeof raw === 'object' ? (raw as { start?: unknown; end?: unknown }) : {};
    sectionTimes.push({
      start: typeof item.start === 'string' ? item.start.trim() : '',
      end: typeof item.end === 'string' ? item.end.trim() : '',
    });
  }
  const startDate = typeof source.startDate === 'string' ? source.startDate.trim() : '';
  return {
    semesterName: typeof source.semesterName === 'string' ? source.semesterName.trim().slice(0, MAX_SEMESTER_NAME) : '',
    startDate: isValidStartDate(startDate) ? startDate : '',
    totalWeeks: normalizeTotalWeeks(source.totalWeeks),
    sectionTimes,
  };
}

interface CloudResponse {
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * 调用 `timetable` 云函数的一个 action。
 *
 * 这里不直接用 `services/timetable/index.ts` 里的私有 `callTimetable`（没有导出），
 * 但复用它导出的同一套口径：函数名 `FUNCTION_NAME`、错误分类 `readableCloudError`、
 * 文案映射 `messageOf`。`ok:false` 的业务提示原样抛出（kind 'invalid'），
 * 平台/数据库层的技术性文本换成学生能看懂的一句（kind 'unavailable'），原文打到控制台。
 */
async function callSettings<T>(data: Record<string, unknown>): Promise<T> {
  requireCloud();
  const response = await wx.cloud.callFunction({ name: FUNCTION_NAME, data });
  const result = (response === null || response === undefined ? undefined : response.result) as CloudResponse | undefined;
  if (result === undefined || result.ok !== true) {
    const raw = result !== undefined && typeof result.error === 'string' && result.error !== ''
      ? result.error
      : '课表服务返回了无法识别的结果';
    const mapped = readableCloudError(raw);
    if (mapped.technical) console.error('课表服务返回技术性错误：', raw);
    throw new SettingsError(mapped.technical ? 'unavailable' : 'invalid', mapped.text);
  }
  return result as T;
}

/**
 * 读取本人设置。**不会 reject**：云函数未部署、集合未建、断网、返回脏数据都降级为空设置，
 * 并把原因放在 `loadError` 上；读成功（含「云端确实还没有设置」）时没有这个字段。
 */
export async function loadSettings(): Promise<LoadedSettings> {
  try {
    const result = await callSettings<{ settings?: unknown }>({ action: 'getSettings' });
    return normalizeSettings(result.settings);
  } catch (error) {
    console.error('读取课表设置失败，已降级为空设置：', error);
    return { ...emptySettings(), loadError: messageOf(error) };
  }
}

/** 保存本人设置。校验不通过或云端拒绝时抛出，调用方用 `failureOf` 取分类与文案。 */
export async function saveSettings(next: TimetableSettings): Promise<TimetableSettings> {
  const problem = validateSettings(next);
  if (problem !== '') throw new SettingsError('invalid', problem);
  const payload = normalizeSettings(next);
  const result = await callSettings<{ settings?: unknown }>({ action: 'saveSettings', settings: payload });
  return normalizeSettings(result.settings);
}

/**
 * 把保存失败分成两类文案：`invalid` 填写有误（服务端业务校验拒绝），
 * `unavailable` 云函数/集合未就绪等技术性失败。页面据此给两种不同的提示。
 */
export function failureOf(error: unknown): SettingsFailure {
  if (error instanceof SettingsError) return { kind: error.settingsKind, text: error.message };
  // 传输层失败（云函数未部署、超时、断网、云开发不可用）都归到「暂时存不到云端」，
  // 不去冒充「填写有误」——那会把学生引到错误的方向。
  return { kind: 'unavailable', text: messageOf(error) };
}
