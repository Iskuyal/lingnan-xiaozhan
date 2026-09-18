/**
 * 部门 AI 问答的纯逻辑（页面只绑定数据，规则在这里，便于用 node:test 直接验证）。
 *
 * 答案只能建立在 services/departments.ts 的已核实语料上：语料组装进系统提示词，
 * 模型被要求「资料里没有的信息一律回答官网未公布，绝不编造联系方式/负责人/所属校区」，
 * 回答可注明「来源：学校官网学生组织页面」——全项目「不编造」纪律的直接落点
 * （docs/development-spec.md「AI 功能」与 Ticket 07）。
 *
 * 提示词纪律之外还有两道**客户端后置检查**（Ticket 07 两轴复核补）：
 * - `findUnverifiedContacts`：回答里出现语料之外的联系方式类记号时标记这条回答；
 * - `safetyNoteFor`：服务端内容安全没有真正执行（`checked: false`）时在对话里明说。
 * 两者都只是**后置标记**，不构成「不会编造」「已检干净」的事实性保证。
 */
import { ChatMessage } from '../../services/ai';
import { Department, departments, departmentsSource } from '../../services/departments';

/** AI 主动询问的欢迎语；措辞与 Ticket 07 验收第一条一致。 */
export const WELCOME_TEXT = '你想了解什么部门？可以点下面的选项进入对应页面，也可以直接打字问我。';

/**
 * 对话底部固定的来源说明。
 *
 * 只说**语料来源**：这批资料经学校官网核实、核查日期明确；但回答由模型生成，
 * 不等于「这句话本身已被逐条核实」。写成「回答依据：已核实资料」容易被读成后者，
 * 因此这里把两件事分开写，并指向官网原文。
 */
export const QA_SOURCE_NOTE = 'AI 答案的依据是学校官网已核实的学生组织资料（核查于 '
  + departmentsSource.verifiedAt
  + '）；资料里没有的内容会回答「官网未公布」。这只是语料来源，不代表每句回答都已逐字核对，请以官网原文为准。';

/**
 * 服务端内容安全没有真正执行时的提示行（`safety.checked === false`）。
 *
 * 依据 docs/cloud-development.md：`checked: false` 表示这次没有真正检测
 * （`AI_SAFETY_PROVIDER=off` 或 `AI_SAFETY_FAIL_MODE=open` 放行未检内容、长文本只检了前一段），
 * 调用方与日志都不得把「跳过」读成「干净」——所以要在对话里明说。
 */
export const UNCHECKED_SAFETY_NOTE = '⚠️ 本轮回答没有经过内容安全检测（服务端未执行或跳过了检测），请谨慎参考。';

/** 回答里出现语料之外的联系方式时的提示行（后置标记，不是「已确认编造」的结论）。 */
export const FABRICATED_CONTACT_NOTE = '⚠️ 这条回答出现了资料里没有的联系方式，请以官网为准，不要直接使用。';

/** 多轮历史最多带多少条（与 ai 云函数 MAX_MESSAGES=20 对齐）。 */
export const MAX_HISTORY = 20;

export interface QaOption {
  id: string;
  name: string;
}

/**
 * 一条对话轮次：页面展示用，比服务端消息形状多一个可选的「已标记」提示。
 * 消息形状本身来自 `services/ai.ts` 的 `ChatMessage`，两边不再各写一份。
 */
export type ChatTurn = ChatMessage & { warning?: string };

/** 单个组织的语料段落：缺失字段如实标注「官网未公布」，不写任何推测值。 */
function corpusSection(department: Department): string {
  const lines: string[] = [
    '【' + department.name + '】',
    department.campus === null ? '所属校区：官网未标注所属校区' : '所属校区：' + department.campus,
    '简介：' + department.introduction,
    '下设部门：' + department.units.join('、'),
  ];
  if (department.contacts.length === 0) {
    lines.push('联系方式：官网未公布联系方式');
  } else {
    lines.push('联系方式：' + department.contacts.map((contact) => contact.label + '：' + contact.value).join('；'));
  }
  if (department.activities.length === 0) {
    lines.push('活动动态：官网暂未收录该组织的活动动态');
  } else {
    lines.push('活动动态：' + department.activities
      .map((activity) => activity.title + '（' + activity.publishedAt + '）')
      .join('；'));
  }
  return lines.join('\n');
}

/** 已核实语料全文：来源链接与核查日期在前，五个组织的事实按统一结构列出。 */
export function buildCorpusText(): string {
  const head = '以下是从学校官网核实的学生组织资料（来源：' + departmentsSource.label + ' '
    + departmentsSource.sourceUrl + '，核查日期 ' + departmentsSource.verifiedAt + '）。';
  return [head].concat(departments.map(corpusSection)).join('\n\n');
}

/** 系统提示词：角色约束 + 「不编造」纪律 + 完整语料。语料约两千字，每次追问都带全量。 */
export function buildSystemPrompt(): string {
  return [
    '你是校园学生部门问答助手，只能依据下面「已核实资料」回答。',
    '必须遵守：',
    '1. 资料里有的内容，按资料回答，必要时注明「来源：学校官网学生组织页面」；',
    '2. 资料里没有的信息（例如联系方式、负责人、所属校区、招新时间等），一律回答「官网未公布」，绝不编造；',
    '3. 不要添加资料之外的任何信息，不要推测，不要替学校承诺任何事项。',
    '',
    buildCorpusText(),
  ].join('\n');
}

/** 打开对话时的欢迎消息与可点选项（选项来自已核实名录，点击进对应详情页）。 */
export function buildWelcome(): { text: string; options: QaOption[] } {
  return {
    text: WELCOME_TEXT,
    options: departments.map((department) => ({ id: department.id, name: department.name })),
  };
}

/** 把页面上的多轮历史映射成 ai 云函数的消息数组，只保留最近 MAX_HISTORY 条。 */
export function chatMessages(history: ChatTurn[]): ChatMessage[] {
  return history.slice(-MAX_HISTORY).map((turn) => ({ role: turn.role, text: turn.text }));
}

/**
 * 服务端内容安全是否**真的执行过**。
 *
 * 只有 `safety.checked === true` 才算检测过：字段缺失、`safety` 为 null、
 * `checked: false`（检测被关闭/跳过/只检了一段）一律按「未检测」处理，
 * 宁可多提示一次，也不把跳过读成干净。
 */
export function safetyChecked(safety: { checked: boolean } | null | undefined): boolean {
  return safety !== null && safety !== undefined && safety.checked === true;
}

/** 未真正检测时对话里显示的提示行；检测过则为空串（页面据此隐藏该行）。 */
export function safetyNoteFor(safety: { checked: boolean } | null | undefined): string {
  return safetyChecked(safety) ? '' : UNCHECKED_SAFETY_NOTE;
}

/** 页脚来源说明；本轮未真正检测时补一句，避免脚注被读成「这次也检过了」。 */
export function sourceNoteFor(safety: { checked: boolean } | null | undefined): string {
  return safetyChecked(safety)
    ? QA_SOURCE_NOTE
    : QA_SOURCE_NOTE + ' 另：本轮回答未经内容安全检测。';
}

/**
 * 联系方式类记号的识别规则：手机号、座机、QQ / 微信号、邮箱。
 *
 * 只认**带标签或带固定格式**的写法（QQ / 微信必须带出「号」的上下文），
 * 不把任意数字串当联系方式，避免误伤（例如活动日期、场地编号）。
 * 不用后置断言 `(?<!…)`：部分 iOS 的 JSCore 不支持，正则在页面加载时就会抛语法错误。
 */
const CONTACT_RULES: { label: string; pattern: RegExp }[] = [
  { label: '手机号', pattern: /\b1[3-9]\d{9}\b/gu },
  { label: '座机', pattern: /\b0\d{2,3}-\d{7,8}\b/gu },
  { label: 'QQ', pattern: /(?:QQ|qq|Qq)\s*(?:号|号码)?\s*[:：]?\s*(\d{5,12})/gu },
  { label: '微信', pattern: /(?:微信|WeChat|wechat|Weixin|weixin|WX|wx)\s*(?:号|号码)?\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,19})/gu },
  { label: '邮箱', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
];

/** 去掉空白后比较：语料里写「138 0013 8000」而回答写「13800138000」不算编造。 */
function compact(text: string): string {
  return text.replace(/\s+/gu, '');
}

/**
 * 扫出回答里出现、但**不在已核实语料里**的联系方式记号（带类别名，便于提示里说明是什么）。
 */
function scanContacts(answer: string, corpus: string): { label: string; token: string }[] {
  const haystack = compact(corpus);
  const found: { label: string; token: string }[] = [];
  for (const rule of CONTACT_RULES) {
    // 每次新建正则，避免带 g 标志的 lastIndex 在调用之间残留。
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(answer);
    while (match !== null) {
      const token = match[1] === undefined ? match[0] : match[1];
      const seen = found.some((hit) => hit.token === token);
      if (token !== '' && !haystack.includes(compact(token)) && !seen) {
        found.push({ label: rule.label, token });
      }
      match = pattern.exec(answer);
    }
  }
  return found;
}

/**
 * 找出回答里出现、但**不在已核实语料里**的联系方式记号。
 *
 * 返回空数组只表示「没发现这类记号」，不是「回答一定正确」：模型可能编造别的东西，
 * 也可能把语料里的号码改了中间一位（那时仍会被本函数标出）。
 */
export function findUnverifiedContacts(answer: string, corpus: string = buildCorpusText()): string[] {
  return scanContacts(answer, corpus).map((hit) => hit.token);
}

/** 回答里的联系方式后置标记；没有可疑记号时返回空串。 */
export function contactWarningFor(answer: string, corpus: string = buildCorpusText()): string {
  const hits = scanContacts(answer, corpus);
  if (hits.length === 0) return '';
  const detail = hits.map((hit) => hit.label + '「' + hit.token + '」').join('、');
  return FABRICATED_CONTACT_NOTE + '（' + detail + '）';
}
