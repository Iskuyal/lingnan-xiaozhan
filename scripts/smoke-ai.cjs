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
 * 用法：`npm run smoke:ai`（端口可用 WECHAT_AUTO_PORT 覆盖，默认 9420）
 *
 * 退出码：0 = 端到端成功（`ok: true` 且 `text` 非空）；
 *         1 = 云函数调用没跑通（未部署 / 权限 / 网络）；
 *         2 = 云函数返回失败（多半是环境变量没配全，返回里会写明缺哪几个）。
 */
const automator = require('miniprogram-automator');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const PORT = process.env.WECHAT_AUTO_PORT || '9420';

/** 冒烟文本与步骤 E 保持一致：固定、短、不含任何个人信息。 */
const SMOKE_TEXT = '只回复四个字：链路已通';

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` });
  try {
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 函数体在模拟器里执行，取不到外层变量，因此文本与等待上限都写成字面量。
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
              resolve(
                JSON.stringify({
                  invoked: false,
                  err: (error && (error.errMsg || error.message)) || String(error),
                }),
              );
            });
        }),
    );

    const parsed = JSON.parse(raw);
    if (!parsed.invoked) {
      console.error('❌ 调用云函数 ai 失败，端到端没跑起来');
      console.error(`   ${String(parsed.err).slice(0, 500)}`);
      writeFileSync(
        path.join(output, 'ai-smoke.json'),
        JSON.stringify({ smokeAt: new Date().toISOString(), invoked: false, err: parsed.err }, null, 2),
      );
      process.exitCode = 1;
      return;
    }

    const result = parsed.result || {};
    const system = await mini.systemInfo();
    const report = {
      smokeAt: new Date().toISOString(),
      platform: system.platform,
      model: system.model,
      SDKVersion: system.SDKVersion,
      realDevice: false,
      request: { action: 'chat', feature: 'e2e-check', text: SMOKE_TEXT, maxTokens: 64 },
      response: result,
    };
    writeFileSync(path.join(output, 'ai-smoke.json'), JSON.stringify(report, null, 2));

    console.log('');
    console.log(`ok=${result.ok} failureClass=${result.failureClass || '(空)'} elapsedMs=${result.elapsedMs}`);
    console.log(`provider=${result.provider || '(空)'} model=${result.model || '(空)'}`);
    console.log(`模型输出：${result.text || '(空)'}`);
    if (result.message) console.log(`失败文案：${result.message}`);
    if (result.detail) console.log(`细节：${String(result.detail).slice(0, 500)}`);
    if (result.safety) console.log(`内容安全：provider=${result.safety.provider} checked=${result.safety.checked} passed=${result.safety.passed}｜${result.safety.detail}`);
    if (result.usage) console.log(`本次用量：${result.usage.totalTokens} token / ${result.usage.costYuan} 元（estimated=${result.usage.estimated}）`);
    if (result.usageSummary) console.log(`当月累计：${result.usageSummary.calls} 次 / ${result.usageSummary.costYuan} 元（上限 ${result.usageSummary.capYuan} 元）`);
    if (result.capWarning) console.log(`上限告警：${result.capWarning}`);
    if (Array.isArray(result.warnings) && result.warnings.length > 0) console.log(`告警：${result.warnings.join('｜')}`);
    console.log('');
    console.log(`记录已写入 ${path.relative(process.cwd(), path.join(output, 'ai-smoke.json'))}`);

    if (result.ok !== true) {
      console.error('');
      console.error('❌ 云函数返回失败：先看上面的失败文案与细节（环境变量没配全会直接写在这里）');
      process.exitCode = 2;
    }
  } finally {
    mini.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
