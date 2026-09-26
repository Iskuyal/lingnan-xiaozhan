/**
 * `ai` 云函数的端到端冒烟（Ticket 01 步骤 E 的可重复执行版）：一句测试文本经模型返回结果。
 *
 * 为什么必须从小程序端跑：默认内容安全适配器是 `wechat`（云调用），云调用要求调用方带
 * 小程序侧的票据——控制台「测试」页、CLI、HTTP 触发都拿不到它，chat/vision 会在内容安全
 * 这一步以 `internal` 失败（错误码 -501001，见 cloudfunctions/ai/safety.ts）。
 *
 * 前置：开发者工具已用
 *   `cli auto --project <仓库>/dist --auto-port 9420 --trust-project`
 *   打开项目；云函数 `ai` 已部署、环境变量（模型地址/密钥/模型名）已在控制台配好。
 *
 * 用法：`npm run smoke:ai`；用 `npm run smoke:ai -- --attempts=3` 顺序复测 3 次。
 * 端口可用 WECHAT_AUTO_PORT 覆盖，默认 9420；每次结果追加到 ai-smoke.jsonl，最新一次写入 ai-smoke.json。
 *
 * 退出码：0 = 端到端成功（`ok: true` 且 `text` 非空）；
 *         1 = 云函数调用没跑通（未部署 / 权限 / 网络）；
 *         2 = 云函数返回失败（多半是环境变量没配全，返回里会写明缺哪几个）。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { appendAttemptRecord, makeAttemptRecord, parseOptions } = require('./lib/ai-smoke-records.cjs');

/** 冒烟文本与步骤 E 保持一致：固定、短、不含任何个人信息。 */
const SMOKE_TEXT = '只回复四个字：链路已通';
const REQUEST = { action: 'chat', feature: 'e2e-check', text: SMOKE_TEXT, maxTokens: 64 };

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  return String((error && (error.errMsg || error.message)) || error);
}

function printRecord(record) {
  console.log('');
  console.log(`第 ${record.attempt}/${record.attempts} 次：ok=${record.ok} 可重试=${record.retryable} failureClass=${record.failureClass || '(空)'} elapsedMs=${record.elapsedMs ?? '(空)'}`);
  console.log(`provider=${record.provider || '(空)'} model=${record.model || '(空)'}`);
  if (record.response.text) console.log(`模型输出：${record.response.text}`);
  if (record.response.message) console.log(`失败文案：${record.response.message}`);
  if (record.response.detail) console.log(`细节：${String(record.response.detail).slice(0, 500)}`);
  if (record.err) console.log(`调用错误：${String(record.err).slice(0, 500)}`);
  if (record.response.safety) {
    const safety = record.response.safety;
    console.log(`内容安全：provider=${safety.provider} checked=${safety.checked} passed=${safety.passed}｜${safety.detail}`);
  }
  if (record.response.usage) {
    const usage = record.response.usage;
    console.log(`本次用量：${usage.totalTokens} token / ${usage.costYuan} 元（estimated=${usage.estimated}）`);
  }
  if (record.response.usageSummary) {
    const summary = record.response.usageSummary;
    console.log(`当月累计：${summary.calls} 次 / ${summary.costYuan} 元（上限 ${summary.capYuan} 元）`);
  }
  if (record.response.capWarning) console.log(`上限告警：${record.response.capWarning}`);
  if (Array.isArray(record.response.warnings) && record.response.warnings.length > 0) {
    console.log(`告警：${record.response.warnings.join('｜')}`);
  }
}

async function run() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('用法：npm run smoke:ai -- --attempts=3（次数 1 到 5，默认 1）');
    process.exitCode = 1;
    return;
  }

  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const latestPath = path.join(output, 'ai-smoke.json');
  const historyPath = path.join(output, 'ai-smoke.jsonl');
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  let mini = null;
  let exitCode = 0;

  function saveRecord(record) {
    appendAttemptRecord(historyPath, record);
    // Keep the long-standing one-result report shape for existing readers; the JSONL is the history.
    writeFileSync(latestPath, JSON.stringify({
      ...record,
      platform: record.system?.platform ?? null,
      model: record.system?.model ?? null,
      SDKVersion: record.system?.SDKVersion ?? null,
    }, null, 2));
    printRecord(record);
  }

  try {
    mini = await connectMini();
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await sleep(1500);
    const system = await mini.systemInfo();

    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      if (attempt > 1) await sleep(1500);
      let parsed;
      try {
        // 函数体在模拟器里执行，取不到外层变量，因此请求与等待上限写成字面量。
        const raw = await mini.evaluate(
          () =>
            new Promise((resolve) => {
              const timer = setTimeout(
                () => resolve(JSON.stringify({ invoked: false, err: '云函数调用超过 60 秒未返回' })),
                60000,
              );
              wx.cloud
                .callFunction({
                  name: 'ai',
                  data: {
                    action: 'chat',
                    feature: 'e2e-check',
                    system: '你是一个只做连通性检查的助手，回答尽量短。',
                    messages: [{ role: 'user', text: '只回复四个字：链路已通' }],
                    maxTokens: 64,
                  },
                })
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
        );
        parsed = JSON.parse(raw);
      } catch (error) {
        parsed = { invoked: false, err: errorText(error) };
      }

      const record = makeAttemptRecord({
        smokeAt: new Date().toISOString(),
        runId,
        attempt,
        attempts: options.attempts,
        system: { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion },
        request: REQUEST,
        invoked: parsed.invoked === true,
        result: parsed.result,
        err: parsed.err,
      });
      saveRecord(record);
      if (!record.invoked) exitCode = Math.max(exitCode, 1);
      else if (!record.ok) exitCode = Math.max(exitCode, 2);
    }
    console.log('');
    console.log(`全部 ${options.attempts} 次结果已追加到 ${path.relative(process.cwd(), historyPath)}`);
    console.log(`最新一次结果：${path.relative(process.cwd(), latestPath)}`);
  } catch (error) {
    const record = makeAttemptRecord({
      smokeAt: new Date().toISOString(),
      runId,
      attempt: 1,
      attempts: options.attempts,
      request: REQUEST,
      invoked: false,
      err: errorText(error),
    });
    saveRecord(record);
    console.error(`❌ 冒烟测试未能启动：${record.err}`);
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
