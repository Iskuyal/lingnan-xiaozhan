/**
 * 项目讲解与答辩练习（岭南红 UI 第二轮 C 分支；设计 31–35、42、56–62、77/78）。
 *
 * 页面只做渲染与交互；「这轮算不算完成」「失败算不算一轮」全部交给
 * `services/defense/index.ts` 的状态机——那是可测的纯逻辑，页面不重复判断一遍。
 *
 * 77/78 的练习记录复制是本轮新增能力：`buildRecordView()` 与 `practiceRecordText()`
 * 是从页面模块导出的纯函数（方便测试），只汇总**当前会话真实已有**的内容——
 * 没有答案、没有已返回反馈的轮次不会出现；原答逐字照抄，不改写、不补写、不臆造。
 */
import {
  DEFENSE_ANSWER_MAX_CHARS,
  DEFENSE_ANSWER_MIN_CHARS,
  DEFENSE_MATERIALS,
  DEFENSE_QUESTIONS,
  DEFENSE_REANSWER_NOTE,
  DEFENSE_REANSWER_ROUND,
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

/** 一条可复制的轮次记录：问题、原答、已返回的反馈各自独立，互不覆盖。 */
export interface PracticeRecordRound {
  round: number;
  dimension: string;
  question: string;
  answer: string;
  feedback: string;
}

/** 「三轮复盘」里的一行：只写会话里真实拿到的反馈内容。 */
export interface PracticeRecordReviewLine {
  index: string;
  dimension: string;
  status: string;
  summary: string;
  basis: string;
  followup: string;
  excerpt: string;
}

/** 77 屏与剪贴板共用的一份视图数据。 */
export interface PracticeRecordView {
  materialName: string;
  rounds: PracticeRecordRound[];
  review: PracticeRecordReviewLine[];
  reanswer: PracticeRecordRound | null;
  empty: boolean;
}

const EMPTY_RECORD_VIEW: PracticeRecordView = { materialName: '', rounds: [], review: [], reanswer: null, empty: true };

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

/**
 * 汇总当前会话**真实已有**的内容。判定只看 session 里的 answers / feedbacks：
 * 两者缺一（或为空）的轮次一律跳过——这正是「不补写未返回内容」的实现点。
 */
export function buildRecordView(input: {
  materialName: string;
  session: DefenseSession;
  reviewRows: ReviewRow[];
}): PracticeRecordView {
  const rounds: PracticeRecordRound[] = [];
  for (const question of DEFENSE_QUESTIONS) {
    const answer = input.session.answers.find((item) => item.round === question.round);
    const feedback = input.session.feedbacks.find((item) => item.round === question.round);
    if (answer === undefined || feedback === undefined) continue;
    if (answer.text.trim() === '' || feedback.text.trim() === '') continue;
    rounds.push({
      round: question.round,
      dimension: question.dimension,
      question: question.text,
      answer: answer.text,
      feedback: feedback.text,
    });
  }

  const reanswerAnswer = input.session.answers.find((item) => item.round === DEFENSE_REANSWER_ROUND);
  const reanswerFeedback = input.session.feedbacks.find((item) => item.round === DEFENSE_REANSWER_ROUND);
  const hasReanswer = reanswerAnswer !== undefined && reanswerFeedback !== undefined
    && reanswerAnswer.text.trim() !== '' && reanswerFeedback.text.trim() !== '';
  const reanswer: PracticeRecordRound | null = hasReanswer
    ? {
      round: DEFENSE_REANSWER_ROUND,
      dimension: `沿用第 ${DEFENSE_QUESTIONS.length} 轮问题`,
      question: '',
      answer: reanswerAnswer.text,
      feedback: reanswerFeedback.text,
    }
    : null;

  const review: PracticeRecordReviewLine[] = [];
  for (const row of input.reviewRows) {
    const filled = row.summary !== '' || row.basis !== '' || row.followup !== '' || row.excerpt !== '';
    if (row.status !== '已反馈' && !filled) continue;
    review.push({
      index: String(review.length + 1).padStart(2, '0'),
      dimension: row.dimension,
      status: row.status,
      summary: row.summary,
      basis: row.basis,
      followup: row.followup,
      excerpt: row.excerpt,
    });
  }

  return {
    materialName: input.materialName,
    rounds,
    review,
    reanswer,
    empty: rounds.length === 0 && reanswer === null && review.length === 0,
  };
}

/**
 * 复制到剪贴板的纯文本。分段名与设计 77 的标签逐字一致：
 * 「问题」「你的回答」「材料反馈」「你的重答」「重答反馈」。
 * 空视图返回空串——页面据此提示「没有可复制内容」，不写空剪贴板。
 */
export function practiceRecordText(view: PracticeRecordView): string {
  if (view.empty) return '';
  const lines: string[] = ['项目讲解练习 · 练习记录'];
  if (view.materialName !== '') lines.push(`材料：${view.materialName}`);
  for (const round of view.rounds) {
    lines.push('', `第 ${round.round} 轮 · ${round.dimension} · 原答`);
    lines.push(`问题：${round.question}`);
    lines.push('你的回答：', round.answer, '');
    lines.push('材料反馈：', round.feedback);
  }
  if (view.review.length > 0) {
    lines.push('', '三轮复盘');
    for (const line of view.review) {
      lines.push(`${line.index} ${line.dimension}：${line.status}`);
      if (line.summary !== '') lines.push(`对应回答：${line.summary}`);
      if (line.basis !== '') lines.push(`引用核对：${line.basis}`);
      if (line.followup !== '') lines.push(`本轮追问：${line.followup}`);
      if (line.excerpt !== '') lines.push(`待验证保留：${line.excerpt}`);
    }
  }
  if (view.reanswer !== null) {
    lines.push('', `重答 · ${view.reanswer.dimension}`);
    lines.push('你的重答：', view.reanswer.answer, '', '重答反馈：', view.reanswer.feedback);
  }
  return lines.join('\n');
}

/** 当前轮次的展示字段（第 1–3 轮与重答共用一块 WXML）。 */
function roundPatch(session: DefenseSession): { round: number; dimension: string; question: string; roundLabel: string; progressNow: number } {
  if (session.round === DEFENSE_REANSWER_ROUND) {
    const last = DEFENSE_QUESTIONS[DEFENSE_QUESTIONS.length - 1];
    return {
      round: session.round,
      dimension: '重答',
      // 重答沿用第 3 轮的问题；模型收到的是 DEFENSE_REANSWER_NOTE，界面按设计 60 显示原问题。
      question: last === undefined ? '' : last.text,
      roundLabel: last === undefined ? '重答' : `第 ${last.round} 轮 · ${last.dimension} · 重答`,
      progressNow: DEFENSE_QUESTIONS.length,
    };
  }
  const question = questionFor(session.round);
  return {
    round: session.round,
    dimension: question === null ? '' : question.dimension,
    question: question === null ? '' : question.text,
    roundLabel: question === null ? '' : `第 ${session.round} 轮 · ${question.dimension}`,
    progressNow: session.round,
  };
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
    boundsOpen: false,
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
    roundLabel: '',
    progressNow: 0,
    answer: '',
    answerCount: 0,
    minChars: DEFENSE_ANSWER_MIN_CHARS,
    maxChars: DEFENSE_ANSWER_MAX_CHARS,
    pendingSeconds: 0,
    sections: [] as SectionView[],
    ask: '',
    nextQuestion: '',
    nextDimension: '',
    safetyNote: '',
    reviewRows: [] as ReviewRow[],
    failureTitle: '',
    failureBody: '',
    failureRetryable: true,
    reanswerNote: DEFENSE_REANSWER_NOTE,
    hint: '',
    recordOpen: false,
    recordView: EMPTY_RECORD_VIEW,
    copiedOpen: false,
    copyHint: '',
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
  toggleBounds() {
    this.setData({ boundsOpen: !this.data.boundsOpen });
  },

  onOpenMaterial(event?: { currentTarget: { dataset: { anchor?: string; id?: string } } }) {
    const dataset = event === undefined ? undefined : event.currentTarget.dataset;
    const id = String(dataset?.id ?? '') || this.data.materialId || this.data.selectedMaterialId;
    const material = materialForReading(id);
    if (material === null) return;
    const anchor = dataset?.anchor ?? '';
    this.setData({
      materialOpen: true, materialIndexOpen: false, materialReaderName: material.name, materialReaderKind: material.kindLabel,
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
    this.session = session;
    this.setData({
      phase: session.phase,
      materialId: material.id,
      materialName: material.name,
      materialKindLabel: material.kindLabel,
      materialNote: material.note,
      materialFacts: material.facts,
      materialEntries: material.entries,
      ...roundPatch(session),
      answer: '',
      answerCount: 0,
      sections: [],
      ask: '',
      nextQuestion: '',
      nextDimension: '',
      hint: '',
      copyHint: '',
      recordOpen: false,
      copiedOpen: false,
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
    this.setData({ phase: session.phase, hint: '', copyHint: '' });
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
    this.session = session;
    this.setData({
      phase: session.phase,
      ...roundPatch(session),
      answer: '',
      answerCount: 0,
      sections: [],
      ask: '',
      nextQuestion: '',
      nextDimension: '',
      hint: '',
    });
  },

  onStartReanswer() {
    const session = startReanswer(this.session);
    this.session = session;
    this.setData({
      phase: session.phase,
      ...roundPatch(session),
      answer: '',
      answerCount: 0,
      sections: [],
      ask: '',
      nextQuestion: '',
      nextDimension: '',
      hint: '',
      copyHint: '',
    });
  },

  /** 77 屏：把当前会话已产生的内容整理成可读卡片。 */
  buildRecord(): PracticeRecordView {
    return buildRecordView({ materialName: this.data.materialName, session: this.session, reviewRows: this.data.reviewRows });
  },
  onOpenRecord() {
    this.setData({ recordOpen: true, recordView: this.buildRecord(), copyHint: '' });
  },
  onCloseRecord() {
    this.setData({ recordOpen: false, copyHint: '' });
  },
  onCloseCopied() {
    this.setData({ copiedOpen: false });
  },

  /**
   * 复制当前已有的全部内容（77 → 78）。三条底线：
   * - 空会话不写剪贴板，只说明没有可复制内容；
   * - 失败只报失败，**不清空会话**，草稿与已返回的反馈都还在；
   * - 只复制本页内存里的内容，不保存到云端、不调用模型。
   */
  onCopyReview() {
    const text = practiceRecordText(this.buildRecord());
    if (text === '') {
      this.setData({ copyHint: '当前会话还没有可复制的内容：至少完成一轮、拿到反馈后再复制。' });
      wx.showToast({ title: '没有可复制的内容', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        this.setData({ copyHint: '', recordOpen: false, copiedOpen: true });
        wx.showToast({ title: '练习记录已复制', icon: 'none' });
      },
      fail: () => {
        // 不重置 this.session：失败也要保住会话，用户还能再试或直接退出。
        this.setData({ copyHint: '复制没有成功，剪贴板里没有写入内容。会话仍保留，可以再试一次。', copiedOpen: false });
        wx.showToast({ title: '复制失败，会话已保留', icon: 'none' });
      },
    });
  },

  onExit() {
    wx.showModal({
      title: '结束这次练习？',
      content: '本次会话只保留在当前页面内存里。退出后，材料选择、回答、反馈与复盘都会清空。想保留内容，可先取消并复制现有记录。',
      confirmText: '确认结束',
      cancelText: '继续练习',
      success: (res: { confirm: boolean }) => {
        if (!res.confirm) return;
        this.requestToken += 1;
        this.stopTimer();
        this.session = resetSession();
        this.setData({ recordOpen: false, copiedOpen: false });
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
        const next = questionFor(result.session.round + 1);
        this.setData({
          phase: result.session.phase,
          sections,
          ask: askOf(sections),
          safetyNote: feedbackSafetyNote(call),
          reviewRows: reviewRows(result.session),
          nextQuestion: next === null ? '' : next.text,
          nextDimension: next === null ? '' : next.dimension,
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
      nextQuestion: '',
      nextDimension: '',
    });
  },
});
