/**
 * 升学问答（Issue #94 模型版）的服务端约束：**可信段落注册表 + 出处校验**。
 *
 * 这一版与「本地原文检索」的差别只有一处：回答交给模型解释。因此风险也从
 * 「检索不到」变成「模型补出原文里没有的日期、条件与数字」。本模块就是这条风险的闸门：
 *
 * 1. **语料在服务端**（`scripts/build.mjs` 从 `docs/evidence/advancement-poc/corpus.json`
 *    生成 `dist/cloudfunctions/ai/advancement-corpus.js`）。调用方只能给**段落 id**，
 *    段落正文一律取服务端自己那一份——客户端传不了「官方原文」。
 * 2. **范围由服务端复核**：类别/年份/地区必须与所选段落的文档元信息一致，
 *    不一致按参数错误拒绝（fail-closed），不给模型任何不该答的题。
 * 3. **回答上屏前逐句校验**：含日期/数字或官方事实关键词的句子必须带 `[Sn]` 标记，
 *    标记只能指向本次注入的段落，且句中的数字与日期必须逐字出现在所引段落里。
 *    校验不过就**不返回模型答案**（`citation_unverified`），由调用方降级为本地原文摘录。
 *
 * 与 `safety.ts` 的输入/输出内容安全是两件事：那层管「内容是否违规」，这层管
 * 「事实是否有依据」。两层都在模型之后、返回之前。
 *
 * **这个校验器能发现**：没带出处的数字/日期/官方事实句；指向不存在段落的标记；
 * 数字与日期在所引段落里找不到的句子（含把 2026 改成 2027、把 40 元改成 30 元这类改写）。
 * **不能发现**：不含数字与上述关键词的错误转述；把甲段落的合法数字安到乙段落上
 * （数字在语料里出现过就算支持）；小数点的移位（`1.5万` 与 `15万` 归一后同为 `15`）。
 * 因此它是**上屏前的最后一道闸**，不是「回答一定正确」的证明——评测报告仍按逐题人工判定统计。
 */

/** 升学问答的 feature 名（客户端 `miniprogram/services/advancement/model.ts` 同名常量，跨包有意复制）。 */
export const ADVANCEMENT_QA_FEATURE = 'advancement-qa';

/** 一次回答最多注入几个段落：与客户端 top-3 检索一致，再多会挤占提示词与检测窗口。 */
export const ADVANCEMENT_MAX_SOURCES = 3;

export interface AdvancementPassage {
  id: string;
  /** 官方原文的逐字摘录；回答与引用只能用这段文字。 */
  text: string;
}

export interface AdvancementDocument {
  id: string;
  category: string;
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  /** 0 表示与年份无关（例如入口导航页）。 */
  applicableYear: number;
  applicableRegion: string;
  applicableAudience: string;
  sourceUrl: string;
  collectedAt: string;
  passages: AdvancementPassage[];
}

export interface AdvancementCorpus {
  version: string;
  collectedAt: string;
  documents: AdvancementDocument[];
}

/** 调用方声明的适用范围：三个字段都必须给出（服务端不与客户端「商量」范围）。 */
export interface AdvancementScope {
  category: string;
  year: number;
  region: string;
}

/** 注入给模型、并回传给调用方的一条可信段落（引用卡片需要的全部元信息）。 */
export interface AdvancementSource {
  id: string;
  documentId: string;
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  applicableYear: number;
  applicableRegion: string;
  collectedAt: string;
  sourceUrl: string;
  quote: string;
}

export interface AdvancementVerdict {
  /** 模型自己说「无法核实」：不是失败，但也不能当成有依据的回答。 */
  refused: boolean;
  /** 校验不过的原因（短代码，不含回答正文），空数组表示通过。 */
  violations: string[];
}

/**
 * 段落文本里出现的「数字块」：`2026年1月12日09:00`、`1.5万`、`40元` 里的数字部分。
 *
 * 比较分两层：
 * - `digits`：去掉所有非数字字符后的字符串，用于逐字比对（`1月23日17:00` 与 `1 月 23 日 17:00` 相同）；
 * - `value`：**纯数字带单位**的数值（`1.5万` → 15000，`15000` → 15000），用于放过等值改写——
 *   模型把「1.5万」写成「15000」是同一个数，不该判成「数字没有出处」。
 *   带日期分隔符的块（`1月23日`）没有数值，只能逐字比。
 */
const NUMBER_CHUNK = /[0-9]+(?:[年月日时分秒.:：/、\-]\s*[0-9]+)*\s*[万亿]?/gu;
/** 纯数字（可带小数与单位）的形态；用来判断一个数字块能不能按数值比较。 */
const PURE_NUMBER = /^([0-9]+(?:\.[0-9]+)?)([万亿])?$/u;
const UNIT_VALUE: Record<string, number> = { 万: 10000, 亿: 100000000 };

interface NumberToken {
  /** 原文里的写法（只用于校验点标记，便于维护者定位是哪个数字）。 */
  raw: string;
  /** 数字字符（比较用）。 */
  digits: string;
  /** 纯数字带单位时的数值；日期、时间与带其它分隔符的块为 null。 */
  value: number | null;
}

/** 句中数字块 → 归一化数字串与（可能的）数值。 */
function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const pattern = new RegExp(NUMBER_CHUNK.source, NUMBER_CHUNK.flags);
  let match = pattern.exec(text);
  while (match !== null) {
    const raw = match[0];
    const digits = raw.replace(/[^0-9]/gu, '');
    const pure = PURE_NUMBER.exec(raw.replace(/\s+/gu, ''));
    const value = pure === null ? null : Number(pure[1]) * (pure[2] === undefined ? 1 : UNIT_VALUE[pure[2]]);
    if (digits !== '' && !tokens.some((token) => token.digits === digits && token.value === value)) {
      tokens.push({ raw: raw.trim(), digits, value });
    }
    match = pattern.exec(text);
  }
  return tokens;
}

/**
 * 官方事实类关键词：句子提到这些内容就属于「官方事实断言」，必须带出处。
 *
 * 故意收得窄一点：命中即要求出处（代价是多拦一句，收益是无依据的官方口径不上屏）。
 * 问候、过渡句（「以下依据官方原文」）不含这些词，不会被误拦。
 */
const FACT_WORDS = [
  '报名', '报考', '缴费', '考试', '考核', '招生', '录取', '志愿', '证书', '资格', '条件',
  '材料', '分数线', '投档', '免考', '加分', '体检', '流程', '截止', '时间', '日期',
  '要求', '规定', '政策', '岗位', '人数', '名额', '费用', '标准', '对象', '范围', '期限',
];

/** 出处标记 `[S1]`，同时接受全角方括号与 `[S1,S2]` / `[S1、S2]` 写法。 */
const CITATION_MARKER = /[\[［]\s*S\s*([0-9]+(?:\s*[,，、;；/]\s*S?\s*[0-9]+)*)\s*[\]］]/gu;

/** 句子切分：中文句读与换行（引号内的句读不特殊处理——切细一点只会更严格，不会更松）。 */
const SENTENCE_SPLIT = /[。；！？!?\n]+/u;

/** 模型拒答的开头（提示词要求的固定写法）。 */
const REFUSAL_PREFIX = /^[「『【\[]*\s*无法核实/u;

/** 语料是否可用（构建产物缺字段时按不可用处理，由调用方 fail-closed）。 */
export function isAdvancementCorpus(value: unknown): value is AdvancementCorpus {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  const corpus = value as Partial<AdvancementCorpus>;
  if (typeof corpus.version !== 'string' || corpus.version === '') return false;
  if (!Array.isArray(corpus.documents) || corpus.documents.length === 0) return false;
  for (const document of corpus.documents) {
    if (document === null || typeof document !== 'object') return false;
    if (typeof document.id !== 'string' || typeof document.category !== 'string') return false;
    if (typeof document.applicableYear !== 'number' || typeof document.applicableRegion !== 'string') return false;
    if (!Array.isArray(document.passages) || document.passages.length === 0) return false;
    for (const passage of document.passages) {
      if (passage === null || typeof passage !== 'object') return false;
      if (typeof passage.id !== 'string' || typeof passage.text !== 'string' || passage.text.trim() === '') return false;
    }
  }
  return true;
}

/** 打平所有段落，便于按 id 直接取（顺序即语料顺序，取引用时稳定可复现）。 */
function flatPassages(corpus: AdvancementCorpus): Array<{ document: AdvancementDocument; passage: AdvancementPassage }> {
  const list: Array<{ document: AdvancementDocument; passage: AdvancementPassage }> = [];
  for (const document of corpus.documents) {
    for (const passage of document.passages) list.push({ document, passage });
  }
  return list;
}

/** 语料里收录了哪些类别（供排查与测试核对，不用于放行判断）。 */
export function advancementCategories(corpus: AdvancementCorpus): string[] {
  const categories: string[] = [];
  for (const document of corpus.documents) {
    if (!categories.includes(document.category)) categories.push(document.category);
  }
  return categories;
}

/**
 * 复核调用方声明的适用范围。
 *
 * 三个字段缺一不可：范围不清就不该给官方结论（客户端在范围不清时本来也只会澄清），
 * 因此这里不提供「推断默认值」的分支——推断等于替用户拍板年份或地区。
 */
export function resolveAdvancementScope(corpus: AdvancementCorpus, raw: unknown): { scope: AdvancementScope } | { error: string } {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { error: '升学问答需要 scope（category / year / region）' };
  }
  const source = raw as { category?: unknown; year?: unknown; region?: unknown };
  const category = typeof source.category === 'string' ? source.category : '';
  const region = typeof source.region === 'string' ? source.region : '';
  const year = typeof source.year === 'number' && Number.isInteger(source.year) ? source.year : Number.NaN;
  if (category === '' || region === '' || Number.isNaN(year)) {
    return { error: '升学问答的 scope 必须同时给出 category、year、region' };
  }
  if (!advancementCategories(corpus).includes(category)) {
    return { error: `scope.category「${category}」不在可信语料的类别里` };
  }
  const years = new Set<number>();
  const regions = new Set<string>();
  for (const document of corpus.documents) {
    if (document.category !== category) continue;
    // 与年份无关的材料（applicableYear = 0，例如入口导航页）不进候选集：
    // scope.year 要的是「哪一年的政策」，0 不是一个可声明的年份。
    if (document.applicableYear > 0) years.add(document.applicableYear);
    regions.add(document.applicableRegion);
  }
  if (!years.has(year)) return { error: `scope.year ${year} 不在类别 ${category} 收录的年份里` };
  if (!regions.has(region)) return { error: `scope.region「${region}」不在类别 ${category} 收录的地区里` };
  return { scope: { category, year, region } };
}

/** 把段落变成回传/注入用的来源条目。 */
function sourceOf(document: AdvancementDocument, passage: AdvancementPassage): AdvancementSource {
  return {
    id: passage.id,
    documentId: document.id,
    title: document.title,
    documentNumber: document.documentNumber,
    issuer: document.issuer,
    publishedAt: document.publishedAt,
    applicableYear: document.applicableYear,
    applicableRegion: document.applicableRegion,
    collectedAt: document.collectedAt,
    sourceUrl: document.sourceUrl,
    quote: passage.text,
  };
}

/**
 * 把调用方给的段落 id 解析成可信来源。
 *
 * 逐条检查：id 必须存在、所属文档必须与声明范围一致（类别相同、年份相同或该材料与年份无关、
 * 地区相同）、条数不超过上限。任何一条不满足都**整体拒绝**而不是丢掉那一句——
 * 调用方与注入内容必须严格对应，静默丢弃会让「模型引用了段落 X」这句话失去意义。
 */
export function resolveAdvancementSources(
  corpus: AdvancementCorpus,
  rawIds: unknown,
  scope: AdvancementScope,
): { sources: AdvancementSource[] } | { error: string } {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { error: '升学问答需要 passageIds（本次检索到的可信段落 id）' };
  }
  if (rawIds.length > ADVANCEMENT_MAX_SOURCES) {
    return { error: `passageIds 最多 ${ADVANCEMENT_MAX_SOURCES} 条` };
  }
  const available = flatPassages(corpus);
  const sources: AdvancementSource[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = typeof raw === 'string' ? raw : '';
    if (id === '') return { error: 'passageIds 必须是字符串' };
    if (seen.has(id)) return { error: `passageIds 里重复出现 ${id}` };
    seen.add(id);
    const found = available.find((entry) => entry.passage.id === id);
    if (found === undefined) return { error: `段落 ${id} 不在可信语料里` };
    const { document } = found;
    if (document.category !== scope.category) {
      return { error: `段落 ${id} 属于类别 ${document.category}，与 scope.category 不一致` };
    }
    if (document.applicableRegion !== scope.region) {
      return { error: `段落 ${id} 的适用地区是 ${document.applicableRegion}，与 scope.region 不一致` };
    }
    if (document.applicableYear !== 0 && document.applicableYear !== scope.year) {
      return { error: `段落 ${id} 的适用年份是 ${document.applicableYear}，与 scope.year 不一致` };
    }
    sources.push(sourceOf(document, found.passage));
  }
  return { sources };
}

/**
 * 注入给模型的资料块（在输入内容安全之前拼进 system，与部门动态注入同一时机）。
 *
 * 标记写法 `[S1]` 是**契约**：提示词要求模型在每句事实后带上它，校验器按它核对。
 * 段落正文逐字给出，并明确「只能引用这些段落里的内容」。
 */
export function injectedAdvancementText(sources: AdvancementSource[], scope: AdvancementScope): string {
  const lines: string[] = [
    '【升学资料检索结果】以下是从官方材料里检索到的段落（逐字原文，标记为出处编号）。',
    `适用范围：${scope.category} · ${scope.year} 年 · ${scope.region}。`,
    '回答纪律：只能使用下面这些段落里写过的事实；每个含日期、数字或条件的句子末尾必须标出出处编号；',
    '段落里没有的内容一律不要写；如果这些段落回答不了这个问题，只回复「无法核实」四个字。',
  ];
  sources.forEach((source, index) => {
    lines.push(`[S${index + 1}] ${source.quote}`);
    lines.push(`    出处：《${source.title}》${source.documentNumber === '' ? '' : `（${source.documentNumber}）`} ${source.issuer} · ${source.publishedAt} · ${source.sourceUrl}`);
  });
  return lines.join('\n');
}

/** 句子里的出处标记编号（1 起）。 */
function markersIn(sentence: string): number[] {
  const ids: number[] = [];
  const pattern = new RegExp(CITATION_MARKER.source, CITATION_MARKER.flags);
  let match = pattern.exec(sentence);
  while (match !== null) {
    for (const piece of match[1].split(/[,，、;；/]/u)) {
      const digits = piece.replace(/[^0-9]/gu, '');
      if (digits === '') continue;
      const id = Number(digits);
      if (!ids.includes(id)) ids.push(id);
    }
    match = pattern.exec(sentence);
  }
  return ids;
}

/**
 * 去掉出处标记后的句子。
 *
 * 必须去掉再抽数字：标记本身就带数字（`[S1]` 里的 1），不去掉会把标记当成
 * 「句中出现了一个没有出处的数字」，合法回答会被自己的标记判死。
 */
function withoutMarkers(sentence: string): string {
  return sentence.replace(new RegExp(CITATION_MARKER.source, CITATION_MARKER.flags), '');
}

/**
 * 数字块是否被段落支持：逐字相等、互相包含（模型可能省略年份前缀，如段落写 `2026年3月28日`
 * 而回答写 `3月28日`），或**数值相等**（段落写 `1.5万`、回答写 `15000`）。
 */
function supportedNumber(token: NumberToken, passageTokens: NumberToken[]): boolean {
  return passageTokens.some((candidate) => candidate.digits === token.digits
    || candidate.digits.endsWith(token.digits)
    || token.digits.endsWith(candidate.digits)
    || (token.value !== null && candidate.value !== null && Math.abs(token.value - candidate.value) < 0.0001));
}

/**
 * 逐句校验模型回答（见文件头「能发现 / 不能发现」）。
 *
 * 通过的条件：每个含数字或官方事实关键词的句子都带出处标记，标记都指向本次注入的段落，
 * 且句中的每个数字块都能在**它所引的那些段落**里找到。
 *
 * 「找到」的范围是**引用卡片上会展示的全部字段**：段落原文 + 材料标题 + 文号 + 发布日期 +
 * 适用年份。学生看到的卡片上就有这些字，模型照问题里的年份说「2026年…」属于可核对的信息
 * （材料标题就是《广东省2026年普通高等学校专升本招生工作规定》），不该判成没出处；
 * 反过来，写成 2027 年仍会被拦下（标题、文号与原文里都没有 2027）。
 */
export function verifyAdvancementAnswer(answer: string, sources: AdvancementSource[]): AdvancementVerdict {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (text === '') return { refused: false, violations: ['empty_answer'] };
  if (REFUSAL_PREFIX.test(text)) return { refused: true, violations: [] };

  const passageTokens = sources.map((source) => numberTokens([
    source.quote,
    source.title,
    source.documentNumber,
    source.publishedAt,
    String(source.applicableYear),
  ].join(' ')));
  const violations: string[] = [];
  const sentences = text.split(SENTENCE_SPLIT);
  sentences.forEach((raw, index) => {
    const sentence = raw.trim();
    if (sentence === '') return;
    const where = `s${index + 1}`;
    const ids = markersIn(sentence);
    const tokens = numberTokens(withoutMarkers(sentence));
    const factual = tokens.length > 0 || FACT_WORDS.some((word) => sentence.includes(word));
    if (ids.length === 0) {
      if (factual) violations.push(`${where}:uncited_claim`);
      return;
    }
    const invalid = ids.filter((id) => id < 1 || id > sources.length);
    if (invalid.length > 0) {
      violations.push(`${where}:unknown_marker`);
      return;
    }
    const allowed = ids.flatMap((id) => passageTokens[id - 1]);
    for (const token of tokens) {
      // 校验点带上具体的数字：维护者能从记录里看出是哪个数字没核上（回答正文本身不返回）。
      if (!supportedNumber(token, allowed)) violations.push(`${where}:unsupported_number(${token.raw})`);
    }
  });
  return { refused: false, violations };
}

/**
 * 升学问答的返回块：调用方要的引用、本次校验结论与所用语料版本。
 *
 * 与部门动态的 `citations` 分开放：形状不同（这里有逐字引文与文号，部门那边是动态条目），
 * 混进同一个字段会让两边的解析互相牵制。
 */
export interface AdvancementResult {
  scope: AdvancementScope;
  corpusVersion: string;
  sources: AdvancementSource[];
  /** 校验通过（或模型自己拒答）。false 表示这条回答没有上屏。 */
  verified: boolean;
  /** 模型自己说「无法核实」。 */
  refused: boolean;
  /** 校验不过的原因（短代码，不含回答正文）。 */
  violations: string[];
}
