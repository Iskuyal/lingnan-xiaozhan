/**
 * 项目讲解与答辩练习（G4）模拟器端到端：真实页面路径 + 三条失败路径。
 *
 * 对应 [Issue #115](https://github.com/Iskuyal/wx-match/issues/115)。跑的是**已部署的 `ai` 云函数**
 * 与 `dist/` 里的客户端，走真实点击与真实输入，不走 PoC 桩。
 *
 * 阶段（`--phase=`）：
 *   - `happy`：首页入口 → 选材料 → 三轮（每轮一个维度）→ 四节反馈 + 追问 → 复盘 → 重答 → 结束；
 *              并检查「退出后再进会话已清空」。**消耗真实模型额度**。
 *   - `failure`：三条失败路径各一次——① 断网（把 `wx.cloud.callFunction` 换成 reject，**mock**）
 *              ② 额度（真实调用，服务端 `quota_exhausted`）③ 四节不齐（把返回换成三节，**stub**）。
 *              三条都要「保留已写内容」且「不显示上一轮反馈」。**②以外不消耗模型额度**。
 *   - `all`：先 failure 后 happy。
 *
 * 前置：
 *   `"<微信开发者工具目录>\cli.bat" auto --project <仓库>/dist --auto-port 9420 --trust-project` 已打开；
 *   端口用 `WECHAT_AUTO_PORT` 覆盖（`cli auto` 在端口被占用时会**自动换端口**，以它输出的 `autoPort` 为准）。
 *
 * 用法：
 *   WECHAT_AUTO_PORT=9421 node scripts/verify-defense-g4-e2e.cjs --phase=failure --out=docs/evidence/project-defense-g4/e2e-failure.json
 *   WECHAT_AUTO_PORT=9421 node scripts/verify-defense-g4-e2e.cjs --phase=happy   --out=docs/evidence/project-defense-g4/e2e-happy.json
 *
 * 退出码：0 = 本阶段全部断言通过；1 = 没跑起来或至少一条断言不通过（明细在输出的 JSON 里）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { connectMini } = require('./lib/mini-connect.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL_WAIT_MS = 60000;

/** 各轮答案：按 FC-1 的条目编号写，且如实区分「已验证」与「仍待验证」。 */
const ANSWERS = {
  1: '这个功能给需要核对课表的同学用：解决的是把微信里的课表文件导入后看不准的问题。依据 F1，只能从聊天记录里选文件；依据 F4，识别不出的只标记不猜，交给确认页裁决。',
  2: '关键环节是导入、识别、确认三步。按 INV-1 保留原文待核对，按 INV-3 未确认前不写库。我们没做的是自己写死解析规则：F4 已经说明识别不出的要交给人裁决，所以放弃自动纠错。',
  3: '验证过的是导入到确认页这一段链路。F8 的三项仍待验证：服务端越权隔离、100 条以上分页读取、临时文件极端残留——这三项我没有做过验证，不写成已完成。',
  reanswer: '补一处可回核的依据：F2 与 INV-2 说明了导入后字段对齐的规则，我上一轮只说「保留原文」没给编号。F8 的第一项服务端越权隔离仍然没有验证过，我保留为待验证。',
};

/** 三节（缺【追问】）的伪造返回：用来验证「缺节不上屏」。 */
const TRUNCATED_TEXT = '【引用核对】你说到了导入链路，编号 F1、F4 都能在材料里回核。\n【是否对应回答】基本对应第 1 轮问的「给谁、解决什么」。\n【待验证保留】F8 的三项仍未验证。';

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const phase = typeof options.phase === 'string' ? options.phase : 'all';
  const report = { startedAt: new Date().toISOString(), phase, checks: [], calls: [], assertions: [] };
  let failures = 0;

  /** 断言：记进 report，不抛错，让一轮跑完再统一看结果。 */
  const check = (id, name, pass, detail) => {
    report.assertions.push({ id, name, pass: Boolean(pass), detail: detail === undefined ? '' : detail });
    if (!pass) failures += 1;
    console.log(`${pass ? '✅' : '❌'} ${id} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`);
  };

  const mini = await connectMini();
  try {
    // 连上后先热身再 reLaunch：连上≠app 就绪，立刻 reLaunch 会偶发 `Uncaught [object Object]`。
    await mini.evaluate(() => undefined).catch(() => undefined);
    await sleep(1500);
    const system = await mini.systemInfo().catch(() => ({}));
    report.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion, realDevice: system.platform !== 'devtools' };

    /** 进答辩练习页：从首页点入口进去（保持「首页 → 入口」这段也是真走的）。 */
    const enterDefense = async () => {
      await mini.reLaunch('/pages/home/index');
      await sleep(2000);
      const home = await mini.currentPage();
      const entry = await home.$('#defense-entry');
      if (entry === null) throw new Error('首页找不到 #defense-entry');
      await entry.tap();
      await sleep(1500);
      const page = await mini.currentPage();
      if (page.path !== 'pages/defense/index') throw new Error(`没进到答辩练习页：${page.path}`);
      return page;
    };

    /** 提交一轮：输入 → 点提交 → 等到某个 phase 或超时。 */
    const submitRound = async (page, text, waitMs = MODEL_WAIT_MS) => {
      const input = await page.$('.answer-input');
      if (input === null) throw new Error('找不到作答输入框 .answer-input');
      await input.input(text);
      await sleep(300);
      const button = await page.$('.primary');
      if (button === null) throw new Error('找不到提交按钮 .primary');
      const startedAt = Date.now();
      await button.tap();
      await sleep(600);
      let data = await page.data();
      while (data.phase === 'pending' && Date.now() - startedAt < waitMs) {
        await sleep(1000);
        data = await page.data();
      }
      return { data, clientElapsedMs: Date.now() - startedAt };
    };

    // ---------------------------------------------------------------- failure 阶段
    /** 每条失败路径都从**新会话**开始：失败态页面没有输入框，复用同一页会让下一步没处输入。 */
    const freshRound = async () => {
      const page = await enterDefense();
      const materials = await page.$$('.material');
      if (materials.length !== 2) throw new Error(`材料页应有 2 份，实际 ${materials.length} 份`);
      await materials[0].tap();
      await sleep(800);
      return page;
    };

    const runFailurePhase = async () => {
      // ① 断网：把云函数调用换成 reject（**mock**，不是真实网络故障）
      let page = await freshRound();
      await mini.evaluate(() => {
        globalThis.__g4OriginalCallFunction = wx.cloud.callFunction;
        wx.cloud.callFunction = () => Promise.reject(new Error('mock: 网络不可用'));
      });
      let result = await submitRound(page, ANSWERS[1], 20000);
      check('F-1', '断网：进入失败态（不是反馈态）', result.data.phase === 'failure', `phase=${result.data.phase}`);
      check('F-1b', '断网：失败文案说明没发出去', String(result.data.failureTitle).includes('没能发出去'), result.data.failureTitle);
      check('F-1c', '断网：已写内容保留', String(result.data.answer).trim() === ANSWERS[1].trim(), `保留 ${String(result.data.answer).length} 字`);
      check('F-1d', '断网：不显示反馈', (result.data.sections || []).length === 0, `sections=${(result.data.sections || []).length}`);
      check('F-1e', '断网：给得出重试入口', result.data.failureRetryable === true, `retryable=${result.data.failureRetryable}`);
      await mini.evaluate(() => {
        if (globalThis.__g4OriginalCallFunction) wx.cloud.callFunction = globalThis.__g4OriginalCallFunction;
        delete globalThis.__g4OriginalCallFunction;
      });

      // ② 额度：**真实调用**，服务端按 quota_exhausted 拒绝（当日额度用尽时）；额度充足时会正常拿到反馈，两种都如实记录
      page = await freshRound();
      result = await submitRound(page, ANSWERS[1], 40000);
      const quotaHit = result.data.phase === 'failure' && String(result.data.failureTitle).includes('额度');
      check('F-2', '额度：真实调用被服务端拒绝或正常拿到反馈（如实记录）',
        quotaHit || result.data.phase === 'feedback',
        `phase=${result.data.phase}｜title=${result.data.failureTitle}`);
      if (quotaHit) {
        check('F-2b', '额度：文案指向 45009 排障且不可重试',
          String(result.data.failureBody).includes('45009') && result.data.failureRetryable === false,
          `body=${result.data.failureBody}｜retryable=${result.data.failureRetryable}`);
      }
      check('F-2c', '额度：不显示上一轮反馈', (result.data.sections || []).length === 0, `sections=${(result.data.sections || []).length}`);
      check('F-2d', '额度：已写内容保留', String(result.data.answer).trim() === ANSWERS[1].trim(), `保留 ${String(result.data.answer).length} 字`);

      // ③ 四节不齐：把返回换成三节（缺【追问】），必须一个字都不上屏
      page = await freshRound();
      await mini.evaluate((text) => {
        globalThis.__g4OriginalCallFunction = wx.cloud.callFunction;
        wx.cloud.callFunction = () => Promise.resolve({
          result: { ok: true, failureClass: '', text, safety: { provider: 'wechat', checked: true, passed: true }, usage: null },
        });
      }, TRUNCATED_TEXT);
      result = await submitRound(page, ANSWERS[1], 20000);
      check('F-3', '四节不齐：进入失败态', result.data.phase === 'failure', `phase=${result.data.phase}`);
      check('F-3b', '四节不齐：文案说明缺了哪几节', String(result.data.failureTitle).includes('不完整'), result.data.failureTitle);
      check('F-3c', '四节不齐：缺节内容一个字都不上屏', (result.data.sections || []).length === 0, `sections=${(result.data.sections || []).length}`);
      check('F-3d', '四节不齐：回答已保留', String(result.data.answer).trim() === ANSWERS[1].trim(), `保留 ${String(result.data.answer).length} 字`);
      await mini.evaluate(() => {
        if (globalThis.__g4OriginalCallFunction) wx.cloud.callFunction = globalThis.__g4OriginalCallFunction;
        delete globalThis.__g4OriginalCallFunction;
      });
    };

    // ---------------------------------------------------------------- happy 阶段
    const runHappyPhase = async () => {
      // 记录每次真实云调用的请求与原始返回（token / 费用 / 检测结论都从这里来）。
      const page = await enterDefense();
      await mini.evaluate(() => {
        globalThis.__g4Calls = [];
        const original = wx.cloud.callFunction.bind(wx.cloud);
        wx.cloud.callFunction = (callOptions) => {
          const at = Date.now();
          return original(callOptions).then((response) => {
            globalThis.__g4Calls.push({ at, request: callOptions && callOptions.data ? callOptions.data : null, result: response && response.result ? response.result : null });
            return response;
          });
        };
      });

      const materials = await page.$$('.material');
      check('H-0', '材料页列出 2 份材料', materials.length === 2, `实际 ${materials.length} 份`);
      await materials[0].tap();
      await sleep(800);

      const roundResults = [];
      for (const round of [1, 2, 3]) {
        const result = await submitRound(page, ANSWERS[round]);
        roundResults.push({ round, ...result });
        // 第 3 轮提交后页面可能已被推进到复盘（setData 批处理会让 phase 与 sections 出现一帧不一致），
        // 因此「四节已上屏」比 phase 字面更可靠：两者任一成立即算这一轮拿到了反馈。
        const gotFeedback = result.data.phase === 'feedback' || (result.data.sections || []).length === 4;
        check(`H-${round}`, `第 ${round} 轮拿到四节反馈`, gotFeedback, `phase=${result.data.phase}｜sections=${(result.data.sections || []).length}｜${result.data.failureTitle || ''}`);
        const sections = result.data.sections || [];
        check(`H-${round}b`, `第 ${round} 轮四节齐全`, sections.length === 4, sections.map((s) => s.title).join(''));
        check(`H-${round}c`, `第 ${round} 轮有追问`, String(result.data.ask || '').trim() !== '', String(result.data.ask || '').slice(0, 40));
        if (round < 3 && result.data.phase === 'feedback') {
          const next = await page.$('.primary');
          if (next === null) throw new Error(`第 ${round} 轮反馈页找不到「进入下一轮」按钮`);
          await next.tap();
          await sleep(1200);
        }
      }

      // 复盘
      let data = await page.data();
      check('H-R', '三轮后进入复盘', data.phase === 'review', `phase=${data.phase}`);
      const reviewRows = data.reviewRows || [];
      check('H-Rb', '复盘列出三个维度且都有反馈', reviewRows.length === 3 && reviewRows.every((r) => r.status === '已反馈'),
        reviewRows.map((r) => `${r.dimension}:${r.status}`).join('｜'));

      // 重答（额度用尽时这里会落在失败态，如实记录而不中断整轮）
      const reanswerButton = await page.$('.primary');
      if (reanswerButton === null) throw new Error('复盘页找不到「重答一处薄弱项」按钮');
      await reanswerButton.tap();
      await sleep(1000);
      const reanswerResult = await submitRound(page, ANSWERS.reanswer);
      check('H-A', '重答后进入结束态', reanswerResult.data.phase === 'done', `phase=${reanswerResult.data.phase}｜${reanswerResult.data.failureTitle || ''}`);
      check('H-Ab', '重答也有四节反馈', (reanswerResult.data.sections || []).length === 4, String((reanswerResult.data.sections || []).length));
      check('H-Ac', '重答失败时回答已保留（失败不算一轮）',
        reanswerResult.data.phase !== 'failure' || String(reanswerResult.data.answer || '').trim() === ANSWERS.reanswer.trim(),
        `phase=${reanswerResult.data.phase}`);

      report.calls = await mini.evaluate(() => globalThis.__g4Calls || []);
      report.rounds = roundResults.map((r) => ({ round: r.round, phase: r.data.phase, clientElapsedMs: r.clientElapsedMs, ask: r.data.ask, sections: r.data.sections }));

      // 退出后再进：会话已清空
      const homeButton = await page.$('.primary') ?? await page.$('.secondary');
      if (homeButton !== null) {
        await homeButton.tap();
        await sleep(1500);
      }
      const page2 = await enterDefense();
      const fresh = await page2.data();
      check('H-X', '退出后再进：回到材料选择且会话已清空', fresh.phase === 'materials' && String(fresh.answer || '') === '', `phase=${fresh.phase}`);
    };

    // ---------------------------------------------------------------- 等待态与取消
    // 判据来自 G4 清单：「等待态显示『在等什么』与耗时区间；取消后草稿还在，且不产生反馈」。
    const runPendingPhase = async () => {
      const page = await enterDefense();
      const materials = await page.$$('.material');
      await materials[0].tap();
      await sleep(800);
      const input = await page.$('.answer-input');
      if (input === null) throw new Error('找不到作答输入框');
      await input.input(ANSWERS[1]);
      await sleep(300);
      const startedAt = Date.now();
      const submit = await page.$('.primary');
      if (submit === null) throw new Error('找不到提交按钮');
      await submit.tap();
      await sleep(1500);

      let data = await page.data();
      check('P-1', '提交后进入等待态', data.phase === 'pending', `phase=${data.phase}`);

      // 等待态文案：小程序里没有 DOM，用元素 text() 读渲染结果。
      const pendingEl = await page.$('.pending');
      const pendingText = pendingEl === null ? '' : String(await pendingEl.text());
      check('P-2', '等待态说明「在等什么」', pendingText.includes('在等什么'), pendingText.replace(/\s+/gu, ' ').slice(0, 70));
      const rangeMatch = /(\d+)\s*[–\-~]\s*(\d+)\s*秒/u.exec(pendingText);
      check('P-3', '等待态给出耗时区间', rangeMatch !== null, rangeMatch === null ? '(未找到区间文案)' : rangeMatch[0]);

      const firstTick = Number(data.pendingSeconds);
      await sleep(3200);
      data = await page.data();
      check('P-4', '等待秒数在走', Number(data.pendingSeconds) > firstTick, `${firstTick} -> ${data.pendingSeconds}`);

      const secondaries = await page.$$('.secondary');
      check('P-5', '等待态给出取消入口', secondaries.length >= 1, `secondary 按钮 ${secondaries.length} 个`);
      await secondaries[0].tap();
      await sleep(1200);
      data = await page.data();
      report.pendingElapsedMs = Date.now() - startedAt;
      check('P-6', '取消后回到作答态', data.phase === 'practice', `phase=${data.phase}`);
      check('P-7', '取消后草稿还在', String(data.answer).trim() === ANSWERS[1].trim(), `保留 ${String(data.answer).length} 字`);
      check('P-8', '取消后不显示反馈', (data.sections || []).length === 0, `sections=${(data.sections || []).length}`);
      report.pendingRangeCopy = rangeMatch === null ? null : rangeMatch[0];
    };

    // 阶段异常也要把**已经跑到的部分**写进报告：中途抛错时最需要看的就是前面几条断言的结果。
    try {
      if (phase === 'failure' || phase === 'all') await runFailurePhase();
      if (phase === 'pending' || phase === 'all') await runPendingPhase();
      if (phase === 'happy' || phase === 'all') await runHappyPhase();
    } catch (error) {
      report.aborted = error instanceof Error ? error.message : String(error);
      failures += 1;
      console.error(`❌ 阶段中断：${report.aborted}`);
    }
  } finally {
    mini.disconnect();
  }

  report.finishedAt = new Date().toISOString();
  report.passed = failures === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (typeof options.out === 'string') {
    const file = path.resolve(options.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    console.error(`已写入 ${file}`);
  } else {
    console.log(text);
  }
  console.error(`\n${failures === 0 ? '✅ 本阶段全部断言通过' : `❌ ${failures} 条断言不通过`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ 没跑起来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
