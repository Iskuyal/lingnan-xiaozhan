/**
 * 项目讲解与答辩练习：客户端契约与状态机（G3 最小纵向实现，Issue #114）。
 *
 * 三个刻意的分工，别在实现里混起来：
 * - **服务端**（`cloudfunctions/ai/defense.ts`）持有 G0 **冻结**的材料正文，按 `materialId` 自己取；
 *   四节结构与引用编号的存在性由它校验，不过就不返回正文。客户端**不发材料正文**。
 * - **本模块**：组装请求、把模型返回按契约「缺任一节不上屏」再守一道、把失败映射成本页文案、
 *   以及一个可测的状态机（轮次、重答一次、失败不改轮次也不产生反馈）。
 * - **页面**（`pages/defense/`）：只负责渲染与交互，不自己判断「这轮算不算完成」。
 *
 * 与设计图/契约的对齐见 `docs/design/project-defense/README.md`（已定稿）。
 */
import { AiCallResult, callAi, transportMessage, userMessage } from '../ai';

/** 与云函数 `DEFENSE_FEATURE` 同名（跨包有意复制，项目惯例同 FAILURE_CLASSES）。 */
export const DEFENSE_FEATURE = 'project-defense';

/** 四节标题：**顺序也是契约**，缺一节或顺序不对都不上屏。 */
export const DEFENSE_SECTIONS = ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'];

/** 单轮回答的字数窗口（设计定稿：20–500 字）。 */
export const DEFENSE_ANSWER_MIN_CHARS = 20;
export const DEFENSE_ANSWER_MAX_CHARS = 500;

/** 三轮 = 三个维度；重答另算一次（全流程仅一次）。 */
export const DEFENSE_MAX_ROUNDS = 3;
export const DEFENSE_REANSWER_ROUND = 4;

/** 材料展示摘要。**正文不放这里**——正文在服务端，客户端只展示要点与可引用编号。 */
export interface DefenseMaterialSummary {
  id: string;
  name: string;
  kind: 'owned' | 'design';
  kindLabel: string;
  note: string;
  facts: string[];
  /** 该材料里可被引用的条目编号（服务端也会按冻结正文再算一遍）。 */
  entries: string[];
}

/**
 * 两份材料的展示摘要。id 必须与 `scripts/lib/generate-defense-materials.cjs` 的登记一致，
 * `tests/defense-g3.test.cjs` 会比对「这里的 entries 是否是冻结件里编号的超集」。
 */
export const DEFENSE_MATERIALS: DefenseMaterialSummary[] = [
  {
    id: 'FC-1',
    name: '课表导入与校对',
    kind: 'owned',
    kindLabel: '本项目自有材料',
    note: '9 条事实 + 3 条不变量 · 3 条待验证 · 3 处文档待核实',
    facts: [
      'F1 只能从微信聊天记录里选文件，不能浏览手机本地文件',
      'F4 识别不出的只标记不猜，交给学生在确认页裁决',
      'F8 三项仍待验证：服务端越权隔离、100 条以上分页读取、临时文件极端残留',
    ],
    entries: ['INV-1', 'INV-2', 'INV-3', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'],
  },
  {
    id: 'FC-2',
    name: '打字练习小游戏',
    kind: 'design',
    kindLabel: '维护者原创设计情景（不是小程序已有功能）',
    note: '8 条设计事实 + 2 条不变量 · 没有任何代码或测试记录',
    facts: [
      'D3 计时以第一次键入为起点，不是点「开始」的时刻',
      'D7 按住不放只计一次错误：希望如此，但未测试、实现方式未定',
      'D8 中途刷新行为未定义；移动端软键盘遮挡布局未验证',
    ],
    entries: ['INV-A', 'INV-B', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'],
  },
];

/** 三个维度各一个问题（设计定稿：不是同一问题问三遍）。 */
export interface DefenseQuestion {
  round: number;
  dimension: string;
  text: string;
}

export const DEFENSE_QUESTIONS: DefenseQuestion[] = [
  { round: 1, dimension: '问题与目标', text: '这个功能是给谁、解决什么问题的？请用两三句话说清。' },
  { round: 2, dimension: '方案及取舍', text: '它是怎么做的？请说明关键环节，以及你放弃或没做的做法。' },
  { round: 3, dimension: '验证与限制', text: '哪些部分验证过、哪些还没验证？请如实说明依据与限制。' },
];

/** 重答前的固定说明：重答必须新写，且要补可回核的依据。 */
export const DEFENSE_REANSWER_NOTE = '重答请针对一处薄弱项，尽量补上能回核的条目编号；只把句子写长不算改善。';

/** 每次作答后面的固定指令（纪律与四节格式由服务端下发，这里只说「做什么」）。 */
export const DEFENSE_FEEDBACK_INSTRUCTION = '请按服务端下发的四节格式，对上面这段回答给出反馈与一个追问。';

export function materialById(id: string): DefenseMaterialSummary | null {
  return DEFENSE_MATERIALS.find((material) => material.id === id) ?? null;
}

export function questionFor(round: number): DefenseQuestion | null {
  return DEFENSE_QUESTIONS.find((question) => question.round === round) ?? null;
}

/**
 * 一次作答的事件：**没有 `system`**，材料也只有一个 id。
 * 服务端会用自己那份冻结正文重建提示词，客户端传什么都覆盖不掉。
 */
export function defenseChatEvent(materialId: string, question: string, answer: string): Record<string, unknown> {
  return {
    action: 'chat',
    feature: DEFENSE_FEATURE,
    materialId,
    messages: [
      { role: 'user', text: question },
      { role: 'assistant', text: answer },
      { role: 'user', text: DEFENSE_FEEDBACK_INSTRUCTION },
    ],
  };
}

/** 提交前对回答的字数校验。返回空串表示可以提交。 */
export function answerProblem(answer: string): '' | 'empty' | 'too-short' | 'too-long' {
  const text = String(answer ?? '').trim();
  if (text === '') return 'empty';
  if (text.length < DEFENSE_ANSWER_MIN_CHARS) return 'too-short';
  if (text.length > DEFENSE_ANSWER_MAX_CHARS) return 'too-long';
  return '';
}

/** 缺哪几节（按契约顺序返回缺失的标题；顺序错也算缺，交给页面拒绝上屏）。 */
export function missingSections(text: string): string[] {
  const body = String(text ?? '');
  const positions = DEFENSE_SECTIONS.map((title) => body.indexOf(title));
  const missing: string[] = [];
  let previous = -1;
  for (let index = 0; index < DEFENSE_SECTIONS.length; index += 1) {
    const position = positions[index];
    if (position < 0) missing.push(DEFENSE_SECTIONS[index]);
    else if (position < previous) missing.push(DEFENSE_SECTIONS[index]);
    else previous = position;
  }
  return missing;
}

/** 四节齐全且顺序正确才算完整反馈（**缺一节就不上屏**，这是 G1 截断事故的直接教训）。 */
export function completeFeedback(text: string): boolean {
  return String(text ?? '').trim() !== '' && missingSections(text).length === 0;
}

/** 按四节切成 { title, body }，供页面分块渲染。缺节的块不会出现。 */
export function parseSections(text: string): Array<{ title: string; body: string }> {
  const body = String(text ?? '');
  const index = DEFENSE_SECTIONS.map((title) => body.indexOf(title));
  const out: Array<{ title: string; body: string }> = [];
  for (let position = 0; position < DEFENSE_SECTIONS.length; position += 1) {
    if (index[position] < 0) continue;
    const start = index[position] + DEFENSE_SECTIONS[position].length;
    let end = body.length;
    for (const candidate of index) if (candidate > index[position] && candidate < end) end = candidate;
    out.push({ title: DEFENSE_SECTIONS[position], body: body.slice(start, end).trim() });
  }
  return out;
}

/** 本页自己的失败文案：**不改全局 `AI_MSG_*`**，因此不影响升学问答等既有功能。 */
export interface DefenseFailureCopy {
  title: string;
  body: string;
  retryable: boolean;
}

export function defenseFailureCopy(call: AiCallResult | null, transportNote: string): DefenseFailureCopy {
  if (call === null) {
    return { title: '这次没能发出去', body: `${transportNote} 你的回答还在下面，可以直接重试。`, retryable: true };
  }
  // 服务端可能没给出 failureClass（老版本/异常形状），这时退回它给的文案。
  const failureClass = call.failureClass;
  switch (failureClass) {
    case 'model_unavailable':
      return { title: '模型暂时没有返回结果', body: '这次核对超时或模型没有返回正文，你的回答没有被判定，也没有产生任何评价。可以直接重试。', retryable: true };
    case 'content_rejected':
      return { title: '这段内容没有通过安全检测', body: '请改一改再试。你的其他内容没有被判定，也没有产生评价。', retryable: true };
    case 'quota_exhausted':
      return { title: '额度或当日检测配额已用尽', body: '这项练习暂时无法继续；已写的内容仍可复制。排障时先确认是不是内容安全当日配额（45009）。', retryable: false };
    case 'invalid_request':
      return { title: '这次请求没能发出去', body: '回答或材料超出了长度限制（单轮 ≤500 字）。请精简后重试。', retryable: true };
    case 'citation_unverified':
      return { title: '这次反馈没有通过引用核对', body: '服务端发现反馈里的引用对不上材料，已拦下，不显示半截内容。你的回答还在，可以重试。', retryable: true };
    default:
      return { title: '这次没能完成核对', body: `${userMessage(call)} 你的回答还在，可以重试。`, retryable: true };
  }
}

/** 四节不齐时的文案（不上屏，但要说清为什么）。 */
export function incompleteFeedbackCopy(missing: string[]): DefenseFailureCopy {
  return {
    title: '这次的反馈不完整',
    body: `服务端返回的内容缺少 ${missing.join('、')}，按契约不上屏。你的回答已保留，可以重试。`,
    retryable: true,
  };
}

/** 页面状态。失败是独立状态：它不推进轮次，也不产生反馈。 */
export type DefensePhase = 'materials' | 'practice' | 'pending' | 'feedback' | 'review' | 'reanswer' | 'done' | 'failure';

export interface DefenseSession {
  materialId: string;
  /** 当前作答轮次：1–3 是三轮，4 是重答。 */
  round: number;
  answers: Array<{ round: number; text: string }>;
  feedbacks: Array<{ round: number; text: string }>;
  reanswerUsed: boolean;
  phase: DefensePhase;
  /** 待重试的回答（失败/取消时保留，退出清空）。 */
  draft: string;
  failure: DefenseFailureCopy | null;
}

const EMPTY_SESSION: DefenseSession = {
  materialId: '',
  round: 0,
  answers: [],
  feedbacks: [],
  reanswerUsed: false,
  phase: 'materials',
  draft: '',
  failure: null,
};

export function createSession(materialId: string): DefenseSession {
  return { ...EMPTY_SESSION, materialId, round: 1, phase: 'practice', answers: [], feedbacks: [] };
}

/** 退出/重置：会话只留在内存里，清空后不保留任何回答与反馈。 */
export function resetSession(): DefenseSession {
  return { ...EMPTY_SESSION, answers: [], feedbacks: [] };
}

/** 提交一轮：进入 pending，**不改轮次**，草稿留着（失败可重试）。 */
export function submitAnswer(session: DefenseSession, answer: string): DefenseSession {
  return { ...session, draft: answer, phase: 'pending', failure: null };
}

/** 取消（等待态）：回到作答态并保留草稿，不产生反馈。 */
export function cancelPending(session: DefenseSession): DefenseSession {
  return { ...session, phase: session.round === DEFENSE_REANSWER_ROUND ? 'reanswer' : 'practice', failure: null };
}

/** 失败：保留草稿与已完成的轮次，**不推进轮次、不产生本轮的反馈**。 */
export function recordFailure(session: DefenseSession, copy: DefenseFailureCopy): DefenseSession {
  return { ...session, phase: 'failure', failure: copy };
}

/**
 * 收到模型返回：先按契约守一道（四节齐不齐），再决定推进。
 * - 不完整 → `accepted: false`，状态进 failure，**不写入 feedbacks**；
 * - 完整 → 写入 `feedbacks`（同一轮重复提交时覆盖），状态进 `feedback` 或 `review`。
 */
export function recordFeedback(session: DefenseSession, text: string): { session: DefenseSession; accepted: boolean; missing: string[] } {
  const missing = missingSections(text);
  if (text.trim() === '' || missing.length > 0) {
    return { session: recordFailure(session, incompleteFeedbackCopy(missing)), accepted: false, missing };
  }
  const answer = { round: session.round, text: session.draft };
  const updated: DefenseSession = {
    ...session,
    answers: [...session.answers.filter((item) => item.round !== session.round), answer],
    feedbacks: [...session.feedbacks.filter((item) => item.round !== session.round), { round: session.round, text }],
    failure: null,
  };
  if (session.round === DEFENSE_REANSWER_ROUND) return { session: { ...updated, phase: 'done' }, accepted: true, missing: [] };
  if (session.round >= DEFENSE_MAX_ROUNDS) return { session: { ...updated, phase: 'review' }, accepted: true, missing: [] };
  return { session: { ...updated, phase: 'feedback' }, accepted: true, missing: [] };
}

/** 进入下一轮（只在 feedback 态调用）。 */
export function advanceRound(session: DefenseSession): DefenseSession {
  if (session.phase !== 'feedback') return session;
  return { ...session, round: session.round + 1, phase: 'practice', draft: '', failure: null };
}

/** 从复盘进入重答（全流程仅一次）。 */
export function startReanswer(session: DefenseSession): DefenseSession {
  if (session.phase !== 'review' || session.reanswerUsed) return session;
  return { ...session, round: DEFENSE_REANSWER_ROUND, phase: 'reanswer', draft: '', failure: null };
}

/** 页面只渲染**当前轮**的反馈：失败态与下一轮开始时都拿不到旧结果。 */
export function currentFeedback(session: DefenseSession): string | null {
  if (session.phase !== 'feedback' && session.phase !== 'review' && session.phase !== 'done') return null;
  return session.feedbacks.find((item) => item.round === session.round)?.text ?? null;
}

/**
 * 发起一次核对。返回 `{ call, transportNote }`；**不抛错**，传输层失败用 `call: null` 表达。
 * 取消由调用方用「请求代号」判断（仓库惯例，见 pages/advancement）。
 */
export async function requestFeedback(session: DefenseSession, question: string): Promise<{ call: AiCallResult | null; transportNote: string }> {
  const material = materialById(session.materialId);
  if (material === null) return { call: null, transportNote: '材料不存在，请回到材料页重新选择。' };
  try {
    const call = await callAi(defenseChatEvent(material.id, question, session.draft));
    return { call, transportNote: '' };
  } catch (error) {
    const note = transportMessage(error);
    return { call: null, transportNote: note === '' ? '网络或云函数调用失败。' : note };
  }
}

/** 内容安全提示（服务端检过才显示；未检测时如实提示）。 */
export function feedbackSafetyNote(call: AiCallResult | null): string {
  if (call === null || call.safety === null) return '';
  return call.safety.checked ? '内容安全已检测' : '本轮内容未检测（服务端未开启检测，请谨慎参考）';
}
