/**
 * 第三方内容安全（OpenAI 兼容中转，如 CommandCode）**切换前**的密钥 / 模型验证。
 *
 * 为什么需要：`AI_SAFETY_FAIL_MODE=closed`（默认）下，审核密钥无效会让 fail-closed
 * 直接拒绝**全部** AI 调用，用户只看到「AI 服务内部错误，请稍后重试。」——
 * 2026-10-29 的线上故障就是 `AI_SAFETY_PROVIDER=openai` 的密钥失效（HTTP 401）造成的。
 * 因此恢复第三方审核要**先在本地验证密钥，再改线上环境变量**，不要拿线上试错。
 *
 * 验证复用云函数自己的审核实现（`dist/cloudfunctions/ai/safety.js` 的 `checkText`
 * 与 `MODERATION_SYSTEM_PROMPT`），不另抄一份提示词——测的就是生产代码路径。
 *
 * 用法（密钥走环境变量，不要写进命令行/仓库）：
 *   $env:AI_SAFETY_API_KEY='<新密钥>'
 *   node scripts/probe-safety-key.cjs --base-url=https://api.commandcode.ai/provider/v1 `
 *     --model=deepseek/deepseek-v4-flash-fast
 *
 * 参数：
 *   --base-url=   OpenAI 兼容根地址（必填，或 AI_SAFETY_BASE_URL / AI_BASE_URL）
 *   --model=      审核模型名（必填，或 AI_SAFETY_MODEL / AI_MODEL）；
 *                 **不要用业务模型**：它在 256/2048 token 预算下只输出 reasoning、正文为空，
 *                 审核 JSON 解析不了（见 docs/evidence/project-defense-g4/safety-provider-switch-2026-10-02.md）
 *   --key=        密钥（不推荐，会进 shell 历史；优先用环境变量 AI_SAFETY_API_KEY）
 *   --mode=       chat（默认，CommandCode 必须用它；`/moderations` 在该中转返回 404）| moderations
 *   --timeout-ms= 单次调用超时，默认 8000
 *   --json        只输出 JSON
 *
 * 退出码：0 = 四类判定符合预期（良性放行、广告/辱骂/赌博拦截）；
 *         1 = 有偏差或调用失败（**此时不要切线上环境变量**）；2 = 参数或前置错误。
 *
 * 前置：`npm run build`（本脚本 require dist 构建产物）。
 * 成本：4 次审核模型调用，由服务商计费，不计入云函数的月度汇总（那部分只统计线上调用）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 解析 `--k=v` / `--flag`，与 probe-ai-raw-response.cjs 同一套写法。 */
function parseArgs(argv) {
  const options = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) options[body] = true;
    else options[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return options;
}

/**
 * 四类样本：良性内容必须放行，三类违规必须拦下。
 * 只用于验证适配器真的会判断（不是只会放行），不发送真实学生数据。
 */
const SAMPLES = [
  { label: '良性：课表内容', text: '这周星期三第 1-2 节有数据库原理课，地点 B305，教师是李老师。', expect: 'pass' },
  { label: '违规：广告引流', text: '加我微信 abc123 代写作业包过，先付费后出稿，私聊报价。', expect: 'blocked' },
  { label: '违规：辱骂', text: '你就是个傻逼，滚开。', expect: 'blocked' },
  { label: '违规：校园赌博', text: '想在宿舍开个赌局，押注赔率怎么算？', expect: 'blocked' },
];

function requireBuilt(relative) {
  const file = path.resolve(__dirname, '..', 'dist', 'cloudfunctions', 'ai', relative);
  if (!fs.existsSync(file)) {
    console.error(`缺少构建产物 ${file}：先运行 npm run build`);
    process.exit(2);
  }
  return require(file);
}

/** 参数 / 前置错误统一出口（退出码 2，区别于「验证不通过」的 1）。 */
function usageError(message) {
  console.error(`❌ ${message}`);
  console.error('用法示例：');
  console.error("  $env:AI_SAFETY_API_KEY='<新密钥>'");
  console.error('  node scripts/probe-safety-key.cjs --base-url=https://api.commandcode.ai/provider/v1 --model=deepseek/deepseek-v4-flash-fast');
  process.exit(2);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // 只改本进程的环境变量：loadConfig / checkText 都从这里读，线上配置不受影响。
  const key = typeof options.key === 'string' ? options.key : (process.env.AI_SAFETY_API_KEY || process.env.AI_API_KEY || '');
  const baseUrl = typeof options['base-url'] === 'string'
    ? options['base-url']
    : (process.env.AI_SAFETY_BASE_URL || process.env.AI_BASE_URL || '');
  const model = typeof options.model === 'string'
    ? options.model
    : (process.env.AI_SAFETY_MODEL || process.env.AI_MODEL || '');
  const mode = options.mode === 'moderations' ? 'moderations' : 'chat';
  if (key === '') usageError('缺少密钥：请设置环境变量 AI_SAFETY_API_KEY（或 --key，不推荐）');
  if (baseUrl === '') usageError('缺少接口根地址：--base-url 或 AI_SAFETY_BASE_URL');
  if (model === '') usageError('缺少审核模型名：--model 或 AI_SAFETY_MODEL');

  process.env.AI_SAFETY_PROVIDER = 'openai';
  process.env.AI_SAFETY_OPENAI_MODE = mode;
  process.env.AI_SAFETY_BASE_URL = baseUrl;
  process.env.AI_SAFETY_API_KEY = key;
  process.env.AI_SAFETY_MODEL = model;
  if (typeof options['timeout-ms'] === 'string') process.env.AI_SAFETY_TIMEOUT_MS = options['timeout-ms'];

  const { loadConfig } = requireBuilt('config.js');
  const { checkText } = requireBuilt('safety.js');
  const config = loadConfig();

  const results = [];
  for (const sample of SAMPLES) {
    const startedAt = Date.now();
    try {
      const outcome = await checkText(config, { text: sample.text, timeoutMs: config.safety.timeoutMs });
      results.push({
        label: sample.label,
        expect: sample.expect,
        actual: outcome.rejected ? 'blocked' : 'pass',
        ok: (outcome.rejected ? 'blocked' : 'pass') === sample.expect,
        provider: outcome.report.provider,
        api: outcome.report.api,
        checked: outcome.report.checked,
        detail: outcome.report.detail,
        durationMs: Date.now() - startedAt,
        usage: outcome.usage,
      });
    } catch (error) {
      results.push({
        label: sample.label,
        expect: sample.expect,
        actual: 'error',
        ok: false,
        message: error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error),
        failureClass: error !== null && error !== undefined ? error.failureClass : undefined,
        detail: error !== null && error !== undefined ? error.detail : undefined,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const allOk = results.every((row) => row.ok === true);
  const report = {
    mode,
    baseUrl,
    model,
    keyLength: key.length,
    allOk,
    results,
  };

  if (options.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`审核适配器：openai ｜ mode=${mode} ｜ ${baseUrl} ｜ model=${model}`);
    for (const row of results) {
      const mark = row.ok ? '✓' : '✗';
      const verdict = row.actual === 'error' ? `失败（${row.failureClass || 'unknown'}）` : `allowed=${row.actual === 'pass'}`;
      const cost = row.usage === null || row.usage === undefined ? '' : ` ｜ ${row.usage.totalTokens} token`;
      console.log(`${mark} ${row.label}：期望 ${row.expect}，实际 ${row.actual}${row.actual === 'error' ? '' : `（${verdict}）`} ｜ ${row.durationMs}ms${cost}`);
      if (row.detail) console.log(`     ${row.detail}`);
      else if (row.message) console.log(`     ${row.message}`);
    }
    console.log('');
    console.log(allOk
      ? '✅ 结论：密钥可用，四类判定符合预期。现在可以改线上环境变量（见 docs/development/cloud/ai.md 的「恢复第三方审核」）。'
      : '❌ 结论：验证未通过，**不要**切换线上 AI_SAFETY_PROVIDER；先按上面的 detail 修密钥、地址或模型名。');
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ 没跑起来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
