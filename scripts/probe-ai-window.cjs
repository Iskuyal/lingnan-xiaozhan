/**
 * 内容安全检测窗口的**云端**复验探针（待办总表 V8；修复见审计报告 CT-01/CT-02）。
 *
 * 为什么要单独一个脚本：修复前后的差别只在「输入或输出超过 2 万字」时才显现，
 * `smoke:ai`（短文本）与 `smoke:ai:vision`（真实截图）都构造不到那个长度，
 * 只跑它们无法证明修复在线上生效。
 *
 * 两个探针：
 * 1. **超长输入**（4 条 8000 字消息 = 3.2 万字）：期望 `ok: false` + `invalid_request`，
 *    且 `usage` / `safety` 为空、无告警——说明服务端**在花检测配额与调模型之前**就拒绝了。
 *    这一档**不消耗微信检测配额**（拒绝早于检测），可以放心在演示前跑。
 * 2. **长输出**（要求模型输出大量字符，`maxTokens: 8192`）：期望 `ok: true` 且
 *    `safety.checked: true`、无 `checked=false` 告警（整段检完才返回）。
 *    这一档**会消耗检测配额**：按 2000 字一片，2 万字以上约 10~16 次。
 *    模型若没输出到 2 万字，脚本如实标 `covered: false`（不算通过）——不能把
 *    「这次模型没写那么长」当成修复已验证。
 *
 * 长文本在**模拟器里就地构造**（`'好'.repeat(8000)`），不把几万字经自动化协议传过去。
 *
 * 前置与 `smoke:ai` 相同：开发者工具已用
 *   `cli auto --project <仓库>/dist --auto-port 9420 --trust-project`
 *   打开项目，且 `ai` 已是修复后的版本（部署判据见 docs/cloud-development.md）。
 *
 * 用法：`npm run probe:ai-window`。记录追加到 artifacts/verify/ai-window.jsonl，
 * 最新一次写入 ai-window.json（artifacts 已 gitignore，只在执行机上）。
 *
 * 退出码：0 = 两个探针都符合期望（或探针 2 如实报告「未覆盖」）；1 = 调用没跑通
 *         （未部署 / 权限 / 端口）；2 = 有探针与期望不符（输出里会写明差在哪一行）。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { judgeLongOutput, judgeOversizeInput } = require('./lib/ai-window-judge.cjs');
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const path = require('node:path');

/** 输入侧上限（与服务端 `MAX_INPUT_CHARS` 同源：2000 字 × 10 片）。 */
const INPUT_LIMIT = 20000;
/** 输出侧分片上限（服务端 `MAX_OUTPUT_CHARS`：2000 字 × 20 片）。 */
const OUTPUT_LIMIT = 40000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  return String((error && (error.errMsg || error.message)) || error);
}

/**
 * 在模拟器里调一次云函数并取回结果。
 *
 * `kind` 是唯一过协议传的参数（小字符串）；请求体按 kind 在模拟器里就地拼出来——
 * 超长输入那个请求有 3.2 万字，不该经自动化协议来回搬。
 */
async function callAi(mini, kind) {
  const raw = await mini.evaluate(
    (probeKind) =>
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve(JSON.stringify({ invoked: false, err: '云函数调用超过 60 秒未返回' })),
          60000,
        );
        const request = probeKind === 'oversize-input'
          ? {
            action: 'chat',
            feature: 'window-probe',
            system: '你是一个只做连通性检查的助手。',
            // 单条消息上限 8000 字，4 条拼出 3.2 万字，超过 2 万字的检测窗口。
            messages: [0, 1, 2, 3].map(() => ({ role: 'user', text: '好'.repeat(8000) })),
            maxTokens: 64,
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
            clearTimeout(timer);
            resolve(JSON.stringify({ invoked: true, result: res.result }));
          })
          .catch((error) => {
            clearTimeout(timer);
            resolve(JSON.stringify({
              invoked: false,
              err: (error && (error.errMsg || error.message)) || String(error),
            }));
          });
      }),
    kind,
  );
  const parsed = JSON.parse(raw);
  if (parsed.invoked !== true) throw new Error(`${kind} 调用没跑通：${parsed.err}`);
  return parsed.result;
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

    // 探针 1：超长输入（拒绝早于检测，因此不消耗检测配额）。
    const oversize = await callAi(mini, 'oversize-input');
    const oversizeVerdict = judgeOversizeInput(oversize, INPUT_LIMIT);
    probes.push({
      probe: 'oversize-input',
      expectation: `ok=false 且 failureClass=invalid_request、usage/safety 为空、detail 写明上限 ${INPUT_LIMIT}`,
      limit: INPUT_LIMIT,
      verdict: oversizeVerdict,
      result: oversize,
    });
    console.log('===== 探针 1：超长输入（3.2 万字 > 2 万字窗口）=====');
    console.log(summarize(oversize));
    console.log(`detail=${String(oversize.detail || '').slice(0, 300)}`);
    console.log(oversizeVerdict.pass
      ? '✅ 符合期望：拒绝发生在检测与模型调用之前（这一档不消耗检测配额）'
      : `❌ 与期望不符：${oversizeVerdict.reasons.join('；')}`);
    if (!oversizeVerdict.pass) exitCode = Math.max(exitCode, 2);

    // 探针 2：长输出（按片消耗检测配额）。
    await sleep(1500);
    const long = await callAi(mini, 'long-output');
    const textLength = String(long.text || '').length;
    const longVerdict = judgeLongOutput(long, INPUT_LIMIT, OUTPUT_LIMIT, textLength);
    probes.push({
      probe: 'long-output',
      expectation: `文本长度 ≥ ${INPUT_LIMIT} 字时：ok=true、safety.checked=true、无 checked=false 告警（分片上限 ${OUTPUT_LIMIT} 字）`,
      limit: INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      textLength,
      verdict: longVerdict,
      result: long,
    });
    console.log('');
    console.log('===== 探针 2：长输出 =====');
    console.log(`${summarize(long)} 文本长度=${textLength}`);
    console.log(`warnings=${JSON.stringify(Array.isArray(long.warnings) ? long.warnings : []).slice(0, 300)}`);
    if (!longVerdict.covered) {
      console.log(`⚠️ 未被覆盖：${longVerdict.reasons.join('；')}`);
    } else {
      console.log(longVerdict.pass ? '✅ 符合期望：输出整段检完才返回' : `❌ 与期望不符：${longVerdict.reasons.join('；')}`);
      if (!longVerdict.pass) exitCode = Math.max(exitCode, 2);
    }

    save({
      probedAt: new Date().toISOString(),
      runId,
      inputLimit: INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      probes,
    });
    if (exitCode === 0) console.log('\n探针结论：无与期望不符的项。');
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
