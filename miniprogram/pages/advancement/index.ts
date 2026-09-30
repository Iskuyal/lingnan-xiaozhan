/**
 * 升学 / 实习问答页（Issue #94；2026-09-30 起为模型版）。
 *
 * 一屏三件事：本地检索决定「能不能答」（范围守门 + 原文依据），`ai` 云函数解释，
 * 服务端的出处校验决定「模型解释能不能上屏」。任何一环不给结论，就退回到本地原文摘录——
 * 页面任何时候都能看到一个有出处的答案，但**不会**把没核过出处的模型文字当官方结论展示。
 *
 * 三条稳定性约定：
 * - **新问题清空旧范围**：`ask()` 把 `scope` 重置、并把 `requestToken` 加一，
 *   上一个问题的模型回答回来时会被丢弃（不能落到新问题下面）；
 * - **取消**：等待期间点「取消」同样把 `requestToken` 加一，在途回答不再上屏；
 * - **降级不是失败页**：模型不可用/未过核对时，展示的是本地已经检索到的原文摘录 + 出处，
 *   用户还可以重试模型解释。
 */
import {
  AskResult,
  AskScope,
  CORPUS_COLLECTED_AT,
  ask,
  selectScope,
} from '../../services/advancement/index';
import { canAskModel, advancementChatEvent, modelOutcome } from '../../services/advancement/model';
import { callAi, transportMessage } from '../../services/ai';

interface InputEvent {
  detail: { value: string };
}

interface TapEvent {
  currentTarget: { dataset: { value?: string; url?: string } };
}

const EXAMPLES = [
  '2026年普通专升本什么时候网上预报名？',
  '转段考核包括哪几个部分？',
  '三二分段报名是1月12日开始吗？',
  '在哪里看招聘活动和就业服务入口？',
];

/** 模型解释的四种页面状态：未开始 / 等待中 / 已上屏 / 降级或拒答。 */
type ModelPhase = 'idle' | 'loading' | 'ready' | 'fallback';

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
    this.setData({ question: this.data.asked, result });
    this.startModel(token, this.data.asked, result);
  },
  /** 提问入口：新问题一律清空上一题的澄清选择，并让在途回答失效。 */
  ask(question: string) {
    this.scope = {};
    const token = this.beginRequest();
    const result = ask(question);
    this.setData({ asked: question, result, hasResult: true, modelPhase: 'idle', modelText: '', modelNote: '', modelLabel: '', modelRefused: false });
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
    });
  },
  /** 重试模型解释：用当前这份本地检索结果再问一次。 */
  onRetryModel() {
    if (this.data.result === null) return;
    const token = this.beginRequest();
    this.startModel(token, this.data.asked, this.data.result);
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
      this.setData({ modelPhase: 'idle', modelText: '', modelNote: '', modelLabel: '', modelRefused: false });
      return;
    }
    this.setData({ modelPhase: 'loading', modelLabel: '', modelText: '', modelNote: '', modelRefused: false });
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
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
