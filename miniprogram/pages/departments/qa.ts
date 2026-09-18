/**
 * 部门 AI 问答的纯逻辑（页面只绑定数据，规则在这里，便于用 node:test 直接验证）。
 *
 * 答案只能建立在 services/departments.ts 的已核实语料上：语料组装进系统提示词，
 * 模型被要求「资料里没有的信息一律回答官网未公布，绝不编造联系方式/负责人/所属校区」，
 * 回答可注明「来源：学校官网学生组织页面」——全项目「不编造」纪律的直接落点
 * （docs/development-spec.md「AI 功能」与 Ticket 07）。
 *
 * 提示词纪律之外还有两道**客户端后置检查**：
 * - `guardAnswer`：确定性复核模型输出，命中就**整条替换**成如实回答（见该函数上方的
 *   「能发现 / 不能发现」清单；它不构成「不会编造」的事实性保证）；
 * - `safetyNoteFor`：服务端内容安全没有真正执行（`checked !== true`）时在对话里明说。
 */
import {
  ChatMessage,
  MAX_HISTORY,
  UNCHECKED_SAFETY_NOTE,
  chatMessages,
  safetyChecked,
  safetyNoteFor,
} from '../../services/ai';
import {
  Department,
  MISSING_CAMPUS_TEXT,
  departments,
  departmentsSource,
  findDepartmentById,
} from '../../services/departments';

// 对话历史裁剪、消息形状与「未检测」提示行统一放在 services/ai.ts（05/06/07 共用一份），
// 这里原样转出，页面与既有测试的引用路径不变。
export { MAX_HISTORY, UNCHECKED_SAFETY_NOTE, chatMessages, safetyChecked, safetyNoteFor };

/** 资料里没有的信息一律用这句话回答——验收要求「明确回答官网未公布」（同 PR #29）。 */
export const NOT_PUBLISHED_TEXT = '官网未公布';

/** AI 主动询问的欢迎语；措辞与 Ticket 07 验收第一条一致，并说明资料没有的会答什么。 */
export const WELCOME_TEXT = '你想了解什么部门？我从学校官网已核实的资料里回答，资料里没有的会说'
  + `「${NOT_PUBLISHED_TEXT}」。可以点下面的选项进入对应页面，也可以直接打字问我。`;

/** 详情页的开场提示：把对话范围收到当前部门（移植自 PR #29 的详情页问答面板）。 */
export function departmentPromptFor(name: string): string {
  return `关于${name}，你想了解什么？我只依据官网已核实的资料回答，资料里没有的会说「${NOT_PUBLISHED_TEXT}」。`;
}

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
 * 提示行与判定函数本身在 `services/ai.ts`（05/06/07 共用），这里只保留引用。
 */

/**
 * 模型不可用时页面上要说明「资料仍可看」——不能让人以为整个部门模块坏了
 * （文案移植自 PR #29；开发者工具验收按 `#qa-offline` 与「仍可正常查看」判定）。
 */
export const QA_OFFLINE_NOTE = '部门资料随小程序包提供，AI 不可用时仍可正常查看列表与详情。';

/** 回答里出现语料之外的联系方式时的提示行（后置标记，不是「已确认编造」的结论）。 */
export const FABRICATED_CONTACT_NOTE = '⚠️ 这条回答出现了资料里没有的联系方式，请以官网为准，不要直接使用。';

/**
 * 被防幻觉守卫拦下时的提示行（联系方式以外的命中类别）。
 * 同样只是**标记**：它说明这条回答没上屏、换成了如实回答，不是「检测过就一定没错」。
 */
export const GUARD_NOTE = '⚠️ 这条回答被防幻觉复核拦下：它提到了已核实资料里没有的内容，已换成如实回答，请以官网资料为准。';

export interface QaOption {
  id: string;
  name: string;
  /** 选项上的校区说明，与名录条目同一口径（官网未标注时给缺失文案）。 */
  campusLabel: string;
  /** 当前对话就在这个部门（列表页高亮用）。 */
  active: boolean;
}

/**
 * 一条对话轮次：页面展示用，比服务端消息形状多几个标记字段。
 * 消息形状本身来自 `services/ai.ts` 的 `ChatMessage`，两边不再各写一份。
 */
export type ChatTurn = ChatMessage & {
  /** 上屏时附在这条回答下的提示行（命中守卫或出现语料外联系方式时才有）。 */
  warning?: string;
  /** 被守卫替换过：`text` 是替换后的如实回答，这里留模型原话。 */
  modelText?: string;
  /** 被守卫替换过（只有替换过才出现这个字段）。 */
  replaced?: boolean;
};

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
export function buildWelcome(activeId = ''): { text: string; options: QaOption[] } {
  return {
    text: WELCOME_TEXT,
    options: departments.map((department) => ({
      id: department.id,
      name: department.name,
      campusLabel: department.campus ?? MISSING_CAMPUS_TEXT,
      active: department.id === activeId,
    })),
  };
}

/**
 * 详情页的追问建议（移植自 PR #29）：三个已公布字段加一个未公布字段，
 * 正好把「官网未公布」这条路径演示出来。
 */
export function suggestQuestions(department: Department): string[] {
  return [
    `${department.name}下设哪些部门？`,
    `${department.name}最近有什么动态？`,
    `${department.name}属于哪个校区？`,
    `${department.name}的联系方式是什么？`,
  ];
}

/** 页脚来源说明；本轮未真正检测时补一句，避免脚注被读成「这次也检过了」。 */
export function sourceNoteFor(safety: { checked: boolean } | null | undefined): string {
  return safetyChecked(safety)
    ? QA_SOURCE_NOTE
    : QA_SOURCE_NOTE + ' 另：本轮回答未经内容安全检测。';
}

// ---------------------------------------------------------------------------
// 联系方式记号扫描（Ticket 07 两轴复核补；PR #29 的守卫在这同一套规则上合并）
// ---------------------------------------------------------------------------

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

export interface ContactHit {
  label: string;
  token: string;
}

/**
 * 扫出回答里出现、但**不在已核实语料里**的联系方式记号（带类别名，便于提示里说明是什么）。
 *
 * 这是本文件里**唯一**一处联系方式记号识别规则：既供 `findUnverifiedContacts` 返回记号清单，
 * 也供 `guardAnswer` 判定是否整条替换（PR #29 的号码 / 邮箱正则属于同一类检查，
 * 已并入这里，不再各写一份）。
 */
function scanContacts(answer: string, corpus: string): ContactHit[] {
  const haystack = compact(corpus);
  const found: ContactHit[] = [];
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

// ---------------------------------------------------------------------------
// 防幻觉守卫（移植自 PR #29，原作者 SU5114；联系方式一路改与上面的扫描规则合并）
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
/** 具体校区名：资料没写校区时，出现校区名就是编造（「官网未公布所属校区」不含校区名）。 */
const CAMPUS_PATTERN = /(广州|清远|广清)[^。；！？\n]{0,6}?校区/u;
/** 成立年份断言。 */
const FOUNDED_PATTERN = /(?:成立于|创办于|创建于|组建于|成立时间)[^。；！？\n]{0,8}?(\d{4})/gu;
/** 网址：只允许资料里已有的链接。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。；、）)】\]]+/giu;

/** 守卫命中的类别（写进日志与替换文案，便于评估时统计）。 */
export type GuardReason =
  | '联系方式记号'
  | '联系方式表述'
  | '负责人表述'
  | '校区表述'
  | '成立时间'
  | '资料外链接';

export interface GuardHit {
  reason: GuardReason;
  /** 命中的具体记号（关键词类命中时是关键词本身）。 */
  token: string;
}

export interface GuardResult {
  /** 上屏文本：没命中时是模型原文（去掉首尾空白），命中时是如实回答。 */
  text: string;
  /** 是否被整条替换。 */
  replaced: boolean;
  /** 命中类别（去重）。 */
  reasons: GuardReason[];
  /** 命中的具体记号，便于排查与评估统计。 */
  hits: GuardHit[];
  /** 上屏时附在回答下的提示行；没有命中时为空串。 */
  note: string;
}

export interface GuardOptions {
  /** 可信语料文本；默认取随包的已核实语料（`buildCorpusText()`）。 */
  corpus?: string;
  /** 追问的是哪个部门；给出时替换文案会点名该部门，校区检查按这个部门判定。 */
  department?: Department | null;
}

/**
 * 确定性的防幻觉复核：命中任何一条就把**整条回答**换成如实回答（不是只加提示行）。
 *
 * **能发现**（命中即整条替换，替换文案里点出命中的记号）：
 * - 联系方式记号：手机号 / 座机 / QQ 号 / 微信号 / 邮箱，且这串记号不在已核实语料里；
 * - 联系方式表述：「联系方式」「联系电话」「办公地点」「公众号」等关键词附近没有否定表述；
 * - 负责人表述：「负责人」「指导老师」「秘书长」「站长」「队长」等称谓附近没有否定表述；
 * - 校区表述：语料里没有的校区名；能认出回答在讲哪个部门（调用方给了部门，或回答里只提到
 *   一个组织）且该部门资料写明「未标注所属校区」时，任何校区名都算编造；
 * - 成立时间：「成立于 / 创办于 / 组建于 / 成立时间」后面的年份不在语料出现过的成立年份里；
 * - 资料外链接：回答里的网址不在已核实来源链接（含各组织与动态的来源链接）里。
 *
 * **不能发现**（不要读成「不会编造」）：
 * - 不带上述关键词的编造：直接写出的负责人姓名（「张三负责值班」）、招新时间
 *   （「9 月 1 日开始招新」）、活动细节、对资料的错误转述，一律管不了；
 * - 与资料不符但形态合法的内容：给 A 组织安上 B 组织的号码（号码本身在语料里）、
 *   把已公布字段写错，本守卫看不出来；
 * - 校区名只认语料里出现过的写法（「广州 / 清远 / 广清 + 校区」），
 *   「南校区」「校本部」这类别的写法不会被当成校区表述；
 * - 命中只按关键词与记号判断，**分不清「引用资料」与「编造」**：
 *   像「可以联系该组织的负责人了解」这种建议式说法也可能被拦下（代价是一句措辞，
 *   收益是无依据的断言不上屏）；
 * - 真实的编造率仍要按评估表人工判定；守卫只是上屏前的最后一道闸，不是达标证据。
 *
 * 替换只作用于**展示给学生的回答**：调用方要把模型原话留在 `ChatTurn.modelText`，
 * 让下一轮送进模型的历史保持原样（见 `historyMessages`）。
 */
export function guardAnswer(answer: string, options: GuardOptions = {}): GuardResult {
  const corpus = options.corpus === undefined ? buildCorpusText() : options.corpus;
  const department = options.department === undefined ? null : options.department;
  const text = answer.trim();
  const hits: GuardHit[] = [];

  for (const hit of scanContacts(text, corpus)) {
    hits.push({ reason: '联系方式记号', token: hit.token });
  }
  for (const term of CONTACT_TERMS) {
    if (assertsAround(text, term)) hits.push({ reason: '联系方式表述', token: term });
  }
  for (const term of ROLE_TERMS) {
    if (assertsAround(text, term)) hits.push({ reason: '负责人表述', token: term });
  }
  for (const token of unsupportedCampuses(text, corpus, department)) {
    hits.push({ reason: '校区表述', token });
  }
  const year = unfoundedYear(text, corpus);
  if (year !== '') hits.push({ reason: '成立时间', token: year });
  for (const url of unverifiedLinks(text, corpus)) {
    hits.push({ reason: '资料外链接', token: url });
  }

  const reasons = hits
    .map((hit) => hit.reason)
    .filter((reason, index, all) => all.indexOf(reason) === index);
  if (hits.length === 0) return { text, replaced: false, reasons, hits, note: '' };
  const contactTokens = hits.filter((hit) => hit.reason === '联系方式记号');
  return {
    text: unsupportedAnswerText(department, hits, reasons),
    replaced: true,
    reasons,
    hits,
    // 有语言记号时沿用既有的记号级提示行（点出是哪个号码 / 邮箱），其余用一句总说明。
    note: contactTokens.length > 0 ? contactWarningFor(text, corpus) : GUARD_NOTE,
  };
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

/** 语料里出现过的成立年份：只取「成立于…」这类上下文里的四位年份，不把活动日期算进来。 */
function foundedYearsIn(corpus: string): string[] {
  const years: string[] = [];
  const pattern = new RegExp(FOUNDED_PATTERN.source, FOUNDED_PATTERN.flags);
  let match = pattern.exec(corpus);
  while (match !== null) {
    years.push(match[1]);
    match = pattern.exec(corpus);
  }
  return years;
}

/** 回答里的成立时间断言：年份不是语料里的成立年份（或语料根本没写）就算编造。 */
function unfoundedYear(text: string, corpus: string): string {
  const pattern = new RegExp(FOUNDED_PATTERN.source, FOUNDED_PATTERN.flags);
  const match = pattern.exec(text);
  if (match === null) return '';
  return foundedYearsIn(corpus).includes(match[1]) ? '' : match[1];
}

/**
 * 回答里唯一提到的那个组织。
 *
 * 列表页的自由提问没有部门上下文，用它把校区检查收紧一档；提到多个组织或一个都没提到时
 * 返回 null，退回语料级判定（见 `unsupportedCampuses`）。
 */
function departmentInAnswer(text: string): Department | null {
  const mentioned = departments.filter((department) => text.includes(department.name));
  return mentioned.length === 1 ? mentioned[0] : null;
}

/**
 * 回答里语料不支持的校区名。
 *
 * 判定按「这个回答在讲哪个部门」来定：调用方给了部门就用它；列表页没给时，若回答里只提到
 * 一个组织就按那个组织判（编造校区正是「给 A 组织安上 B 组织的校区」这类错误）。
 * 部门资料写明校区的，允许资料里那几个；资料写「未标注所属校区」的，任何校区名都是编造。
 * 连组织都认不出来时才退回语料级：只拦语料整体都没有的校区名，弱一档。
 */
function unsupportedCampuses(text: string, corpus: string, department: Department | null): string[] {
  const found = text.match(new RegExp(CAMPUS_PATTERN.source, CAMPUS_PATTERN.flags));
  if (found === null) return [];
  const scope = department === null ? departmentInAnswer(text) : department;
  const allowed = scope === null
    ? compact(corpus)
    : compact(scope.campus === null ? '' : scope.campus + scope.campusNote);
  return found.filter((token, index) => !allowed.includes(compact(token)) && found.indexOf(token) === index);
}

/** 回答里的链接是否出自资料：语料里出现的链接与各来源链接（含动态）都算已核实。 */
function unverifiedLinks(text: string, corpus: string): string[] {
  const found = text.match(new RegExp(URL_PATTERN.source, URL_PATTERN.flags));
  if (found === null) return [];
  // target 是 ES2017（小程序基础库），不用 flatMap，手写一层展开。
  const known: string[] = [departmentsSource.sourceUrl];
  for (const department of departments) {
    known.push(department.sourceUrl);
    if (department.campusSourceUrl !== null) known.push(department.campusSourceUrl);
    for (const activity of department.activities) known.push(activity.sourceUrl);
  }
  const allowed = [compact(corpus)].concat(known.map(compact));
  return found.filter((url, index) => {
    const token = compact(url);
    return found.indexOf(url) === index && !allowed.some((one) => one.includes(token) || token.includes(one));
  });
}

/** 被守卫拦下时展示的文本：如实说明没有依据、按「官网未公布」处理，并指向来源链接。 */
export function unsupportedAnswerText(
  department: Department | null,
  hits: GuardHit[] = [],
  reasons: GuardReason[] = [],
): string {
  const scope = department === null ? '这条回答' : `${department.name}的这条回答`;
  const detail = hits.length > 0
    ? hits.map((hit) => `${hit.reason}「${hit.token}」`).join('、')
    : reasons.join('、');
  return `${scope}里出现了已核实资料中没有的内容（${detail}），已按「${NOT_PUBLISHED_TEXT}」`
    + '处理：资料里没有的信息不能推测或补全，请以页面上的来源链接为准。';
}

/** vm 沙箱里（node:test 直接加载纯逻辑时）没有 console，日志不能让它抛错。 */
function warn(message: string, detail: string): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(message, detail);
  }
}

/**
 * 把模型回答变成上屏的一条助手轮次：过一遍守卫，命中就整条替换并带上提示行。
 *
 * 替换只改 `text`（学生看到的回答）：模型原话留在 `modelText`，供下一轮历史使用。
 */
export function guardTurn(answer: string, departmentId: string): ChatTurn {
  const guard = guardAnswer(answer, { department: findDepartmentById(departmentId) });
  const turn: ChatTurn = { role: 'assistant', text: guard.text };
  if (guard.note !== '') turn.warning = guard.note;
  if (guard.replaced) {
    turn.replaced = true;
    turn.modelText = answer.trim();
    warn('部门问答命中防幻觉守卫：', guard.reasons.join('、'));
  }
  return turn;
}

/**
 * 送进模型的历史：被守卫替换过的回答用**模型原话**（`modelText`）。
 *
 * 守卫替换的是展示给学生的回答，不能改写送进模型的上下文——否则模型会以为
 * 自己说过「官网未公布」，下一轮追问就容易顺着这句假上下文走。
 */
export function historyMessages(history: ChatTurn[]): ChatMessage[] {
  return chatMessages(history.map((turn) => ({
    role: turn.role,
    text: turn.modelText === undefined ? turn.text : turn.modelText,
  })));
}

// ---------------------------------------------------------------------------
// 会话：列表页与详情页共用同一份对话
// ---------------------------------------------------------------------------

/**
 * 列表页与详情页共用一份对话（移植自 PR #29 的会话能力：点选项进详情页追问，
 * 返回列表后对话不丢、可以直接接着问）。
 *
 * 按部门分开存放：不同部门的上下文不混；`''` 键表示列表页里还没选定部门的对话。
 * 只存在内存里（退出小程序即清空），不落本地存储——对话是过程内容，没必要留在设备上。
 */
const conversations = new Map<string, ChatTurn[]>();

/** 对话开头那句（也是发给模型的第一条助手消息）：列表页是欢迎语，部门页是部门提示。 */
export function conversationHeadText(departmentId: string): string {
  const department = findDepartmentById(departmentId);
  return department === null ? WELCOME_TEXT : departmentPromptFor(department.name);
}

function turnsOf(departmentId: string): ChatTurn[] {
  const existing = conversations.get(departmentId);
  if (existing !== undefined) return existing;
  const created: ChatTurn[] = [{ role: 'assistant', text: conversationHeadText(departmentId) }];
  conversations.set(departmentId, created);
  return created;
}

/** 取某部门的对话（副本）；还没有就以开场白新建一份。 */
export function conversationOf(departmentId: string): ChatTurn[] {
  return turnsOf(departmentId).slice();
}

/** 追加一轮（用户提问或助手回答）。 */
export function appendTurn(departmentId: string, turn: ChatTurn): void {
  turnsOf(departmentId).push(turn);
}

/** 清空某部门的对话：下次取时以开场白重建。 */
export function resetConversation(departmentId: string): void {
  conversations.delete(departmentId);
}

/** 清空所有会话（测试用：模块级状态会让用例之间互相影响）。 */
export function resetAllConversations(): void {
  conversations.clear();
}

/** 页面 setData 用的对话框数据（列表页与详情页同一份，字段名与共用模板一一对应）。 */
export function qaPanelPatch(input: {
  departmentId: string;
  /** 列表页给 5 个可点选项；详情页给空数组（追问建议由 `qaSuggestionList` 给）。 */
  withOptions?: boolean;
}): {
    qaDepartmentId: string;
    qaPrompt: string;
    qaMessages: ChatTurn[];
    qaOptions: QaOption[];
    qaSuggestionList: string[];
    qaOfflineNote: string;
  } {
  const department = findDepartmentById(input.departmentId);
  return {
    qaDepartmentId: input.departmentId,
    qaPrompt: conversationHeadText(input.departmentId),
    qaMessages: conversationOf(input.departmentId),
    qaOptions: input.withOptions === true ? buildWelcome(input.departmentId).options : [],
    qaSuggestionList: department === null ? [] : suggestQuestions(department),
    qaOfflineNote: QA_OFFLINE_NOTE,
  };
}

/**
 * 「用户已经主动关掉过对话框」的持久标记（列表页与详情页共用一条）。
 *
 * Ticket 07 要求进入部门模块就出现对话框并主动问「你想了解什么部门」，
 * 因此页面首次显示时自动展开一次；但用户明确关掉之后不该反复弹——
 * 标记写在本地存储里，之后（含下次进入、含部门详情页）由用户主动点开。
 */
export const QA_DISMISS_KEY = 'departments-qa-dismissed';

export function qaDismissed(): boolean {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return false;
    return wx.getStorageSync(QA_DISMISS_KEY) === true;
  } catch {
    // 存储读失败按「没关过」处理：自动展开一次比永久不再提示更符合票面要求。
    return false;
  }
}

export function markQaDismissed(): void {
  try {
    if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return;
    wx.setStorageSync(QA_DISMISS_KEY, true);
  } catch {
    // 写失败只影响「下次不再自动展开」这一便利，不影响本次关闭。
  }
}
