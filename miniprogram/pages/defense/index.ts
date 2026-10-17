/**
 * 项目讲解与答辩练习（G3 最小纵向实现，Issue #114）。
 *
 * 页面只做渲染与交互；「这轮算不算完成」「失败算不算一轮」全部交给
 * `services/defense/index.ts` 的状态机——那是可测的纯逻辑，页面不重复判断一遍。
 */
import {
  DEFENSE_ANSWER_MAX_CHARS,
  DEFENSE_ANSWER_MIN_CHARS,
  DEFENSE_MATERIALS,
  DEFENSE_QUESTIONS,
  DEFENSE_REANSWER_NOTE,
  DefenseSession,
  advanceRound,
  answerProblem,
  cancelPending,
  createSession,
  defenseFailureCopy,
  feedbackSafetyNote,
  parseSections,
  questionFor,
  recordFailure,
  recordFeedback,
  requestFeedback,
  resetSession,
  startReanswer,
  submitAnswer,
} from '../../services/defense/index';
import { materialForReading, MaterialEntry } from '../../services/defense/reader';

interface SectionView {
  title: string;
  body: string;
}

interface ReviewRow {
  dimension: string;
  status: string;
  excerpt: string;
  summary: string;
  basis: string;
  followup: string;
}

/** 一轮反馈里【追问】的内容，作为下一轮的回答引导。 */
function askOf(sections: SectionView[]): string {
  const found = sections.find((section) => section.title === '【追问】');
  return found === undefined ? '' : found.body;
}

/** 复盘只列「哪个维度有反馈」与「该轮保留了什么待验证」，不生成新结论。 */
function reviewRows(session: DefenseSession): ReviewRow[] {
  return DEFENSE_QUESTIONS.map((question) => {
    const feedback = session.feedbacks.find((item) => item.round === question.round);
    if (feedback === undefined) return { dimension: question.dimension, status: '未完成', excerpt: '', summary: '', basis: '', followup: '' };
    const sections = parseSections(feedback.text);
    const body = (title: string) => sections.find(section => section.title === title)?.body ?? '';
    return {
      dimension: question.dimension,
      status: '已反馈',
      excerpt: body('【待验证保留】'),
      summary: body('【是否对应回答】'),
      basis: body('【引用核对】'),
      followup: body('【追问】'),
    };
  });
}

Page({
  data: {
    materials: DEFENSE_MATERIALS,
    phase: 'materials',
    materialId: '',
    materialName: '',
    materialKindLabel: '',
    materialNote: '',
    materialFacts: [] as string[],
    materialEntries: [] as string[],
    selectedMaterialId: 'FC-1',
    materialOpen: false,
    materialIndexOpen: false,
    materialReaderName: '',
    materialReaderKind: '',
    materialFrozenAt: '',
    materialPreface: '',
    materialBoundary: '',
    materialRows: [] as MaterialEntry[],
    materialAnchor: '',
    round: 0,
    dimension: '',
    question: '',
    answer: '',
    answerCount: 0,
    minChars: DEFENSE_ANSWER_MIN_CHARS,
    maxChars: DEFENSE_ANSWER_MAX_CHARS,
    pendingSeconds: 0,
    sections: [] as SectionView[],
    ask: '',
    safetyNote: '',
    reviewRows: [] as ReviewRow[],
    failureTitle: '',
    failureBody: '',
    failureRetryable: true,
    reanswerNote: DEFENSE_REANSWER_NOTE,
    hint: '',
  },
  session: resetSession() as DefenseSession,
  requestToken: 0,
  timer: 0,

  onLoad() {
    this.session = resetSession();
  },

  onUnload() {
    this.stopTimer();
    // 会话只留在内存里：离开页面即清空，不写任何云端业务记录。
    this.session = resetSession();
  },

  stopTimer() {
    if (this.timer !== 0) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  },
  onSelectMaterial(event: { currentTarget: { dataset: { id?: string } } }) {
    const id = String(event.currentTarget.dataset.id ?? '');
    if (DEFENSE_MATERIALS.some(material => material.id === id)) this.setData({ selectedMaterialId: id });
  },
  onBegin() {
    this.onPickMaterial({ currentTarget: { dataset: { id: this.data.selectedMaterialId } } });
  },
  onOpenMaterial(event?: { currentTarget: { dataset: { anchor?: string } } }) {
    const material = materialForReading(this.data.materialId || this.data.selectedMaterialId);
    if (material === null) return;
    const anchor = event?.currentTarget.dataset.anchor ?? '';
    this.setData({ materialOpen: true, materialIndexOpen: false, materialReaderName: material.name, materialReaderKind: material.kindLabel,
      materialFrozenAt: material.frozenAt, materialRows: material.entries, materialPreface: material.preface, materialBoundary: material.boundary,
      materialAnchor: material.entries.some(entry => entry.id === anchor) ? `material-${anchor}` : '',
    });
  },
  onCloseMaterial() {
    this.setData({ materialOpen: false, materialIndexOpen: false, materialAnchor: '' });
  },
  toggleMaterialIndex() {
    this.setData({ materialIndexOpen: !this.data.materialIndexOpen });
  },
  stopMaterialTap() {},
  onLocateMaterial(event: { currentTarget: { dataset: { id?: string } } }) {
    const id = String(event.currentTarget.dataset.id ?? '');
    if (!this.data.materialRows.some(entry => entry.id === id)) return;
    this.setData({ materialIndexOpen: false, materialAnchor: '' }, () => this.setData({ materialAnchor: `material-${id}` }));
  },

  startTimer() {
    this.stopTimer();
    this.setData({ pendingSeconds: 0 });
    this.timer = setInterval(() => {
      this.setData({ pendingSeconds: this.data.pendingSeconds + 1 });
    }, 1000) as unknown as number;
  },

  onPickMaterial(event: { currentTarget: { dataset: { id?: string } } }) {
    const id = String(event.currentTarget.dataset.id ?? '');
    const material = DEFENSE_MATERIALS.find((item) => item.id === id);
    if (material === undefined) return;
    const session = createSession(material.id);
    const question = questionFor(session.round);
    this.session = session;
    this.setData({
      phase: session.phase,
      materialId: material.id,
      materialName: material.name,
      materialKindLabel: material.kindLabel,
      materialNote: material.note,
      materialFacts: material.facts,
      materialEntries: material.entries,
      round: session.round,
      dimension: question === null ? '' : question.dimension,
      question: question === null ? '' : question.text,
      answer: '',
      answerCount: 0,
      sections: [],
      ask: '',
      hint: '',
    });
  },

  onAnswerInput(event: { detail: { value: string } }) {
    const answer = String(event.detail.value ?? '');
    this.setData({ answer, answerCount: answer.trim().length, hint: '' });
  },

  onSubmit() {
    const problem = answerProblem(this.data.answer);
    if (problem !== '') {
      const hint = problem === 'too-long'
        ? `回答最多 ${DEFENSE_ANSWER_MAX_CHARS} 字，请精简后提交。`
        : `至少写 ${DEFENSE_ANSWER_MIN_CHARS} 字，把对象或做法说清一句。`;
      this.setData({ hint });
      return;
    }
    const session = submitAnswer(this.session, this.data.answer);
    this.session = session;
    this.setData({ phase: session.phase, hint: '' });
    const token = this.beginRequest();
    this.startTimer();
    this.ask(session, token);
  },

  onRetry() {
    const session: DefenseSession = { ...this.session, phase: 'practice', failure: null };
    this.session = session;
    this.setData({ phase: session.phase, failureTitle: '', failureBody: '' });
    this.onSubmit();
  },

  onCancelPending() {
    const session = cancelPending(this.session);
    this.session = session;
    this.stopTimer();
    this.requestToken += 1;
    this.setData({ phase: session.phase, failureTitle: '', failureBody: '' });
  },

  onNextRound() {
    const session = advanceRound(this.session);
    const question = questionFor(session.round);
    this.session = session;
    this.setData({
      phase: session.phase,
      round: session.round,
      dimension: question === null ? '' : question.dimension,
      question: question === null ? '' : question.text,
      answer: '',
      answerCount: 0,
      sections: [],
      ask: '',
      hint: '',
    });
  },

  onStartReanswer() {
    const session = startReanswer(this.session);
    this.session = session;
    this.setData({ phase: session.phase, round: session.round, dimension: '重答', question: DEFENSE_REANSWER_NOTE, answer: '', answerCount: 0, sections: [], ask: '', hint: '' });
  },

  onCopyReview() {
    const lines = [`材料：${this.data.materialName}`];
    for (const row of this.data.reviewRows) {
      lines.push(`${row.dimension}：${row.status}`);
      if (row.summary !== '') lines.push(`对应回答：${row.summary}`);
      if (row.basis !== '') lines.push(`引用核对：${row.basis}`);
      if (row.followup !== '') lines.push(`本轮追问：${row.followup}`);
      if (row.excerpt !== '') lines.push(`待验证保留：${row.excerpt}`);
    }
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '复盘已复制', icon: 'none' }),
    });
  },

  onExit() {
    wx.showModal({
      title: '退出练习',
      content: '本次会话只留在本页内存里，退出后材料选择、三轮回答与反馈都会清空。',
      confirmText: '退出',
      cancelText: '继续',
      success: (res: { confirm: boolean }) => {
        if (!res.confirm) return;
        this.requestToken += 1;
        this.stopTimer();
        this.session = resetSession();
        wx.navigateBack({ delta: 1 });
      },
    });
  },

  goHome() {
    wx.navigateBack({ delta: 1 });
  },

  beginRequest(): number {
    this.requestToken += 1;
    return this.requestToken;
  },

  ask(session: DefenseSession, token: number) {
    const question = questionFor(session.round);
    const prompt = question === null ? DEFENSE_REANSWER_NOTE : question.text;
    requestFeedback(session, prompt)
      .then(({ call, transportNote }) => {
        if (this.requestToken !== token) return; // 取消或退出后回来的结果不上屏
        this.stopTimer();
        if (call === null || !call.ok) {
          this.showFailure(defenseFailureCopy(call, transportNote));
          return;
        }
        const text = call.text;
        const result = recordFeedback(session, text);
        this.session = result.session;
        if (!result.accepted) {
          // 四节不齐：**一个字都不上屏**，只说明缺了哪几节（G1 首评的截断事故就是这样暴露的）。
          const copy = result.session.failure ?? defenseFailureCopy(null, '');
          this.setData({
            phase: result.session.phase,
            failureTitle: copy.title,
            failureBody: copy.body,
            failureRetryable: copy.retryable,
            sections: [],
            ask: '',
            hint: '',
          });
          return;
        }
        const sections = parseSections(text);
        this.setData({
          phase: result.session.phase,
          sections,
          ask: askOf(sections),
          safetyNote: feedbackSafetyNote(call),
          reviewRows: reviewRows(result.session),
          hint: '',
        });
      })
      .catch((error: unknown) => {
        if (this.requestToken !== token) return;
        this.stopTimer();
        this.showFailure(defenseFailureCopy(null, error instanceof Error ? error.message : String(error)));
      });
  },

  showFailure(copy: { title: string; body: string; retryable: boolean }) {
    this.session = recordFailure(this.session, copy);
    this.setData({
      phase: 'failure',
      failureTitle: copy.title,
      failureBody: copy.body,
      failureRetryable: copy.retryable,
      sections: [],
      ask: '',
    });
  },
});
