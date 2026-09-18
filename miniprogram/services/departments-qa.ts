/**
 * 部门 AI 问答（Ticket 07）。
 *
 * 只调 Ticket 01 的 `ai` 云函数（`action: "chat"`、`feature: "department-qa"`）：
 * 模型调用、输入输出的内容安全检测、失败分类与成本记账都在云函数侧，
 * 这里不直连模型、不持密钥，也不自己拼 HTTP 请求。
 *
 * 语料是随包提供的已核实部门资料（`services/departments.ts`），来源见
 * `docs/departments-sources.md`。**「不编造」由两道防线保证**：
 * ① 提示词要求模型只依据资料作答，资料里没有的一律回答「官网未公布」；
 * ② `guardAnswer` 确定性复核模型输出，出现资料不支持的断言就整条换成如实回答，
 *    并把命中原因记在返回结果里，便于评估时统计「防幻觉」。
 */
import {
  Department,
  departments,
  departmentsSource,
  findDepartmentById,
} from './departments';

/** 云函数名与记账落点：与 Ticket 01 的调用契约一致，改动等于同时改动云函数。 */
export const AI_FUNCTION_NAME = 'ai';
export const QA_FEATURE = 'department-qa';

/** 资料里没有的信息一律用这句话回答——验收要求「明确回答官网未公布」。 */
export const NOT_PUBLISHED_TEXT = '官网未公布';
/** 单条提问的字数上限：超过就不发请求，按参数错误提示。 */
export const MAX_QUESTION_LENGTH = 200;
/** 送进云函数的对话条数上限（云函数上限 20 条，这里留余量）。 */
export const MAX_REQUEST_MESSAGES = 12;
/** 每个部门保留的对话轮数（一问一答为一轮），超出丢弃最早一轮。 */
export const MAX_TURNS = 10;
/** 每条消息送进模型前截断的长度（云函数单条上限 8000 字）。 */
const MAX_MESSAGE_CHARS = 1200;

/** 与云函数同一套失败分类（见 docs/cloud-development.md 的「失败分类与默认文案」）。 */
export type QaFailureClass =
  | 'model_unavailable'
  | 'content_rejected'
  | 'quota_exhausted'
  | 'invalid_request'
  | 'internal';

/**
 * 本地兜底文案：只有在请求没到云函数、或云函数没给 `message` 时才用。
 * 云函数返回的文案优先（那是可被 `AI_MSG_*` 环境变量调整的一份），
 * 三类用户可见失败在这里同样各自成句、不合并。
 */
export const FAILURE_TEXT: Record<QaFailureClass, string> = {
  model_unavailable: 'AI 助手暂时不可用或响应超时，请稍后重试；部门资料仍可正常浏览。',
  content_rejected: '这条内容没有通过安全检测，请换一种问法。',
  quota_exhausted: '本月 AI 额度已用尽，暂时无法使用部门问答；部门资料仍可正常浏览。',
  invalid_request: '这条提问无法提交，请修改后重试。',
  internal: 'AI 服务内部错误，请稍后重试；部门资料仍可正常浏览。',
};

/** 模型不可用时页面上要说明「资料仍可看」——不能让人以为整个部门模块坏了。 */
export const OFFLINE_NOTE = '部门资料随小程序包提供，AI 不可用时仍可正常查看列表与详情。';

export interface QaRequestMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** 对话气泡：页面直接渲染它；`isNotice` 为真表示这是失败提示而不是模型回答。 */
export interface QaBubble {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 助手回答的依据行；失败提示与用户提问为空串。 */
  source: string;
  isNotice: boolean;
  failureClass: string;
  /** 被 `guardAnswer` 替换过：模型给出了资料不支持的断言。 */
  replaced: boolean;
}

export interface QaAskResult {
  ok: boolean;
  failureClass: QaFailureClass | '';
  /** 用户可见的一句话；失败时与气泡里显示的一致。 */
  message: string;
  /** 命中防幻觉守卫并被替换成如实回答。 */
  replaced: boolean;
}

/** 云函数调用函数；测试注入桩，页面用默认实现。 */
export type QaCall = (data: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 追问建议：三个已公布字段加一个未公布字段，正好把「官网未公布」这条路径演示出来。 */
export function suggestQuestions(department: Department): string[] {
  return [
    `${department.name}下设哪些部门？`,
    `${department.name}最近有什么动态？`,
    `${department.name}属于哪个校区？`,
    `${department.name}的联系方式是什么？`,
  ];
}

/**
 * 系统提示词：把该部门的已核实资料整段交给模型，并写清「资料里没有的说官网未公布」。
 * 未公布的字段逐项列出，避免模型拿别的组织或学校层面的信息顶上。
 */
export function buildSystemPrompt(department: Department): string {
  const lines: string[] = [
    '你是校园小程序里的部门问答助手，只回答关于广东岭南职业技术学院学生组织的问题。',
    '',
    '回答规则（必须遵守）：',
    '1. 只依据下面《已核实资料》回答，不补充资料之外的知识，不推测、不举例、不补全。',
    `2. 资料里没有的内容一律回答「${NOT_PUBLISHED_TEXT}」。尤其不得编造联系方式（电话、邮箱、公众号、办公地点）、负责人或成员姓名、所属校区、成立时间、组织标识。`,
    '3. 资料里写明「未公布」的字段，就照实说没有公布，不要用其他组织或学校层面的信息代替。',
    '4. 用简体中文回答，先直接回答，必要时分点，不超过 200 字；不要输出网址。',
    '5. 与这个组织无关的问题，回答你只了解这个组织，并提示可以问下属部门、组织介绍或近期动态。',
    '',
    '【已核实资料】',
    `- 组织名称：${department.name}`,
    `- 组织介绍：${department.introduction}`,
    `- 下设部门：${department.units.join('、')}（${department.unitNote}）`,
    department.campus === null
      ? `- 所属校区：${NOT_PUBLISHED_TEXT}（官网没有该组织所属校区的公开表述）`
      : `- 所属校区：${department.campus}${department.campusNote === '' ? '' : `（依据：${department.campusNote}）`}`,
    department.contacts.length === 0
      ? `- 联系方式：${NOT_PUBLISHED_TEXT}（官网未公布该组织的电话、邮箱或办公地点）`
      : `- 联系方式：${department.contacts.map((item) => `${item.label} ${item.value}`).join('；')}`,
    `- 成立时间：${foundedTextOf(department)}`,
    `- 组织动态（标题与官网发布时间）：${department.activities.length === 0 ? '暂无' : ''}`,
  ];
  for (const activity of department.activities) {
    lines.push(`  · ${activity.title}（${activity.publishedAt}）`);
  }
  lines.push(
    `- 资料核查日期：${department.verifiedAt}`,
    `- 资料来源：${departmentsSource.label}（${department.sourceUrl}）`,
  );
  if (department.activities.length === 0) {
    lines.push(`- 组织动态：${NOT_PUBLISHED_TEXT}`);
  }
  return lines.join('\n');
}

/** 介绍里写明的成立时间；没写就是官网未公布（只有退役军人事务服务部写了）。 */
export function foundedTextOf(department: Department): string {
  const match = /成立于\s*(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?/u.exec(department.introduction);
  if (match === null) return NOT_PUBLISHED_TEXT;
  return match[2] === undefined ? `${match[1]} 年` : `${match[1]} 年 ${match[2]} 月`;
}

/** 介绍里出现过的四位数年份（用于判断「成立于某年」是否出自资料）。 */
function yearsIn(text: string): string[] {
  const years: string[] = [];
  const pattern = /(\d{4})\s*年/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    years.push(match[1]);
    match = pattern.exec(text);
  }
  return years;
}

/**
 * 裁剪送进模型的对话：只留最近若干条，去掉失败提示（那是界面提示，不是模型的话），
 * 并删掉裁剪后开头的助手消息——对话必须以 user 起头。
 */
export function trimMessages(bubbles: QaBubble[]): QaRequestMessage[] {
  const usable = bubbles
    .filter((bubble) => !bubble.isNotice)
    .map((bubble) => ({ role: bubble.role, text: bubble.text.slice(0, MAX_MESSAGE_CHARS) }));
  const tail = usable.slice(Math.max(0, usable.length - MAX_REQUEST_MESSAGES));
  while (tail.length > 0 && tail[0].role !== 'user') tail.shift();
  return tail;
}

/** 组装一次云函数调用的事件。 */
export function buildQaRequest(
  department: Department,
  bubbles: QaBubble[],
): Record<string, unknown> {
  return {
    action: 'chat',
    feature: QA_FEATURE,
    system: buildSystemPrompt(department),
    messages: trimMessages(bubbles),
  };
}

// ---------------------------------------------------------------------------
// 防幻觉守卫
// ---------------------------------------------------------------------------

/**
 * 未公布字段的否定表述：出现在关键词附近就认为回答在如实说明「没有公布」，
 * 不算断言。（`没有` 单列是为了放过「没有该组织的联系方式」这类说法。）
 */
const NEGATIONS = [
  '未公布', '没有公布', '不公布', '未公开', '未提供', '暂无', '尚未', '未收录',
  '未标注', '未说明', '未提及', '不对外', '无公开', '未知', '没有', '官网未',
];

/** 联系方式关键词：附近没有否定表述就认为回答在给出联系方式。 */
const CONTACT_TERMS = ['联系方式', '联系电话', '联系邮箱', '电话号码', '办公地点', '办公地址', '公众号', '微信号', 'QQ群', 'QQ号'];
/** 人员类关键词：官网未以「负责人」形式公布任何姓名。 */
const ROLE_TERMS = ['负责人', '指导老师', '秘书长', '站长', '队长'];
/** 号码与邮箱：无论上下文都按断言处理——学校招生热线不能当学生组织联系方式。 */
const PHONE_PATTERN = /(?:\+?86[-\s]?)?(?:0\d{2,3}[-\s]?\d{7,8}|1[3-9]\d{9}|\d{7,8})/u;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/u;
/** 具体校区名：资料没写校区时，出现校区名就是编造（「官网未公布所属校区」不含校区名）。 */
const CAMPUS_PATTERN = /(广州|清远|广清)[^。；！？\n]{0,6}?校区/u;
/** 成立年份断言。 */
const FOUNDED_PATTERN = /(?:成立于|创办于|创建于|组建于|成立时间)[^。；！？\n]{0,8}?(\d{4})/u;
/** 网址：只允许资料里已有的链接。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。；、）)】\]]+/giu;

export interface GuardResult {
  /** 最终展示给用户的文本：通过守卫时是模型原文，否则是如实回答。 */
  text: string;
  /** 是否被替换。 */
  replaced: boolean;
  /** 命中的规则名，便于评估时统计与排查。 */
  reasons: string[];
}

/** 被守卫拦下时展示的文本：如实说明没有公布，并指向来源链接。 */
export function unsupportedAnswerText(department: Department): string {
  return `${department.name}的这一项官网未公布。已核实资料里没有这条信息，我不能推测或补全，可以打开页面上的来源链接自行核对。`;
}

/** 关键词附近（前后各一段）没有否定表述，就认为回答在断言该字段的值。 */
function assertsAround(text: string, term: string): boolean {
  const before = 10;
  const after = 16;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const window = text.slice(Math.max(0, at - before), at + term.length + after);
    if (!NEGATIONS.some((word) => window.includes(word))) return true;
    from = at + term.length;
  }
}

/** 答案里的号码/邮箱是否是资料里已有的联系方式；资料没有联系方式时任何号码都算编造。 */
function assertsUnpublishedContact(text: string, department: Department): boolean {
  const allowed = department.contacts.map((item) => item.value.replace(/[\s-]/gu, ''));
  const found: string[] = [];
  for (const pattern of [PHONE_PATTERN, EMAIL_PATTERN]) {
    const match = text.match(pattern);
    if (match !== null) found.push(match[0].replace(/[\s-]/gu, ''));
  }
  if (found.length === 0) return false;
  if (allowed.length === 0) return true;
  return found.some((value) => !allowed.some((one) => value.includes(one) || one.includes(value)));
}

/** 答案里的链接是否出自资料。 */
function assertsUnverifiedLink(text: string, department: Department): boolean {
  const found = text.match(URL_PATTERN);
  if (found === null) return false;
  const allowed = [
    departmentsSource.sourceUrl,
    department.sourceUrl,
    department.campusSourceUrl,
    ...department.activities.map((activity) => activity.sourceUrl),
  ].filter((url): url is string => typeof url === 'string' && url !== '');
  return found.some((url) => !allowed.some((one) => one.startsWith(url) || url.startsWith(one)));
}

/** 成立年份：资料里没有写成立时间的组织，任何成立时间都算编造。 */
function assertsUnfoundedYear(text: string, department: Department): boolean {
  const match = FOUNDED_PATTERN.exec(text);
  if (match === null) return false;
  const allowed = yearsIn(department.introduction);
  return !allowed.includes(match[1]);
}

/**
 * 复核模型输出：资料不支持的断言一律替换成如实回答。
 *
 * 覆盖范围是**未公布字段上的显式断言**（联系方式、负责人、校区、成立时间、来源链接），
 * 不覆盖自由文本里的任何形式的编造；宁可多拦也不放编造内容上屏——被拦下的措辞
 * 换成「官网未公布」在语义上仍然成立，代价是一句措辞，收益是「防幻觉」这条硬指标。
 */
export function guardAnswer(answer: string, department: Department): GuardResult {
  const text = answer.trim();
  const reasons: string[] = [];
  if (assertsUnpublishedContact(text, department)) reasons.push('contact');
  if (department.campus === null && CAMPUS_PATTERN.test(text)) reasons.push('campus');
  if (assertsUnfoundedYear(text, department)) reasons.push('founded');
  if (ROLE_TERMS.some((term) => assertsAround(text, term))) reasons.push('role');
  if (CONTACT_TERMS.some((term) => assertsAround(text, term))) reasons.push('contact-term');
  if (assertsUnverifiedLink(text, department)) reasons.push('link');
  if (reasons.length === 0) return { text, replaced: false, reasons };
  return { text: unsupportedAnswerText(department), replaced: true, reasons };
}

// ---------------------------------------------------------------------------
// 云函数调用与失败处理
// ---------------------------------------------------------------------------

interface CloudCallResponse {
  result?: unknown;
}

/** 默认调用实现：只调 `ai` 云函数，不直连模型、不带任何密钥。 */
async function callAiFunction(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof wx === 'undefined' || wx.cloud === undefined) {
    throw new Error('云开发不可用：请确认基础库版本与 app.ts 中的 wx.cloud.init');
  }
  const response = (await wx.cloud.callFunction({
    name: AI_FUNCTION_NAME,
    data,
  })) as CloudCallResponse | null | undefined;
  const result = response === null || response === undefined ? undefined : response.result;
  if (result === null || result === undefined || typeof result !== 'object') {
    throw new Error('AI 服务返回了无法识别的结果');
  }
  return result as Record<string, unknown>;
}

function failureClassOf(value: unknown): QaFailureClass | '' {
  return value === 'model_unavailable' ||
    value === 'content_rejected' ||
    value === 'quota_exhausted' ||
    value === 'invalid_request' ||
    value === 'internal'
    ? value
    : '';
}

/**
 * 调用没到云函数时的分类：函数没部署、权限没配、超时都要说清楚，
 * 但不能让用户以为部门内容坏了——失败文案里都带「资料仍可正常浏览」。
 */
export function describeCallError(error: unknown): { failureClass: QaFailureClass; message: string } {
  let raw = '';
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') raw = candidate.message;
    else if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') raw = candidate.errMsg;
  } else {
    raw = error === null || error === undefined ? '' : String(error);
  }
  if (raw !== '') console.error('部门问答调用失败：', raw);
  if (/FUNCTION_NOT_FOUND|FunctionName parameter could not be found|SERVICE_NOT_FOUND/u.test(raw)) {
    return {
      failureClass: 'model_unavailable',
      message: 'AI 助手暂时不可用（云函数尚未部署或正在部署），部门资料仍可正常浏览，请稍后重试。',
    };
  }
  if (/permission denied|-501023/u.test(raw)) {
    return {
      failureClass: 'internal',
      message: 'AI 助手暂时不可用（云函数调用权限未配置），部门资料仍可正常浏览。',
    };
  }
  if (/timeout|-504003/u.test(raw)) {
    return {
      failureClass: 'model_unavailable',
      message: 'AI 助手响应超时，请稍后重试；部门资料仍可正常浏览。',
    };
  }
  if (/云开发不可用/u.test(raw)) {
    return { failureClass: 'internal', message: `${raw}；部门资料仍可正常浏览。` };
  }
  return { failureClass: 'internal', message: FAILURE_TEXT.internal };
}

/** 云函数返回 `ok:false` 时的用户文案：优先用云函数给的，缺了才用本地兜底。 */
export function describeFailure(result: Record<string, unknown>): { failureClass: QaFailureClass; message: string } {
  const failureClass = failureClassOf(result.failureClass);
  const message = typeof result.message === 'string' && result.message.trim() !== '' ? result.message.trim() : '';
  const kind = failureClass === '' ? 'internal' : failureClass;
  return { failureClass: kind, message: message === '' ? FAILURE_TEXT[kind] : message };
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

interface QaRecord {
  bubbles: QaBubble[];
  truncation: number;
}

export interface QaStore {
  /** 列表页展示哪个部门的对话；空串表示还没选定部门。 */
  readonly activeId: string;
  readonly pending: boolean;
  messagesOf(departmentId: string): QaBubble[];
  isTruncated(departmentId: string): boolean;
  setActive(departmentId: string): void;
  reset(departmentId: string): void;
  ask(departmentId: string, question: string): Promise<QaAskResult>;
}

/**
 * 对话存放在内存里（按部门分开）：页面间跳转不丢，退出小程序即清空。
 * 不落本地存储——对话是过程内容，没必要留在设备上。
 */
export function createQaStore(call: QaCall = callAiFunction): QaStore {
  const records = new Map<string, QaRecord>();
  let activeId = '';
  let pending = false;
  let counter = 0;

  function recordOf(departmentId: string): QaRecord {
    const existing = records.get(departmentId);
    if (existing !== undefined) return existing;
    const created: QaRecord = { bubbles: [], truncation: 0 };
    records.set(departmentId, created);
    return created;
  }

  function append(departmentId: string, bubble: QaBubble): void {
    const record = recordOf(departmentId);
    record.bubbles.push(bubble);
    const limit = MAX_TURNS * 2;
    if (record.bubbles.length > limit) {
      record.truncation += record.bubbles.length - limit;
      record.bubbles.splice(0, record.bubbles.length - limit);
    }
  }

  function bubble(
    departmentId: string,
    role: QaBubble['role'],
    text: string,
    extra: Partial<QaBubble> = {},
  ): QaBubble {
    counter += 1;
    return {
      id: `${departmentId}-${counter}`,
      role,
      text,
      source: '',
      isNotice: false,
      failureClass: '',
      replaced: false,
      ...extra,
    };
  }

  return {
    get activeId() {
      return activeId;
    },
    get pending() {
      return pending;
    },
    messagesOf(departmentId: string) {
      const record = records.get(departmentId);
      return record === undefined ? [] : record.bubbles.slice();
    },
    isTruncated(departmentId: string) {
      const record = records.get(departmentId);
      return record !== undefined && record.truncation > 0;
    },
    setActive(departmentId: string) {
      activeId = departmentId;
    },
    reset(departmentId: string) {
      records.delete(departmentId);
    },
    ask(departmentId: string, question: string) {
      const department = findDepartmentById(departmentId);
      const trimmed = question.trim();
      const invalid = (message: string): QaAskResult => {
        append(departmentId, bubble(departmentId, 'assistant', message, { isNotice: true, failureClass: 'invalid_request' }));
        return { ok: false, failureClass: 'invalid_request', message, replaced: false };
      };
      if (department === null) return Promise.resolve(invalid('没有找到这个部门，可以返回列表重新选择。'));
      if (trimmed === '') return Promise.resolve(invalid('请先输入想问的问题。'));
      if (trimmed.length > MAX_QUESTION_LENGTH) {
        return Promise.resolve(invalid(`问题太长了，请精简到 ${MAX_QUESTION_LENGTH} 字以内再发送。`));
      }
      activeId = departmentId;
      append(departmentId, bubble(departmentId, 'user', trimmed));
      const request = buildQaRequest(department, recordOf(departmentId).bubbles);
      pending = true;
      return call(request)
        .then((result) => {
          if (result.ok !== true) {
            const failure = describeFailure(result);
            append(departmentId, bubble(departmentId, 'assistant', failure.message, {
              isNotice: true,
              failureClass: failure.failureClass,
            }));
            return { ok: false, failureClass: failure.failureClass, message: failure.message, replaced: false };
          }
          const text = typeof result.text === 'string' ? result.text.trim() : '';
          if (text === '') {
            const message = 'AI 没有返回内容，请换一种问法重试；部门资料仍可正常浏览。';
            append(departmentId, bubble(departmentId, 'assistant', message, { isNotice: true, failureClass: 'internal' }));
            return { ok: false, failureClass: 'internal' as QaFailureClass, message, replaced: false };
          }
          const guard = guardAnswer(text, department);
          if (guard.replaced) {
            console.warn('部门问答命中防幻觉守卫：', guard.reasons.join('、'));
          }
          append(departmentId, bubble(departmentId, 'assistant', guard.text, {
            source: sourceLineOf(department),
            replaced: guard.replaced,
          }));
          return { ok: true, failureClass: '' as const, message: '', replaced: guard.replaced };
        })
        .catch((error: unknown) => {
          const failure = describeCallError(error);
          append(departmentId, bubble(departmentId, 'assistant', failure.message, {
            isNotice: true,
            failureClass: failure.failureClass,
          }));
          return { ok: false, failureClass: failure.failureClass, message: failure.message, replaced: false };
        })
        .then((result: QaAskResult) => {
          pending = false;
          return result;
        });
    },
  };
}

/** 回答的依据行：给出资料来源与核查日期，让回答可追溯。 */
export function sourceLineOf(department: Department): string {
  return `依据：${departmentsSource.label} · 核查于 ${department.verifiedAt}`;
}

/** 全局共用的会话：列表页与详情页看到的是同一份对话。 */
export const qaStore = createQaStore();

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export interface QaPanelOption {
  id: string;
  name: string;
  campusLabel: string;
  /** 这个部门就是当前对话的部门。 */
  active: boolean;
}

export interface QaPanelView {
  scope: 'list' | 'detail';
  /** AI 的开场提示。 */
  prompt: string;
  /** 可点的部门选项（列表页）。 */
  options: QaPanelOption[];
  showOptions: boolean;
  activeId: string;
  activeName: string;
  hasActive: boolean;
  bubbles: QaBubble[];
  truncated: boolean;
  /** 追问建议（详情页）。 */
  suggestions: string[];
  showSuggestions: boolean;
  /** 最近一条是失败提示：页面在下方补一句「资料仍可浏览」。 */
  showOffline: boolean;
  pending: boolean;
  draft: string;
  canSend: boolean;
  placeholder: string;
  idleHint: string;
  offlineNote: string;
}

export interface QaPanelInput {
  scope: 'list' | 'detail';
  store: QaStore;
  /** 详情页固定为所看部门；列表页用它覆盖会话里的当前部门。 */
  departmentId?: string;
  draft?: string;
  source?: Department[];
}

/**
 * 组装对话框视图。详情页传入的部门不存在时返回 null，由页面显示未找到状态。
 * 对话内容只依赖本地会话与随包资料，AI 不可用时页面照常渲染。
 */
export function buildQaPanel(input: QaPanelInput): QaPanelView | null {
  const source = input.source ?? departments;
  const scope = input.scope;
  const detailDepartment =
    scope === 'detail' ? findDepartmentById(input.departmentId, source) : null;
  if (scope === 'detail' && detailDepartment === null) return null;
  const activeId = scope === 'detail' ? (detailDepartment as Department).id : input.store.activeId;
  const active = findDepartmentById(activeId, source);
  const bubbles = active === null ? [] : input.store.messagesOf(active.id);
  const draft = input.draft ?? '';
  return {
    scope,
    prompt:
      scope === 'detail' && active !== null
        ? `关于${active.name}，你想了解什么？我只依据官网已核实的资料回答，资料里没有的会说「${NOT_PUBLISHED_TEXT}」。`
        : `你想了解什么部门？我从学校官网已核实的资料里回答，资料里没有的会说「${NOT_PUBLISHED_TEXT}」。`,
    options:
      scope === 'list'
        ? source.map((item) => ({
            id: item.id,
            name: item.name,
            campusLabel: item.campus ?? '官网未标注所属校区',
            active: item.id === activeId,
          }))
        : [],
    showOptions: scope === 'list',
    activeId: active === null ? '' : active.id,
    activeName: active === null ? '' : active.name,
    hasActive: active !== null,
    bubbles,
    truncated: active !== null && input.store.isTruncated(active.id),
    suggestions: active === null ? [] : suggestQuestions(active),
    showSuggestions: scope === 'detail' && active !== null,
    showOffline: bubbles.length > 0 && bubbles[bubbles.length - 1].isNotice,
    pending: input.store.pending,
    draft,
    canSend: active !== null && !input.store.pending && draft.trim() !== '',
    placeholder: active === null ? '先选一个部门' : `继续问${active.name}…`,
    idleHint:
      '点一个部门进入它的页面，就可以继续追问了；返回这里对话不会丢。',
    offlineNote: OFFLINE_NOTE,
  };
}
