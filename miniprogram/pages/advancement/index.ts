/**
 * 升学 / 实习问答页（Issue #94；2026-09-30 起为模型版；岭南红 UI 第二轮 C 分支按设计稿 28/29/30 重做）。
 *
 * 一屏三件事：本地检索决定「能不能答」（范围守门 + 原文依据），`ai` 云函数解释，
 * 服务端的出处校验决定「模型解释能不能上屏」。任何一环不给结论，就退回到本地原文摘录——
 * 页面任何时候都能看到一个有出处的答案，但**不会**把没核过出处的模型文字当官方结论展示。
 *
 * 本轮界面把三件容易含糊的事情显式化：
 * 1. **范围上屏**：回答上方写明这次的适用年份、地区、通道，并标注「已存政策 · 非新年度报考依据」，
 *    不把 2026 年的条款写成对任何一年都成立的结论；
 * 2. **出处可互指**：正文里的 `[S1]`、`[S2]` 与下方「对应原文」区块共用同一套编号，
 *    点任一侧都会把另一侧高亮出来（不依赖滚动，窄屏也能对上）；
 * 3. **降级即原文**：`canAskModel` 为 false（澄清 / 拒答 / 无出处）时**不发模型请求**，
 *    直接展示本地原文摘录与出处卡片；模型失败或未过核对也退回同一形态，并给重试入口。
 *
 * 三条稳定性约定：
 * - **新问题清空旧范围**：`ask()` 把 `scope` 重置、并把 `requestToken` 加一，
 *   上一个问题的模型回答回来时会被丢弃（不能落到新问题下面）；
 * - **取消**：等待期间点「取消」同样把 `requestToken` 加一，在途回答不再上屏；
 * - **降级不是失败页**：模型不可用/未过核对时，展示的是本地已经检索到的原文摘录 + 出处，
 *   用户还可以重试模型解释。
 */
import {
  ADVANCEMENT_DOCUMENTS,
  AskResult,
  AskScope,
  Citation,
  CORPUS_COLLECTED_AT,
  ResolvedScope,
  ask,
  selectScope,
} from '../../services/advancement/index';
import { canAskModel, advancementChatEvent, modelOutcome, sourceLabel } from '../../services/advancement/model';
import { callAi, transportMessage } from '../../services/ai';
import { openUiTab } from '../../ui/navigation';

interface InputEvent {
  detail: { value: string };
}

interface TapEvent {
  currentTarget: { dataset: { value?: string; url?: string; ref?: string } };
}

const EXAMPLES = [
  '2026年普通专升本什么时候网上预报名？',
  '转段考核包括哪几个部分？',
  '三二分段报名是1月12日开始吗？',
  '在哪里看招聘活动和就业服务入口？',
];

/** 模型解释的四种页面状态：未开始 / 等待中 / 已上屏 / 降级或拒答。 */
type ModelPhase = 'idle' | 'loading' | 'ready' | 'fallback';

/** 正文里的一句原文或一个出处编号，用来在模板里把 `[S1]` 画成可点的小标记。 */
export interface ToolsAnswerSegment {
  /** 渲染用的稳定 key（WXML 的 wx:key 不能为空、也不能重复）。 */
  key: string;
  kind: 'text' | 'ref';
  text: string;
  /** 仅 `kind === 'ref'` 时有值，形如 `[S1]`，与「对应原文」区块共用。 */
  ref: string;
}

type RawSegment = Omit<ToolsAnswerSegment, 'key'>;

/** 「对应原文」区块的一张卡片：出处元信息 + 可选中的编号。编号顺序即检索顺序。 */
export interface ToolsSource {
  ref: string;
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  applicableYear: number;
  applicableRegion: string;
  /** 适用范围一行文案：年份为 0（长期有效的就业服务）时不硬写「0 年」。 */
  applicableText: string;
  /** 这份文件自己写明的适用人群：页面上必须让人看到，避免被当成「人人适用」。 */
  applicableAudience: string;
  collectedAt: string;
  sourceUrl: string;
  quote: string;
}

/** 范围说明的键值行（通道 / 适用年份 / 适用地区）。 */
export interface ToolsScopeRow {
  key: string;
  value: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  ordinary_专升本: '普通专升本',
  segmented_三二分段专升本转段: '三二分段专升本转段',
  internship_实习招聘: '实习与招聘',
  uncollected: '未收录类别',
};

/** 文档 id → 该文件自己声明的适用人群；只用于展示，不参与范围判断。 */
const AUDIENCE_BY_DOCUMENT: Record<string, string> = {};
for (const document of ADVANCEMENT_DOCUMENTS) AUDIENCE_BY_DOCUMENT[document.id] = document.applicableAudience;

/** 把一段正文拆成「文字 + 出处编号」片段，模板据此把 `[S1]` 单独画出来。 */
function splitMarked(text: string): RawSegment[] {
  const segments: RawSegment[] = [];
  const pattern = /\[S(\d+)\]/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index), ref: '' });
    segments.push({ kind: 'ref', text: match[0], ref: match[0] });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last), ref: '' });
  return segments;
}

/**
 * 没有 `[Sn]` 标记的正文（降级时的原文摘录）：
 * 只有当它**正好**是各条引用原文按顺序拼接时，才逐段补上编号；
 * 对不上就原样返回——宁可没有行内编号，也不把人家的文字贴错编号。
 */
function splitPlain(text: string, citations: Citation[]): RawSegment[] | null {
  if (citations.length === 0) return null;
  const segments: RawSegment[] = [];
  let rest = text;
  for (let index = 0; index < citations.length; index += 1) {
    const quote = citations[index].quote;
    if (!rest.startsWith(quote)) return null;
    const ref = sourceLabel(index);
    segments.push({ kind: 'ref', text: ref, ref });
    segments.push({ kind: 'text', text: quote, ref: '' });
    rest = rest.slice(quote.length);
    if (rest.startsWith('\n')) rest = rest.slice(1);
  }
  if (rest.trim() !== '') return null;
  return segments;
}

/** 渲染片段补上稳定 key：同一段正文里 key 只会出现一次。 */
function withKeys(segments: RawSegment[]): ToolsAnswerSegment[] {
  return segments.map((segment, index) => ({ ...segment, key: `seg-${index}` }));
}

/** 正文 → 渲染片段。先认模型写的 `[Sn]`，再认「逐段原文拼接」这种降级形态。 */
export function answerSegments(text: string, citations: Citation[]): ToolsAnswerSegment[] {
  if (text === '') return [];
  const marked = splitMarked(text);
  if (marked.some((segment) => segment.kind === 'ref')) return withKeys(marked);
  const plain = splitPlain(text, citations);
  if (plain !== null) return withKeys(plain);
  return withKeys(marked.length > 0 ? marked : [{ kind: 'text', text, ref: '' }]);
}

/** 出处列表 → 「对应原文」卡片；编号与正文共用 `[Sn]`。 */
export function toSources(citations: Citation[]): ToolsSource[] {
  return citations.map((citation, index) => ({
    ref: sourceLabel(index),
    title: citation.title,
    documentNumber: citation.documentNumber,
    issuer: citation.issuer,
    publishedAt: citation.publishedAt,
    applicableYear: citation.applicableYear,
    applicableRegion: citation.applicableRegion,
    applicableText: citation.applicableYear > 0
      ? `适用：${citation.applicableRegion}${citation.applicableYear} 年`
      : `适用：${citation.applicableRegion}（文件未标注年份）`,
    applicableAudience: AUDIENCE_BY_DOCUMENT[citation.documentId] ?? '',
    collectedAt: citation.collectedAt,
    sourceUrl: citation.sourceUrl,
    quote: citation.quote,
  }));
}

/** 回答上方那行范围说明：写清「这是哪一年的既有政策」，不是新年度报考结论。 */
export function scopeLabelOf(scope: ResolvedScope | undefined): string {
  if (scope === undefined) return '';
  if (scope.year > 0) return `${scope.year} 年已存政策 · 非新年度报考依据`;
  return '已收录资料 · 非新年度报考依据';
}

/** 范围键值行：通道 / 适用年份 / 适用地区，逐项都能被看见。 */
export function scopeRowsOf(scope: ResolvedScope | undefined): ToolsScopeRow[] {
  if (scope === undefined) return [];
  return [
    { key: '通道', value: CATEGORY_LABEL[scope.category] ?? scope.category },
    { key: '适用年份', value: scope.year > 0 ? `${scope.year} 年` : '未标注年份' },
    { key: '适用地区', value: scope.region },
  ];
}

Page({
  data: {
    question: '',
    asked: '',
    result: null as AskResult | null,
    hasResult: false,
    examples: EXAMPLES,
    collectedAt: CORPUS_COLLECTED_AT,
    modelPhase: 'idle' as ModelPhase,
    /** 主文本（模型解释 / 模型拒答 / 降级时的原文摘录）。 */
    modelText: '',
    modelNote: '',
    /** 主文本的标签：模型解释与拒答要区分开，降级时明确写「原文摘录」。 */
    modelLabel: '',
    /** 拒答形态：主文本是模型说的「无法核实」，下面仍列原文。 */
    modelRefused: false,
    /** 主文本拆成文字/编号片段，模板里把 `[S1]` 画成可点标记。 */
    segments: [] as ToolsAnswerSegment[],
    /** 「对应原文」区块；编号与正文一致。 */
    sources: [] as ToolsSource[],
    /** 这次回答的适用范围（类别/年份/地区），仅 answer 时有值。 */
    scopeLabel: '',
    scopeRows: [] as ToolsScopeRow[],
    /** 当前被选中的出处编号：正文与原文区块共用，点一侧亮另一侧。 */
    activeRef: '',
  },
  scope: {} as AskScope,
  /**
   * 在途请求的代号：只有最后一次用户动作的代号能上屏。
   * 新问题、重新提问、取消都会让它加一，因此过期回答不会落到新问题下面。
   */
  requestToken: 0,
  onLoad() {
    this.ask('2026年广东普通专升本什么时候网上预报名？');
  },
  onInput(event: InputEvent) {
    this.setData({ question: event.detail.value });
  },
  onAsk() {
    this.ask(this.data.question);
  },
  onExample(event: TapEvent) {
    const value = event.currentTarget.dataset.value;
    if (value === undefined || value === '') return;
    this.setData({ question: value });
    this.ask(value);
  },
  /** 只接受本轮可选项，保留原问题，继续确认该题的适用范围。 */
  onChoice(event: TapEvent) {
    const value = event.currentTarget.dataset.value;
    if (value === undefined || value === '') return;
    if (this.data.result === null) return;
    const selected = selectScope(this.data.result, value);
    if (selected === null) return;
    this.scope = { ...this.scope, ...selected };
    const token = this.beginRequest();
    const result = ask(this.data.asked, 2, this.scope);
    this.setData({
      question: this.data.asked,
      result,
      activeRef: '',
      // 选定范围后范围条要跟着换，否则屏幕上还挂着上一轮（或不存在的）适用范围。
      scopeLabel: scopeLabelOf(result.resolvedScope),
      scopeRows: scopeRowsOf(result.resolvedScope),
    });
    this.startModel(token, this.data.asked, result);
  },
  /** 提问入口：新问题一律清空上一题的澄清选择，并让在途回答失效。 */
  ask(question: string) {
    this.scope = {};
    const token = this.beginRequest();
    const result = ask(question);
    this.setData({
      asked: question,
      result,
      hasResult: true,
      activeRef: '',
      modelPhase: 'idle',
      modelText: '',
      modelNote: '',
      modelLabel: '',
      modelRefused: false,
      segments: [],
      sources: [],
      scopeLabel: scopeLabelOf(result.resolvedScope),
      scopeRows: scopeRowsOf(result.resolvedScope),
    });
    this.startModel(token, question, result);
  },
  /** 用户取消等待：在途回答作废，立刻显示本地原文摘录。 */
  onCancelModel() {
    this.requestToken += 1;
    const result = this.data.result;
    if (result === null) return;
    this.setData({
      modelPhase: 'fallback',
      modelLabel: '原文摘录',
      modelText: result.answer,
      modelNote: '已取消这次的模型解释，下面是检索到的官方原文（未改写）。',
      modelRefused: false,
      segments: answerSegments(result.answer, result.citations),
    });
  },
  /** 重试模型解释：用当前这份本地检索结果再问一次。 */
  onRetryModel() {
    if (this.data.result === null) return;
    const token = this.beginRequest();
    this.startModel(token, this.data.asked, this.data.result);
  },
  /** 继续提问：清掉上一题的答案，回到输入状态（不保留旧结论在屏幕上）。 */
  onAskAgain() {
    this.requestToken += 1;
    this.scope = {};
    this.setData({
      question: '',
      asked: '',
      result: null,
      hasResult: false,
      modelPhase: 'idle',
      modelText: '',
      modelNote: '',
      modelLabel: '',
      modelRefused: false,
      segments: [],
      sources: [],
      scopeLabel: '',
      scopeRows: [],
      activeRef: '',
    });
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  /** 点正文里的 `[S1]` 或原文区块标题：把两边同时高亮，便于逐条核对。 */
  onJumpRef(event: TapEvent) {
    const ref = event.currentTarget.dataset.ref;
    if (ref === undefined || ref === '') return;
    this.setData({ activeRef: this.data.activeRef === ref ? '' : ref });
  },
  /** 开始一次用户动作：返回本次动作的代号。 */
  beginRequest(): number {
    this.requestToken += 1;
    return this.requestToken;
  },
  /**
   * 有原文依据时交给模型解释；没有依据（澄清/拒答）时**不调用模型**——
   * 这一层不花额度，也不给模型在无依据时作答的机会。
   */
  startModel(token: number, question: string, result: AskResult) {
    if (!canAskModel(result)) {
      // 没有可核对的出处：不上模型，直接把本地原文/话术摆出来。
      this.setData({
        modelPhase: 'idle',
        modelText: '',
        modelNote: '',
        modelLabel: '',
        modelRefused: false,
        segments: [],
        sources: toSources(result.citations),
      });
      return;
    }
    this.setData({
      modelPhase: 'loading',
      modelLabel: '',
      modelText: '',
      modelNote: '',
      modelRefused: false,
      segments: [],
      sources: toSources(result.citations),
    });
    const event = advancementChatEvent(question, result.resolvedScope, result.citations);
    callAi(event)
      .then((call) => {
        // 过期回答（用户已换问题或已取消）：不上屏，也不留痕。
        if (this.requestToken !== token) return;
        const outcome = modelOutcome({ call, transportNote: '', result });
        this.setData({
          modelPhase: outcome.kind === 'model' ? 'ready' : 'fallback',
          modelLabel: outcome.kind === 'model'
            ? 'AI 解释 · 依据官方原文'
            : outcome.kind === 'refused' ? '模型无法核实' : '原文摘录',
          modelText: outcome.text,
          modelNote: outcome.note,
          modelRefused: outcome.kind === 'refused',
          segments: answerSegments(outcome.text, result.citations),
        });
      })
      .catch((error) => {
        if (this.requestToken !== token) return;
        const outcome = modelOutcome({ call: null, transportNote: transportMessage(error), result });
        this.setData({
          modelPhase: 'fallback',
          modelLabel: '原文摘录',
          modelText: outcome.text,
          modelNote: outcome.note,
          modelRefused: false,
          segments: answerSegments(outcome.text, result.citations),
        });
      });
  },
  onCopySource(event: TapEvent) {
    const url = event.currentTarget.dataset.url;
    if (url === undefined || url === '') return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
  /**
   * 回「今天」主入口。栈里还有上一页就直接返回（保留提问与原答）；只剩本页时走公共导航
   * 切「今天」tab，让底栏高亮跟着变。宿主没有 switchTab 时退回 reLaunch。
   */
  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openUiTab('today').catch(() => {
      wx.reLaunch({ url: '/pages/home/index' });
    });
  },
});
