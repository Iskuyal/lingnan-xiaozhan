/**
 * 目标日：学生自己填的日期与剩余天数，**只保存在本机**（`wx.setStorageSync`），
 * 不经过云开发、不进 AI 请求、不上传任何字段。
 *
 * 为什么日期算法全是纯函数：剩余天数直接决定学生看到的「还有几天」，
 * 而它最容易在跨月、跨年、闰日、设备时区上出错，必须能用 node:test 把每一种都钉住。
 * 页面只做取值与渲染，不自己算天数。
 *
 * 存储约定：单个 key 存一个数组，元素是 `GoalDay`。**读到的任何脏数据都只丢弃那一条**，
 * 不让一条坏记录把整个列表变成空——「删除后重建」「旧版本残留字段」都要能继续用。
 */

/** 存储 key 带版本号：将来结构变化时换 key，不原地迁移未知格式的旧数据。 */
const STORAGE_KEY = 'goal-days/v1';

/** 单机上限：目标日是本机存储，给一个上限避免无限堆积（也挡住误操作批量写入）。 */
export const MAX_GOALS = 50;

/** 名称上限：与设计图 03 的提示一致。 */
export const MAX_NAME_LENGTH = 30;

/**
 * 日期判断全部来自 `services/dates`：本项目只有一份「今天怎么算」。
 * 这里把它们再导出，页面与测试继续从本模块取，不必知道实现被搬到了哪。
 */
import { compareText, diffDays, isValidDate, parseDate, shanghaiToday } from '../dates/index';

export { diffDays, isValidDate, parseDate, shanghaiToday };

/** 目标日状态：未到期 / 今天 / 已过期。 */
export type GoalKind = 'upcoming' | 'today' | 'expired';

export interface GoalDay {
  id: string;
  name: string;
  /** 'YYYY-MM-DD'，Asia/Shanghai 的日历日。 */
  date: string;
  /** 「计入当天」：打开后剩余天数把今天也算一天。 */
  countToday: boolean;
  /** 创建与最后修改的毫秒时间戳（本机时间，仅用于排序与展示）。 */
  createdAt: number;
  updatedAt: number;
}

/** 一条目标日算出来的状态。`days` 是界面上直接显示的天数，永远是 0 或正数。 */
export interface GoalStatus {
  kind: GoalKind;
  /** 日历日差：目标日 − 今天。0 今天、正数未到期、负数已过期。 */
  diffDays: number;
  /** 剩余天数（未到期 / 今天）或已过天数（已过期）。 */
  days: number;
  /** 徽标文案：「还有 67 天」「就是今天」「已过期 4 天」。 */
  label: string;
}

/** 列表里的一行：条目本体 + 算好的状态与元信息，页面直接渲染。 */
export interface GoalRow extends GoalDay {
  kind: GoalKind;
  days: number;
  label: string;
  /** 「2026-12-05 · 不计入当天」；今天状态的条目只写日期。 */
  meta: string;
}

export interface GoalGroups {
  upcoming: GoalRow[];
  today: GoalRow[];
  expired: GoalRow[];
}

/** 新建或修改一条目标日的输入：只有这三个字段由学生决定。 */
export interface GoalInput {
  name: string;
  date: string;
  countToday: boolean;
}

let sequence = 0;

/** 本机唯一 id：时间戳 + 会话内自增序号。不依赖随机数，测试里只看格式。 */
function nextId(now: number): string {
  sequence += 1;
  return `goal-${now.toString(36)}-${sequence.toString(36)}`;
}

/**
 * 一条目标日此刻的状态。
 *
 * 判定只看日历日差：`d > 0` 未到期、`d = 0` 今天、`d < 0` 已过期。
 * 「计入当天」只把未到期条目的剩余天数加一（今天也算一天），**不改状态**——
 * 否则「今天」会同时出现「就是今天」和「已过期」两种读法。
 */
export function statusOf(goal: { date: string; countToday: boolean }, now: number = Date.now()): GoalStatus {
  const diff = diffDays(shanghaiToday(now), goal.date);
  if (diff === null) {
    // 目标日非法时不给天数：页面本来就不该存下这种记录，这里只是不猜。
    return { kind: 'upcoming', diffDays: 0, days: 0, label: '日期待核对' };
  }
  if (diff === 0) return { kind: 'today', diffDays: 0, days: 0, label: '就是今天' };
  if (diff < 0) return { kind: 'expired', diffDays: diff, days: -diff, label: `已过期 ${-diff} 天` };
  const days = goal.countToday ? diff + 1 : diff;
  return { kind: 'upcoming', diffDays: diff, days, label: `还有 ${days} 天` };
}

function metaOf(goal: GoalDay, status: GoalStatus): string {
  if (status.kind === 'today') return goal.date;
  return `${goal.date} · ${goal.countToday ? '计入当天' : '不计入当天'}`;
}

function toRow(goal: GoalDay, now: number): GoalRow {
  const status = statusOf(goal, now);
  return { ...goal, kind: status.kind, days: status.days, label: status.label, meta: metaOf(goal, status) };
}

/**
 * 按状态分组。组内顺序：未到期按目标日由近到远；今天按创建时间（同一天里先建的排前面）；
 * 已过期按目标日由近到远（刚过期的排前面）。日期相同时用创建时间兜底，
 * 保证顺序稳定、不随读取次序或运行平台抖动。
 */
export function groupGoals(goals: GoalDay[], now: number = Date.now()): GoalGroups {
  const rows = goals.map((goal) => toRow(goal, now));
  const byDate = (a: GoalRow, b: GoalRow) => compareText(a.date, b.date) || a.createdAt - b.createdAt;
  const byNewest = (a: GoalRow, b: GoalRow) => compareText(b.date, a.date) || a.createdAt - b.createdAt;
  const byCreated = (a: GoalRow, b: GoalRow) => a.createdAt - b.createdAt || compareText(a.id, b.id);
  return {
    upcoming: rows.filter((row) => row.kind === 'upcoming').sort(byDate),
    today: rows.filter((row) => row.kind === 'today').sort(byCreated),
    expired: rows.filter((row) => row.kind === 'expired').sort(byNewest),
  };
}

/**
 * 首页入口带要显示的那一条：先看今天，再看最近的未到期；
 * 只有已过期（或没有）时返回 null——首页不拿过期的事当「最近的安排」。
 */
export function nearestGoal(goals: GoalDay[], now: number = Date.now()): GoalRow | null {
  const groups = groupGoals(goals, now);
  if (groups.today.length > 0) return groups.today[0];
  if (groups.upcoming.length > 0) return groups.upcoming[0];
  return null;
}

/** 校验输入：返回空字符串表示可以保存，否则是可直接展示的原因。 */
export function validateInput(input: GoalInput): string {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') return '请填写事项名称';
  if (name.length > MAX_NAME_LENGTH) return `事项名称最多 ${MAX_NAME_LENGTH} 字`;
  if (typeof input.date !== 'string' || input.date.trim() === '') return '请选择目标日期';
  if (!isValidDate(input.date)) return '目标日期要用 YYYY-MM-DD 的合法日期';
  return '';
}

/** 把一条记录收敛成合法结构；字段缺失或日期非法时返回 null（调用方丢弃这一条）。 */
export function normalizeGoal(raw: unknown, now: number = Date.now()): GoalDay | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name.trim().slice(0, MAX_NAME_LENGTH) : '';
  const date = typeof source.date === 'string' ? source.date.trim() : '';
  if (name === '' || !isValidDate(date)) return null;
  const id = typeof source.id === 'string' && source.id !== '' ? source.id : nextId(now);
  const createdAt = typeof source.createdAt === 'number' && Number.isFinite(source.createdAt) ? source.createdAt : now;
  const updatedAt = typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;
  return { id, name, date, countToday: source.countToday === true, createdAt, updatedAt };
}

/** 本机存储是否可用；开发者工具的普通环境与真机都有，但测试与异常环境要能兜住。 */
function storageAvailable(): boolean {
  return typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function' && typeof wx.setStorageSync === 'function';
}

/**
 * 读取全部目标日。**读失败或数据损坏都不抛异常**：返回已经能用的那些记录，
 * 让页面至少能显示、能新建，而不是整页打不开。
 */
export function loadGoals(): GoalDay[] {
  if (!storageAvailable()) return [];
  let raw: unknown;
  try {
    raw = wx.getStorageSync(STORAGE_KEY);
  } catch (error) {
    console.error('读取目标日失败，按空列表处理：', error);
    return [];
  }
  if (raw === '' || raw === null || raw === undefined) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error('目标日数据不是合法 JSON，按空列表处理：', error);
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const goals: GoalDay[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const goal = normalizeGoal(item);
    if (goal === null || seen.has(goal.id)) continue;
    seen.add(goal.id);
    goals.push(goal);
  }
  return goals;
}

/** 写入全部目标日；存储写失败（配额、环境异常）时抛出，由页面提示，不静默丢弃。 */
export function saveGoals(goals: GoalDay[]): void {
  if (!storageAvailable()) throw new Error('当前环境无法保存到本机');
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(goals));
  } catch (error) {
    console.error('保存目标日失败：', error);
    throw new Error('保存失败：本机存储不可写');
  }
}

/** 新建一条；名称或日期不合法、超过上限时抛出。返回新记录。 */
export function addGoal(input: GoalInput, now: number = Date.now()): GoalDay {
  const problem = validateInput(input);
  if (problem !== '') throw new Error(problem);
  const goals = loadGoals();
  if (goals.length >= MAX_GOALS) throw new Error(`最多保存 ${MAX_GOALS} 个目标日，请先删掉一些`);
  const goal: GoalDay = {
    id: nextId(now),
    name: input.name.trim(),
    date: input.date.trim(),
    countToday: input.countToday === true,
    createdAt: now,
    updatedAt: now,
  };
  saveGoals([...goals, goal]);
  return goal;
}

/** 修改一条；找不到（已被删除）时抛出，避免页面以为保存成功。 */
export function updateGoal(id: string, input: GoalInput, now: number = Date.now()): GoalDay {
  const problem = validateInput(input);
  if (problem !== '') throw new Error(problem);
  const goals = loadGoals();
  const index = goals.findIndex((goal) => goal.id === id);
  if (index === -1) throw new Error('这条目标日已经不在了，请返回列表重试');
  const updated: GoalDay = {
    ...goals[index],
    name: input.name.trim(),
    date: input.date.trim(),
    countToday: input.countToday === true,
    updatedAt: now,
  };
  goals[index] = updated;
  saveGoals(goals);
  return updated;
}

/** 删除一条；返回是否真的删掉了（不存在时返回 false，不报错）。 */
export function removeGoal(id: string): boolean {
  const goals = loadGoals();
  const rest = goals.filter((goal) => goal.id !== id);
  if (rest.length === goals.length) return false;
  saveGoals(rest);
  return true;
}

/** 按 id 取一条；找不到返回 null。 */
export function findGoal(id: string): GoalDay | null {
  return loadGoals().find((goal) => goal.id === id) || null;
}
