import { buildDepartmentList } from '../../services/departments';
import { callAi, chatEvent, transportMessage, userMessage } from '../../services/ai';
import {
  ChatTurn,
  QA_SOURCE_NOTE,
  QaOption,
  buildSystemPrompt,
  buildWelcome,
  chatMessages,
  contactWarningFor,
  sourceNoteFor,
  safetyNoteFor,
} from './qa';

/**
 * 「用户已经主动关掉过对话框」的持久标记。
 *
 * Ticket 07 要求进入部门模块就出现对话框并主动问「你想了解什么部门」，
 * 因此页面首次显示时自动展开一次；但用户明确关掉之后不该反复弹——
 * 标记写在本地存储里，之后（含下次进入）由用户主动点开。
 */
export const QA_DISMISS_KEY = 'departments-qa-dismissed';

function qaDismissed(): boolean {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return false;
    return wx.getStorageSync(QA_DISMISS_KEY) === true;
  } catch {
    // 存储读失败按「没关过」处理：自动展开一次比永久不再提示更符合票面要求。
    return false;
  }
}

function markQaDismissed(): void {
  try {
    if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return;
    wx.setStorageSync(QA_DISMISS_KEY, true);
  } catch {
    // 写失败只影响「下次不再自动展开」这一便利，不影响本次关闭。
  }
}

interface InputEvent {
  detail: { value?: unknown };
}

Page({
  data: {
    view: buildDepartmentList(),
    qaOpen: false,
    qaMessages: [] as ChatTurn[],
    qaOptions: [] as QaOption[],
    qaInput: '',
    qaSending: false,
    qaError: '',
    qaCapWarning: '',
    qaSourceNote: QA_SOURCE_NOTE,
    qaSafetyNote: '',
  },
  /** 进入（含从详情页返回）时按票面主动展示对话框；用户关过就不再自动弹。 */
  onShow() {
    if (this.data.qaOpen || qaDismissed()) return;
    this.openQa();
  },
  openDetail(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id.length === 0) return;
    wx.navigateTo({ url: `/pages/departments/detail/index?id=${id}` });
  },
  /** 打开对话框：欢迎语 + 可点选项；从详情页返回后对话状态原样保留。 */
  openQa() {
    if (this.data.qaOpen) return;
    const welcome = buildWelcome();
    this.setData({
      qaOpen: true,
      qaMessages: [{ role: 'assistant', text: welcome.text }],
      qaOptions: welcome.options,
      qaError: '',
      qaCapWarning: '',
      qaSourceNote: QA_SOURCE_NOTE,
      qaSafetyNote: '',
    });
  },
  /** 关闭后记住：本次会话与下次进入都不再自动展开，由用户主动打开。 */
  closeQa() {
    markQaDismissed();
    this.setData({ qaOpen: false });
  },
  onQaInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ qaInput: typeof raw === 'string' ? raw : '' });
  },
  /**
   * 追问：发送中锁定，空输入不调用；失败不产生假回答，三类失败文案各自独立。
   *
   * 成功的回答要过两道客户端后置检查（都只做标记，不当成事实保证）：
   * 内容安全没真正执行时在对话里明说；回答里出现语料之外的联系方式时标注这条回答。
   */
  sendQuestion() {
    const text = this.data.qaInput.trim();
    if (text === '' || this.data.qaSending) return;
    const history: ChatTurn[] = this.data.qaMessages.concat([{ role: 'user', text }]);
    this.setData({ qaMessages: history, qaInput: '', qaSending: true, qaError: '' });
    return callAi(chatEvent('department-qa', buildSystemPrompt(), chatMessages(history)))
      .then((result) => {
        if (!result.ok) {
          this.setData({ qaSending: false, qaError: userMessage(result), qaCapWarning: result.capWarning });
          return;
        }
        const answer: ChatTurn = { role: 'assistant', text: result.text };
        const warning = contactWarningFor(result.text);
        if (warning !== '') answer.warning = warning;
        this.setData({
          qaMessages: history.concat([answer]),
          qaSending: false,
          qaError: '',
          qaCapWarning: result.capWarning,
          qaSafetyNote: safetyNoteFor(result.safety),
          qaSourceNote: sourceNoteFor(result.safety),
        });
      })
      .catch((error) => {
        this.setData({ qaSending: false, qaError: transportMessage(error) });
      });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
