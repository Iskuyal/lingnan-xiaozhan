import { buildDepartmentList, findDepartmentById } from '../../services/departments';
import { buildQaPanel, qaStore } from '../../services/departments-qa';

interface DraftEvent {
  detail: { value: string };
}

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; text?: string } };
}

/**
 * 学生部门（Ticket 07：进入模块即有对话框）。
 *
 * AI 提示「你想了解什么部门」并给出可点的组织选项，点进去是部门详情页；
 * 详情页里可以继续追问，返回这里对话仍在，也可以直接接着问。
 */
Page({
  data: {
    view: buildDepartmentList(),
    qa: buildQaPanel({ scope: 'list', store: qaStore }),
    draft: '',
  },
  /** 从详情页返回时对话可能已经变了，重新组装对话框。 */
  onShow() {
    this.refreshQa();
  },
  refreshQa() {
    this.setData({ qa: buildQaPanel({ scope: 'list', store: qaStore, draft: this.data.draft }) });
  },
  openDetail(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id.length === 0) return;
    wx.navigateTo({ url: `/pages/departments/detail/index?id=${id}` });
  },
  /** 点 AI 给出的选项：把对话切到该部门，再进入它的页面。 */
  openOption(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || findDepartmentById(id) === null) return;
    qaStore.setActive(id);
    this.refreshQa();
    wx.navigateTo({ url: `/pages/departments/detail/index?id=${id}` });
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
    const departmentId = qaStore.activeId;
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
    const departmentId = qaStore.activeId;
    if (departmentId === '') return;
    qaStore.reset(departmentId);
    this.refreshQa();
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
