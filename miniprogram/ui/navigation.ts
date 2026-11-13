/**
 * 四 tab 导航与跨 tab 意图桥（岭南红重设计，A 维护）。
 *
 * 为什么要有这个模块：2026-11-11 的定稿把底部导航改成四个真实 tab
 * （今天 / 课表 / 学习 / 校园）。tab 页只能用 wx.switchTab 打开，而 switchTab 不接受
 * query——「首页问课表」这类要把一句话带进课表页的动作因此没有 URL 可用。
 * 与其让每个页面自己拼 storage key（很快就会有两三个不同的 key 和三套校验），
 * 统一收在这个文件里：只有这里持有 `lingnan/ui-timetable-intent/v1`。
 *
 * 意图不是业务存储：不改课程、不写计划、不触发模型。它只是一次性纸条——
 * 写进去、课表页 onShow 时读走、随即删除；五分钟内没有人读就作废。
 */
export type UiTab = 'today' | 'timetable' | 'study' | 'campus';

export type TimetableIntent =
  | { kind: 'assistant'; text?: string }
  | { kind: 'week'; week: number }
  | { kind: 'plan-week'; planDate: string };

/** 唯一持有者：别的模块读写这个 key 就是绕开了本模块的校验。 */
export const TIMETABLE_INTENT_KEY = 'lingnan/ui-timetable-intent/v1';

/** 五分钟有效：够切 tab，不够留到第二天被当成新指令。 */
export const INTENT_TTL_MS = 5 * 60 * 1000;

/** 助手预填文字的上限，与课表页输入框的可发送长度一致，避免塞进超长粘贴。 */
export const INTENT_TEXT_MAX_CHARS = 500;

/** 周次上限：一学期不会超过这个数，超出的数字按非法处理而不是夹紧成一个错周。 */
export const MAX_WEEK = 60;

export const TAB_ROUTES: Record<UiTab, string> = {
  today: '/pages/home/index',
  timetable: '/pages/timetable/index',
  study: '/pages/study/index',
  campus: '/pages/campus/index',
};

interface StoredIntent {
  id: string;
  createdAt: number;
  intent: TimetableIntent;
}

let intentSeed = 0;

function now(): number {
  return Date.now();
}

/** 意图 id：带时间与自增，同一毫秒内写两次也不会撞。 */
function nextIntentId(): string {
  intentSeed += 1;
  return `${now().toString(36)}-${intentSeed.toString(36)}`;
}

/** 'YYYY-MM-DD' 且是真实存在的日历日（2026-02-30 不算）。 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (month < 1 || month > 12 || day < 1) return false;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/**
 * 校验并规整意图。返回 null 表示这条意图非法，调用方既不写入也不消费。
 * 助手文字允许省略（只是打开助手），但不接受非字符串或被截断到空。
 */
export function normalizeIntent(raw: unknown): TimetableIntent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as { kind?: unknown; text?: unknown; week?: unknown; planDate?: unknown };
  if (value.kind === 'assistant') {
    if (value.text === undefined) return { kind: 'assistant' };
    if (typeof value.text !== 'string') return null;
    const text = value.text.trim().slice(0, INTENT_TEXT_MAX_CHARS);
    return text === '' ? { kind: 'assistant' } : { kind: 'assistant', text };
  }
  if (value.kind === 'week') {
    const week = value.week;
    if (typeof week !== 'number' || !Number.isInteger(week) || week < 1 || week > MAX_WEEK) return null;
    return { kind: 'week', week };
  }
  if (value.kind === 'plan-week') {
    return isCalendarDate(value.planDate) ? { kind: 'plan-week', planDate: value.planDate } : null;
  }
  return null;
}

function readStored(): StoredIntent | null {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return null;
  let raw: unknown;
  try {
    raw = wx.getStorageSync(TIMETABLE_INTENT_KEY);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const stored = raw as { id?: unknown; createdAt?: unknown; intent?: unknown };
  if (typeof stored.id !== 'string' || stored.id === '') return null;
  if (typeof stored.createdAt !== 'number' || !Number.isFinite(stored.createdAt)) return null;
  const intent = normalizeIntent(stored.intent);
  if (intent === null) return null;
  return { id: stored.id, createdAt: stored.createdAt, intent };
}

function writeStored(stored: StoredIntent): boolean {
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return false;
  try {
    wx.setStorageSync(TIMETABLE_INTENT_KEY, stored);
    return true;
  } catch {
    return false;
  }
}

/** 只清理与给定 id 相同的那条：别人（或更晚的一次点击）写的新意图保持不动。 */
function clearStored(id: string | null): void {
  if (typeof wx === 'undefined' || typeof wx.removeStorageSync !== 'function') return;
  const current = readStored();
  // 读不出来（已过期 / 已损坏 / 非本模块结构）时也清掉，避免坏数据常驻。
  if (id !== null && current !== null && current.id !== id) return;
  try {
    wx.removeStorageSync(TIMETABLE_INTENT_KEY);
  } catch {
    /* 清理失败不影响主流程；下次读取仍会按 TTL 与校验作废。 */
  }
}

function switchTabRoute(route: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.switchTab !== 'function') {
      reject(new Error('当前运行环境不支持 switchTab'));
      return;
    }
    wx.switchTab({
      url: route,
      success: () => resolve(),
      fail: (error: unknown) => reject(error),
    });
  });
}

/** 切到四个主入口之一；失败时把错误交给调用方，页面可以提示「稍后再试」。 */
export function openUiTab(tab: UiTab): Promise<void> {
  const route = TAB_ROUTES[tab];
  if (route === undefined) return Promise.reject(new Error(`未知的主入口：${String(tab)}`));
  return switchTabRoute(route);
}

/**
 * 打开课表，可带一条一次性意图。
 *
 * 顺序是有意的：先写意图再切 tab。切成功时课表页 onShow 一定能读到；
 * 切失败时只回滚自己写的那条（同 id），页面上的输入不受影响。
 */
export function openTimetable(intent?: TimetableIntent): Promise<void> {
  if (intent === undefined) return switchTabRoute(TAB_ROUTES.timetable);
  const normalized = normalizeIntent(intent);
  if (normalized === null) return Promise.reject(new Error('课表意图不合法'));
  const stored: StoredIntent = { id: nextIntentId(), createdAt: now(), intent: normalized };
  const written = writeStored(stored);
  return switchTabRoute(TAB_ROUTES.timetable).catch((error: unknown) => {
    if (written) clearStored(stored.id);
    throw error;
  });
}

/**
 * 课表页在数据读完之后调用一次：返回意图并删除它。
 *
 * 过期、结构损坏、类型不对都返回 null 并顺手清掉——一张读不出来的纸条
 * 留着只会在下一次 onShow 里继续骗人。
 */
export function consumeTimetableIntent(): TimetableIntent | null {
  const stored = readStored();
  if (stored === null) {
    clearStored(null);
    return null;
  }
  clearStored(stored.id);
  if (now() - stored.createdAt > INTENT_TTL_MS) return null;
  return stored.intent;
}

/** 仅供测试：把模块内的自增计数器复位，避免断言依赖全局顺序。 */
export function __resetIntentSeedForTest(): void {
  intentSeed = 0;
}
