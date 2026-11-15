/** 明确授权后最多一次真实AI请求，只读课表，不保存或改写课程/本机计划。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connectMini } = require('./lib/mini-connect.cjs');
const { buildPlanIntentEvent, parsePlanIntent } = require('../dist/services/goals/intent.js');
const { buildPlan } = require('../dist/services/goals/plan.js');
const { normalizeSettings } = require('../dist/services/timetable/settings.js');
const { shanghaiToday } = require('../dist/services/dates/index.js');
const { addDays } = require('../dist/services/timetable/semester.js');
const { occursInWeek } = require('../dist/services/timetable/view.js');

async function run() {
  if (!process.argv.includes('--allow-one-ai')) throw new Error('真实验证需显式传 --allow-one-ai；不得复用上一轮已使用的授权');
  const out = path.resolve('artifacts/ai-study-plan/live'); fs.mkdirSync(out, { recursive: true });
  const mini = await connectMini();
  const source = '我周四没空，周末上午有兼职，每次半小时，听力总拖后腿，一周安排三回。';
  const goal = '演示英语目标';
  const event = buildPlanIntentEvent(goal, source);
  let snapshot = null, captured = null, result = null, failure = null, installed = false;
  const call = (data) => mini.evaluate((data) => wx.cloud.callFunction({ name: 'timetable', data }).then((r) => r.result), data);
  try {
    assert.equal(await mini.evaluate(() => !!wx.__aiStudyFixture || !!wx.__noticePlanLoop || !!wx.__aiReview || !!wx.__liveStudyRequest), false, '已有测试或验证上下文，不能宣称真实调用');
    // 自动化端口就绪不代表客户端onLaunch已完成，先走正常首页启动再调用云API。
    await mini.reLaunch('/pages/home/index');
    snapshot = await call({ action: 'list' }); assert.equal(snapshot.ok, true, snapshot.error);
    const settingResult = await call({ action: 'getSettings' }); assert.equal(settingResult.ok, true, settingResult.error);
    installed = true;
    await mini.evaluate((event) => {
      wx.__liveStudyRequest = { startedAt: Date.now(), attempts: 1, done: false, result: null, error: '' };
      wx.cloud.callFunction({ name: 'ai', data: event }).then((response) => {
        if (wx.__liveStudyRequest) Object.assign(wx.__liveStudyRequest, { done: true, result: response.result });
      }, (error) => {
        if (wx.__liveStudyRequest) Object.assign(wx.__liveStudyRequest, { done: true, error: String(error.errMsg || error.message || error) });
      });
    }, event);
    const deadline = Date.now() + 90000;
    for (;;) {
      captured = await mini.evaluate(() => ({ ...wx.__liveStudyRequest, elapsedMs: Date.now() - wx.__liveStudyRequest.startedAt }));
      if (captured.done) break;
      if (Date.now() > deadline) throw new Error('唯一请求未取得终态，不自动重试；费用状态需保留未知');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(captured.attempts, 1); assert.equal(captured.error, '');
    const raw = captured.result; assert.equal(raw?.ok, true, raw?.message || raw?.failureClass);
    assert.equal(raw.safety?.checked, true); assert.equal(raw.safety?.passed, true);
    assert.ok(!['fixture', 'test', 'offline'].includes(raw.safety?.provider));
    const reply = parsePlanIntent(raw.text, source, goal); assert.equal(reply.kind, 'constraints', reply.message);
    const { constraints } = reply.draft.readout;
    assert.equal(constraints.maxMinutesPerBlock, 30); assert.equal(constraints.blocksPerWeek, 3); assert.equal(constraints.focus, '听力');
    assert.deepEqual(constraints.excludedWeekdays, [4]);
    assert.deepEqual([...(constraints.blockedSections ?? [])].sort((a, b) => a.weekday - b.weekday || a.start - b.start),
      [{ weekday: 6, start: 1, end: 4 }, { weekday: 7, start: 1, end: 4 }]);
    const settings = normalizeSettings(settingResult.settings);
    const today = shanghaiToday(), clock = new Date(Date.now() + 8 * 3600000);
    const plan = buildPlan({ goalName: goal, goalDate: addDays(today, 30), today, courses: snapshot.courses,
      settings, constraints, readout: reply.draft.readout, constraintText: source,
      clockMinutes: clock.getUTCHours() * 60 + clock.getUTCMinutes() });
    assert.ok(plan.blocks.length <= 3);
    for (const block of plan.blocks) {
      assert.ok(block.weekday !== 4 && block.minutes <= 30 && (block.weekday < 6 || block.startSection > 4));
      for (const course of snapshot.courses) {
        if (course.weekday !== block.weekday || (plan.weekKnown && !occursInWeek(course, block.week))) continue;
        const ranges = Array.isArray(course.sectionRanges) && course.sectionRanges.length ? course.sectionRanges : [{ start: course.startSection, end: course.endSection }];
        assert.ok(!ranges.some((range) => range.start <= block.endSection && block.startSection <= range.end));
      }
    }
    result = { constraints, evidence: reply.draft.evidence, requestedBlocks: 3, placedBlocks: plan.blocks.length,
      headline: plan.headline, blocks: plan.blocks, safetyChecked: true, provider: raw.safety.provider, usage: raw.usage ?? null };
  } catch (error) { failure = error.message; }
  finally {
    try {
      if (installed) {
        captured = await mini.evaluate(() => wx.__liveStudyRequest ? { ...wx.__liveStudyRequest,
          elapsedMs: Date.now() - wx.__liveStudyRequest.startedAt } : null);
        await mini.evaluate(() => { delete wx.__liveStudyRequest; });
      }
      if (snapshot?.ok) {
        const after = await call({ action: 'list' }); assert.equal(after.ok, true, after.error);
        const sorted = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(sorted(after.courses), sorted(snapshot.courses), '只读验证前后原课程应逐条不变');
      }
    } catch (error) { failure = (failure ? failure + '；' : '') + error.message; }
    finally { mini.disconnect(); }
  }
  const report = { verifiedAt: new Date().toISOString(), status: failure ? 'failed' : 'passed',
    requests: captured?.attempts ?? 0, elapsedMs: captured?.elapsedMs ?? null, source, goal,
    rawModelText: captured?.result?.ok === true ? captured.result.text : '', result, error: failure,
    courseCount: snapshot?.courses?.length ?? null, courseWriteActions: 0, localStorageWrites: 0,
    realDevice: false, boundaries: ['最多一次真实AI业务请求，失败不自动重试', '只发送虚构目标与情况，课表仅由本机规则读取', '没有保存新计划或改写课程；这是功能样例，不是独立质量评测'] };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (failure) process.exitCode = 1;
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
