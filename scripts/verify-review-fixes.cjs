// 2026-09-30 审查修复的开发者工具验收。不调用模型，不上传/保存云端业务数据。
// 临时合成目标日测试结束后恢复原本机存储，历史截图不覆盖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectMini } = require('./lib/mini-connect.cjs');

const output = path.resolve('docs/evidence/review-fixes-2026-09-30');
const checks = [];
const screenshots = [];
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  let originalGoals;
  let backedUp = false;
  const mocks = new Set();
  const report = { verifiedAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: '审查修复补丁未提交时验证，最终提交引用本记录', realDevice: false, checks, screenshots, result: 'running' };
  const shot = async (name) => { await mini.screenshot({ path: path.join(output, `${name}.png`) }); screenshots.push(`${name}.png`); };
  const open = async (route) => {
    // 编译缓存刚清理时工具可能尚未注册 webview，等导航元数据就绪后再操作。
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        await mini.reLaunch(`/${route}`);
        const page = await mini.currentPage();
        if (page && page.path === route) { await page.waitFor(300); return page; }
      } catch (error) {
        if (!/rawPath|getPageMetaByWebviewId/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`等待页面导航超时：${route}`);
  };
  const pick = async (page, text) => {
    const choices = await page.$$('.qa-choice');
    for (const choice of choices) if ((await choice.text()).trim() === text) { await choice.tap(); await page.waitFor(100); return; }
    throw new Error(`页面缺少澄清选项：${text}`);
  };
  const ask = async (page, text) => { await (await page.$('#qa-input')).input(text); await (await page.$('#qa-ask')).tap(); await page.waitFor(100); };
  try {
    originalGoals = await mini.evaluate(() => wx.getStorageSync('goal-days/v1'));
    backedUp = true;
    await mini.evaluate(() => wx.setStorageSync('goal-days/v1', '[]'));

    const qa = await open('pages/advancement/index');
    for (const question of ['2026年广东中职学校应届毕业生想报三二分段，报名时间是什么时候？', '2027专升本什么时候报名？', '2026年湖南普通专升本什么时候报名？']) {
      await ask(qa, question);
      assert.equal((await qa.data('result')).behavior, 'refuse');
      assert.equal((await qa.data('result')).citations.length, 0);
    }
    checks.push('S1/S2：年份简写、异省和中职自然长句拒答、无错误引用'); await shot('01-qa-region-refusal');
    await ask(qa, '普通专升本什么时候报名？');
    assert.equal((await qa.data('result')).behavior, 'clarify'); await shot('02-qa-scope-confirm');
    await pick(qa, '2026 年广东省');
    assert.equal((await qa.data('result')).behavior, 'answer');
    checks.push('S1：年份地区不明先确认，选择 2026 年广东省后给原文出处');

    const comparison = '专升本和三二分段报名日期是什么？';
    await ask(qa, comparison);
    await pick(qa, '普通专升本（专科毕业生统考）');
    assert.equal((await qa.data('result')).behavior, 'clarify', '新题必须重新确认年份地区');
    await pick(qa, '2026 年广东省');
    assert.equal((await qa.data('result')).behavior, 'answer');
    assert.equal(await qa.data('asked'), comparison);
    checks.push('S2：比较题逐步确认后可回答，原问题不拼接、新题不沿用范围'); await shot('03-qa-cited');
    await ask(qa, '三二分段报名是1月12日开始吗？');
    await pick(qa, '中高职贯通三二分段（中职升高职）');
    assert.equal((await qa.data('result')).behavior, 'refuse');
    checks.push('S2：选择未收录的中职升高职明确拒答，不混入专升本转段'); await shot('04-qa-category-refusal');

    const fitness = await open('pages/fitness/index');
    const values = { '#fit-height': '175', '#fit-weight': '80', '#fit-vital': '4300', '#fit-sprint': '7', '#fit-sit': '17.7', '#fit-jump': '248', '#fit-strength': '15', '#fit-run': '3:42' };
    for (const [selector, value] of Object.entries(values)) await (await fitness.$(selector)).input(value);
    await (await fitness.$('#fit-calc')).tap();
    await fitness.waitFor(500);
    assert.equal(await (await fitness.$('.fit-total')).text(), '81');
    assert.equal(await (await fitness.$('.fit-grade')).text(), '良好');
    assert.equal((await fitness.data('result')).items[0].score, 80);
    checks.push('R1：BMI 26.1 计 80 分，七项完整总分 81、等级良好');
    const summaryOffset = await (await fitness.$('.fit-summary')).offset();
    await mini.pageScrollTo(Math.max(0, summaryOffset.top - 80)); await fitness.waitFor(300); await shot('05-fitness-bmi-total');
    await mini.pageScrollTo(0);
    await (await fitness.$('#fit-vital')).input('');
    await (await fitness.$('#fit-calc')).tap();
    await fitness.waitFor(300);
    assert.equal((await fitness.data('result')).total, null);
    assert.deepEqual((await fitness.data('result')).missing, ['肺活量']);
    checks.push('R1：清空肺活量仅缺肺活量，BMI 不再被误列无分');

    let edit = await open('pages/goals/edit/index');
    await edit.callMethod('onNameInput', { detail: { value: '修复验收合成目标' } });
    const doubled = await mini.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      page.save(); page.save();
      return JSON.parse(wx.getStorageSync('goal-days/v1'));
    });
    assert.equal(doubled.length, 1); await edit.waitFor(700);
    const list = await open('pages/goals/index');
    assert.equal(await list.data('todayCount'), 1);
    checks.push('R5：真实页面连续保存只生成一条目标日，重进列表可读'); await shot('06-goal-reopen');

    edit = await open('pages/goals/edit/index');
    await edit.callMethod('onNameInput', { detail: { value: '读取失败时禁止保存' } });
    await mini.mockWxMethod('getStorageSync', () => { throw new Error('合成读取故障'); }); mocks.add('getStorageSync');
    await mini.mockWxMethod('showModal', () => ({ confirm: true, cancel: false })); mocks.add('showModal');
    await edit.callMethod('save');
    assert.equal(await edit.data('saving'), false);
    await mini.restoreWxMethod('getStorageSync'); mocks.delete('getStorageSync');
    await mini.restoreWxMethod('showModal'); mocks.delete('showModal');
    const afterFailedRead = await mini.evaluate(() => JSON.parse(wx.getStorageSync('goal-days/v1')));
    assert.deepEqual(afterFailedRead, doubled);
    checks.push('R4：模拟器注入本机读取异常后保存被阻止，旧目标完整保留');
    await edit.callMethod('save'); await edit.waitFor(700);
    const recovered = await mini.evaluate(() => JSON.parse(wx.getStorageSync('goal-days/v1')));
    assert.equal(recovered.length, 2);
    checks.push('R4：读取恢复后可再次保存，不丢失已有目标');

    const calendar = await open('pages/calendar/index');
    assert.equal((await calendar.data('problems')).length, 0);
    checks.push('校历与考试日期卡数据自检仍通过');
    const system = await mini.systemInfo();
    report.platform = system.platform; report.model = system.model; report.SDKVersion = system.SDKVersion;
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.error = error.message; throw error;
  } finally {
    for (const name of mocks) await mini.restoreWxMethod(name);
    if (backedUp) {
      await mini.evaluate((value) => wx.setStorageSync('goal-days/v1', value), originalGoals);
      assert.deepEqual(await mini.evaluate(() => wx.getStorageSync('goal-days/v1')), originalGoals, '验收后必须恢复原目标日');
      report.originalGoalStorageRestored = true;
    }
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    mini.disconnect();
    console.log(JSON.stringify(report, null, 2));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
