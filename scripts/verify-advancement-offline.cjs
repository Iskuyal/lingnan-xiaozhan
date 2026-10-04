/** 停止真实调用后验证模拟器接线。所有云请求都被mock，不能作为真实模型/时延证据。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connectMini } = require('./lib/mini-connect.cjs');
const { waitForInitialExample } = require('./lib/advancement-bootstrap.cjs');
const { advancementBuildHashes } = require('./lib/advancement-build-hashes.cjs');

async function run() {
  const out = path.resolve(process.argv[2] || 'artifacts/advancement-optimization/ui-offline.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const report = { mode: 'simulator_mock_no_cloud', proofBoundary: '真实模拟器页面；模型/网络失败均mock；0次真实云请求，不证明真实模型、真机或8秒门槛', buildHashes: advancementBuildHashes(), checks: [], passed: false };
  const mini = await connectMini();
  try {
    report.env = await mini.systemInfo();
    await mini.evaluate(() => {
      globalThis.__advOfflineOriginal = wx.cloud.callFunction;
      globalThis.__advOfflineCalls = 0;
      wx.cloud.callFunction = () => {
        globalThis.__advOfflineCalls += 1;
        return Promise.resolve({ result: { ok: false, failureClass: 'model_unavailable', message: '模拟模型失败（本轮未调用云端）', text: '', warnings: [], advancement: null, safety: null } });
      };
    });
    await mini.reLaunch('/pages/advancement/index');
    let page = await mini.currentPage();
    await waitForInitialExample(page);
    const ask = async question => {
      await (await page.$('#qa-input')).input(question);
      await (await page.$('#qa-ask')).tap();
      await page.waitFor(400);
      await waitForInitialExample(page);
      return page.data();
    };
    const shot = async name => {
      const file = path.join(path.dirname(out), `${name}.png`);
      await mini.screenshot({ path: file });
      return path.relative(process.cwd(), file).replace(/\\/gu, '/');
    };
    let state = await ask('2026年广东普通专升本计划招生总量是多少万人？');
    assert.equal(state.modelPhase, 'fallback');
    assert.ok(state.modelText.includes('普通专升本计划招生6.5万人'));
    assert.equal(state.result.citations[0].passageId, 'gd-employment-2026#upgrade-plan');
    report.checks.push({ id: 'O1', pass: true, question: state.asked, phase: state.modelPhase, text: state.modelText, screenshot: await shot('ui-offline-cross-topic') });
    const before = await mini.evaluate(() => globalThis.__advOfflineCalls);
    for (const [id, question, behavior] of [
      ['O2', '广东普通专升本志愿怎么填？', 'clarify'],
      ['O3', '2027年北京普通专升本什么时候预报名？', 'refuse'],
      ['O4', '2026年广东实习岗位现在的月薪是多少？', 'refuse'],
    ]) {
      state = await ask(question);
      assert.equal(state.result.behavior, behavior);
      assert.equal(state.modelPhase, 'idle');
      assert.equal(state.modelText, '');
      report.checks.push({ id, pass: true, question, behavior, text: state.result.answer });
    }
    assert.equal(await mini.evaluate(() => globalThis.__advOfflineCalls), before, '守门不得生成模型请求');
    report.checks[3].screenshot = await shot('ui-offline-salary-refuse');
    state = await ask('2026年广东三二分段转段毕业证书怎么标注，毕业后就业办法如何？');
    assert.equal(state.modelPhase, 'fallback');
    assert.ok(state.modelText.includes('复查合格并经注册后'));
    assert.ok(state.modelText.includes('在本校xx专业专科起点本科学习'));
    assert.ok(state.modelText.includes('转段学生毕业后的就业办法'));
    report.checks.push({ id: 'O5', pass: true, phase: state.modelPhase, text: state.modelText, screenshot: await shot('ui-offline-complete-quotes') });
    await mini.evaluate(() => { wx.cloud.callFunction = () => Promise.reject(new Error('模拟传输失败（未发云请求）')); });
    state = await ask('2026年广东普通专升本网上缴费截止时间？');
    assert.equal(state.modelPhase, 'fallback');
    assert.ok(state.modelText.includes('1月23日17:00'));
    report.checks.push({ id: 'O6', pass: true, phase: state.modelPhase, text: state.modelText, note: state.modelNote });
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    await mini.evaluate(() => {
      if (globalThis.__advOfflineOriginal) wx.cloud.callFunction = globalThis.__advOfflineOriginal;
      delete globalThis.__advOfflineOriginal;
      delete globalThis.__advOfflineCalls;
    }).catch(() => undefined);
    // 返回首页防止后续误点重试消耗真实额度。
    await mini.reLaunch('/pages/home/index').catch(() => undefined);
    mini.disconnect();
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`模拟器mock验证 ${report.passed ? '通过' : '失败'}：${report.checks.length}项；真实云请求0次`);
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
