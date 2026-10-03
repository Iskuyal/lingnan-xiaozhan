/**
 * 升学问答模型版的模拟器端到端检查（Issue #94 M1：提问 → 澄清 → 模型解释与引用 / 拒答 → 失败降级）。
 *
 * 与 `tests/advancement-model.test.cjs` 的分工：那边用 vm + 桩验证行为契约（不联网、不花钱），
 * 这边在**真实小程序 + 真实云函数**上跑一遍，确认页面接线、真实模型回答与引用卡片能对得上。
 *
 * 前置：`cli.bat auto --project <仓库>/dist --auto-port 9420 --trust-project` 已打开；
 * `ai` 已部署；当日内容安全配额与个人额度有余量。
 *
 * 用法：`npm run verify:advancement-model`（端口可用 WECHAT_AUTO_PORT 覆盖）
 * 产出：`artifacts/verify/advancement-model-ui-<时间戳>.json` 与若干 PNG 截图。
 * 退出码：0 = 全部通过；1 = 未跑起来；2 = 有断言不通过。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectMini } = require('./lib/mini-connect.cjs');
const { waitForInitialExample } = require('./lib/advancement-bootstrap.cjs');

const MODEL_WAIT_MS = 45000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从今天的逐题评测记录里取一条**真实服务端响应**（同一天、同一个已部署版本）。
 *
 * 用途：当日个人额度用尽后，现场再调一次模型会被服务端按额度拒绝；这时把当天真实返回
 * （模型解释 + 引用 + 出处校验结论）回放进模拟器，验证的是**页面对真实响应形状的渲染**，
 * 与「现场再调一次模型」区分开记录（`source: 'replay'` vs `'live'`）。
 */
function recordedResponse() {
  const verifier = require(path.resolve('dist/cloudfunctions/ai/advancement.js'));
  const buildHashes = Object.fromEntries(['index.js', 'advancement.js', 'advancement-corpus.js'].map((file) => [file,
    createHash('sha256').update(fs.readFileSync(path.resolve('dist/cloudfunctions/ai', file))).digest('hex')]));
  const dir = path.resolve('artifacts/verify');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith('advancement-model-') && name.endsWith('.jsonl'))
    .sort()
    .reverse();
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const call = record.modelCall;
      if (!call || call.ok !== true || !call.advancement || call.advancement.refused !== false || call.advancement.verified !== true) continue;
      if (record.id !== 'n01' && record.id !== 'q01') continue;
      // 旧版响应不得冒充当前构建的回放；同语料版本不等于同代码版本。
      let recordedHashes;
      try { recordedHashes = JSON.parse(record.fingerprint)[1]; } catch { continue; }
      if (JSON.stringify(recordedHashes) !== JSON.stringify(buildHashes)) continue;
      if (verifier.verifyAdvancementAnswer(call.text, call.advancement.sources).violations.length > 0) continue;
      return {
        file,
        response: {
          ok: true,
          action: 'chat',
          failureClass: '',
          message: '',
          detail: '',
          feature: 'advancement-qa',
          provider: 'openai',
          model: call.model,
          text: call.text,
          safety: call.safety,
          usage: call.usage,
          usageSummary: null,
          capWarning: call.capWarning,
          warnings: call.warnings,
          citations: [],
          advancement: call.advancement,
          probe: null,
          elapsedMs: call.elapsedMs,
        },
      };
    }
  }
  return null;
}

/** 等页面进入某个 modelPhase（模型回答要等真实云函数返回）。 */
async function waitPhase(page, phase, timeoutMs = MODEL_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await page.data('modelPhase');
    if (current === phase) return current;
    if (phase === 'ready' && (current === 'fallback' || current === 'refused')) throw new Error(`模型未生成可核对回答，进入 ${current}`);
    if (Date.now() > deadline) throw new Error(`等待 modelPhase=${phase} 超时，当前 ${current}`);
    await page.waitFor(300);
  }
}

async function run() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outDir = path.resolve('artifacts/verify');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), checks: [], shots: [], passed: false };
  const shots = [];
  const shot = async (mini, name) => {
    const file = path.join(outDir, `advancement-model-${name}.png`);
    await mini.screenshot({ path: file });
    shots.push({ name, file: path.relative(process.cwd(), file) });
  };
  let mini = null;
  let exitCode = 0;
  try {
    mini = await connectMini();
    const system = await mini.systemInfo();
    report.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion };
    await mini.reLaunch('/pages/advancement/index');
    await sleep(2000);
    const page = await mini.currentPage();
    report.route = page.path;
    report.initialExamplePhase = await waitForInitialExample(page);

    const ask = async (text) => {
      await (await page.$('#qa-input')).input(text);
      await (await page.$('#qa-ask')).tap();
      await page.waitFor(400);
    };

    // 1) 真实模型解释 + 引用卡片（现场调用一次模型；当日额度用尽时回放当天真实响应，
    //    两种情况分开记录：live = 现场调用，replay = 回放已部署版本的真实返回）
    await ask('2026年广东普通专升本网上缴费截止到什么时候？');
    let live = true;
    try {
      await waitPhase(page, 'ready', 30000);
    } catch {
      live = false;
    }
    let liveNote = '';
    if (!live) {
      liveNote = String(await page.data('modelNote'));
      report.checks.push({
        id: 'M0',
        name: '现场调用未拿到模型解释时的降级（如实记录原因）',
        phase: await page.data('modelPhase'),
        note: liveNote,
        pass: (await page.data('modelPhase')) === 'fallback',
      });
      await shot(mini, '01a-quota-fallback');
      if (process.argv.includes('--require-live')) throw new Error(`本轮要求现场模型响应，实际未取得：${liveNote}`);
      const replay = recordedResponse();
      if (replay === null) throw new Error('没有可回放的真实响应记录，无法验证模型解释的渲染');
      await mini.evaluate((serialized) => {
        globalThis.__advOriginalCallFunction = wx.cloud.callFunction;
        const payload = JSON.parse(serialized);
        wx.cloud.callFunction = () => Promise.resolve({ result: payload });
      }, JSON.stringify(replay.response));
      await (await page.$('#qa-retry')).tap();
      await waitPhase(page, 'ready', 15000);
      report.replayFrom = replay.file;
      // 回放用完立刻复原真实调用：后面的降级检查要针对真实函数做替换/还原。
      await mini.evaluate(() => {
        if (globalThis.__advOriginalCallFunction) wx.cloud.callFunction = globalThis.__advOriginalCallFunction;
        delete globalThis.__advOriginalCallFunction;
      });
    }
    const answerText = await page.data('modelText');
    const label = await page.data('modelLabel');
    const result = await page.data('result');
    const citations = result.citations;
    if (!answerText || answerText.trim() === '') throw new Error('模型解释为空');
    if (!label.includes('AI 解释')) throw new Error(`标签不是 AI 解释：${label}`);
    if (citations.length === 0) throw new Error('没有出处卡片');
    // 模型回答里出现的 [S1] 必须能在出处卡片编号里找到（引用编号与卡片一一对应）。
    const markers = [...String(answerText).matchAll(/\[S(\d+)\]/gu)].map((match) => Number(match[1]));
    if (markers.length === 0) throw new Error(`模型解释没有出处标记：${answerText}`);
    for (const marker of markers) {
      if (marker < 1 || marker > citations.length) throw new Error(`出处标记 [S${marker}] 没有对应的卡片`);
    }
    // 上下文安全的结论要能上屏说明（服务端 checked=true 时是「内容安全已检测」）。
    const note = await page.data('modelNote');
    if (!String(note).includes('内容安全')) throw new Error(`说明里没有内容安全结论：${note}`);
    report.checks.push({
      id: 'M1',
      name: live ? '事实题：现场真实模型解释 + 出处标记与卡片一一对应' : '事实题：回放当天真实响应，出处标记与卡片一一对应',
      source: live ? 'live' : 'replay',
      liveDegradeNote: liveNote,
      modelText: answerText,
      label,
      note,
      citations: citations.map((citation) => ({ passageId: citation.passageId, title: citation.title, documentNumber: citation.documentNumber })),
      markers,
      pass: true,
    });
    await shot(mini, '01-model-answer');

    // 2) 澄清：没有年份/地区时不调用模型，页面只给确认选项
    await ask('普通专升本的加分政策是什么？');
    const clarify = await page.data('result');
    const clarifyPhase = await page.data('modelPhase');
    if (clarify.behavior !== 'clarify') throw new Error(`期望澄清，实际 ${clarify.behavior}`);
    if (clarifyPhase !== 'idle') throw new Error(`澄清态不该有模型内容：modelPhase=${clarifyPhase}`);
    if (clarify.choices.length === 0) throw new Error('澄清没有可点选项');
    report.checks.push({ id: 'M2', name: '缺失年份：先澄清且不调用模型', choices: clarify.choices, pass: true });
    await shot(mini, '02-clarify');

    // 3) 拒答：语料不含的数据给官方入口
    await ask('2026年广东普通专升本录取分数线是多少？');
    const refuse = await page.data('result');
    if (refuse.behavior !== 'refuse') throw new Error(`期望拒答，实际 ${refuse.behavior}`);
    if (refuse.links.length === 0) throw new Error('拒答没有给官方入口');
    if ((await page.data('modelPhase')) !== 'idle') throw new Error('拒答态不该有模型内容');
    report.checks.push({ id: 'M3', name: '语料不含的数据：拒答并给官方入口', links: refuse.links.map((link) => link.label), pass: true });
    await shot(mini, '03-refuse');

    // 4) 失败降级：把页面里的云函数调用临时换掉（模拟传输失败），必须退回原文摘录并可重试
    await mini.evaluate(() => {
      globalThis.__advOriginalCallFunction = wx.cloud.callFunction;
      wx.cloud.callFunction = () => Promise.reject(new Error('mock: 网络不可用'));
    });
    report.mockNote = '降级检查里的传输失败是模拟器内 mock 出来的（不是真实网络故障），真实额度用尽导致的降级见 M0';
    await ask('2026年广东普通专升本网上缴费截止到什么时候？');
    await waitPhase(page, 'fallback', 15000);
    const fallbackText = await page.data('modelText');
    const fallbackNote = await page.data('modelNote');
    const localAnswer = (await page.data('result')).answer;
    if (fallbackText !== localAnswer) throw new Error('降级后展示的必须是本地原文摘录');
    const retryButton = await page.$('#qa-retry');
    if (retryButton === null) throw new Error('降级后缺少重试入口');
    report.checks.push({ id: 'M4', name: '传输失败：降级为原文摘录并给重试入口', note: fallbackNote, pass: true });
    await shot(mini, '04-fallback');
    // 复原真实调用，点重试（真实调用可能因当日额度被拒，两种结果都如实记录）
    await mini.evaluate(() => {
      if (globalThis.__advOriginalCallFunction) wx.cloud.callFunction = globalThis.__advOriginalCallFunction;
    });
    await retryButton.tap();
    await page.waitFor(500);
    const retryPhase = await page.data('modelPhase');
    if (retryPhase === 'loading') {
      try {
        await waitPhase(page, 'ready');
        report.checks.push({ id: 'M4b', name: '重试后拿到真实模型解释', pass: true });
      } catch (error) {
        // 额度用尽等失败时，页面必须仍停在降级态（不是空白也不是原始错误）
        const phase = await page.data('modelPhase');
        const text = await page.data('modelText');
        report.checks.push({
          id: 'M4b',
          name: '重试未拿到模型解释时保持降级态（如实记录）',
          phase,
          note: await page.data('modelNote'),
          keptFallback: phase === 'fallback' && text === localAnswer,
          pass: phase === 'fallback' && text === localAnswer,
        });
      }
    } else {
      report.checks.push({ id: 'M4b', name: `重试未进入加载态（${retryPhase}），按降级态记录`, pass: retryPhase === 'fallback' });
    }
    await shot(mini, '05-after-retry');

    report.shots = shots;
    report.passed = report.checks.every((check) => check.pass !== false);
    if (!report.passed) exitCode = 2;
    console.log('');
    for (const check of report.checks) {
      console.log(`${check.pass === false ? '✖' : '✔'} ${check.id} ${check.name}`);
      if (check.modelText) console.log(`    模型：${check.modelText}`);
      if (check.note && check.id === 'M4') console.log(`    说明：${check.note}`);
    }
    for (const item of shots) console.log(`截图：${item.file}`);
  } catch (error) {
    report.error = error === null || error === undefined ? String(error) : error.message || String(error);
    console.error(`❌ 未能完成：${report.error}`);
    exitCode = 1;
  } finally {
    if (mini) mini.disconnect();
    report.finishedAt = new Date().toISOString();
    const file = path.join(outDir, `advancement-model-ui-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`记录：${path.relative(process.cwd(), file)}`);
  }
  process.exitCode = exitCode;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
