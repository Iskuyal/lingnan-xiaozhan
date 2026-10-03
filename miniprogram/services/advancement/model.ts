/**
 * 升学 / 实习问答的模型版（Issue #94）：把本地检索结果交给 `ai` 云函数解释，并决定上屏形态。
 *
 * 分工是刻意的：
 * - **本地（`./index.ts`）**：范围守门（类别/年份/地区）与检索。答案必须有原文段落支撑，
 *   检索不到就不发模型请求——「没有依据」这一步不花额度，也不给模型编的机会。
 * - **服务端（`cloudfunctions/ai/advancement.ts`）**：段落必须来自它自己的可信语料，
 *   范围要与段落元信息一致，回答里含日期/数字/条件的句子必须带 `[Sn]` 出处标记、
 *   而且这些数字得在标记指向的段落里找得到。校验不过就**不返回模型答案**。
 * - **本模块**：组装请求、按服务端的校验结论决定上屏什么。
 *   `verified !== true` 或调用失败时一律**降级为原文摘录**（本地已有，不需要再请求）。
 *
 * 因此用户看到的三种形态：模型解释（带引用）/ 模型说无法核实 / 原文摘录降级。
 */
import {
  AdvancementCallReport,
  AiCallResult,
  chatEvent,
  safetyNoteFor,
  userMessage,
} from '../ai';
import { AskResult, Citation, ResolvedScope } from './index';

/** 与云函数 `ADVANCEMENT_QA_FEATURE` 同名（跨包有意复制，项目惯例同 FAILURE_CLASSES）。 */
export const ADVANCEMENT_QA_FEATURE = 'advancement-qa';

/** 回答上限：答案要求不超过 200 字，留一倍余量即可；过长会拖时间且更容易跑偏。 */
export const ADVANCEMENT_MAX_TOKENS = 600;

/**
 * 系统提示词（纪律部分）。
 *
 * 只说「怎么做」，**不重复资料本身**——资料由服务端按 `passageIds` 注入，
 * 客户端传不了「官方原文」（传了也会被服务端丢掉，只认它自己那份语料）。
 * 引用标记 `[S1]` 是服务端校验的契约，改这里要同步改服务端校验与测试。
 */
export const ADVANCEMENT_SYSTEM_PROMPT = [
  '你是「升学与实习问答」助手，只能依据下面【升学资料检索结果】里给出的官方段落回答。',
  '必须遵守：',
  '1. 只选直接回答问题的完整原句，每句独占一行，句号前标出 [S1]、[S2]（半角方括号）；',
  '2. 可以选取、排列完整原句，不得改写、删条件、删否定词或截断分号列表。原文没有句号时保留整段；',
  '3. 检索结果回答不了的问题，只回复「无法核实」四个字，不要给建议性结论；',
  '4. 不要给个人录取或报考资格的保证，不要说「你一定能报」「你不符合条件」；',
  '5. 完整保留条件优先于字数。同段多句也逐句引用，不加解释、标题、总结。',
].join('\n');

/** 模型的三种上屏形态。 */
export type OutcomeKind = 'model' | 'refused' | 'fallback';

export interface ModelOutcome {
  kind: OutcomeKind;
  /** 上屏的主文本：模型解释 / 模型拒答 / 本地原文摘录。 */
  text: string;
  /** 主文本下方的一句说明（失败原因、降级原因或内容安全提示）。 */
  note: string;
  /** 服务端回传的可信段落（降级时为空数组，页面仍用本地 citations 展示原文）。 */
  sources: AdvancementCallReport['sources'];
  /** 服务端出处校验的失败原因（短代码），供页面在降级说明里点名。 */
  violations: string[];
}

/** 降级时的那句说明：主文本已经是原文摘录，这里只说清「为什么没用上模型」。 */
export const FALLBACK_SUFFIX = '下面是检索到的官方原文（未改写），可以自己核对。';

/** 模型拒答时的说明。 */
export const REFUSED_NOTE = '模型看过检索到的原文后仍表示无法核实，下面是这些原文，请自行核对。';

/** 引用卡片标题里显示的出处编号。 */
export function sourceLabel(index: number): string {
  return `[S${index + 1}]`;
}

/**
 * 一次模型解释的事件：问题 + 本地已经定下来的范围 + 本次检索到的段落 id。
 *
 * `passageIds` 只给 id，正文由服务端从自己的语料取——这样「官方原文」不会经过客户端。
 */
export function advancementChatEvent(question: string, scope: ResolvedScope, citations: Citation[]): Record<string, unknown> {
  return {
    ...chatEvent(ADVANCEMENT_QA_FEATURE, ADVANCEMENT_SYSTEM_PROMPT, [{ role: 'user', text: question }]),
    scope: { category: scope.category, year: scope.year, region: scope.region },
    passageIds: citations.map((citation) => citation.passageId),
    maxTokens: ADVANCEMENT_MAX_TOKENS,
  };
}

/** 这个结果能不能交给模型解释：只有本地检索出了带出处的答案才可以。 */
export function canAskModel(result: AskResult | null): result is AskResult & { resolvedScope: ResolvedScope } {
  return result !== null
    && result.behavior === 'answer'
    && result.resolvedScope !== undefined
    && result.citations.length > 0
    && result.citations.every((citation) => typeof citation.passageId === 'string' && citation.passageId !== '');
}

/** 请求体是否在服务端的内容安全窗口内（超窗会被整次拒绝，客户端先自己把关）。 */
export function eventInputLength(event: Record<string, unknown>): number {
  const parts: string[] = [];
  if (typeof event.system === 'string' && event.system !== '') parts.push(event.system);
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && typeof (message as { text?: unknown }).text === 'string') {
      parts.push((message as { text: string }).text);
    }
  }
  return parts.join('\n').length;
}

/**
 * 决定这次提问上屏什么。
 *
 * 判定顺序（**服务端结论优先，缺证据一律降级**）：
 * 1. 调用没到达云端 / 服务端失败 → 降级（附失败原因）；
 * 2. 服务端说模型拒答（`refused`）→ 拒答形态，仍把原文列给用户；
 * 3. 服务端 `verified === true` → 模型解释上屏；
 * 4. 其它（`ok` 但没有校验结论、`verified !== true`）→ 降级。**不因为「返回了文字」就上屏**。
 */
export function modelOutcome(input: {
  /** 服务端返回；调用抛错时为 null。 */
  call: AiCallResult | null;
  /** 调用抛错时的可读文案（传输层失败）。 */
  transportNote: string;
  /** 本地检索结果（降级时用它的原文摘录与出处）。 */
  result: AskResult;
}): ModelOutcome {
  const fallback = (note: string, violations: string[] = []): ModelOutcome => ({
    kind: 'fallback',
    text: input.result.answer,
    note,
    sources: [],
    violations,
  });

  if (input.call === null) return fallback(`${input.transportNote}；${FALLBACK_SUFFIX}`);
  const call = input.call;
  const report = call.advancement;
  if (!call.ok) {
    // 降级时**不加**「本轮回答未经内容安全检测」那句：这时候上屏的是本地官方原文摘录，
    // 不是 AI 生成的内容，而 `safety` 为空只是因为这次请求在模型之前就被拒了（额度、参数等）。
    // 把「没检测」挂在官方原文上会让人以为原文有问题。
    const reason = userMessage(call);
    const detail = report !== null && report.violations.length > 0 ? `（核对点：${report.violations.join('、')}）` : '';
    return fallback(`${reason}${detail} ${FALLBACK_SUFFIX}`, report === null ? [] : report.violations);
  }
  // 走到这里说明模型真的出了内容：这时才轮到「这一轮检测了没有」的提示。
  const safety = safetyNoteFor(call.safety);
  if (report === null) return fallback(`没有拿到服务端的出处核对结论。${FALLBACK_SUFFIX}`);
  if (report.refused) {
    return {
      kind: 'refused',
      text: call.text,
      note: `${REFUSED_NOTE}${safety === '' ? '' : ` ${safety}`}`,
      sources: report.sources,
      violations: [],
    };
  }
  if (!report.verified) {
    const detail = report.violations.length > 0 ? `（核对点：${report.violations.join('、')}）` : '';
    return fallback(`这条回答没有通过服务端的出处核对${detail}。${FALLBACK_SUFFIX}`, report.violations);
  }
  return {
    kind: 'model',
    // 服务端已经检过内容安全且核过出处；上屏前只做一次裁剪（模型偶尔多出空行）。
    text: call.text.trim(),
    note: `依据下面列出的官方原文 · 内容安全${call.safety !== null && call.safety.checked ? '已检测' : '未检测'}`,
    sources: report.sources,
    violations: [],
  };
}

/** 供测试与页面共用：这条提问会不会触发模型调用。 */
export function shouldCallModel(result: AskResult | null): boolean {
  return canAskModel(result);
}

/** 声明导出，避免打包器把仅用于类型的导入误删。 */
export type { AdvancementCallReport, ResolvedScope };
