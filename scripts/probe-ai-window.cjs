/**
 * 内容安全检测窗口的**云端**复验探针（待办总表 V8；修复见审计报告 CT-01/CT-02）。
 *
 * 为什么要单独一个脚本：修复前后的差别只在「输入或输出超过 2 万字」时才显现，
 * `smoke:ai`（短文本）与 `smoke:ai:vision`（真实截图）都构造不到那个长度，
 * 只跑它们无法证明修复在线上生效。
 *
 * 三个探针（前两个计入结论，第三个只作记录）：
 * 1. **超长输入**（4 条 8000 字消息 = 3.2 万字）：期望 `ok: false` + `invalid_request`，
 *    且 `usage` / `safety` 为空、无告警——说明服务端**在花检测配额与调模型之前**就拒绝了。
 *    这一档**不消耗微信检测配额**（拒绝早于检测），可以放心在演示前跑。
 * 2. **分片全检（输出侧判据，2026-09-29 改为 B 方案）**：由维护者动作 `moderateText`
 *    送 6000 字（3 片）良性文本，期望 `safety.checked: true`、无 `checked=false` 告警。
 *    `moderateOutput`（chat / vision 的输出检测）走的是同一个分片函数，只是片数上限
 *    不同（输出 20 片 / 诊断 10 片）。**这一档消耗 3 次检测调用**，且需要维护者白名单
 *    （不是维护者时标 `covered: false`，脚本按「没有覆盖证据」退出 3）。
 *    **原判据（要求模型自己写出 ≥2 万字）已废弃**：服务端把 `maxTokens` 钳在 1..8192，
 *    而当前模型每个字符要烧几十个 token（实测 600 字用 5575 completion token），
 *    模型写不出 2 万字 ⇒ 那条判据永远不可达。**代价要说清楚**：这一档证明「输出被切成
 *    多片并全部检完」，**不再证明 2 万字窗口被用满**；「输出 >4 万字即不返回」那条
 *    fail-closed 规则仍只有单测覆盖。
 * 3. **模型自写长输出**（机会性，不计入结论）：让模型自己写长文本，能写到 ≥2 万字就
 *    按原判据判，写不到就如实标未覆盖——留着它是因为模型或供应商换掉后这一档可能又可用。
 *
 * 长文本在**模拟器里就地构造**（`'好'.repeat(8000)` 或 `'好'.repeat(6000)`），不把几万字经自动化协议传过去。
 *
 * **取结果用轮询，不把云函数调用包在一次 `evaluate` 里等到底。** 开发者工具的自动化桥
 * 对单次 `evaluate` 有约 10 秒上限（2026-09-29 实测：超长输入那次恰好在 10010ms 报
 * `timeout waiting for automator response`）。而这两档恰恰都会超过 10 秒——修复前的
 * 超长输入会真的走进模型，长输出那一档本身就要模型写几十秒——包在一次调用里就永远
 * 拿不到结果，而那正是「与期望不符」要看的东西。改成：在模拟器里发起后立刻返回，
 * 结果挂到 `globalThis`，再用多次短 `evaluate` 轮询取回。
 *
 * 前置与 `smoke:ai` 相同：开发者工具已用
 *   `cli auto --project <仓库>/dist --auto-port 9420 --trust-project`
 *   打开项目，且 `ai` 已是修复后的版本（部署判据见 docs/cloud-development.md）。
 *
 * **配额提醒**：「探针 1 不消耗检测配额」只在**修复版已部署**时成立。部署的是修复前
 * 的版本时，超长输入不会被提前拒绝，会照旧按 2 万字分 10 片送检、再进模型，因此
 * 那一档照样花检测配额（2026-09-29 实测如此）。
 *
 * 用法：`npm run probe:ai-window`。记录追加到 artifacts/verify/ai-window.jsonl，
 * 最新一次写入 ai-window.json（artifacts 已 gitignore，只在执行机上）。
 *
 * 退出码：0 = 探针 1 与探针 2 都覆盖且符合期望；1 = 调用没跑通（未部署 / 权限 / 端口）；
 *         2 = 有探针与期望不符；3 = 输出侧没有覆盖证据（探针 2 被跳过，例如当前账号不是维护者）。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { judgeChunkedModeration, judgeLongOutput, judgeOversizeInput, probeRunExitCode } = require('./lib/ai-window-judge.cjs');
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const path = require('node:path');

/** 输入侧上限（与服务端 `MAX_INPUT_CHARS` 同源：2000 字 × 10 片）。 */
const INPUT_LIMIT = 20000;
/** 输出侧分片上限（服务端 `MAX_OUTPUT_CHARS`：2000 字 × 20 片）。 */
const OUTPUT_LIMIT = 40000;
/** 微信检测的分片大小（与服务端 `MODERATION_CHUNK_CHARS` 同源）。 */
const MODERATION_CHUNK_CHARS = 2000;
/** 探针 2 送检的文本长度：3 片，足以证明「多片全检」。 */
const CHUNKED_TEXT_CHARS = 6000;
/** 探针 2 至少几片才算覆盖。 */
const CHUNKED_MIN_CHUNKS = 3;
/** 轮询上限：云函数自身超时 60 秒（控制台配置），长输出那一档实测约 42 秒。 */
const RESULT_WAIT_MS = 180000;
/** 轮询间隔：每次 `evaluate` 都很短，2 秒足够取回结果。 */
const POLL_INTERVAL_MS = 2000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  return String((error && (error.errMsg || error.message)) || error);
}

/**
 * 在模拟器里**发起**一次云函数调用并立刻返回，不等结果。
 *
 * `kind` 是唯一经协议传的参数（小字符串）；请求体按 kind 在模拟器里就地拼出来——
 * 超长输入那个请求有 3.2 万字，不该经自动化协议来回搬。这个函数会被序列化后在页面
 * 上下文里执行，因此必须自包含（不能引用 Node 侧的变量与函数）。
 */
async function startAi(mini, kind) {
  const started = await mini.evaluate((probeKind) => {
    globalThis.__aiWindowProbe = { done: false, startedAt: Date.now() };
    const request = probeKind === 'oversize-input'
      ? {
        action: 'chat',
        feature: 'window-probe',
        system: '你是一个只做连通性检查的助手。',
        // 单条消息上限 8000 字，4 条拼出 3.2 万字，超过 2 万字的检测窗口。
        messages: [0, 1, 2, 3].map(() => ({ role: 'user', text: '好'.repeat(8000) })),
        maxTokens: 64,
      }
      : probeKind === 'chunked-moderation'
        ? {
          // 维护者动作：文本由调用方给出（6000 字 = 3 片），不依赖模型写多少字。
          action: 'moderateText',
          feature: 'window-probe',
          text: '好'.repeat(6000),
        }
        : {
          action: 'chat',
          feature: 'window-probe',
          system: '你只输出被要求的内容，不要解释，不要换行。',
          messages: [{ role: 'user', text: '请连续输出 30000 个小写字母 a，不要换行、不要分段、不要任何其它字符。' }],
          maxTokens: 8192,
        };
    wx.cloud
      .callFunction({ name: 'ai', data: request })
      .then((res) => {
        globalThis.__aiWindowProbe = {
          done: true,
          invoked: true,
          result: res.result,
          elapsedMs: Date.now() - globalThis.__aiWindowProbe.startedAt,
        };
      })
      .catch((error) => {
        globalThis.__aiWindowProbe = {
          done: true,
          invoked: false,
          err: (error && (error.errMsg || error.message)) || String(error),
          elapsedMs: Date.now() - globalThis.__aiWindowProbe.startedAt,
        };
      });
    return 'started';
  }, kind);
  if (started !== 'started') throw new Error(`${kind} 没能在模拟器里发起：${String(started)}`);
}

/** 轮询取回上一次发起的结果：每次 `evaluate` 都很短，不受单次约 10 秒上限影响。 */
async function awaitAi(mini, kind) {
  const deadline = Date.now() + RESULT_WAIT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const raw = await mini.evaluate(() => JSON.stringify(globalThis.__aiWindowProbe || { done: false }));
    const state = JSON.parse(raw);
    if (state.done === true) {
      if (state.invoked !== true) throw new Error(`${kind} 调用没跑通：${state.err}`);
      return { result: state.result, elapsedMs: state.elapsedMs };
    }
    if (Date.now() > deadline) throw new Error(`${kind} 超过 ${RESULT_WAIT_MS / 1000} 秒仍未返回`);
  }
}

function summarize(result) {
  const usage = result.usage === null || result.usage === undefined ? 'null' : '(非空)';
  const safety = result.safety === null || result.safety === undefined
    ? 'null'
    : `checked=${result.safety.checked}`;
  return `ok=${result.ok} failureClass=${JSON.stringify(result.failureClass || '')} usage=${usage} safety=${safety}`;
}

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const latestPath = path.join(output, 'ai-window.json');
  const historyPath = path.join(output, 'ai-window.jsonl');
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  const probes = [];
  let mini = null;
  let exitCode = 0;

  function save(record) {
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
    writeFileSync(latestPath, JSON.stringify(record, null, 2));
    console.log(`结果已追加到 ${path.relative(process.cwd(), historyPath)}`);
    console.log(`最新一次结果：${path.relative(process.cwd(), latestPath)}`);
  }

  try {
    mini = await connectMini();
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await sleep(1500);

    // 探针 1：超长输入（修复版上拒绝早于检测，因此不消耗检测配额）。
    await startAi(mini, 'oversize-input');
    const oversize = await awaitAi(mini, 'oversize-input');
    const oversizeVerdict = judgeOversizeInput(oversize.result, INPUT_LIMIT);
    probes.push({
      probe: 'oversize-input',
      expectation: `ok=false 且 failureClass=invalid_request、usage/safety 为空、detail 写明上限 ${INPUT_LIMIT}`,
      limit: INPUT_LIMIT,
      cloudElapsedMs: oversize.elapsedMs,
      verdict: oversizeVerdict,
      result: oversize.result,
    });
    console.log('===== 探针 1：超长输入（3.2 万字 > 2 万字窗口）=====');
    console.log(`${summarize(oversize.result)} 云函数耗时=${oversize.elapsedMs}ms`);
    console.log(`detail=${String(oversize.result.detail || '').slice(0, 300)}`);
    console.log(oversizeVerdict.pass
      ? '✅ 符合期望：拒绝发生在检测与模型调用之前（这一档不消耗检测配额）'
      : `❌ 与期望不符：${oversizeVerdict.reasons.join('；')}`);

    // 探针 2：输出侧的可达判据——维护者动作 `moderateText` 送 6000 字（3 片）良性文本，
    // 期望整段检完（`checked: true`、无 `checked=false` 告警）。这是 `moderateOutput`
    // 走的同一个分片函数，只是片数上限不同（输出 20 片 / 诊断 10 片）。
    await sleep(1500);
    await startAi(mini, 'chunked-moderation');
    const chunked = await awaitAi(mini, 'chunked-moderation');
    const chunkedVerdict = judgeChunkedModeration(chunked.result, CHUNKED_TEXT_CHARS, MODERATION_CHUNK_CHARS, CHUNKED_MIN_CHUNKS);
    probes.push({
      probe: 'chunked-moderation',
      expectation: `送检 ${CHUNKED_TEXT_CHARS} 字（${CHUNKED_TEXT_CHARS / MODERATION_CHUNK_CHARS} 片）：ok=true、safety.checked=true、无 checked=false 告警`,
      textChars: CHUNKED_TEXT_CHARS,
      chunkChars: MODERATION_CHUNK_CHARS,
      minChunks: CHUNKED_MIN_CHUNKS,
      cloudElapsedMs: chunked.elapsedMs,
      verdict: chunkedVerdict,
      result: chunked.result,
    });
    console.log('');
    console.log(`===== 探针 2：分片全检（维护者送检 ${CHUNKED_TEXT_CHARS} 字 = ${CHUNKED_TEXT_CHARS / MODERATION_CHUNK_CHARS} 片）=====`);
    console.log(`${summarize(chunked.result)} 云函数耗时=${chunked.elapsedMs}ms`);
    console.log(`safety.detail=${String((chunked.result.safety && chunked.result.safety.detail) || '').slice(0, 240)}`);
    if (!chunkedVerdict.covered) {
      console.log(`⚠️ 未被覆盖：${chunkedVerdict.reasons.join('；')}`);
    } else {
      console.log(chunkedVerdict.pass
        ? '✅ 符合期望：多片文本整段检完才返回（分片链路在线上成立）'
        : `❌ 与期望不符：${chunkedVerdict.reasons.join('；')}`);
    }

    // 探针 3（机会性，不计入结论）：让模型自己写长文本。2026-09-29 实测模型写不出
    // 多片输出（每个字符要烧几十个 token，1200 字就在 40 秒模型超时处失败），
    // 因此这一档常常「未覆盖」——输出侧判据以探针 2 为准。
    await sleep(1500);
    await startAi(mini, 'long-output');
    const long = await awaitAi(mini, 'long-output');
    const textLength = String(long.result.text || '').length;
    const longVerdict = judgeLongOutput(long.result, INPUT_LIMIT, OUTPUT_LIMIT, textLength);
    probes.push({
      probe: 'long-output',
      expectation: `（机会性）文本长度 ≥ ${INPUT_LIMIT} 字时：ok=true、safety.checked=true、无 checked=false 告警（分片上限 ${OUTPUT_LIMIT} 字）`,
      limit: INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      textLength,
      cloudElapsedMs: long.elapsedMs,
      verdict: longVerdict,
      result: long.result,
    });
    console.log('');
    console.log('===== 探针 3：模型自写长输出（机会性，不计入结论）=====');
    console.log(`${summarize(long.result)} 文本长度=${textLength} 云函数耗时=${long.elapsedMs}ms`);
    console.log(!longVerdict.covered
      ? `ℹ️ 未覆盖（模型没写出足够长的文本）：${longVerdict.reasons.join('；')}`
      : (longVerdict.pass ? '✅ 符合期望：输出整段检完才返回' : `❌ 与期望不符：${longVerdict.reasons.join('；')}`));

    exitCode = probeRunExitCode(oversizeVerdict, chunkedVerdict);

    save({
      probedAt: new Date().toISOString(),
      runId,
      inputLimit: INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      probes,
    });
    if (exitCode === 0) console.log('\n探针结论：输入侧与输出侧（分片全检）均覆盖且符合期望。');
    else if (exitCode === 3) console.log('\n探针结论：输出侧没有覆盖证据（例如当前账号不是维护者、分片探针被跳过），不能算通过。');
  } catch (error) {
    save({
      probedAt: new Date().toISOString(),
      runId,
      inputLimit: INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      probes,
      err: errorText(error),
    });
    console.error(`❌ 探针未能跑完：${errorText(error)}`);
    exitCode = 1;
  } finally {
    if (mini) mini.disconnect();
  }
  process.exitCode = exitCode;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
