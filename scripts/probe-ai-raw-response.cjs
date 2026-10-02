/**
 * 直接读回 `ai` 云函数对一条真实请求的**原始返回**（不经过页面文案映射）。
 *
 * 为什么需要：页面把 `failureClass` 映射成用户文案（例如 `internal` → 「AI 服务内部错误，请稍后重试。」），
 * 排查「是模型调用失败、还是本地校验拦下、还是配额」时看文案会误判，必须看原始
 * `failureClass` / `detail`。本脚本从**小程序端**发调用（云调用才拿得到内容安全凭证，
 * 控制台 / CLI / HTTP 触发必然 `-501001`，见 docs/development/cloud/ai.md）。
 *
 * 两种模式：
 *   - 直发模式：自己拼 `{action, feature, messages, ...}`。适合只读动作与形状简单的调用。
 *   - 页面模式（`--route`）：在真实页面上把 `wx.cloud.callFunction` 包一层，用页面自己的交互
 *     触发请求。请求形状由页面构造，不在这里复制一遍——升学 / 答辩这类要 `scope`、`passageIds`、
 *     `materialId` 的调用只能这样拿到**真实**请求体。
 *
 * 前置：`"<微信开发者工具目录>\cli.bat" auto --project <仓库>/dist --auto-port 9420 --trust-project` 已打开；
 * 端口用 `WECHAT_AUTO_PORT` 覆盖（`cli auto` 在端口被占用时会自动换端口，输出里的 `autoPort` 才是真实端口）。
 *
 * 用法：
 *   node scripts/probe-ai-raw-response.cjs --payload='{"action":"usage"}'
 *   node scripts/probe-ai-raw-response.cjs --feature=project-defense --material-id=FC-1 --text="……"
 *   node scripts/probe-ai-raw-response.cjs --route=pages/advancement/index --input=#qa-input --submit=#qa-ask \
 *     --text="2026年广东普通专升本网上缴费截止到什么时候？" --wait=30000
 *
 * 产出：stdout 打印原始记录；`--out=<文件>` 时同时写入 JSON。
 * 退出码：0 = 拿到了原始返回；1 = 没跑起来（桥不通 / 参数错）。
 */
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { connectMini } = require('./lib/mini-connect.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析 `--k=v` / `--flag`；只支持这两种形状，免得引号在各 shell 里不一致。 */
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

/** 页面模式：请求体由页面构造，这里只负责触发与截获。 */
async function runPageMode(options) {
  const mini = await connectMini();
  const record = { mode: 'page', route: options.route, startedAt: new Date().toISOString(), steps: [], calls: [] };
  /** 每一步都留痕：页面模式里失败点常常只在 automator 的原始错误里，不记就查不出是哪一步。 */
  const step = async (name, work) => {
    try {
      const value = await work();
      record.steps.push({ name, ok: true });
      return value;
    } catch (error) {
      record.steps.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  try {
    // 连上后先读一次 currentPage 热身、并等 app 启动完再 reLaunch：连上≠app 就绪，
    // 立刻 reLaunch 会偶发 `Uncaught [object Object]`（同一页面前后两次一次失败一次成功，
    // 属工具侧时序，不是页面报错）。仍失败时重试，次数与结果都记进 steps。
    await step('warmUp', () => mini.currentPage());
    await sleep(2000);
    // reLaunch 偶发失败：最多试 3 次，每次之间给工具侧喘口气；失败明细留在 steps 里。
    let launched = false;
    for (let attempt = 1; attempt <= 3 && !launched; attempt += 1) {
      try {
        await mini.reLaunch(options.route);
        launched = true;
        record.steps.push({ name: `reLaunch#${attempt}`, ok: true });
      } catch (error) {
        record.steps.push({ name: `reLaunch#${attempt}`, ok: false, error: error instanceof Error ? error.message : String(error) });
        await sleep(2000);
      }
    }
    if (!launched) throw new Error(`reLaunch 重试 3 次仍失败：${options.route}`);
    await sleep(2000);
    const system = await step('systemInfo', () => mini.systemInfo());
    record.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion };

    // 包一层 callFunction：原样转发，只把请求与原始 result 记到页面上下文里。
    // 用 bind 固定原始实现，不用 `.call(this, …)`：automator 的 evaluate 上下文里
    // `this` 不保证是 `wx.cloud`，转发时依赖 `this` 会抛错。
    await step('wrap', () => mini.evaluate(() => {
      globalThis.__rawCalls = [];
      const original = wx.cloud.callFunction.bind(wx.cloud);
      wx.cloud.callFunction = (callOptions) => original(callOptions).then((response) => {
        globalThis.__rawCalls.push({
          at: new Date().toISOString(),
          request: callOptions && callOptions.data ? callOptions.data : null,
          result: response && response.result ? response.result : null,
        });
        return response;
      });
    }));

    const page = await step('currentPage', () => mini.currentPage());
    if (typeof options.text === 'string' && typeof options.input === 'string') {
      const input = await step('findInput', () => page.$(options.input));
      if (input === null) throw new Error(`找不到输入框 ${options.input}`);
      await step('input', () => input.input(options.text));
    }
    if (typeof options.submit === 'string') {
      const submit = await step('findSubmit', () => page.$(options.submit));
      if (submit === null) throw new Error(`找不到提交按钮 ${options.submit}`);
      await step('tap', () => submit.tap());
    }
    await sleep(Number(options.wait ?? 30000));
    record.calls = await step('readCalls', () => mini.evaluate(() => globalThis.__rawCalls || []));
    return { mini, record };
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    return { mini, record };
  }
}

/** 直发模式：自己拼 payload。 */
async function runDirectMode(payload) {
  const mini = await connectMini();
  try {
    // 先热身再 reLaunch：连上≠app 就绪。直发模式原来缺这一步，会在
    // `wx.cloud.callFunction` 上偶发 `timeout waiting for automator response`
    // （同一条命令手工分步执行就能过，属工具侧时序）。这里补上并加重试。
    await mini.currentPage().catch(() => undefined);
    await sleep(2000);
    let launched = false;
    for (let attempt = 1; attempt <= 3 && !launched; attempt += 1) {
      try {
        await mini.reLaunch('/pages/home/index');
        launched = true;
      } catch {
        await sleep(2000);
      }
    }
    if (!launched) throw new Error('reLaunch 重试 3 次仍失败');
    // app 初始化与云环境就绪需要时间；太早发调用会拿不到响应。
    await sleep(3000);
    const startedAt = Date.now();
    // **不要在 evaluate 里 await 云调用**：内容安全换成第三方审核后单次调用变长，
    // automator 的 evaluate 会先超时，表现为 `timeout waiting for automator response`
    // ——看起来像桥坏了，其实是等得不够。改成「先发出去、结果挂 globalThis、再轮询」。
    await mini.evaluate((data) => {
      globalThis.__rawResult = null;
      globalThis.__rawError = null;
      wx.cloud.callFunction({ name: 'ai', data })
        .then((response) => { globalThis.__rawResult = response && response.result ? response.result : null; })
        .catch((error) => { globalThis.__rawError = String(error && error.message ? error.message : error); });
      return true;
    }, payload);
    const deadline = Date.now() + 120000;
    let result = null;
    let callError = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const snapshot = await mini.evaluate(() => ({ result: globalThis.__rawResult, error: globalThis.__rawError }));
      result = snapshot.result;
      callError = snapshot.error;
      if (result !== null || callError !== null) break;
    }
    if (result === null && callError === null) throw new Error('轮询 120 秒仍未拿到云函数返回');
    if (callError !== null) throw new Error(callError);
    return {
      mini,
      record: { mode: 'direct', requestedAt: new Date().toISOString(), request: payload, elapsedMs: Date.now() - startedAt, result },
    };
  } catch (error) {
    return { mini, record: { mode: 'direct', request: payload, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let handle;
  if (typeof options.route === 'string') {
    handle = await runPageMode(options);
  } else if (typeof options.payload === 'string') {
    handle = await runDirectMode(JSON.parse(options.payload));
  } else if (typeof options.text === 'string') {
    const payload = { action: 'chat', feature: options.feature || '', messages: [{ role: 'user', text: options.text }] };
    if (typeof options['material-id'] === 'string') payload.materialId = options['material-id'];
    handle = await runDirectMode(payload);
  } else {
    console.error('用法见文件头注释：需要 --route=<页面> 或 --payload=<JSON> 或 --feature=<feature> --text="<问题>"');
    process.exit(1);
  }

  const { mini, record } = handle;
  mini.disconnect();
  console.log(JSON.stringify(record, null, 2));
  if (typeof options.out === 'string') {
    const file = path.resolve(options.out);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.error(`已写入 ${file}`);
  }
  if (record.error) process.exit(1);
}

main().catch((error) => {
  console.error(`❌ 没跑起来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
