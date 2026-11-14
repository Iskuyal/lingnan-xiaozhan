/** 集成候选原生夹具回归：启动前隔离网络/存储，不调用真实模型或写真实课程。 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { connectMini } = require('./lib/mini-connect.cjs');
const { installOfflineUiSession } = require('./lib/offline-ui-session.cjs');
const { fixtures, install, waitForApp } = require('./verify-ui-v2-a.cjs');
const { fixture, installB } = require('./ui-v2-b-native.cjs');
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.WECHAT_AUTO_PORT || '9464';
const OUTPUT = path.resolve(process.env.WECHAT_VERIFY_OUTPUT || 'docs/evidence/lingnan-ui-implementation/integration-2026-11-14/native');
const event = (dataset) => ({ currentTarget: { dataset } });
const input = (value) => ({ detail: { value } });

function prepareProject() {
  const project = path.join(ROOT, '.scratch', `ui-integration-${Date.now()}`);
  fs.cpSync(path.join(ROOT, 'dist'), project, { recursive: true });
  const appFile = path.join(project, 'app.js');
  const guard = `const originalApp = App; App = (definition) => { const launch = definition.onLaunch; definition.onLaunch = function (...args) { if (launch) launch.apply(this,args); (${installOfflineUiSession.toString()})(); }; return originalApp(definition); };\n`;
  fs.writeFileSync(appFile, guard + fs.readFileSync(appFile, 'utf8'));
  const configFile = path.join(project, 'project.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.projectname = 'wx-match-integration';
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(ROOT, '.scratch', 'ui-integration-project.txt'), project);
  console.log(project);
}

async function run() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const report = { date: new Date().toISOString(), git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    mode: 'native_simulator_offline_fixtures', port: Number(PORT), realAiCalls: 0, realCloudWrites: 0,
    boundary: '独立项目在app启动前安装请求/存储隔离；AI和业务全为夹具，不是真机或模型效果验收。', checks: [], screenshots: [] };
  const mini = await connectMini(PORT);
  const check = (name) => report.checks.push({ name, passed: true });
  const open = async (route) => { await mini.reLaunch(route); await new Promise((r) => setTimeout(r, 500)); return mini.currentPage(); };
  const current = async (route) => {
    for (let i = 0; i < 30; i += 1) {
      const page = await mini.currentPage();
      if (page.path === route) { await new Promise((r) => setTimeout(r, 300)); return page; }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('未到目标页面：' + route);
  };
  const shot = async (name) => {
    const file = path.join(OUTPUT, name + '.png');
    await mini.screenshot({ path: file });
    const bytes = fs.readFileSync(file);
    report.screenshots.push({ file: name + '.png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  };
  try {
    await waitForApp(mini);
    assert.equal(await mini.evaluate(() => !!globalThis.__offlineUiSession), true, '项目必须先安装离线隔离');
    report.environment = await mini.systemInfo();
    await install(mini, fixtures());
    let page = await open('/pages/home/index?today=2026-11-11&clock=600');
    assert.equal(await page.data('hero.label'), '下一节课');
    await shot('01-home');
    const ask = await page.$('#ask-entry');
    assert.ok(ask); await ask.tap();
    page = await current('pages/timetable/index');
    assert.equal(await page.data('assistantOpen'), true);
    assert.equal(await page.data('assistantSending'), false);
    assert.equal(await mini.evaluate(() => globalThis.__uiV2A.calls.filter((c) => c.name === 'ai').length), 0);
    check('首页真实点击切课表并打开助手，仅消费一次，不自动请求模型');
    await shot('02-home-to-assistant');
    await page.callMethod('closeAssistant');
    await mini.evaluate(() => wx.switchTab({ url: '/pages/home/index' }));
    await current('pages/home/index');
    await mini.evaluate(() => wx.switchTab({ url: '/pages/timetable/index' }));
    page = await current('pages/timetable/index');
    assert.equal(await page.data('assistantOpen'), false);
    check('tab往返不重放旧助手意图');

    page = await open('/pages/home/index?today=2026-11-14&clock=600');
    assert.equal(await page.data('hero.title'), '今天没有课');
    await shot('03-home-no-classes');
    check('已有课表的无课日不会引导重新导入');
    page = await open('/pages/home/index?today=2026-11-11&clock=600');
    await (await page.$('#hero-card')).tap();
    page = await current('pages/timetable/edit/index');
    assert.equal(await page.data('scope'), 'saved');
    assert.equal(await page.data('form.name'), 'Java 程序设计（布局示例）');
    check('首页点课程进入已有课程编辑，而非新增');
    await shot('04-home-course-edit');

    page = await open('/pages/goals/plan/index?today=2026-11-11');
    await mini.evaluate(async () => {
      const p = getCurrentPages().slice(-1)[0];
      p.pickGoal({ id: 'mock-goal', name: '英语四级考试', date: '2026-12-19' });
      p.showRules();
      p.onRuleMinutes({ currentTarget: { dataset: { value: 30 } } });
      p.onRuleBlocks({ currentTarget: { dataset: { value: 2 } } });
      p.onRuleWeekday({ currentTarget: { dataset: { value: 4 } } });
      await p.generateRules();
      p.onVariant();
    });
    assert.equal(await page.data('plan.weeklyCount'), 2);
    const blocks = await page.data('plan.blocks');
    assert.ok(blocks.length > 0 && blocks.every((b) => b.minutes <= 30 && b.weekday !== 4));
    check('基础规则换排法仍保持时长、频次和不可用星期');
    await mini.pageScrollTo(0); await shot('05-rule-preview');
    await page.callMethod('onSave');
    await page.callMethod('onViewWeek');
    page = await current('pages/timetable/index');
    assert.equal(await page.data('week'), 8);
    check('保存计划跨tab到对应日历周，计划独立于正式课程');
    await shot('06-plan-to-week');

    await installB(mini, fixture());
    page = await open('/pages/timetable/index?today=2026-11-11&clock=10:00');
    await page.callMethod('openAssistant'); await page.callMethod('toggleNotice');
    await page.callMethod('onNoticeInput', input('第11周Java程序设计调到周五5-6节，地点改为博雅楼A302，其余周次不变'));
    await page.callMethod('readNotice');
    assert.ok(await page.data('noticeProposal'));
    await page.callMethod('applyNotice');
    await mini.evaluate(() => getCurrentPages().slice(-1)[0].clearUndoTimer());
    report.undoTimerFixture = '拍摄结果期间暂停撤销计时，不用于验证10秒截止边界';
    assert.equal(await page.data('week'), 11);
    await shot('07-notice-saved');
    await page.callMethod('undoNotice');
    check('限定周次调课应用后定位第11周，并支持整项撤销');
    await shot('08-notice-undo');

    await mini.evaluate(async () => {
      const p = getCurrentPages().slice(-1)[0];
      const original = wx.cloud.callFunction;
      let respond;
      wx.cloud.callFunction = (options) => options.name === 'ai'
        ? new Promise((resolve) => { respond = resolve; }) : original(options);
      try {
        p.onNoticeInput({ detail: { value: '第11周Java调课通知A' } });
        const pending = p.readNotice();
        p.onNoticeInput({ detail: { value: '新通知B：取消调课，不修改课程' } });
        respond({ result: { ok: true, text: globalThis.__lingnanB.data.noticeReply, safety: { checked: true, passed: true }, warnings: [] } });
        await pending;
      } finally { wx.cloud.callFunction = original; }
    });
    assert.equal((await page.data()).noticeProposal, null);
    assert.equal(await page.data('noticeInput'), '新通知B：取消调课，不修改课程');
    assert.equal(await page.data('noticeReading'), false);
    check('等待中改通知后，迟到模型夹具回复不能恢复旧提案');
    await shot('09-notice-late-reply');

    const lockedText = await page.data('noticeInput');
    await mini.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.setData({ noticeApplying: true });
      p.onNoticeInput({ detail: { value: '不应在写入中改动原文' } });
      p.readNoticeText('不应在写入中发起新解析');
    });
    assert.equal(await page.data('noticeInput'), lockedText);
    assert.equal((await page.data()).noticeProposal, null);
    check('写入锁定时输入和新解析处理器均不改变原文及提案');
    await shot('10-notice-input-locked');
    await mini.evaluate(() => getCurrentPages().slice(-1)[0].setData({ noticeApplying: false }));

    page = await open('/pages/defense/index');
    await mini.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.session = { ...p.session, materialId: 'FC-1', round: 1, phase: 'failure', draft: '这份原答在反馈失败后仍应逐字保留。', answers: [], feedbacks: [] };
      p.setData({ materialName: '夹具材料' });
      p.onOpenRecord();
    });
    assert.equal(await page.data('recordView.rounds[0].answer'), '这份原答在反馈失败后仍应逐字保留。');
    await page.callMethod('onCopyReview');
    assert.equal(await page.data('copiedOpen'), true);
    check('练习反馈未返回时仍能复制已有原答，不生成未返回反馈');
    await shot('11-copy-record');
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    mini.disconnect();
    fs.writeFileSync(path.join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error }));
}
if (process.argv.includes('--prepare')) prepareProject();
else run().catch((error) => { console.error(error); process.exitCode = 1; });
