/** 原生闭环验收：真实页面 -> 实际云函数入口 -> 内存数据库；模型响应为固定夹具。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connectMini } = require('./lib/mini-connect.cjs');
const { harness } = require('../tests/lib/timetable-harness.cjs');

async function run() {
  const out = path.resolve(process.env.WECHAT_VERIFY_OUTPUT || 'artifacts/notice-plan-loop/native');
  fs.mkdirSync(out, { recursive: true });
  const options = {};
  const h = harness(options);
  const owner = 'loop-fixture-owner';
  const seed = await h.run(owner, { action: 'createCourse', course: { name: '示例数学', weekday: 3,
    sectionRanges: [{ start: 3, end: 4 }], weeks: [7, 8, 9], weeksRecognized: true, weekText: '7-9', location: 'B602' } });
  assert.equal(seed.ok, true);
  await h.run(owner, { action: 'saveSettings', settings: { semesterName: '闭环夹具学期', startDate: '2026-09-21', totalWeeks: 20,
    sectionTimes: Array.from({ length: 12 }, (_, i) => ({ start: String(8 + i).padStart(2, '0') + ':00', end: String(8 + i).padStart(2, '0') + ':45' })) } });
  const noticeText = '仅第8周示例数学改到周五5-6节，教室为B604。';
  const modelText = JSON.stringify({ kind: 'changes', changes: [{ action: 'move', courseId: seed.course.id,
    courseName: '示例数学', weekday: 5, startSection: 5, endSection: 6, weekText: '第8周', location: 'B604', quote: noticeText }] });
  const mini = await connectMini();
  const checks = [], shots = [], requests = [];
  let offline = false;
  let installed = false;
  const calls = [];
  try {
    await mini.exposeFunction('__noticePlanLoopCall', (payload) => {
      const task = (async () => {
        const { request } = payload;
        requests.push({ name: request.name, action: request.data?.action });
        if (offline) throw new Error('夹具模拟离线');
        if (request.name === 'ai') return { ok: true, text: modelText, failureClass: '', message: '', capWarning: '', safety: null, warnings: ['固定模型响应夹具'] };
        if (request.name !== 'timetable') throw new Error('测试禁止访问其他真实云函数');
        if (request.data.action === 'applyScopedChange') calls.push(JSON.parse(JSON.stringify(request.data)));
        return h.run(owner, request.data);
      })();
      task.then((result) => mini.evaluate((key, result) => {
        const pending = wx.__noticePlanLoop?.pending[key];
        if (pending) { delete wx.__noticePlanLoop.pending[key]; pending.resolve({ result }); }
      }, payload.key, result), (error) => mini.evaluate((key, message) => {
        const pending = wx.__noticePlanLoop?.pending[key];
        if (pending) { delete wx.__noticePlanLoop.pending[key]; pending.reject(new Error(message)); }
      }, payload.key, error.message)).catch((error) => console.error('原生测试桥失败：', error.message));
    });
    await mini.evaluate(() => {
      if (typeof __noticePlanLoopCall !== 'function') throw new Error('自动化绑定未成功，不安装云函数替身');
      const keys = wx.getStorageInfoSync().keys;
      const backup = ['study-plan/v1', 'goal-days/v1'].map((key) => ({ key, exists: keys.includes(key), value: wx.getStorageSync(key) }));
      wx.__noticePlanLoop = { original: wx.cloud.callFunction, backup, pending: {}, serial: 0 };
      wx.cloud.callFunction = (request) => new Promise((resolve, reject) => {
        const key = String(++wx.__noticePlanLoop.serial);
        wx.__noticePlanLoop.pending[key] = { resolve, reject };
        __noticePlanLoopCall({ key, request });
      });
      wx.removeStorageSync('study-plan/v1');
      wx.setStorageSync('goal-days/v1', JSON.stringify([{ id: 'loop-goal', name: '演示·英语四级', date: '2026-12-13', countToday: false, createdAt: 1, updatedAt: 1 }]));
    });
    installed = true;
    async function until(page, predicate, label) {
      const end = Date.now() + 15000;
      for (;;) {
        if (predicate(await page.data())) return;
        if (Date.now() > end) throw new Error('等待终态超时：' + label);
        await page.waitFor(120);
      }
    }
    async function pageAt(route) {
      const end = Date.now() + 15000;
      for (;;) {
        const page = await mini.currentPage();
        if (page?.path === route) return page;
        if (Date.now() > end) throw new Error('页面未切换到：' + route);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    async function tap(page, selector) {
      const node = await page.$(selector); assert.ok(node, selector + '必须可见'); await node.tap();
    }
    async function shot(page, name, selector) {
      await mini.callWxMethod('hideToast');
      if (selector) {
        assert.ok(await page.$(selector));
        await mini.evaluate((selector) => {
          const q = wx.createSelectorQuery(); q.select(selector).boundingClientRect(); q.selectViewport().scrollOffset();
          q.exec((rows) => { if (rows[0] && rows[1]) wx.pageScrollTo({ scrollTop: Math.max(0, rows[0].top + rows[1].scrollTop - 60), duration: 0 }); });
        }, selector);
      }
      await page.waitFor(350);
      const file = path.join(out, name + '.png'); await mini.screenshot({ path: file });
      assert.ok(fs.readFileSync(file).readUInt32BE(16) >= 320, '截图分辨率不足，请放大模拟器后重跑');
      shots.push(name + '.png');
    }

    let page = await mini.reLaunch('/pages/timetable/index?today=2026-11-10&week=8');
    await until(page, (d) => d.status === 'ready', '课表读取');
    await page.callMethod('openAssistant'); await page.callMethod('toggleNotice');
    await page.callMethod('onNoticeInput', { detail: { value: noticeText } });
    await tap(page, '#notice-read');
    await until(page, (d) => !d.noticeReading && d.noticeProposal !== null, '固定模型提案');
    assert.match((await page.data('noticeProposal.rows'))[0].scopeLabel, /8/);
    await shot(page, '01-scoped-proposal', '#notice-proposal');
    options.loseScopedResponse = true;
    await tap(page, '#notice-apply');
    await until(page, (d) => !d.noticeReading && d.noticeError.includes('未确认'), '提交后响应丢失');
    assert.equal((await h.run(owner, { action: 'list' })).courses.length, 2);
    await tap(page, '#notice-apply');
    await until(page, (d) => !d.noticeReading && d.noticeToast?.canUndo === true, '幂等重试');
    assert.equal(calls.length, 2); assert.equal(calls[0].requestId, calls[1].requestId);
    assert.deepEqual(calls[0].expected.weeks, [7, 8, 9]); assert.deepEqual(calls[1].expected.weeks, [7, 8, 9]);
    const changed = (await h.run(owner, { action: 'list' })).courses;
    assert.equal(changed.length, 2); assert.deepEqual(changed.find((c) => c.id === seed.course.id).weeks, [7, 9]);
    assert.equal(changed.find((c) => c.id !== seed.course.id).location, 'B604');
    await tap(page, '#notice-undo');
    await until(page, (d) => !d.noticeReading && d.noticeToast?.text.includes('已撤销'), '整项撤销');
    assert.equal((await h.run(owner, { action: 'list' })).courses.length, 1);
    checks.push('实际云函数入口：限定第8周调课、响应丢失后同编号重试、整项撤销，其他周次保留');

    page = await mini.reLaunch('/pages/goals/plan/index?id=loop-goal&today=2026-11-10');
    await page.callMethod('onConstraintInput', { detail: { value: '每周3段，每次45分钟，晚上不排' } });
    await tap(page, '#plan-generate-rules');
    await until(page, (d) => !d.busy && d.plan !== null, '计划生成');
    const blocks = await page.data('plan.blocks'); assert.equal(blocks.length, 3);
    await tap(page, '#plan-save');
    await until(page, (d) => d.savedView === true, '保存结果');
    assert.equal(await page.data('plan.goalId'), 'loop-goal');
    await shot(page, '02-plan-saved', '#saved-plan-card');
    page = await mini.reLaunch('/pages/goals/plan/index?today=2026-11-10');
    await until(page, (d) => d.savedView === true, '重开恢复');
    assert.deepEqual(await page.data('plan.blocks'), blocks);
    checks.push('计划：实际保存按钮写本机，重开恢复同一份安排和目标id，不重新生成');
    await tap(page, '#saved-plan-week');
    page = await pageAt('pages/timetable/index');
    await until(page, (d) => d.status === 'ready' && d.savedPlanPanel?.rows.length === 3, '对应周课表');
    assert.equal(await page.data('week'), 8); assert.equal(await page.data('count'), 1);
    await shot(page, '03-week-plan', '#week-saved-plan');
    const first = blocks[0];
    await h.run(owner, { action: 'createCourse', course: { name: '新占用的示例课程', weekday: first.weekday,
      sectionRanges: [{ start: first.startSection, end: first.endSection }], weeks: [8], weeksRecognized: true, weekText: '8' } });
    await page.callMethod('load');
    await until(page, (d) => d.savedPlanPanel.rows.some((r) => r.status === 'conflict'), '新课程冲突');
    await shot(page, '04-plan-conflict', '#week-saved-plan');
    await page.callMethod('nextWeek');
    assert.equal((await page.data('savedPlanPanel.rows')).length, 0);
    checks.push('周课表：按日历周匹配，计划不计课程数；课程后改发生冲突有提示，翻周不重复显示');
    offline = true;
    page = await mini.reLaunch('/pages/goals/plan/index?today=2026-11-10');
    await page.waitFor(600);
    assert.equal(await page.data('savedView'), true); assert.deepEqual(await page.data('plan.blocks'), blocks);
    assert.equal((await page.data('savedRows')).length, 3);
    await shot(page, '05-offline-reopen', '#saved-plan-card');
    checks.push('断网重开：本机计划仍完整可见，保留原日期与原安排');
    await mini.evaluate(() => wx.setStorageSync('goal-days/v1', '[]'));
    page = await mini.reLaunch('/pages/goals/plan/index?today=2026-11-10');
    assert.equal(await page.data('savedGoalMissing'), true); assert.equal((await page.data('savedRows')).length, 3);
    await tap(page, '#saved-plan-remove');
    await until(page, (d) => d.savedView === false, '撤回本机计划');
    checks.push('目标删除仍可查看原计划；撤回只移除本机计划，不修改正式课程');
    const sources = ['cloudfunctions/timetable/index.ts', 'cloudfunctions/timetable/scoped.ts',
      'miniprogram/services/timetable/notice.ts', 'miniprogram/services/goals/plan.ts', 'miniprogram/services/goals/saved.ts',
      'miniprogram/pages/timetable/index.ts', 'miniprogram/pages/timetable/index.wxml',
      'miniprogram/pages/goals/plan/index.ts', 'miniprogram/pages/goals/plan/index.wxml'];
    const report = { checkedAt: new Date().toISOString(), result: 'passed', checks, screenshots: shots, requests,
      system: await mini.systemInfo(), realDevice: false, realModelCalls: 0, liveCloudWrites: 0,
      screenshotSource: process.env.WECHAT_VERIFY_SCREENSHOT_SOURCE || 'miniprogram-automator',
      sources: Object.fromEntries(sources.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
      boundaries: ['实际小程序页面通过自动化桥调用本机真实云函数入口，数据库和微信身份由夹具接管', '模型返回为固定JSON，不属于真实AI效果评测', '本机两项存储在finally恢复，未部署或写入真实云端'] };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks, screenshots: shots, realDevice: false, realModelCalls: 0, liveCloudWrites: 0 }));
  } finally {
    try {
      if (installed) await mini.evaluate(() => {
        const state = wx.__noticePlanLoop;
        if (!state) return;
        wx.cloud.callFunction = state.original;
        for (const item of state.backup) {
          if (item.exists) wx.setStorageSync(item.key, item.value); else wx.removeStorageSync(item.key);
        }
        delete wx.__noticePlanLoop;
      });
    } finally { mini.disconnect(); }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
