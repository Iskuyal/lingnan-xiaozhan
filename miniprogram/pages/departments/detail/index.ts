import {
  buildDepartmentDetail,
  NOT_FOUND_COPY,
  NOT_FOUND_TITLE,
  type DepartmentDetailView,
} from '../../../services/departments';
import { callAi, chatEvent, DEPARTMENT_QA_FEATURE, transportMessage, userMessage } from '../../../services/ai';
import {
  ChatTurn,
  QA_OFFLINE_NOTE,
  QA_SOURCE_NOTE,
  QaOption,
  WELCOME_TEXT,
  appendTurn,
  buildSystemPrompt,
  conversationOf,
  copyActivitySourceUrl,
  guardTurn,
  historyMessages,
  markQaDismissed,
  qaDismissed,
  qaPanelPatch,
  resetConversation,
  safetyNoteFor,
  sourceNoteFor,
} from '../qa';

interface InputEvent {
  detail: { value?: unknown };
}

interface DatasetEvent {
  currentTarget: { dataset: { text?: string; url?: string } };
}

/**
 * 部门详情（Ticket 07：可就该部门继续追问）。
 *
 * 页面顶部是组织信息，紧跟一个问答面板（面板做法移植自 PR #29）：AI 给出这个部门的
 * 追问建议，回答只依据随包提供的已核实资料；模型不可用时如实提示，资料照常展示。
 *
 * 交互仍按 main 的既有约定：进入自动展开一次、可收起、关过之后不再自动弹
 * （与列表页共用同一条持久标记与同一份会话，返回列表后对话不丢）。
 */
Page({
  data: {
    detail: null as DepartmentDetailView | null,
    notFound: false,
    notFoundTitle: NOT_FOUND_TITLE,
    notFoundCopy: NOT_FOUND_COPY,
    qaOpen: false,
    /** 这个页面的对话固定属于 URL 里的部门（未知部门不显示面板）。 */
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
  onLoad(query: Record<string, string | undefined> | undefined) {
    const id = query ? query.id : undefined;
    const detail = buildDepartmentDetail(id);
    this.setData({
      detail,
      notFound: detail === null,
      qaDepartmentId: detail === null || typeof id !== 'string' ? '' : id,
    });
    if (detail !== null) this.refreshQa();
  },
  /**
   * 进入这台页面自动展开一次（与列表页同一套交互与同一条持久标记：关过就不再弹）；
   * 从别处返回时只把共享会话重新读一遍，不重置——返回后可以接着问。
   */
  onShow() {
    if (this.data.detail === null) return;
    if (this.data.qaOpen) {
      this.refreshQa();
      return;
    }
    if (qaDismissed()) return;
    this.openQa();
  },
  refreshQa() {
    this.setData(qaPanelPatch({ departmentId: this.data.qaDepartmentId }));
  },
  /** 详情页的首屏入口保留上下文，点击后滚到下方的部门问答面板。 */
  scrollToQa() {
    if (!this.data.qaOpen) this.openQa();
    setTimeout(() => wx.pageScrollTo({ selector: '#department-qa-panel', duration: 250 }), 40);
  },
  /** 打开面板。与列表页不同：这里不清空对话（用户要清空可以点「重新开始对话」）。 */
  openQa() {
    if (this.data.qaOpen || this.data.detail === null) return;
    this.setData({
      qaOpen: true,
      qaError: '',
      qaCapWarning: '',
      qaSourceNote: QA_SOURCE_NOTE,
      qaSafetyNote: '',
    });
    this.refreshQa();
  },
  closeQa() {
    markQaDismissed();
    this.setData({ qaOpen: false });
  },
  restartConversation() {
    if (this.data.qaDepartmentId === '') return;
    resetConversation(this.data.qaDepartmentId);
    this.refreshQa();
  },
  /** 点追问建议：等价于填进输入框再发送。 */
  askSuggestion(event: DatasetEvent) {
    const text = event.currentTarget.dataset.text;
    if (typeof text !== 'string' || text.length === 0) return;
    this.setData({ qaInput: text });
    return this.sendQuestion();
  },
  onQaInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ qaInput: typeof raw === 'string' ? raw : '' });
  },
  /** 追问：与列表页同一套（守卫、失败文案、内容安全提示），只是部门固定为当前页。 */
  sendQuestion() {
    const text = this.data.qaInput.trim();
    const departmentId = this.data.qaDepartmentId;
    if (text === '' || this.data.qaSending || departmentId === '') return;
    appendTurn(departmentId, { role: 'user', text });
    const history = conversationOf(departmentId);
    this.setData({ qaMessages: history, qaInput: '', qaSending: true, qaError: '' });
    const system = buildSystemPrompt();
    return callAi(chatEvent(DEPARTMENT_QA_FEATURE, system, historyMessages(history, system)))
      .then((result) => {
        if (!result.ok) {
          this.setData({ qaSending: false, qaError: userMessage(result), qaCapWarning: result.capWarning });
          return;
        }
        const turn = guardTurn(result.text, departmentId, text);
        // 检索命中的动态来源挂到这条回答上，模板据此渲染来源条（无命中时不出现）。
        if (result.citations.length > 0) turn.citations = result.citations;
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
  /** 点检索来源条：复制官网原文链接（交互实现收在 qa.ts，见 qa.wxml）。 */
  copyActivitySource(event: DatasetEvent) {
    copyActivitySourceUrl(event.currentTarget.dataset.url ?? '');
  },
  goBackToList() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/departments/index' });
  },
  copySource() {
    const detail = this.data.detail;
    if (!detail) return;
    wx.setClipboardData({
      data: detail.sourceUrl,
      success: () => wx.showToast({ title: '来源链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
