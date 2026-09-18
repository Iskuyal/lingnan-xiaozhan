import { buildDepartmentList } from '../../services/departments';
import { callAi, chatEvent, transportMessage, userMessage } from '../../services/ai';
import { buildSystemPrompt, buildWelcome, chatMessages, ChatTurn, QaOption, QA_SOURCE_NOTE } from './qa';

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
    });
  },
  closeQa() {
    this.setData({ qaOpen: false });
  },
  /** 点选项 = 进入对应部门详情（与列表点击同一入口）。 */
  pickDepartment(event: WechatMiniprogram.TouchEvent) {
    this.openDetail(event);
  },
  onQaInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ qaInput: typeof raw === 'string' ? raw : '' });
  },
  /** 追问：发送中锁定，空输入不调用；失败不产生假回答，三类失败文案各自独立。 */
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
        this.setData({
          qaMessages: history.concat([{ role: 'assistant', text: result.text }]),
          qaSending: false,
          qaError: '',
          qaCapWarning: result.capWarning,
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
