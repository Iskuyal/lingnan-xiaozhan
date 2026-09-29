/**
 * 微信内容安全探测（云函数动作 `{"action":"probe"}`）的**小程序端**执行入口。
 *
 * 为什么必须从小程序端跑：云调用要求调用方带上小程序侧的云调用票据。
 * 云开发控制台的「测试」页、CLI、HTTP 触发、云函数互调都拿不到它，
 * 这些方式下调用**必然**返回 -501001（CloudBase `INVALID_WX_ACCESS_TOKEN`），
 * 那条结果说明的是「本次调用怎么发起的」，不是「微信接口能不能用」。
 * 官方口径见 cloudfunctions/ai/safety.ts 的 WECHAT_ERRCODE_NOTES。
 *
 * 前置：
 *   开发者工具已用
 *   `cli auto --project <仓库>/dist --auto-port 9420 --trust-project`
 *   打开项目（模拟器在跑、AppID 有权限）。
 *
 * 用法：`npm run probe:wechat`（端口可用 WECHAT_AUTO_PORT 覆盖，默认 9420）
 *
 * 退出码：0 = 拿到有效探测记录（「接口不可用」这类负面结论也是有效测量）；
 *         1 = 云函数调用没跑通（未部署 / 权限 / 网络），没有探测记录；
 *         2 = 探测记录无效（触发方式或上下文不对），需按提示重跑。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { diagnoseMissingProbe } = require('./lib/probe-wechat-diagnostics.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');


/** 探测的等待上限：冷启动 + 两条微信接口各一次调用，探测本身另有 5 秒硬超时。 */
const PROBE_WAIT_MS = 60000;

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  try {
    // 先落到页面，确保 app onLaunch 里的 wx.cloud.init 已经跑过。
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 函数体在模拟器里执行，取不到外层变量，因此这里的等待上限写成字面量。
    const raw = await mini.evaluate(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(
            () => resolve(JSON.stringify({ invoked: false, err: '云函数调用超过 60 秒未返回' })),
            60000,
          );
          wx.cloud
            .callFunction({ name: 'ai', data: { action: 'probe' } })
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
      console.error('❌ 调用云函数 ai 失败，没有拿到探测记录');
      console.error(`   ${String(parsed.err).slice(0, 500)}`);
      writeFileSync(
        path.join(output, 'ai-probe.json'),
        JSON.stringify({ probedAt: new Date().toISOString(), invoked: false, err: parsed.err }, null, 2),
      );
      process.exitCode = 1;
      return;
    }

    const result = parsed.result || {};
    const record = result.probe;
    if (!record) {
      const diagnosis = diagnoseMissingProbe(result);
      console.error(`❌ ${diagnosis.message}`);
      console.error(`   diagnosis=${diagnosis.kind} failureClass=${result.failureClass || '(空)'} message=${result.message || '(空)'}`);
      writeFileSync(path.join(output, 'ai-probe.json'), JSON.stringify({
        probedAt: new Date().toISOString(),
        realDevice: false,
        invoked: true,
        ok: result.ok === true,
        diagnosis: diagnosis.kind,
        failureClass: result.failureClass || null,
        message: result.message || '',
      }, null, 2));
      process.exitCode = 2;
      return;
    }

    const system = await mini.systemInfo();
    const report = {
      probedAt: new Date().toISOString(),
      platform: system.platform,
      model: system.model,
      SDKVersion: system.SDKVersion,
      realDevice: false,
      ok: result.ok === true,
      message: result.message,
      probe: record,
    };
    writeFileSync(path.join(output, 'ai-probe.json'), JSON.stringify(report, null, 2));

    console.log('');
    console.log(`结论：${result.message}`);
    console.log(`建议适配器：${record.recommendedProvider}（当前云端默认 AI_SAFETY_PROVIDER=wechat）`);
    console.log(`环境：${record.env || '(未取到)'}｜openid 是否带上：${record.openidPresent ? '是（v2 形态）' : '否（v1 形态）'}`);
    for (const check of record.checks) {
      console.log(`  - ${check.api} [${check.form}] errCode=${check.errCode} verdict=${check.verdict} ${check.elapsedMs}ms`);
      console.log(`    ${check.errMsg}`);
      console.log(`    说明：${check.note}`);
    }
    console.log('');
    console.log('粘贴进 docs/development/cloud/ai.md 探测记录表的一行：');
    console.log(result.detail || JSON.stringify(record));

    if (record.valid === false) {
      console.error('');
      console.error(`❌ 本次探测无效：${record.invalidReason || '调用上下文不满足云调用要求'}`);
      process.exitCode = 2;
    } else if (record.valid === undefined) {
      // 旧版本的云函数还没有 valid 字段，提示一句但不影响结论。
      console.log('');
      console.log('提示：云端函数返回的记录没有 valid 字段（部署的版本较旧），本次按有效测量处理。');
    }
    console.log('');
    console.log(`记录已写入 ${path.relative(process.cwd(), path.join(output, 'ai-probe.json'))}`);
  } finally {
    mini.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
