/**
 * 升学问答模型版：真实模型逐题评测（Issue #94 / M2）。
 *
 * 做三件事，缺一不可：
 * 1. **本地守门与检索**（不发请求）：每题先跑产品里的 `ask()`，记录行为与检索到的段落；
 *    守门题（澄清/拒答）到这里就结束——它们本来就不产生模型调用。
 * 2. **真实模型调用**（小程序端发起）：事实题按产品页面同一路径组装事件，经开发者工具的
 *    模拟器调用 `ai` 云函数（云调用必须由小程序端触发，见 docs/development/cloud/ai.md）。
 * 3. **一致性复算**：拿服务端回传的段落与模型回答，在 Node 侧用云函数同一份 `verifyAdvancementAnswer`
 *    再算一遍校验结论——一致不等于事实支持，逐句语义复核单独记录。
 *
 * 用法：
 *   node scripts/eval-advancement-model.cjs --plan                     # 只看本地守门与检索（不花额度）
 *   node scripts/eval-advancement-model.cjs --set=new                  # 新题首次评测
 *   node scripts/eval-advancement-model.cjs --set=legacy               # 历史 20 题回归
 *   node scripts/eval-advancement-model.cjs --only=n01,n02 --resume    # 续跑（按 集合:题号 去重）
 *
 * 前置：`npm run build` 已跑过；开发者工具已用
 *   `cli.bat auto --project <仓库>/dist --auto-port 9420 --trust-project` 打开；
 *   `ai` 云函数已部署；当日内容安全配额与个人日额度有余量。
 *
 * 落盘：`artifacts/verify/advancement-model-<时间戳>.jsonl`（每题一行，随跑随写、可续跑）
 * 与同名 `.json`（汇总）。JSONL 里的 `id` 为 `集合:题号`，`--resume` 按它跳过。
 *
 * 退出码：0 = 全部按预期；2 = 有题不符合预期；1 = 没跑起来（未部署/连不上工具/额度用尽）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { connectMini } = require('./lib/mini-connect.cjs');

const LEGACY_SET = 'docs/evidence/advancement-poc/questions.json';
const NEW_SET = 'docs/evidence/advancement-model/questions.json';
const LEGACY_DEFAULT_SCOPE = { year: 2026, region: '广东省' };
/** 与产品页面一致：检索出的段落交给模型，最多两段。 */
const TOP_N = 2;
/** 单次云函数调用的等待上限（云函数超时 60 秒，模型实测 5~12 秒）。 */
const RESULT_WAIT_MS = 90000;
const POLL_INTERVAL_MS = 1500;
/**
 * 两次模型调用之间的间隔：个人分钟限额默认 6 次/分（`AI_USER_MINUTE_LIMIT`），
 * 一次调用约 5 秒，连跑会在第 7 次撞上「本分钟调用次数超过 6 次」。按 12 秒间隔跑，
 * 一分钟最多 5 次，留一次余量。
 */
const PACE_MS = Number(process.env.ADV_EVAL_PACE_MS || 12000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { set: 'all', only: [], plan: false, resume: false, maxCalls: 30, out: '', tag: '', questions: '', budget: '' };
  for (const arg of argv) {
    if (arg === '--plan') options.plan = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg.startsWith('--set=')) options.set = arg.slice(6);
    else if (arg.startsWith('--only=')) options.only = arg.slice(7).split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith('--max-calls=')) options.maxCalls = Number(arg.slice(12));
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else if (arg.startsWith('--tag=')) options.tag = arg.slice(6);
    else if (arg.startsWith('--budget=')) options.budget = arg.slice(9);
    else if (arg.startsWith('--questions=')) { options.questions = arg.slice(12); options.set = 'fresh'; }
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['all', 'new', 'legacy', 'fresh'].includes(options.set)) throw new Error('--set 只接受 all / new / legacy，独立新题用 --questions=<文件>');
  if (options.set === 'fresh' && options.questions === '') throw new Error('fresh 题集须提供 --questions=<文件>');
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0) throw new Error('--max-calls 必须是非负整数');
  if (options.resume && options.out === '') throw new Error('--resume 必须提供原轮次的 --out');
  return options;
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** 两组题集统一成一条内部记录。 */
function loadQuestions(options) {
  const list = [];
  if (options.set === 'all' || options.set === 'legacy') {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_SET, 'utf8'));
    for (const question of legacy.questions) {
      list.push({
        key: `legacy:${question.id}`,
        set: 'legacy',
        id: question.id,
        type: question.type,
        question: question.question,
        behavior: question.behavior,
        expectedPassages: question.expectedPassages ?? [],
        expectedAnswer: question.expectedAnswer ?? '',
        mustContain: question.mustContain ?? [],
        source: 'maintainer_design',
        // 历史 20 题的评测在 09-29 的 PoC 里就用「显式确认 2026 年 / 广东省」跑答案题（见 PoC README）。
        scope: question.scope ?? LEGACY_DEFAULT_SCOPE,
      });
    }
  }
  if (options.set === 'all' || options.set === 'new' || options.set === 'fresh') {
    const fresh = JSON.parse(fs.readFileSync(options.questions || NEW_SET, 'utf8'));
    if (options.set === 'fresh' && (!fresh.datasetId || !fresh.frozenAt)) throw new Error('独立题集须有 datasetId 与 frozenAt');
    for (const question of fresh.questions) {
      list.push({
        key: `${options.set === 'fresh' ? fresh.datasetId : 'new'}:${question.id}`,
        set: options.set === 'fresh' ? fresh.datasetId : 'new',
        id: question.id,
        type: question.type,
        question: question.question,
        behavior: question.behavior,
        expectedPassages: question.expectedPassages ?? [],
        expectedAnswer: question.expectedAnswer ?? '',
        mustContain: question.mustContain ?? [],
        source: question.source ?? 'maintainer_design',
        scope: question.scope ?? {},
      });
    }
  }
  for (const wanted of options.only) {
    if (!list.some((item) => item.id === wanted || item.key === wanted)) throw new Error(`找不到题号：${wanted}`);
  }
  const selected = options.only.length === 0 ? list : list.filter((item) => options.only.includes(item.id) || options.only.includes(item.key));
  if (selected.length === 0) throw new Error('题集为空，未执行评测');
  return selected;
}

/** 本地检索（复用产品里的守门与检索，不复制规则）。 */
function localAsk(product, question) {
  // 明确题面走页面的自动范围判定。冻结旧题中的 category 是当时的材料归类提示，
  // 不是学生本轮点击的澄清选项；仍原样归档，不用它覆盖明确的题面类别。
  const detected = product.classify(question.question);
  const scope = question.behavior === 'answer'
    ? { year: question.scope.year, region: question.scope.region,
      ...(question.scope.category && detected.kind !== 'single' ? { category: question.scope.category } : {}) }
    : {};
  return product.ask(question.question, TOP_N, scope);
}

/** 段落 id → 展示用的短名。 */
function passageIds(product, result) {
  return result.citations.map((citation) => citation.passageId);
}

/** 在模拟器里发起一次云函数调用并立刻返回，结果写到页面全局里轮询取回。 */
async function startCall(mini, event) {
  const payload = JSON.stringify(event);
  const started = await mini.evaluate((serialized) => {
    globalThis.__advEval = { done: false, startedAt: Date.now() };
    const request = JSON.parse(serialized);
    wx.cloud
      .callFunction({ name: 'ai', data: request })
      .then((res) => {
        globalThis.__advEval = { done: true, invoked: true, result: res.result, elapsedMs: Date.now() - globalThis.__advEval.startedAt };
      })
      .catch((error) => {
        globalThis.__advEval = {
          done: true,
          invoked: false,
          err: (error && (error.errMsg || error.message)) || String(error),
          elapsedMs: Date.now() - globalThis.__advEval.startedAt,
        };
      });
    return 'started';
  }, payload);
  if (started !== 'started') throw new Error(`没能在模拟器里发起调用：${String(started)}`);
  const deadline = Date.now() + RESULT_WAIT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const raw = await mini.evaluate(() => JSON.stringify(globalThis.__advEval || { done: false }));
    const state = JSON.parse(raw);
    if (state.done === true) return state;
    if (Date.now() > deadline) throw new Error('云函数调用超过等待上限未返回');
  }
}

/** 汇总一次调用的可记录信息（模型回答与引用都要留档）。 */
function summarizeCall(state) {
  if (state.invoked !== true) {
    return { invoked: false, error: state.err || '', elapsedMs: state.elapsedMs ?? null };
  }
  const result = state.result ?? {};
  const advancement = result.advancement ?? null;
  return {
    invoked: true,
    ok: result.ok === true,
    failureClass: typeof result.failureClass === 'string' ? result.failureClass : '',
    message: typeof result.message === 'string' ? result.message : '',
    text: typeof result.text === 'string' ? result.text : '',
    detail: typeof result.detail === 'string' ? result.detail : '',
    model: typeof result.model === 'string' ? result.model : '',
    elapsedMs: result.elapsedMs ?? state.elapsedMs ?? null,
    clientElapsedMs: state.elapsedMs ?? null,
    usage: result.usage ?? null,
    capWarning: typeof result.capWarning === 'string' ? result.capWarning : '',
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    safety: result.safety ?? null,
    timings: result.timings ?? null,
    advancement: advancement === null
      ? null
      : {
        corpusVersion: advancement.corpusVersion ?? '',
        verified: advancement.verified === true,
        refused: advancement.refused === true,
        violations: Array.isArray(advancement.violations) ? advancement.violations : [],
        sourceIds: Array.isArray(advancement.sources) ? advancement.sources.map((item) => item.id) : [],
        sources: Array.isArray(advancement.sources) ? advancement.sources : [],
      },
  };
}

/** 一致性复算：沿用历史字段 independentVerify，不作为独立事实证据。 */
function independentVerify(verifier, call) {
  if (call.invoked !== true || call.ok !== true || call.advancement === null) return null;
  const verdict = verifier.verifyAdvancementAnswer(call.text, call.advancement.sources);
  return { refused: verdict.refused, violations: verdict.violations };
}

/** 交付形态：模型解释 / 模型表示无法核实 / 降级为原文摘录。 */
function delivery(call) {
  if (call.invoked !== true) return 'transport_failed';
  if (call.ok === true && call.advancement !== null && call.advancement.refused) return 'model_refused';
  if (call.ok === true && call.advancement !== null && call.advancement.verified) return 'model_answer';
  return 'fallback_sources';
}

/** 事实题的自动判定（人工判定在报告里单独写，这里只给可复算的口径）。 */
function judgeAnswer(question, local, call) {
  const kind = delivery(call);
  const mustContainInModel = kind === 'model_answer'
    ? question.mustContain.every((token) => call.text.includes(token))
    : false;
  const mustContainInSources = kind === 'fallback_sources'
    ? question.mustContain.every((token) => local.answer.includes(token))
    : false;
  const expectedHit = question.expectedPassages.length === 0
    ? true
    : question.expectedPassages.every((id) => passageIdsLocal(local).includes(id));
  return { delivery: kind, mustContainInModel, mustContainInSources, expectedPassageInTopN: expectedHit };
}

function passageIdsLocal(result) {
  return result.citations.map((citation) => citation.passageId);
}

/** 额度失败、传输故障和未调用的题保留记录但允许续跑。 */
function isCompleteRecord(record) {
  if (record.expectedBehavior !== 'answer') return typeof record.guardCorrect === 'boolean';
  if (!record.modelCall) return record.error === '答案题没有可交给模型的段落（canAskModel=false）';
  return record.modelCall.invoked === true && record.modelCall.failureClass !== 'quota_exhausted';
}

/** 不自动重试额度、审核配额或记账故障；原始失败照常落盘。 */
function stopReason(call) {
  if (call.failureClass === 'quota_exhausted') return 'quota_exhausted';
  const diagnostic = [call.detail ?? '', ...(call.warnings ?? [])].join(' ');
  if (/记账|accounting|审核.*配额|检测.*配额/iu.test(diagnostic)) return 'accounting_or_safety_quota';
  return '';
}

function validateBudget(file, maxCalls) {
  if (!file) throw new Error('真实调用前须 --budget=<预算JSON>，登记用量快照、个人日余量与本批预算');
  const budget = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!budget.usageSnapshot || !budget.registeredAt || !Number.isInteger(budget.maxCloudCalls)
    || budget.maxCloudCalls < maxCalls || !budget.personalDailyLimit || budget.safetyQuota === undefined) {
    throw new Error('预算登记不完整或 --max-calls 超过预算');
  }
  const daily = budget.personalDailyLimit;
  if (!Number.isInteger(daily.remaining) || daily.remaining < maxCalls) throw new Error('个人日余量不足本批预算，停止真实调用');
  const snapshot = JSON.parse(fs.readFileSync(budget.usageSnapshot, 'utf8'));
  const actual = snapshot.result;
  if (actual?.ok !== true || actual.usageSummary?.exceeded || actual.capWarning || actual.userDailyLimit?.day !== daily.day
    || actual.userDailyLimit?.remaining !== daily.remaining) throw new Error('预算与真实用量快照不一致或月度告警，停止真实调用');
  return budget;
}

function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const product = require(path.resolve('dist/services/advancement/index.js'));
  const model = require(path.resolve('dist/services/advancement/model.js'));
  const verifier = require(path.resolve('dist/cloudfunctions/ai/advancement.js'));
  const questions = loadQuestions(options);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outBase = options.out === '' ? path.resolve(`artifacts/verify/advancement-model-${stamp}`) : path.resolve(options.out);
  const meta = {
    startedAt: new Date().toISOString(),
    gitSha: gitSha(),
    set: options.set,
    tag: options.tag,
    topN: TOP_N,
    questions: questions.length,
    questionSetHashes: Object.fromEntries((options.questions ? [options.questions] : [LEGACY_SET, NEW_SET]).map((file) => [file, hashFile(file)])),
    buildHashes: Object.fromEntries(['index.js', 'advancement.js', 'advancement-corpus.js'].map((file) => [file, hashFile(path.resolve('dist/cloudfunctions/ai', file))])),
    latencyBudgetMs: 8000,
  };
  console.log(`题集：${options.set}（${questions.length} 题）｜Git ${meta.gitSha.slice(0, 7)}`);

  if (options.plan) {
    for (const question of questions) {
      const local = localAsk(product, question);
      const ids = passageIdsLocal(local);
      const hit = question.behavior !== 'answer' || question.expectedPassages.every((id) => ids.includes(id));
      const top1 = question.behavior !== 'answer' || ids[0] === question.expectedPassages[0];
      const correct = hit && top1 && local.behavior === question.behavior;
      if (!correct) process.exitCode = 2;
      console.log([
        correct ? 'OK ' : 'BAD',
        question.key,
        `[${local.behavior}/${question.behavior}]`,
        ids.length > 0 ? ids.join(' ') : '(无段落)',
      ].join(' '));
      if (!hit || !top1) console.log(`     期望 ${question.expectedPassages.join(' ')}｜实际 ${ids.join(' ')}`);
    }
    const answers = questions.filter((item) => item.behavior === 'answer').length;
    console.log(`本地复测完成：答案题 ${answers} 道（实际可调用题须通过检索与范围检查）、守门题 ${questions.length - answers} 道（不调用模型）`);
    return;
  }

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const budget = validateBudget(options.budget, options.maxCalls);
  meta.budget = budget;
  const jsonlPath = `${outBase}.jsonl`;
  const jsonPath = `${outBase}.json`;
  const done = new Set();
  const previous = new Map();
  const fingerprint = JSON.stringify([meta.questionSetHashes, meta.buildHashes]);
  if (options.resume && fs.existsSync(jsonlPath)) {
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line);
        if (record.fingerprint !== fingerprint) throw new Error('续跑题集或构建版本已变；请保留原轮次并创建新输出文件');
        previous.set(record.key, record);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    for (const record of previous.values()) if (record.done === true && isCompleteRecord(record)) done.add(record.key);
    console.log(`续跑：已完成 ${done.size} 题将被跳过`);
  }

  let mini = null;
  const records = [...previous.values()];
  let cloudAttempts = 0;
  let exitCode = 0;
  let stopped = '';
  try {
    mini = await connectMini();
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await sleep(1200);
    const system = await mini.systemInfo();
    meta.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion };

    for (const question of questions) {
      if (done.has(question.key)) {
        console.log(`跳过 ${question.key}（--resume）`);
        continue;
      }
      const local = localAsk(product, question);
      const record = {
        key: question.key,
        set: question.set,
        id: question.id,
        type: question.type,
        question: question.question,
        questionSource: question.source,
        expectedBehavior: question.behavior,
        expectedAnswer: question.expectedAnswer,
        expectedPassages: question.expectedPassages,
        mustContain: question.mustContain,
        local: {
          behavior: local.behavior,
          passageIds: passageIdsLocal(local),
          answer: local.answer,
          note: local.note,
          resolvedScope: local.resolvedScope ?? null,
        },
        done: false,
        fingerprint,
      };

      if (question.behavior !== 'answer') {
        record.guardCorrect = local.behavior === question.behavior;
        if (!record.guardCorrect) exitCode = Math.max(exitCode, 2);
        console.log(`守门 ${question.key} 期望 ${question.behavior}｜实际 ${local.behavior} ${record.guardCorrect ? '✔' : '✘'}`);
      } else if (!model.canAskModel(local)) {
        // 守门题之外的意外：答案题必须能走到模型，否则是检索或范围的问题。
        record.modelCall = null;
        record.error = '答案题没有可交给模型的段落（canAskModel=false）';
        exitCode = Math.max(exitCode, 2);
        console.log(`✘ ${question.key} 未能构成模型请求：${record.error}`);
      } else if (stopped || cloudAttempts >= options.maxCalls) {
        record.modelCall = null;
        record.error = stopped ? `停止条件 ${stopped}，未调用` : `达到本次 --max-calls=${options.maxCalls} 上限，未调用`;
        record.judge = { delivery: 'not_called' };
        console.log(`… ${question.key} 未调用（上限）`);
        exitCode = Math.max(exitCode, 1);
      } else {
        const event = model.advancementChatEvent(question.question, local.resolvedScope, local.citations);
        record.event = {
          feature: event.feature,
          messageChars: event.messages[0].text.length,
          systemChars: event.system.length,
          scope: event.scope,
          passageIds: event.passageIds,
          maxTokens: event.maxTokens,
        };
        cloudAttempts += 1;
        console.log(`调用 ${question.key}（第 ${cloudAttempts} 次）…`);
        if (cloudAttempts > 1) await sleep(PACE_MS);
        let state;
        try { state = await startCall(mini, event); }
        catch (error) { state = { invoked: false, err: error.message, elapsedMs: null }; }
        const call = summarizeCall(state);
        record.modelCall = call;
        record.independentVerify = independentVerify(verifier, call);
        record.judge = judgeAnswer(question, local, call);
        if (record.judge.delivery !== 'model_answer' || !record.judge.mustContainInModel || !record.judge.expectedPassageInTopN) exitCode = Math.max(exitCode, 2);
        process.stdout.write([
          `  → ${record.judge.delivery}`,
          call.ok ? 'ok' : `failureClass=${call.failureClass}`,
          `${call.elapsedMs}ms`,
          call.usage ? `${call.usage.totalTokens ?? 0} token / ${call.usage.costYuan ?? 0} 元` : '用量未知',
        ].join(' '));
        console.log('');
        stopped = stopReason(call);
        if (stopped) {
          console.log(`停止后续真实调用：${stopped}；继续登记未调用题与本地守门结果`);
          exitCode = Math.max(exitCode, 1);
        }
        if (call.invoked === true && call.ok === true && call.advancement !== null
          && call.advancement.verified && record.independentVerify !== null
          && record.independentVerify.violations.length > 0) {
          // 服务端说通过、本地复核说不通过：这条要人工看，先标记出来。
          console.log('  ⚠ 服务端与本地复核结论不一致，需要人工核对');
          record.mismatch = true;
          exitCode = Math.max(exitCode, 2);
        }
      }
      record.done = isCompleteRecord(record);
      fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
      const oldIndex = records.findIndex((item) => item.key === record.key);
      if (oldIndex >= 0) records.splice(oldIndex, 1);
      records.push(record);
    }

    const answers = records.filter((record) => record.expectedBehavior === 'answer' && record.modelCall != null);
    const guards = records.filter((record) => record.expectedBehavior !== 'answer');
    const summary = {
      ...meta,
      finishedAt: new Date().toISOString(),
      jsonl: path.relative(process.cwd(), jsonlPath),
      cloudAttempts,
      stopped,
      completed: records.filter((record) => record.done === true).length,
      pending: questions.filter((question) => !records.some((record) => record.key === question.key && record.done === true)).map((question) => question.key),
      proofBoundary: '同一校验器复算仅为一致性检查；关键串命中仅为候选正确，事实与引用须逐句独立核对',
      humanFactReview: 'pending',
      goNoGo: 'no_go_pending_fact_review',
      guards: {
        total: questions.filter((question) => question.behavior !== 'answer').length,
        attempted: guards.length,
        correct: guards.filter((record) => record.guardCorrect === true).length,
      },
      answers: {
        total: questions.filter((question) => question.behavior === 'answer').length,
        attempted: answers.length,
        modelAnswer: answers.filter((record) => record.judge.delivery === 'model_answer').length,
        refused: answers.filter((record) => record.judge.delivery === 'model_refused').length,
        fallback: answers.filter((record) => record.judge.delivery === 'fallback_sources').length,
        transportFailed: answers.filter((record) => record.judge.delivery === 'transport_failed').length,
        notCalled: records.filter(record => record.expectedBehavior === 'answer' && !record.modelCall).length,
        mustContainHitInModel: answers.filter((record) => record.judge.mustContainInModel === true).length,
        mustContainHitInSources: answers.filter((record) => record.judge.mustContainInSources === true).length,
        expectedPassageInTopN: answers.filter((record) => record.judge.expectedPassageInTopN === true).length,
      },
      cost: {
        cloudAttempts,
        basis: '逐题最新结果的已知费用；完整重复尝试费用须核对JSONL与云端账目',
        totalTokens: answers.reduce((sum, record) => sum + Number(record.modelCall?.usage?.totalTokens ?? 0), 0),
        costYuan: answers.some((record) => record.modelCall?.usage?.costYuan == null && !['quota_exhausted', 'invalid_request'].includes(record.modelCall?.failureClass)) ? null : Number(answers.reduce((sum, record) => sum + Number(record.modelCall?.usage?.costYuan ?? 0), 0).toFixed(6)),
      },
      failures: answers
        .filter((record) => record.judge.delivery === 'fallback_sources' || record.judge.delivery === 'transport_failed')
        .map((record) => ({ key: record.key, failureClass: record.modelCall?.failureClass ?? 'transport', violations: record.modelCall?.advancement?.violations ?? [] })),
    };
    summary.latency = {
      budgetMs: 8000,
      measured: answers.filter((record) => Number.isFinite(record.modelCall.clientElapsedMs)).length,
      withinBudget: answers.filter((record) => Number.isFinite(record.modelCall.clientElapsedMs) && record.modelCall.clientElapsedMs <= 8000).length,
    };
    if (summary.pending.length > 0) exitCode = Math.max(exitCode, 1);
    fs.writeFileSync(jsonPath, JSON.stringify({ ...summary, records }, null, 2));
    console.log('');
    console.log(`守门题：${summary.guards.correct}/${summary.guards.total} 符合预期`);
    console.log(`事实题：模型解释 ${summary.answers.modelAnswer}、模型拒答 ${summary.answers.refused}、降级 ${summary.answers.fallback}、传输失败 ${summary.answers.transportFailed}`);
    console.log(`关键事实命中（模型回答内）：${summary.answers.mustContainHitInModel}/${summary.answers.total}｜预期段落在 top-${TOP_N}：${summary.answers.expectedPassageInTopN}/${summary.answers.total}`);
    console.log(`本次云请求 ${summary.cost.cloudAttempts} 次（不等于模型调用数）、${summary.cost.totalTokens} token、${summary.cost.costYuan} 元`);
    console.log(`逐题记录：${path.relative(process.cwd(), jsonlPath)}`);
    console.log(`汇总：${path.relative(process.cwd(), jsonPath)}`);
  } catch (error) {
    const detail = error === null || error === undefined
      ? String(error)
      : error.message || error.errMsg || (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
    console.error(`❌ 评测未能完成：${detail}`);
    exitCode = 1;
  } finally {
    if (mini) mini.disconnect();
  }
  process.exitCode = exitCode;
}

module.exports = { parseArgs, loadQuestions, localAsk, summarizeCall, judgeAnswer, independentVerify, delivery, isCompleteRecord, stopReason, validateBudget };
if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
