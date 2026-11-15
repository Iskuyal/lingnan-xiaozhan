/** 明确启用后，仅用唯一命名的临时课程验证真实云端；结束时核对原课表逐条未变。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connectMini } = require('./lib/mini-connect.cjs');

async function run() {
  if (!process.argv.includes('--apply')) throw new Error('真实验证需显式传 --apply；可选 --with-ai 最多调用模型一次');
  const withAi = process.argv.includes('--with-ai');
  const out = path.resolve('artifacts/notice-plan-loop/live'); fs.mkdirSync(out, { recursive: true });
  const mini = await connectMini();
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const name = '功能验证-数学-' + nonce;
  const requestId = 'live-scope-' + nonce;
  const checks = [];
  let before, created, outcome = null, ai = null, failure = null, captureInstalled = false;
  async function call(data) {
    return mini.evaluate((data) => wx.cloud.callFunction({ name: 'timetable', data }).then((res) => res.result), data);
  }
  const stable = (courses) => [...courses].sort((a, b) => a.id.localeCompare(b.id));
  async function waitPage(page, test, label) {
    const end = Date.now() + 100000;
    for (;;) {
      if (test(await page.data())) return;
      if (Date.now() > end) throw new Error('等待超时：' + label);
      await page.waitFor(250);
    }
  }
  try {
    assert.equal(await mini.evaluate(() => !!wx.__noticePlanLoop || !!wx.__aiReview || !!wx.__liveScopedCapture), false, '不能在已有夹具或验证环境中重复启动真实验证');
    before = await call({ action: 'list' }); assert.equal(before.ok, true, before.error);
    fs.writeFileSync(path.join(out, 'private-course-snapshot.json'), JSON.stringify(before, null, 2));
    created = await call({ action: 'createCourse', semester: '临时功能验证', course: { name, teacher: '',
      weekday: 3, sectionRanges: [{ start: 3, end: 4 }], weeks: [1, 2, 3], weeksRecognized: true, weekText: '1-3', location: '验证教室A' } });
    assert.equal(created.ok, true, created.error);
    const event = { action: 'applyScopedChange', id: created.course.id, requestId, expected: created.course,
      weeks: [2], course: { weekday: 5, sectionRanges: [{ start: 5, end: 6 }], location: '验证教室B' } };
    const changed = await call(event); assert.equal(changed.ok, true, changed.error);
    const repeated = await call(event); assert.equal(repeated.ok, true, repeated.error); assert.equal(repeated.repeated, true);
    const read = await call({ action: 'list' }); assert.equal(read.ok, true, read.error);
    const group = read.courses.filter((course) => course.name === name);
    assert.equal(group.length, 2);
    const original = group.find((course) => course.id === created.course.id);
    const moved = group.find((course) => course.id !== created.course.id);
    assert.deepEqual(original.weeks, [1, 3]); assert.equal(original.weekday, 3); assert.equal(original.location, '验证教室A');
    assert.deepEqual(moved.weeks, [2]); assert.equal(moved.weekday, 5); assert.equal(moved.location, '验证教室B');
    checks.push('真实云端：仅第2周改变时间地点，第1/3周保留；同编号重试不重复拆课');
    const undone = await call({ action: 'undoScopedChange', requestId }); assert.equal(undone.ok, true, undone.error);
    const undoAgain = await call({ action: 'undoScopedChange', requestId }); assert.equal(undoAgain.ok, true, undoAgain.error); assert.equal(undoAgain.repeated, true);
    checks.push('真实云端：整项撤销与撤销重试成功');

    if (withAi) {
      const page = await mini.reLaunch('/pages/timetable/index');
      await waitPage(page, (d) => d.status === 'ready', '真实课表读取');
      await page.setData({ courses: [created.course], count: 1, semester: '临时功能验证', week: 2, weekOptions: [1, 2, 3],
        assistantOpen: true, noticeOpen: true, noticeInput: `仅第2周，${name}改到星期五5-6节，地点为验证教室B。` });
      captureInstalled = true;
      await mini.evaluate(() => {
        wx.__liveScopedCapture = { original: wx.cloud.callFunction, count: 0, result: null, startedAt: Date.now() };
        wx.cloud.callFunction = (request) => {
          const state = wx.__liveScopedCapture;
          if (request.name === 'ai' && ++state.count > 1) return Promise.reject(new Error('本轮最多允许一次真实AI请求'));
          return state.original.call(wx.cloud, request).then((response) => {
            if (request.name === 'ai' && wx.__liveScopedCapture) wx.__liveScopedCapture.result = response.result;
            return response;
          });
        };
        const stack = getCurrentPages(); stack[stack.length - 1].readNotice();
      });
      await waitPage(page, (d) => d.noticeReading === false, '一次真实AI识别');
      const captured = await mini.evaluate(() => ({ count: wx.__liveScopedCapture.count,
        elapsedMs: Date.now() - wx.__liveScopedCapture.startedAt, result: wx.__liveScopedCapture.result }));
      const rows = (await page.data('noticeProposal'))?.rows ?? [];
      ai = { requests: captured.count, elapsedMs: captured.elapsedMs, ok: false,
        modelOk: captured.result?.ok === true, safetyChecked: captured.result?.safety?.checked === true,
        text: captured.result?.ok === true ? captured.result.text : '',
        error: await page.data('noticeError'), usage: captured.result?.usage ?? null };
      assert.equal(captured.count, 1);
      if (rows.length === 1 && rows[0].courseId === created.course.id && rows[0].action === 'move'
        && rows[0].weekday === 5 && rows[0].startSection === 5 && rows[0].endSection === 6
        && rows[0].location === '验证教室B' && JSON.stringify(rows[0].weeks) === '[2]' && rows[0].blocked === '' && ai.safetyChecked) {
        if (!rows[0].checked) await page.callMethod('toggleNoticeRow', { currentTarget: { dataset: { index: 0 } } });
        await mini.evaluate(() => { const pages = getCurrentPages(); pages[pages.length - 1].applyNotice(); });
        await waitPage(page, (d) => !d.noticeReading && d.noticeToast?.canUndo === true, '真实提案应用');
        const modelApplied = await call({ action: 'list' });
        assert.equal(modelApplied.courses.filter((course) => course.name === name).length, 2);
        await mini.evaluate(() => { const pages = getCurrentPages(); pages[pages.length - 1].undoNotice(); });
        await waitPage(page, (d) => !d.noticeReading && d.noticeToast?.text.includes('已撤销'), '真实提案撤销');
        ai.ok = true;
        checks.push('真实AI一次识别：限定周次、时间、地点与预期一致，经实际页面确认应用并撤销');
      } else {
        checks.push('真实AI本次未取得可安全应用且符合预期的提案，未应用模型内容，不自动重试');
      }
    }
  } catch (error) { failure = error.message; }
  finally {
    try {
      if (captureInstalled) {
        if (ai === null) ai = await mini.evaluate(() => wx.__liveScopedCapture
          ? { requests: wx.__liveScopedCapture.count, ok: false, error: '未取得可验证的终态', elapsedMs: Date.now() - wx.__liveScopedCapture.startedAt }
          : { requests: null, ok: false, error: '无法核实请求计数' });
        await mini.evaluate(() => {
          if (wx.__liveScopedCapture) { wx.cloud.callFunction = wx.__liveScopedCapture.original; delete wx.__liveScopedCapture; }
        });
      }
      if (before?.ok) {
        const current = await call({ action: 'list' }); assert.equal(current.ok, true, current.error);
        const baselineIds = new Set(before.courses.map((course) => course.id));
        for (const course of current.courses.filter((course) => course.name === name && !baselineIds.has(course.id))) {
          const removed = await call({ action: 'deleteCourse', id: course.id }); assert.equal(removed.ok, true, removed.error);
        }
        const finalState = await call({ action: 'list' }); assert.equal(finalState.ok, true, finalState.error);
        assert.deepEqual(stable(finalState.courses), stable(before.courses), '原课表必须逐条恢复，不只比较数量');
        outcome = { beforeCount: before.courses.length, afterCount: finalState.courses.length, originalCoursesUnchanged: true };
      }
      await mini.reLaunch('/pages/home/index');
    } catch (error) { failure = (failure ? failure + '；' : '') + '清理/核对失败：' + error.message; }
    finally { mini.disconnect(); }
  }
  const report = { verifiedAt: new Date().toISOString(), result: failure ? 'failed' : 'passed',
    checks, cleanup: outcome, ai, error: failure, realDevice: false, realCloud: true,
    boundaries: ['只新增、调整和删除唯一命名的临时课程，原课表逐条比对', '可选AI最多一次请求且只发送临时课程，非独立效果评测', '这是开发者工具，不是手机真机'] };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (failure) process.exitCode = 1;
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
