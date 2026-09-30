/**
 * 升学 / 实习问答页（Issue #94，本地演示形态）。
 *
 * 页面完全不含模型调用：`services/advancement` 在本地检索官方原文段落，页面把它原样展示并附出处。
 * 界面固定三句话：语料规模与核查日、「未接模型」、不构成录取或报考资格判断。
 *
 * 澄清用明确的类别/年份/地区状态，原问题不改写；新问题不沿用上一题状态。
 */
import { AskResult, AskScope, CORPUS_COLLECTED_AT, ask, selectScope } from '../../services/advancement/index';

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

Page({
  data: {
    question: '',
    asked: '',
    result: null as AskResult | null,
    hasResult: false,
    examples: EXAMPLES,
    collectedAt: CORPUS_COLLECTED_AT,
  },
  scope: {} as AskScope,
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
    this.setData({ question: this.data.asked, result: ask(this.data.asked, 2, this.scope) });
  },
  ask(question: string) {
    this.scope = {};
    this.setData({ asked: question, result: ask(question), hasResult: true });
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
