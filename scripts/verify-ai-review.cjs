/** 58分反馈后的原生回归。云函数全部由内存夹具接管，不调用模型、不写真实课表或本机存储。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { connectMini } = require('./lib/mini-connect.cjs');
const { parseNoticeReply } = require('../dist/services/timetable/notice.js');

async function run() {
  const output = path.resolve('artifacts/review-ai-20261110/native-after');
  fs.mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  const checks = [];
  const screenshots = [];
  let installed = false;
  try {
    // 保存原传输函数用于 finally 恢复；所有云函数名均接管，未知调用直接拒绝。
    await mini.evaluate(() => {
      if (wx.__aiReview) throw new Error('已有审查替身，拒绝覆盖');
      const base = { id: 'review-base', name: '审查夹具·数学', credits: '', teacher: '', weekday: 2,
        startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }], weeks: [8],
        weeksRecognized: true, weekText: '8', location: '示例教室A', campus: '', siteNumber: '',
        note: '', warnings: [], source: 'manual', semester: '审查夹具', rawText: '', createdAt: '', updatedAt: '' };
      wx.__aiReview = { original: wx.cloud.callFunction, courses: [base], failList: false, failB: true, writes: [] };
      wx.cloud.callFunction = (request) => {
        const state = wx.__aiReview;
        const data = request.data || {};
        if (request.name !== 'timetable') return Promise.reject(new Error('审查禁止真实模型或其他云函数调用'));
        if (data.action === 'getSettings') return Promise.resolve({ result: { ok: true, saved: true, settings: {
          semesterName: '审查夹具', startDate: '2026-09-21', totalWeeks: 20,
          sectionTimes: Array.from({ length: 12 }, (_, i) => ({ start: String(8 + i).padStart(2, '0') + ':00', end: String(8 + i).padStart(2, '0') + ':45' })),
        } } });
        if (data.action === 'list') return state.failList ? Promise.reject(new Error('审查模拟断网')) :
          Promise.resolve({ result: { ok: true, courses: state.courses, count: state.courses.length, semester: '审查夹具', updatedAt: '' } });
        if (data.action === 'createCourse') {
          if (data.course.name === '审查夹具B' && state.failB) { state.failB = false; return Promise.reject(new Error('审查模拟第二条失败')); }
          const created = { ...base, ...data.course, id: data.course.name };
          state.courses.push(created); state.writes.push('create:' + created.id);
          return Promise.resolve({ result: { ok: true, course: created } });
        }
        if (data.action === 'deleteCourse') {
          state.courses = state.courses.filter((c) => c.id !== data.id); state.writes.push('delete:' + data.id);
          return Promise.resolve({ result: { ok: true, count: state.courses.length } });
        }
        return Promise.reject(new Error('审查未允许的动作：' + data.action));
      };
    });
    installed = true;

    // callMethod 返回不代表页面内异步链已结束，按用户可见的 busy 状态等终态。
    async function settled(page, field = 'noticeReading') {
      const deadline = Date.now() + 15000;
      await page.waitFor(150);
      while (await page.data(field)) {
        if (Date.now() > deadline) throw new Error('页面仍在处理中：' + field);
        await page.waitFor(100);
      }
    }

    async function shot(page, name, selector) {
      if (selector) {
        assert.ok(await page.$(selector), '截图目标必须已经渲染：' + selector);
        await mini.evaluate((sel) => {
          const query = wx.createSelectorQuery();
          query.select(sel).boundingClientRect(); query.selectViewport().scrollOffset();
          query.exec((rows) => { if (rows[0] && rows[1]) wx.pageScrollTo({ scrollTop: Math.max(0, rows[0].top + rows[1].scrollTop - 80), duration: 0 }); });
        }, selector);
      }
      await page.waitFor(350);
      await mini.screenshot({ path: path.join(output, name + '.png') });
      const bytes = fs.readFileSync(path.join(output, name + '.png'));
      assert.ok(bytes.readUInt32BE(16) >= 320, '模拟器缩得太小，截图无法评审；请放大开发者工具窗口后重跑');
      screenshots.push(name + '.png');
    }
    let page = await mini.reLaunch('/pages/timetable/index?today=2026-11-10');
    await page.waitFor(800);
    const changes = parseNoticeReply(JSON.stringify({ kind: 'changes', changes: ['A', 'B'].map((suffix) => ({
      action: 'add', courseName: '审查夹具' + suffix, weekday: 3, startSection: 5, endSection: 6, weekText: '8', quote: '审查用的确定性提案，非模型返回',
    })) }), [], 20).changes;
    await page.setData({ assistantOpen: true, noticeOpen: true, noticeProposal: { rows: changes.map((c, index) => ({ ...c, index, checked: true })), checkedCount: 2 } });
    await page.callMethod('applyNotice');
    await settled(page);
    assert.deepEqual((await page.data('noticeProposal.rows')).map((row) => row.checked), [false, true], JSON.stringify({ error: await page.data('noticeError'), writes: await mini.evaluate(() => wx.__aiReview.writes) }));
    checks.push('部分成功后：成功项取消勾选，失败项保留');
    await shot(page, '01-partial-write', '#notice-apply');
    await page.callMethod('applyNotice');
    await settled(page);
    const names = await mini.evaluate(() => wx.__aiReview.courses.map((c) => c.name));
    assert.deepEqual(names, ['审查夹具·数学', '审查夹具A', '审查夹具B']);
    checks.push('重试后：A/B各一条，没有重复新增');
    await page.callMethod('undoNotice');
    await settled(page);
    assert.equal(await mini.evaluate(() => wx.__aiReview.courses.length), 1);
    checks.push('撤销：重试前后同批变更均还原，夹具课表回到一条');

    await mini.evaluate(() => { wx.__aiReview.failList = true; });
    page = await mini.reLaunch('/pages/home/index');
    await page.waitFor(800);
    assert.equal(await page.data('brief.headline'), '今日课表暂时没读到');
    const emptyTitle = await page.$('.home-timeline-empty .empty-title');
    assert.equal(await emptyTitle.text(), '今日课表暂时没读到');
    checks.push('首页读取失败：简报与空态均显示未知，未声称今天无课');
    await shot(page, '02-home-read-error');
    await mini.evaluate(() => { wx.__aiReview.failList = false; });

    page = await mini.reLaunch('/pages/goals/plan/index?today=2026-11-10');
    await page.callMethod('pickGoal', { id: 'review-only', name: '审查示例·明天的考试', date: '2026-11-11', createdAt: 0, updatedAt: 0 });
    await page.callMethod('generate');
    await settled(page, 'busy');
    const plan = await page.data('plan');
    assert.ok(plan.blocks.length > 0);
    assert.ok(plan.blocks.every((b) => b.weekday >= 2 && b.weekday <= 3));
    assert.ok(plan.blocks.every((b) => b.weekday !== 2 || b.startSection >= 5));
    checks.push('计划：仅排周二中午以后至周三，未排昨天或目标日之后');
    await shot(page, '03-plan-window');
    const saveButton = await page.$('#plan-save');
    assert.equal(await saveButton.text(), '保存到本机');
    const foot = (await Promise.all((await page.$$('.gp-foot')).map((node) => node.text()))).join('\n');
    assert.ok(foot.includes('不调用 AI 模型') && foot.includes('自动重排尚未实现'));
    assert.equal(foot.includes('金色虚线显示在周课表里'), false);
    checks.push('计划文案：规则排程、保存到本机、尚未实现的功能均明确显示');
    await shot(page, '04-plan-actions', '#plan-save');

    const files = ['miniprogram/services/timetable/notice.ts', 'miniprogram/pages/timetable/index.ts',
      'miniprogram/services/goals/plan.ts', 'miniprogram/services/timetable/brief.ts',
      'miniprogram/pages/home/index.ts', 'miniprogram/pages/home/index.wxml', 'miniprogram/pages/timetable/index.wxml',
      'miniprogram/pages/goals/plan/index.ts', 'miniprogram/pages/goals/plan/index.wxml', 'miniprogram/pages/goals/index.wxml'];
    const sources = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    const report = { checkedAt: new Date().toISOString(), baseHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: true, sources, system: await mini.systemInfo(), checks, screenshots, result: 'passed',
      screenshotSource: process.env.WECHAT_REVIEW_SCREENSHOT_SOURCE || 'miniprogram-automator',
      realDevice: false, modelCalls: 0, liveCloudWrites: 0, localStorageWrites: 0,
      boundaries: ['云函数全部由内存夹具接管，写入和撤销不涉及真实课表', '计划目标仅注入页面内存，未点击保存，不修改真实目标日或本机计划', '原生模拟器截图，不是真机、真实模型或AI质量评估'] };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks, screenshots, realDevice: false, modelCalls: 0, liveCloudWrites: 0 }));
  } finally {
    try {
      if (installed) await mini.evaluate(() => { wx.cloud.callFunction = wx.__aiReview.original; delete wx.__aiReview; });
      await mini.reLaunch('/pages/home/index');
    } finally { mini.disconnect(); }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
