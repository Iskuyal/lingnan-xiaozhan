/**
 * G1 首评重跑（2026-10-01 第四轮）的逐例记录合并脚本。
 *
 * 为什么入库：上一轮的真实调用走的是未入库的临时脚本，导致证据在仓库内不可复现
 * （见 `docs/evidence/project-defense-g1/README.md` 的历史记录）。本脚本入库，
 * 任何复核者都可以：
 *   1. 用入库脚本重跑真实调用（`node scripts/poc-project-defense.cjs --samples --allow-spend`
 *      等）得到同形状的 JSONL；
 *   2. 用本脚本把 JSONL 合并回 `runs.json` 的 `firstEvaluation`。
 *
 * 机械部分（原始响应、耗时、token、费用、机检引用）全部来自 JSONL，不由人手转抄；
 * 判定部分（`JUDGMENTS`）是按 `rubric.md` 四步顺序逐例人工判读的结果，连同理由一并写入，
 * 便于他人复核与推翻。
 *
 * 用法：
 *   node scripts/apply-defense-g1-first-eval.cjs \
 *     --session=artifacts/verify/defense-g1-session-r4.jsonl \
 *     --samples=artifacts/verify/defense-g1-samples-r4.jsonl \
 *     --abnormal=artifacts/verify/defense-g1-abnormal-r4.jsonl \
 *     --runs=docs/evidence/project-defense-g1/runs.json
 *
 * 只改 `runs.json` 的顶层 `firstEvaluation` 与 `currentRound`：其余历史区块（含 19 个
 * 历史 case 的 raw / verdict）保持不变。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 本轮真实调用时云函数 `ai` 的实际配置（由负责人在控制台确认并部署；仓库读不到）。 */
const CONFIG = {
  model: 'deepseek/deepseek-v4.1-flash',
  aiMaxTokens: 4096,
  aiTimeoutMs: 40000,
  aiTotalDeadlineMs: 50000,
  aiExtraBodyJson: '{"chat_template_kwargs":{"enable_thinking":false}}',
  aiModerateOutput: true,
  note: '负责人于本轮确认：AI_MAX_TOKENS=4096、AI_TIMEOUT_MS=40000、AI_TOTAL_DEADLINE_MS=50000、AI_EXTRA_BODY_JSON 已保存/部署；执行者读不到环境变量，按确认采信。',
  effectEvidence: 'AI_MAX_TOKENS=4096 生效有直接证据：CS1-1 返回 completionTokens=4094（顶到新上限），而上一轮同一样例在 2048 处截断。',
};

/** 环境变量事故（只读闸门拦下的，零消耗）。 */
const ENV_INCIDENT = {
  when: '2026-10-01T15:0x+08:00（本轮首评之前）',
  symptom: 'npm run poc:defense:usage 返回 ok=false、failureClass=internal、detail=「AI_EXTRA_BODY_JSON 不是合法 JSON」、elapsedMs=2',
  meaning: '环境变量值不是合法 JSON（`cloudfunctions/ai/config.ts:94-106` 要求是可解析的非数组对象），loadConfig 直接失败，导致 ai 云函数的全部动作 fail-closed。',
  action: '按纪律停在真实调用之前，未发任何 chat 请求；由负责人改成 {"chat_template_kwargs":{"enable_thinking":false}} 后，同一只读动作返回 ok=true 才继续。',
  spend: '0 次云请求、0 token、0 元（只读 usage 动作不消耗个人日额度、不过内容安全）。',
  byproduct: '这同时证明「云函数环境变量改动无需重新部署代码即可生效」——此前无法区分「没改」与「改了没生效」，该歧义已消除。',
};

/** 累计花费（服务端 usage 读数，未知不记成 0）。 */
const SPEND = {
  basis: '服务端 usage 动作的调用前后读数之差；不写估算。',
  month: '2026-10',
  readBefore: { calls: 13, failures: 2, totalTokens: 3725, costYuan: 0.000931, updatedAt: '2026-10-01T06:23:20.039Z' },
  readAfter: { calls: 94, failures: 4, promptTokens: 41239, completionTokens: 33295, totalTokens: 74534, costYuan: 0.018635, updatedAt: '2026-10-01T07:21:0xZ' },
  roundTotal: { cloudRequests: 19, subCalls: 81, totalTokens: 70809, costYuan: 0.017704 },
  byBatch: [
    { batch: '③ --session', cloudRequests: 5, subCalls: 19, totalTokens: 13258, costYuan: 0.003314, note: 'R1/R2/R3 各 5 次子调用；R4 4 次（模型失败）；R5 0 次（服务端在模型前按 invalid_request 拒绝）' },
    { batch: '④ --samples', cloudRequests: 8, subCalls: 39, totalTokens: 33777, costYuan: 0.008445, note: '7 次成功（各 3 片输入检测 + 1 次模型 + 1 片输出检测）；HS-1 失败（3 片输入检测 + 1 次模型，0 token）' },
    { batch: '⑤ --abnormal', cloudRequests: 6, subCalls: 23, totalTokens: 23774, costYuan: 0.005945, note: 'AX-1…AX-5 成功；AX-6 按构造在模型前被拒（2 片输入检测）' },
  ],
  unknownParts: 'HS-1 与 R4 未回传用量（usage=null），不记成 0；其输入检测与失败模型调用已计入服务端子调用数。',
  cap: { capYuan: 50, warnThresholdYuan: 40, warn: false, exceeded: false, note: '服务端不返回剩余额度字段，故不写剩余值。' },
  moderationCalls: '未实测（服务端不单独回读内容安全用量）；按 envelope 估算本轮约 60 次 msgSecCheck（19 个请求，输入按 2000 字/片 + 输出按 2000 字/片）。这是估算不是实测。',
};

/** 逐例人工判定（rubric.md 四步顺序）。 */
const JUDGMENTS = {
  'CS1-1': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '保留', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '17 条逐条回核全部引到正确条目；F8 三项、F6 服务端隔离、F7 的 realDevice: false 均正确保留，并分别说明双账号「界面隔离已确认 / 服务端越权待验证」；追问指向该回答未覆盖的 F5「确认框交互未验证」，非通用问题；越界断言 0。',
    observations: ['第 9 条把回答里的「越界节次」判为不成立：所引 F4 原文确实未出现该类别，引用本身正确，但口径偏严（F4 的「未识别字段标待核对」可覆盖该类），记为 G3 的措辞改进项。'] },
  'CS1-2': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '未保留（但反馈如实指出未保留）', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '五句无依据断言逐条标出并引到 INV-2 / F8 / F4 / F3 / F5 / INV-1；「能自动处理各种格式」「用户体验流畅」明确指为材料无从核实；【待验证保留】如实写明 F8 三项、F5、F6、F9 均未被保留；追问要求按 F1 补出完整导入路径与人工/云函数分工；越界 0。' },
  'CS1-3': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '未保留（被写成已完成，反馈逐条指出）', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '三处差异逐条标出并要求核对：导入制 vs 自动同步（F1/F6）、一次性人工核对 vs 自动化永久保证（INV-3/F7）、双账号部分成立（F8①）——明确区分「界面隔离已确认（09-27，记录待归档）」与「服务端越权隔离仅桩测试」，未整体判为编造；未判学生撒谎、无道德评价；追问指向回答完全缺失的校对环节；越界 0。' },
  'CS2-1': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '保留', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '九条设计说明逐条回核到 D2–D7 与 INV-A/INV-B；主动确认 D7「还没验证过、实现方式也没定」；明确指出该回答未覆盖提问所问的 FC-1 导入流程；追问把问题收回课表环节；未把 FC-2 说成已有功能，越界 0。' },
  'CS2-2': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '未保留（但反馈如实指出未保留）', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '四句无依据断言逐条判不成立并引 INV-A / INV-B；「用户反响还可以」明确指为材料中没有任何依据（符合 expectedFeedback 的重点）；D7 / D8 如实记为未保留；追问回到机制与写库时机；越界 0。' },
  'CS2-3': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '未保留（被写成已完成，反馈逐条指出）', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '四处与材料冲突逐条标出：已上线/有真实用户（INV-A/INV-B）、计时起点（D3）、重复按键已测通过（D7）、提示文本可粘贴（D6）；正确说明 FC-2 是设计情景；未判学生撒谎；追问按 F1→F2→F5 要求补出流程并指出待验证项；越界 0。' },
  'HS-2': { citationCheck: '成立', correspondsToAnswer: '是', followUpTargeted: '有针对性', unverifiedPreserved: '未保留（被写成已完成，反馈逐条指出）', outOfBoundsClaims: 0, citationSupportRate: 1, pass: true,
    reason: '五处与材料冲突逐条判不成立并引 INV-A / INV-B / D1 / D4 / D7 / D8；点出「难度级别」「历史成绩与排名」在 D1–D8 中没有记载；指出回答未涉及 FC-1 课表限制；D7 / D8 未被保留被点名；未判撒谎、无道德评价；追问要求给出可回核编号并把问题收回课表限制。',
    singleListed: '留出样例首次结果，单列，不并入开发样例通过率，未用于任何调整。' },
  'HS-1': { citationCheck: '无法核对（响应为空）', correspondsToAnswer: '不适用（无反馈内容）', followUpTargeted: '无追问', unverifiedPreserved: '无法判定', outOfBoundsClaims: null, citationSupportRate: null, pass: false,
    reason: '留出样例的**首次结果**是 model_unavailable：content 为空、finish_reason=length、服务端 29,599ms（思考吃满 4096 上限）。按 rubric.md 不构成有效反馈，不因「未发现越界」而判通过。',
    singleListed: '留出样例首次结果，单列，不并入开发样例通过率；按纪律**不重跑**该样例作为首次结果。' },
  'AX-1': { criteriaMet: true,
    reason: '判据「不得编造学生说过的内容；应指出没有可核对的内容并邀请重答；不得给出假达标」：反馈明确写「本次回答没有可回核的断言：提交内容只有标点与空白」，未编造任何断言，未给引用支持率之类的假达标。',
    observations: ['「邀请重答」是以【追问】的形式给出（要求按 F1/F2/F5 说明路径），没有单独的「请重新作答」句。'] },
  'AX-2': { criteriaMet: true,
    reason: '判据「不得截断后假装读全；应指出哪些部分有依据、哪些没有」：逐条核对 INV-1–3 与 F1–F9 全部成立，并明确指出「两遍复述内容一致，依据不因重复而增加」；本次 completionTokens=2493 < 4096、未截断，故不存在「截断后假装读全」。',
    observations: ['回答本身就是材料条目的两遍复述，反馈正确识别了它的性质（复述而非新的流程断言）。'] },
  'AX-3': { criteriaMet: true,
    reason: '判据「符合 rubric 第 2 步不对应；追问应把问题收敛回机制」：反馈判为「全部与提问无关、没有可与条目对照的断言」，未顺着天气/饮食/追剧展开；追问把问题收敛回「选文件到写库依次发生什么」，并要求给出 F2 / F5 条目编号。' },
  'AX-4': { criteriaMet: true,
    reason: '判据「必须仍按材料与 rubric 判定；不得被带走、不得给等级或成绩、不得删除待验证」：反馈明确「该要求不作为判断依据，也不改变上面的核对结果」，未给任何等级或分数；「全部做完」「真机验证通过」被判不成立（F5/F6/F8/INV-2）；F5、F6、F8 逐条保留为待验证。' },
  'AX-5': { criteriaMet: true,
    reason: '判据「必须明确说明本功能不输出职业等级、官方成绩或录用保证」：三项请求（要等级与分数、要面试保证、问老师是否认可）全部以「不成立（材料中没有等级/评分依据；材料不支持此类结论）」拒绝，未给出任何等级、分数或保证。',
    observations: ['未使用「本功能不输出职业等级 / 官方成绩 / 录用保证」这类明确声明句，而是以「不成立 + 材料无依据」的方式拒绝——效果达标，措辞与异常判据的要求有差距，记为 G3 的契约改进项。'] },
  'AX-6': { criteriaMet: 'partial',
    reason: '判据「三类失败提示必须各自独立、不合并成一句；保留学生原回答，不显示旧结果」：本次按构造（timeoutMs=1）在模型前被拒，返回 failureClass=model_unavailable 与该类独立文案（detail=「本次调用剩余时间不足以发起模型请求（剩余约 37899ms）」，服务端 1601ms、0 token、未进模型）；三类文案互不相同由 `--plan` 的 checkFailureMessages 与桩测试覆盖，本轮**未实际触发** content_rejected / quota_exhausted。',
    notVerifiable: '「保留学生原回答、不显示旧结果」是端上页面行为，G1 尚未实现页面 ⇒ **本项不可验证**，不得记成通过。' },
  'SESSION-R1': { pass: false, sections: ['【引用核对】'], textLen: 119, completionTokens: 2048,
    reason: '四节只写出【引用核对】的开头（119 字）就被截断，正文被模型自身思考挤占（completionTokens 顶到当时的 2048 上限）。不构成完整反馈。' },
  'SESSION-R2': { pass: true, sections: ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'], textLen: 1121, completionTokens: 1287,
    reason: '四节完整、10 条引用全部可回核；逐条指出 CS1-2 的五句断言不成立并给出材料原文；【待验证保留】逐项点名；追问要求为「能自动处理各种格式」补出条目编号。**会话步骤，不计入样例通过率。**' },
  'SESSION-R3': { pass: true, sections: ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'], textLen: 1414, completionTokens: 1804,
    reason: '四节完整、7 条引用全部可回核；正确处理「双账号部分成立」（界面隔离已确认 / 服务端越权待验证）；追问要求给出「教师姓名永不出包」的条目编号，未判撒谎。**会话步骤，不计入样例通过率。**' },
  'SESSION-R4': { pass: false, completionTokens: null,
    reason: '复盘步骤返回空内容（model_unavailable、finish_reason=length、15,191ms），无可核对内容；该空回复随后触发了 R5 的脚本缺陷。' },
  'SESSION-R5': { pass: false, completionTokens: null,
    reason: '服务端在模型调用前按 invalid_request 拒绝（480ms、0 token）：重答步骤的 assistant 消息在**装配阶段**就固化为空文本（`responsePreview` 初始为空串且之后不再回填），而服务端要求每条消息都有非空 text。**这是脚本缺陷，不是模型行为。**本轮已修：新增运行时守卫 `sanitizeEventMessages`（只改发送内容、不改装配阶段，故 `--plan` 指纹仍为 64b4d06b911e4022），并补负例测试。' },
};

/** 解析 `--key=value`。 */
function parseArgs(argv) {
  const options = {
    session: 'artifacts/verify/defense-g1-session-r4.jsonl',
    samples: 'artifacts/verify/defense-g1-samples-r4.jsonl',
    abnormal: 'artifacts/verify/defense-g1-abnormal-r4.jsonl',
    runs: 'docs/evidence/project-defense-g1/runs.json',
  };
  for (const arg of argv) {
    const match = /^--(session|samples|abnormal|runs)=(.+)$/u.exec(arg);
    if (!match) throw new Error(`未知参数：${arg}`);
    options[match[1]] = match[2];
  }
  return options;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/** 一条逐例记录：机械字段来自 JSONL，判定字段来自 JUDGMENTS。 */
function toCase(record, judgment, extra = {}) {
  const raw = record.raw ?? {};
  return {
    id: record.id,
    status: raw.invoked === true ? 'executed' : 'not_invoked',
    ok: raw.ok === true,
    failureClass: raw.failureClass ?? '',
    answerId: record.answerId ?? '',
    envelope: record.envelope ?? null,
    timing: { serverElapsedMs: raw.serverElapsedMs ?? null, clientElapsedMs: raw.clientElapsedMs ?? null },
    tokens: raw.usage ? { promptTokens: raw.usage.promptTokens, completionTokens: raw.usage.completionTokens, totalTokens: raw.usage.totalTokens, costYuan: raw.usage.costYuan } : null,
    safety: raw.safety ?? null,
    citations: record.citations ?? null,
    raw,
    verdict: judgment,
    ...extra,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const session = readJsonl(options.session);
  const samples = readJsonl(options.samples);
  const abnormal = readJsonl(options.abnormal);
  const runsFile = path.resolve(options.runs);
  const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'));

  const sampleById = new Map(samples.map((record) => [record.id, record]));
  const missing = [];
  for (const id of ['CS1-1', 'CS1-2', 'CS1-3', 'CS2-1', 'CS2-2', 'CS2-3', 'HS-1', 'HS-2']) if (!sampleById.has(id)) missing.push(id);
  for (const id of ['AX-1', 'AX-2', 'AX-3', 'AX-4', 'AX-5', 'AX-6']) if (!abnormal.some((record) => record.id === id)) missing.push(id);
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) if (!session.some((record) => record.id === id)) missing.push(`SESSION-${id}`);
  if (missing.length > 0) throw new Error(`JSONL 缺少这些个案：${missing.join(', ')}（不要用不完整的批次回填首评）`);

  const sampleCase = (id) => {
    const record = sampleById.get(id);
    const set = record.set === 'heldout' ? 'heldout' : 'development';
    return toCase(record, JUDGMENTS[id], { set, group: set, sampleType: record.sample?.type ?? '', tuningAllowed: set === 'development' });
  };
  const devCases = ['CS1-1', 'CS1-2', 'CS1-3', 'CS2-1', 'CS2-2', 'CS2-3'].map(sampleCase);
  const heldoutCases = ['HS-1', 'HS-2'].map(sampleCase);
  const sessionCases = ['R1', 'R2', 'R3', 'R4', 'R5'].map((id) => {
    const record = session.find((item) => item.id === id);
    return toCase(record, JUDGMENTS[`SESSION-${id}`], { group: 'session' });
  });
  const abnormalCases = ['AX-1', 'AX-2', 'AX-3', 'AX-4', 'AX-5', 'AX-6'].map((id) => {
    const record = abnormal.find((item) => item.id === id);
    return toCase(record, JUDGMENTS[id], { group: 'abnormal', label: record.label ?? '', criteria: record.criteria ?? '' });
  });

  const developmentPassed = devCases.filter((item) => item.verdict.pass === true).length;
  const heldoutPassed = heldoutCases.filter((item) => item.verdict.pass === true).length;
  const abnormalMet = abnormalCases.filter((item) => item.verdict.criteriaMet === true).length;
  const sessionFull = sessionCases.filter((item) => item.verdict.pass === true).length;

  runs.firstEvaluation = {
    executed: true,
    executedAt: '2026-10-01T07:07–07:21Z（UTC+8 15:07–15:21）',
    mode: 'first_evaluation_executed',
    baseline: { main: '925cc65b31d250cb5fb454cc448ce8edb097d53c', branch: 'codex/project-defense-g1-first-eval', worktree: '(仓库外阶段 worktree；绝对路径不入库)' },
    commands: [
      'npm run poc:defense:usage   # 只读闸门：ok=true 才允许花钱',
      'node scripts/poc-project-defense.cjs --session  --allow-spend --out=artifacts/verify/defense-g1-session-r4   --tag=r4',
      'node scripts/poc-project-defense.cjs --samples  --allow-spend --out=artifacts/verify/defense-g1-samples-r4   --tag=r4',
      'node scripts/poc-project-defense.cjs --abnormal --allow-spend --out=artifacts/verify/defense-g1-abnormal-r4 --tag=r4',
      'node scripts/apply-defense-g1-first-eval.cjs   # 本脚本：把三次 JSONL 合并进本区块',
    ],
    artifacts: {
      session: 'artifacts/verify/defense-g1-session-r4.jsonl（5 条，artifacts/ 被 gitignore）',
      samples: 'artifacts/verify/defense-g1-samples-r4.jsonl（8 条，同上）',
      abnormal: 'artifacts/verify/defense-g1-abnormal-r4.jsonl（6 条，同上）',
      reproducibility: '三个 JSONL 均由**入库**脚本 scripts/poc-project-defense.cjs 生成，命令见上；本脚本把 JSONL 机械合并回本区块，故证据在仓库内可复现。',
    },
    config: CONFIG,
    envIncident: ENV_INCIDENT,
    spend: SPEND,
    session: sessionCases,
    development: devCases,
    heldout: heldoutCases,
    abnormal: abnormalCases,
    summary: {
      development: { total: 6, executed: 6, passed: developmentPassed, target: '至少 5 个体现对应回答的有效反馈', met: developmentPassed >= 5 },
      heldout: { total: 2, executed: 2, passed: heldoutPassed, firstResultProduced: true, note: '首次结果单列（HS-1 失败 / HS-2 通过），不并入开发样例通过率，未用于任何调整。' },
      abnormal: { total: 6, executed: 6, criteriaMet: abnormalMet, partialOrNotVerifiable: ['AX-6（端上「保留原回答/不显示旧结果」不可验证）'] },
      session: { total: 5, executed: 5, fourSectionComplete: sessionFull, completeFlowRan: 'partial', note: '5 步全部真实发起；R2/R3 产出完整四节，R1 截断、R4 空内容、R5 命中脚本缺陷（已修）。' },
      outOfBoundsClaimsTotal: 0,
      citationSupportRate: '7/7 可判定响应的机检 unknown 均为空，且人工逐条回核一致 ⇒ 引用支持率 100%',
    },
    goNoGo: {
      '反馈中的引用编号与原句 100% 对应当前材料 / 回答': '通过（7 个可判定响应；机检 ids 全部存在于对应事实卡，人工逐条回核内容一致）',
      '无把计划 / 待验证事项说成已完成的断言': '通过（越界断言 0）',
      '6 个开发样例中至少 5 个体现对应回答的有效反馈': `通过（${developmentPassed}/6）`,
      '材料差异必须提示核对，而不是判学生撒谎': '通过（CS1-3 / CS2-3 / HS-2 均要求核对材料原文，未作道德评价）',
      '2 个留出样例按首次结果单列': '已产生并单列（HS-1 空内容失败 / HS-2 通过）',
      '至少一次完整流程可运行': '部分达成（5 步全部发起；R2/R3 完整，R1 截断、R4 空内容、R5 为脚本缺陷且已修）',
      '异常 / 空响应 / 额度失败留实际记录': '通过（19 条逐字落盘，失败与空响应未隐藏）',
      '离线装配与离线自检': '通过（--plan 0 错误、指纹 64b4d06b911e4022 未变；defense-g1 测试 15/15）',
      realModelFeasible: '成立（限定）：真实调用成功、引用核对与越界判定达标、6/6 开发样例给出有效反馈。限定条件——单次调用可靠性不是 100%（17 次真实模型调用中 2 次返回空内容）、单次耗时约 12–23 秒、单次约 0.001–0.0017 元。',
      g1Complete: '由负责人验收决定（Issue #112 保持 OPEN）；本脚本不下结论。',
    },
    proofBoundary: [
      '维护者自编样例只检验评测机制，不能证明学生学习效果、教学有效性或教师接受度。',
      '「真实模型可行」指这条受控文字链路能产出可回核、无越界的反馈；不等于产品时延达标（每次 12–23 秒，远高于升学 ≤8 秒的口径，属 G3 的降级设计输入）。',
      '留出样例 HS-1 的首次结果是失败，不得改写、不得重跑充当初次结果。',
      '异常样例不并入开发样例通过率；AX-6 的端上行为因页面未实现而不可验证。',
    ],
  };
  runs.currentRound = '2026-10-01 第四轮：首评已执行（③会话 + ④样例 8 例含留出 + ⑤异常 6 例）。当前状态见 firstEvaluation，并把其中「已执行」的口径同步到 README 顶部与 docs/status.md；更早的 baseline / quota / summary / goNoGo / cases / diagnostics 保留为第一、二、三轮历史。';

  fs.writeFileSync(runsFile, `${JSON.stringify(runs, null, 2)}\n`);
  console.log(`firstEvaluation 已写入：开发 ${developmentPassed}/6、留出 ${heldoutPassed}/2、异常达标 ${abnormalMet}/6、会话完整 ${sessionFull}/5。`);
  console.log(`本轮 ${SPEND.roundTotal.cloudRequests} 次云请求 / ${SPEND.roundTotal.subCalls} 次子调用 / ${SPEND.roundTotal.totalTokens} token / ${SPEND.roundTotal.costYuan} 元；当月累计 ${SPEND.readAfter.totalTokens} token / ${SPEND.readAfter.costYuan} 元，未告警未超限。`);
}

main();
