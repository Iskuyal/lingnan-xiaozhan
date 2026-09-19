/**
 * `ai` 云函数的**多模态（vision）路径**冒烟：一张小图经「上传 → 内容安全 → 模型」走完，
 * 把云函数返回的完整结果打出来。文本路径的冒烟是 `npm run smoke:ai`。
 *
 * 为什么必须从小程序端跑：默认内容安全适配器是 `wechat`（云调用），云调用要求调用方带小程序侧票据；
 * 控制台「测试」页、CLI、HTTP 触发都拿不到它（错误码 -501001，见 cloudfunctions/ai/safety.ts）。
 *
 * 为什么用小图而不是真实课表截图：这里只验**链路通不通**（模型能不能在超时预算内回一个 JSON）。
 * 识别准确率要拿真实截图评，见 Ticket 05；真实截图含个人信息，不进仓库。
 *
 * 前置：开发者工具已用
 *   `cli auto --project <仓库>/dist --auto-port 9420 --trust-project`
 *   打开项目；云函数 `ai` 与 `timetable` 已部署、环境变量（模型地址/密钥/模型名、
 *   需要时的 `AI_EXTRA_BODY_JSON`、`AI_TIMEOUT_MS`）已在控制台配好。
 *
 * 用法：`npm run smoke:ai:vision`（端口可用 WECHAT_AUTO_PORT 覆盖，默认 9420）
 *       `npm run smoke:ai:vision -- --bands=auto`：走**分带并行识别**那条路（Ticket 05），
 *       带数由服务端按自己的超时预算算；`--bands=4` 可指定带数。
 *       不带这个参数时是**单次调用**，与 Ticket 01 验收时的原路径一致。
 *       合成小图只验链路，分带会把内容安全检查按带数放大——配额紧张时先跑单次。
 *
 * 退出码：0 = vision 成功（`ok: true` 且 `text` 非空）；
 *         1 = 云函数调用没跑通（未部署 / 权限 / 网络）；
 *         2 = 云函数返回失败（模型超时、模型名不对、内容安全被拒等，返回里写明了原因）。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

/** 分带方式：`--bands=auto` / `--bands=4`，没有该参数时不下发 `bands`（服务端按单带处理）。 */
function bandsOption() {
  const fromArgv = process.argv.find((arg) => arg.startsWith('--bands='));
  const raw = fromArgv === undefined ? process.env.VISION_BANDS : fromArgv.slice('--bands='.length);
  if (raw === undefined || String(raw).trim() === '') return undefined;
  const text = String(raw).trim();
  if (text === 'auto') return 'auto';
  const count = Number(text);
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined;
}

/** 内联的小图（96×32 白底，写着「周一 1-2 高等数学」）：只验证链路，不评估识别质量。 */
const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAYAAADtwH1UAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAF1SURBVGhD7ZIBjsMwCATz/0/fqVGJNhOwieorOYmRkMOyxrXp9tOUslFovksPoJgeQDE9gGJ6AMX0AIrpARQTDmDbtmn8d2Z38OqeRuhhbuzvSNGINhmz+tPgn2cU0R5Po3+0eoQVbprlq7jT13uEVYwelt+ENeam7cGCoYcytL4S7T+DPuYRvAvvNWLkYS/tGWn7euoi8LBZvopsX/qYR0Q+T+fDeUGoR9+HRsHgQV78BezLM72zmY9gn6inx8xjdfZTnVyVN55Z4WGZyJD1GXf9WfjbR2F+3TtalavyRjcxtL6aO33verMxY+TxaqZp7ThPfCe8TSN9Fdm+WZ+R9ev9shH5vZ7kqryZNfaafQrPGMHfNNujde5jTWEeaS/u9nnhqpFZyXieRPZxWPM05goHapqup9pFcEyKHTDzPQ0+MkP1CPq9mua6Uj/yU9Z8nR5AMT2AYnoAxfQAiukBFNMDKKYHUEwPoJgeQDE9gGJ6AMX8Alv5kNqQmezMAAAAAElFTkSuQmCC';

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const bands = bandsOption();
  const mini = await connectMini();
  try {
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 长任务不能挂在一次 evaluate 里等：开发者工具对单次调用的响应有超时，
    // 这里先启动、把结果写进本地 storage，再轮询读回来。
    // 提示词与客户端 services/timetable/photo.ts 的 VISION_SYSTEM 同构（只取链路所需的字段），
    // 且必须写成字面量——evaluate 的函数体在模拟器里执行，取不到外层变量。
    await mini.evaluate(
      (base64, bands) =>
        new Promise((resolve) => {
          const write = (payload) => {
            try {
              wx.setStorageSync('vision-smoke', payload);
            } catch (error) {
              // 写不进去由下面的轮询超时暴露。
            }
          };
          wx.removeStorageSync('vision-smoke');
          resolve('started');
          const filePath = wx.env.USER_DATA_PATH + '/vision-smoke.png';
          try {
            wx.getFileSystemManager().writeFileSync(filePath, base64, 'base64');
          } catch (error) {
            write({ stage: 'write', err: (error && (error.errMsg || error.message)) || String(error) });
            return;
          }
          wx.cloud
            .callFunction({ name: 'timetable', data: { action: 'preparePhotoUpload', fileName: '课表截图.png' } })
            .then((prep) => {
              const cloudPath = prep && prep.result && prep.result.cloudPath;
              if (!cloudPath) {
                write({ stage: 'prepare', err: JSON.stringify(prep && prep.result) });
                return;
              }
              wx.cloud
                .uploadFile({ cloudPath, filePath })
                .then((up) => {
                  // 事件在模拟器里组装：`bands` 有值才下发，没有就是服务端的单带原路径。
                  const event = {
                    action: 'vision',
                    feature: 'vision-smoke',
                    system: '你是课表截图识别器。识别图片中的课程表，只输出一个 JSON 对象，不要输出任何解释或多余文字。JSON 结构：{"courses":[{"name":"课程名","teacher":"教师","weekday":1到7,"startSection":1到12,"endSection":1到12,"weekText":"周次原文"}]}。纪律：识别不出的字段一律留空或留 0，绝不编造。',
                    messages: [{ role: 'user', text: '请识别这张课表截图，按系统提示的 JSON 结构输出。' }],
                    image: { fileID: up.fileID },
                    maxTokens: 512,
                  };
                  if (bands !== undefined) event.bands = bands;
                  wx.cloud
                    .callFunction({
                      name: 'ai',
                      data: event,
                    })
                    .then((res) =>
                      wx.cloud
                        .callFunction({ name: 'timetable', data: { action: 'discardUpload', fileID: up.fileID } })
                        .catch(() => undefined)
                        .then(() => write({ stage: 'vision', fileID: up.fileID, result: res.result })),
                    )
                    .catch((error) =>
                      wx.cloud
                        .callFunction({ name: 'timetable', data: { action: 'discardUpload', fileID: up.fileID } })
                        .catch(() => undefined)
                        .then(() =>
                          write({ stage: 'vision-call', fileID: up.fileID, err: (error && (error.errMsg || error.message)) || String(error) }),
                        ),
                    );
                })
                .catch((error) => write({ stage: 'upload', cloudPath, err: (error && (error.errMsg || error.message)) || String(error) }));
            })
            .catch((error) => write({ stage: 'prepare-call', err: (error && (error.errMsg || error.message)) || String(error) }));
        }),
      SAMPLE_PNG_BASE64,
      bands,
    );

    // vision 在超时预算内本应几秒返回；等满 90 秒仍没有结果就是链路问题（不是慢）。
    let parsed = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const raw = await mini.evaluate(() => JSON.stringify(wx.getStorageSync('vision-smoke') || null));
      const value = JSON.parse(raw);
      if (value != null) {
        parsed = value;
        break;
      }
    }

    const system = await mini.systemInfo();
    const report = {
      smokeAt: new Date().toISOString(),
      platform: system.platform,
      SDKVersion: system.SDKVersion,
      realDevice: false,
      request: { action: 'vision', feature: 'vision-smoke', image: '内联小图 96×32（合成）', bands: bands === undefined ? '（未下发，单带）' : bands },
      response: parsed === null ? { ok: false, failureClass: 'no-response', message: '轮询 90 秒仍未拿到结果' } : parsed,
    };
    writeFileSync(path.join(output, 'ai-vision-smoke.json'), JSON.stringify(report, null, 2));

    if (parsed === null) {
      console.error('❌ 90 秒内没有拿到任何结果：先看云函数是否部署、timetable 的 preparePhotoUpload 是否可用');
      console.error(`   记录已写入 ${path.relative(process.cwd(), path.join(output, 'ai-vision-smoke.json'))}`);
      process.exitCode = 1;
      return;
    }

    if (parsed.stage !== 'vision') {
      console.error(`❌ 没走到 vision 这一步，卡在：${parsed.stage}`);
      console.error(`   ${String(parsed.err).slice(0, 500)}`);
      console.error(`   记录已写入 ${path.relative(process.cwd(), path.join(output, 'ai-vision-smoke.json'))}`);
      process.exitCode = 1;
      return;
    }

    const result = parsed.result || {};
    console.log('');
    console.log(`ok=${result.ok} failureClass=${result.failureClass || '(空)'} elapsedMs=${result.elapsedMs}`);
    console.log(`provider=${result.provider || '(空)'} model=${result.model || '(空)'} bands=${bands === undefined ? '（未下发，单带）' : bands}`);
    if (result.message) console.log(`失败文案：${result.message}`);
    if (result.detail) console.log(`细节：${String(result.detail).slice(0, 500)}`);
    if (result.safety) console.log(`内容安全：provider=${result.safety.provider} checked=${result.safety.checked} passed=${result.safety.passed}｜${result.safety.detail}`);
    if (result.usage) console.log(`本次用量：${result.usage.totalTokens} token（prompt ${result.usage.promptTokens} / completion ${result.usage.completionTokens}）/ ${result.usage.costYuan} 元（estimated=${result.usage.estimated}）`);
    if (result.text) console.log(`模型输出（前 400 字）：${String(result.text).slice(0, 400)}`);
    if (Array.isArray(result.warnings) && result.warnings.length > 0) console.log(`告警：${result.warnings.join('｜')}`);
    console.log('');
    console.log(`记录已写入 ${path.relative(process.cwd(), path.join(output, 'ai-vision-smoke.json'))}`);

    if (result.ok !== true) {
      console.error('');
      console.error('❌ vision 没有成功：先看上面的失败文案与细节（模型超时 / 模型名不支持图片 / 内容安全被拒都会写在这里）');
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
