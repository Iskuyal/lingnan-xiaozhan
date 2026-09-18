import {
  buildDepartmentDetail,
  NOT_FOUND_COPY,
  NOT_FOUND_TITLE,
  type DepartmentDetailView,
} from '../../../services/departments';
import { buildQaPanel, qaStore, type QaPanelView } from '../../../services/departments-qa';

interface DraftEvent {
  detail: { value: string };
}

interface DatasetEvent {
  currentTarget: { dataset: { text?: string } };
}

/**
 * 部门详情（Ticket 07：可就该部门继续追问）。
 *
 * 页面顶部是组织信息，紧跟一个问答面板：AI 给出这个部门的追问建议，
 * 回答只依据随包提供的已核实资料；模型不可用时如实提示，资料照常展示。
 */
Page({
  data: {
    detail: null as DepartmentDetailView | null,
    notFound: false,
    notFoundTitle: NOT_FOUND_TITLE,
    notFoundCopy: NOT_FOUND_COPY,
    departmentId: '',
    qa: null as QaPanelView | null,
    draft: '',
  },
  onLoad(query: Record<string, string | undefined> | undefined) {
    const id = query ? query.id : undefined;
    const departmentId = typeof id === 'string' ? id : '';
    const detail = buildDepartmentDetail(id);
    this.setData({
      detail,
      notFound: detail === null,
      departmentId,
      qa: this.panel(departmentId),
    });
  },
  panel(departmentId: string) {
    return buildQaPanel({
      scope: 'detail',
      store: qaStore,
      departmentId,
      draft: this.data.draft,
    });
  },
  refreshQa() {
    this.setData({ qa: this.panel(this.data.departmentId) });
  },
  askSuggestion(event: DatasetEvent) {
    const text = event.currentTarget.dataset.text;
    if (typeof text !== 'string' || text.length === 0) return;
    this.setData({ draft: text });
    return this.sendQuestion();
  },
  onDraftInput(event: DraftEvent) {
    this.setData({ draft: event.detail.value });
    this.refreshQa();
  },
  sendQuestion() {
    const departmentId = this.data.departmentId;
    if (departmentId === '') return undefined;
    // ask 会同步写入提问并进入「正在回答」，因此先渲染一次再等结果。
    const answered = qaStore.ask(departmentId, this.data.draft);
    this.refreshQa();
    return answered.then((result) => {
      // 成功才清空输入框；失败时保留原文，方便直接再发一次。
      this.setData({ draft: result.ok ? '' : this.data.draft });
      this.refreshQa();
    });
  },
  restartConversation() {
    if (this.data.departmentId === '') return;
    qaStore.reset(this.data.departmentId);
    this.refreshQa();
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
