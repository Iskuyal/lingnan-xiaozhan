/** AI约束流程原生验收：固定模型回复、本机实际云函数入口、内存数据库。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connectMini } = require('./lib/mini-connect.cjs');
const { harness } = require('../tests/lib/timetable-harness.cjs');

async function run() {
  const out = path.resolve(process.env.WECHAT_VERIFY_OUTPUT || 'artifacts/ai-study-plan/native');
  fs.mkdirSync(out, { recursive: true });
  const h = harness(), owner = 'ai-study-fixture';
  await h.run(owner, { action: 'createCourse', course: { name: '隐私夹具课程', teacher: '夹具教师不外发', location: '夹具教室不外发',
    weekday: 5, sectionRanges: [{ start: 1, end: 4 }], weeks: [8], weeksRecognized: true, weekText: '8' } });
  await h.run(owner, { action: 'saveSettings', settings: { semesterName: '夹具学期', startDate: '2026-09-21', totalWeeks: 20,
    sectionTimes: Array.from({ length: 12 }, (_, i) => ({ start: String(8 + i).padStart(2, '0') + ':00', end: String(8 + i).padStart(2, '0') + ':45' })) } });
  const source = '周四没空，周末上午有兼职，每次半小时，听力最弱，一周安排三回';
  const model = { kind: 'constraints', minutes: { value: 30, quote: '每次半小时' }, sessions: { value: 3, quote: '一周安排三回' },
    focus: { value: '听力', quote: '听力最弱' }, excludedDays: [{ days: [4], quote: '周四没空' }],
    excludedPeriods: [{ days: [6, 7], period: 'morning', quote: '周末上午有兼职' }], unhandled: [] };
  const safety = { provider: 'fixture', api: 'fixture', passed: true, checked: true, detail: '模拟审核，非实际检测' };
  const mini = await connectMini();
  const checks = [], screenshots = [], requests = [];
  let mode = 'ok', offline = false, installed = false;
  try {
    await mini.exposeFunction('__aiStudyDispatch', (payload) => {
      const task = (async () => {
        requests.push({ name: payload.request.name, data: payload.request.data });
        if (offline) throw new Error('离线夹具');
        if (payload.request.name === 'ai') {
          assert.equal(payload.request.data.feature, 'study-plan-intent');
          const wire = JSON.stringify(payload.request.data);
          assert.ok(!wire.includes('夹具教师不外发') && !wire.includes('夹具教室不外发') && !wire.includes('隐私夹具课程'));
          await new Promise((resolve) => setTimeout(resolve, 300));
          return mode === 'quota' ? { ok: false, failureClass: 'quota_exhausted', message: '夹具：今日AI次数已用尽，可使用基础规则' }
            : { ok: true, text: JSON.stringify(mode === 'clarify' ? { kind: 'clarify', message: '目前按节次安排，请说明是否晚上不排，并把每段时长调整到15–180分钟。' } : model), safety };
        }
        if (payload.request.name !== 'timetable') throw new Error('测试禁止访问其他真实云函数');
        return h.run(owner, payload.request.data);
      })();
      task.then((result) => mini.evaluate((key, result) => {
        const pending = wx.__aiStudyFixture?.pending[key];
        if (pending) { delete wx.__aiStudyFixture.pending[key]; pending.resolve({ result }); }
      }, payload.key, result), (error) => mini.evaluate((key, message) => {
        const pending = wx.__aiStudyFixture?.pending[key];
        if (pending) { delete wx.__aiStudyFixture.pending[key]; pending.reject(new Error(message)); }
      }, payload.key, error.message)).catch((error) => console.error('原生桥失败：', error.message));
    });
    await mini.evaluate(() => {
      if (typeof __aiStudyDispatch !== 'function' || wx.__aiStudyFixture) throw new Error('原生桥未准备好');
      const keys = wx.getStorageInfoSync().keys;
      wx.__aiStudyFixture = { original: wx.cloud.callFunction, pending: {}, serial: 0,
        backup: ['goal-days/v1', 'study-plan/v1'].map((key) => ({ key, exists: keys.includes(key), value: wx.getStorageSync(key) })) };
      wx.cloud.callFunction = (request) => new Promise((resolve, reject) => {
        const key = String(++wx.__aiStudyFixture.serial); wx.__aiStudyFixture.pending[key] = { resolve, reject }; __aiStudyDispatch({ key, request });
      });
      wx.removeStorageSync('study-plan/v1');
      wx.setStorageSync('goal-days/v1', JSON.stringify([{ id: 'ai-study-goal', name: '演示·英语四级', date: '2026-12-13', countToday: false, createdAt: 1, updatedAt: 1 }]));
    });
    installed = true;
    async function until(page, predicate, label) {
      const deadline = Date.now() + 15000;
      while (!predicate(await page.data())) {
        if (Date.now() > deadline) throw new Error('等待超时：' + label);
        await page.waitFor(120);
      }
    }
    async function tap(page, selector) { const node = await page.$(selector); assert.ok(node, selector); await node.tap(); }
    async function shot(page, name, selector) {
      await mini.callWxMethod('hideToast');
      if (selector) {
        assert.ok(await page.$(selector));
        await mini.evaluate((selector) => {
          const q = wx.createSelectorQuery(); q.select(selector).boundingClientRect(); q.selectViewport().scrollOffset();
          q.exec((r) => { if (r[0] && r[1]) wx.pageScrollTo({ scrollTop: Math.max(0, r[0].top + r[1].scrollTop - 60), duration: 0 }); });
        }, selector);
      }
      await page.waitFor(350);
      const file = path.join(out, name + '.png'); await mini.screenshot({ path: file });
      assert.ok(fs.readFileSync(file).readUInt32BE(16) >= 320, '原始截图分辨率过低，需放大窗口或使用截图适配器');
      screenshots.push(name + '.png');
    }
    const aiCount = () => requests.filter((r) => r.name === 'ai').length;
    async function assertVisible(selector) {
      const deadline = Date.now() + 3000;
      let rect;
      do {
        rect = await mini.evaluate((selector) => new Promise((resolve) => {
          wx.createSelectorQuery().select(selector).boundingClientRect((value) => resolve(value ? { top: value.top } : null)).exec();
        }), selector);
        if (rect !== null && rect.top >= -5 && rect.top < 300) return;
        await page.waitFor(100);
      } while (Date.now() < deadline);
      assert.fail('结果应自动滚动到可见位置：' + selector + ' ' + JSON.stringify(rect));
    }
    let page = await mini.reLaunch('/pages/goals/plan/index?id=ai-study-goal&today=2026-11-11');
    await page.callMethod('onConstraintInput', { detail: { value: source } });
    await mini.pageScrollTo(0);
    await tap(page, '#plan-generate');
    await until(page, (d) => !d.aiBusy && d.aiDraftReady, 'AI约束草稿');
    assert.equal(aiCount(), 1); assert.equal((await page.data()).plan ?? null, null);
    assert.equal((await page.data('aiEvidence')).length, 5);
    await assertVisible('#plan-ai-draft');
    await shot(page, '01-ai-constraints');
    await tap(page, '#plan-ai-confirm');
    await until(page, (d) => !d.busy && d.plan !== null, '规则排程');
    const plan = await page.data('plan'); assert.equal(plan.origin, 'ai-constraints'); assert.equal(plan.blocks.length, 3);
    assert.ok(plan.blocks.every((b) => b.weekday !== 4 && b.minutes <= 30 && (b.weekday < 6 || b.startSection > 4)));
    assert.ok(plan.blocks.every((b) => b.weekday !== 5 || b.startSection > 4));
    checks.push('自然情况 -> 带逐字原话的5项约束 -> 用户确认后才排程；未发送课程/教师/地点给模型');
    await assertVisible('.gp-card');
    await shot(page, '02-rule-checked-plan');
    await tap(page, '#plan-variant'); await page.waitFor(150);
    assert.equal(aiCount(), 1); assert.notDeepEqual(await page.data('plan.blocks'), plan.blocks);
    await tap(page, '#plan-save'); await until(page, (d) => d.savedView, '保存结果');
    const stored = await mini.evaluate(() => wx.getStorageSync('study-plan/v1'));
    page = await mini.reLaunch('/pages/goals/plan/index?id=ai-study-goal&today=2026-11-11');
    await until(page, (d) => d.savedView, '重开AI来源计划');
    assert.equal(await page.data('plan.origin'), 'ai-constraints'); assert.equal(aiCount(), 1);
    await shot(page, '03-saved-ai-plan', '#saved-plan-card');
    checks.push('排程避开指定星期/周末上午/正式课程，遵守30分钟上限；换排法实际变化，保存和重开不重复调用模型');
    await tap(page, '#saved-plan-regenerate'); await until(page, (d) => !d.savedView, '重新编辑');
    mode = 'quota'; await tap(page, '#plan-generate');
    await until(page, (d) => !d.aiBusy && d.aiMessage.includes('次数已用尽'), '额度失败');
    assert.equal(await mini.evaluate(() => wx.getStorageSync('study-plan/v1')), stored);
    await shot(page, '04-ai-quota-fallback', '#plan-ai-message');
    mode = 'clarify'; await page.callMethod('onConstraintInput', { detail: { value: '晚上八点以后不排，每次十分钟' } });
    await tap(page, '#plan-generate'); await until(page, (d) => !d.aiBusy && d.aiMessage.includes('15–180'), '澄清');
    assert.equal((await page.data()).plan ?? null, null); assert.equal(await mini.evaluate(() => wx.getStorageSync('study-plan/v1')), stored);
    await shot(page, '05-clarification', '#plan-ai-message');
    checks.push('额度不足和需要澄清分别说明，保留原输入和旧计划，不生成替代约束或覆盖存储');
    offline = true;
    page = await mini.reLaunch('/pages/goals/plan/index?today=2026-11-11'); await page.waitFor(300);
    assert.equal(await page.data('savedView'), true); assert.equal(await page.data('plan.origin'), 'ai-constraints');
    assert.equal(aiCount(), 3); checks.push('AI来源计划仍可离线重开；本轮全部模型回复为夹具，没有真实模型请求');
    const files = ['miniprogram/services/goals/intent.ts', 'miniprogram/services/goals/plan.ts',
      'miniprogram/pages/goals/plan/index.ts', 'miniprogram/pages/goals/plan/index.wxml', 'miniprogram/pages/goals/plan/index.wxss'];
    const report = { checkedAt: new Date().toISOString(), result: 'passed', checks, screenshots, system: await mini.systemInfo(),
      fixtureAiRequests: aiCount(), realModelCalls: 0, liveCloudWrites: 0, realDevice: false,
      screenshotSource: process.env.WECHAT_VERIFY_SCREENSHOT_SOURCE || 'miniprogram-automator',
      sources: Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
      boundaries: ['模型结果及审核通过标记均为夹具，不是实际AI效果或实际审核证明', '读取课表经本机实际云函数入口，数据库/身份由内存夹具接管', '输入采用与bindinput同形事件，按钮为原生tap', '测试结束恢复本机原目标与计划'] };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks, screenshots, realModelCalls: 0, liveCloudWrites: 0 }));
  } finally {
    try {
      if (installed) await mini.evaluate(() => {
        const state = wx.__aiStudyFixture;
        if (!state) return;
        wx.cloud.callFunction = state.original;
        for (const item of state.backup) { if (item.exists) wx.setStorageSync(item.key, item.value); else wx.removeStorageSync(item.key); }
        delete wx.__aiStudyFixture;
      });
      if (installed) await mini.reLaunch('/pages/home/index');
    } finally { mini.disconnect(); }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
