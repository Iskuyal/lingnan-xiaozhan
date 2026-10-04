import { buildDepartmentList, findDepartmentById } from '../../services/departments';
import { callAi, transportMessage, userMessage } from '../../services/ai';
import {
  ChatTurn,
  QA_OFFLINE_NOTE,
  QA_SOURCE_NOTE,
  QaOption,
  WELCOME_TEXT,
  appendTurn,
  buildWelcome,
  conversationOf,
  copyActivitySourceUrl,
  guardTurn,
  markQaDismissed,
  qaChatEvent,
  qaDismissed,
  qaPanelPatch,
  resetConversation,
  safetyNoteFor,
  sourceNoteFor,
} from './qa';

interface InputEvent {
  detail: { value?: unknown };
}

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; url?: string } };
}

/**
 * 学生部门（Ticket 07：进入模块即有对话框）。
 *
 * AI 提示「你想了解什么部门」并给出可点的组织选项，点进去是部门详情页；
 * 详情页里可以继续追问，返回这里对话仍在（两份页面共用 `./qa` 的会话），
 * 也可以直接在列表页接着问。
 *
 * 对话框的规则全在 `./qa`（纯逻辑，node:test 直接验证），页面只做编排。
 */
Page({
  data: {
    view: buildDepartmentList(),
    qaOpen: false,
    /** 当前对话属于哪个部门；空串表示还没选定部门（列表页的自由提问）。 */
    qaDepartmentId: '',
    qaPrompt: WELCOME_TEXT,
    qaMessages: [] as ChatTurn[],
    qaOptions: [] as QaOption[],
    qaSuggestionList: [] as string[],
    qaInput: '',
    qaSending: false,
    qaError: '',
    qaCapWarning: '',
    qaSourceNote: QA_SOURCE_NOTE,
    qaSafetyNote: '',
    qaOfflineNote: QA_OFFLINE_NOTE,
  },
  /** 进入（含从详情页返回）时按票面主动展示对话框；用户关过就不再自动弹。 */
  onShow() {
    if (!this.data.qaOpen) {
      if (qaDismissed()) return;
      this.openQa();
      return;
    }
    // 从详情页返回：那份对话在详情页里可能又长了，重新读一遍共享会话。
    this.refreshQa();
  },
  /** 面板数据全部从共享会话读，页面只负责 setData（字段名与共用模板一一对应）。 */
  refreshQa() {
    this.setData(qaPanelPatch({ departmentId: this.data.qaDepartmentId, withOptions: true }));
  },
  /** 首屏快捷入口跳到已展开的问答区；若用户先收起过，则先按显式操作重新打开。 */
  scrollToQa() {
    if (!this.data.qaOpen) this.openQa();
    setTimeout(() => wx.pageScrollTo({ selector: '#department-qa-panel', duration: 250 }), 40);
  },
  /**
   * 打开对话框：回到这个部门的开场白与可点选项。
   * 与 main 既有行为一致——收起再打开不保留上一轮；要保留就别收起。
   */
  openQa() {
    if (this.data.qaOpen) return;
    resetConversation(this.data.qaDepartmentId);
    this.setData({
      qaOpen: true,
      qaError: '',
      qaCapWarning: '',
      qaSourceNote: QA_SOURCE_NOTE,
      qaSafetyNote: '',
    });
    this.refreshQa();
  },
  /** 关闭后记住：本次会话与下次进入都不再自动展开，由用户主动打开。 */
  closeQa() {
    markQaDismissed();
    this.setData({ qaOpen: false });
  },
  /** 清空当前部门的对话回到开场白（与「关闭后不再弹」的持久标记互不影响）。 */
  restartConversation() {
    resetConversation(this.data.qaDepartmentId);
    this.refreshQa();
  },
  /** 名录条目与对话框选项共用这个入口：先让对话跟着人去那个部门，再进详情页。 */
  openDetail(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id.length === 0) return;
    if (findDepartmentById(id) !== null) this.setData({ qaDepartmentId: id });
    wx.navigateTo({ url: `/pages/departments/detail/index?id=${id}` });
  },
  /** 点检索来源条：复制官网原文链接（交互实现收在 qa.ts，见 qa.wxml）。 */
  copyActivitySource(event: DatasetEvent) {
    copyActivitySourceUrl(event.currentTarget.dataset.url ?? '');
  },
  onQaInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ qaInput: typeof raw === 'string' ? raw : '' });
  },
  /**
   * 追问：发送中锁定，空输入不调用；失败不产生假回答，三类失败文案各自独立。
   *
   * 成功的回答过一遍客户端的防幻觉守卫（命中就整条替换成如实回答，并在这条回答上说明），
   * 但**送进模型的历史用模型原话**——守卫只改学生看到的回答，不改模型的上下文。
   * 内容安全没真正执行时在对话里明说（`qaSafetyNote` / `qaSourceNote`）。
   */
  sendQuestion() {
    const text = this.data.qaInput.trim();
    if (text === '' || this.data.qaSending) return;
    const departmentId = this.data.qaDepartmentId;
    appendTurn(departmentId, { role: 'user', text });
    const history = conversationOf(departmentId);
    this.setData({ qaMessages: history, qaInput: '', qaSending: true, qaError: '' });
    return callAi(qaChatEvent(history))
      .then((result) => {
        if (!result.ok) {
          this.setData({ qaSending: false, qaError: userMessage(result), qaCapWarning: result.capWarning });
          return;
        }
        const turn = guardTurn(result.text, departmentId, text, result.citations);
        // 来源条使用guardTurn已核对的条目，不把原始返回重新填回上屏结果。
        appendTurn(departmentId, turn);
        this.setData({
          qaMessages: conversationOf(departmentId),
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
