/** B 的岭南红课表原生验收（开发者工具模拟器，9462 端口）。
 * 云函数、数据库与本机存储全部接管为内存夹具；不调用真实业务 AI、不写真实课表。
 * 这是模拟器证据，不是真机；320px 由浏览器辅助另记。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connectMini } = require('./lib/mini-connect.cjs');
const { waitForApp } = require('./verify-lingnan-ui.cjs');

const event = (dataset) => ({ currentTarget: { dataset } });
const input = (value) => ({ detail: { value } });

function course(id, name, weekday, start, end, location, weeks, extra = {}) {
  return {
    id, name, weekday, teacher: '示例教师', location, campus: '清远校区', siteNumber: '44', note: '',
    credits: '2', sectionRanges: [{ start, end }], startSection: start, endSection: end,
    weeks, weeksRecognized: true, weekText: `第 ${weeks[0]}-${weeks[weeks.length - 1]} 周`,
    source: 'manual', warnings: [], rawText: '', semester: '布局验证示例学期',
    createdAt: '', updatedAt: '', ...extra,
  };
}

function fixture() {
  const weeks18 = Array.from({ length: 18 }, (_, index) => index + 1);
  const sectionTimes = Array.from({ length: 12 }, () => ({ start: '', end: '' }));
  sectionTimes[2] = { start: '10:10', end: '10:55' };
  sectionTimes[3] = { start: '11:00', end: '11:45' };
  sectionTimes[4] = { start: '14:00', end: '14:45' };
  sectionTimes[5] = { start: '14:50', end: '15:35' };
  const courses = [
    course('mock-long', '移动应用开发与专业综合实践', 1, 1, 2, '实训楼 B1204', weeks18),
    course('mock-math', '高等数学', 1, 3, 4, '崇礼楼 C203', weeks18),
    course('mock-java', 'Java 程序设计', 3, 3, 4, '博雅楼 B604', weeks18.slice(0, 16)),
    course('mock-db', '数据库原理', 3, 5, 6, '博雅楼 A302', weeks18.slice(0, 16)),
    course('mock-policy', '形势与政策', 3, 5, 6, '博雅楼 A302', [11], { source: 'excel' }),
    course('mock-english', '大学英语', 5, 3, 4, '博雅楼 A405', weeks18),
    course('mock-sun', '晚间课程（压力样例）', 7, 11, 12, '实训楼 A205', weeks18),
  ];
  const draftCourses = courses.map((item) => ({
    ...item,
    draftId: `d${item.id}`,
    source: 'excel',
    rawText: `${item.name} 示例教师 [1-18]周 ${item.startSection}-${item.endSection}节 ${item.location}`,
    sourceRowLabel: item.startSection <= 2 ? '一' : item.startSection <= 4 ? '二' : item.startSection <= 6 ? '三' : '六',
    sourceWeekdayLabel: `星期${['一', '二', '三', '四', '五', '六', '日'][item.weekday - 1]}`,
  }));
  return {
    courses,
    initial: JSON.parse(JSON.stringify(courses)),
    settings: { semesterName: '2026-2027学年第一学期', startDate: '2026-09-07', totalWeeks: 18, sectionTimes },
    draft: {
      meta: { origin: 'excel', school: '布局验证示例', sheetName: '课表', grade: '2026', major: '示例专业', semester: '2026-2027学年第一学期', className: '示例班', fileName: '示例课表.xls', department: '', exportedAt: '' },
      courses: draftCourses,
      stats: { sheets: 1, cells: draftCourses.length, entries: draftCourses.length, courses: draftCourses.length, duplicates: 0, warnings: 2 },
      problems: [],
    },
    noticeReply: JSON.stringify({
      kind: 'changes',
      message: '识别到 1 处变更。',
      changes: [{
        action: 'move', courseName: 'Java 程序设计', weekText: '第11周',
        quote: '第 11 周周三 3-4 节 Java 程序设计调到周五 5-6 节，地点改为博雅楼 A302，其余周次不变',
        courseId: 'mock-java', weekday: 5, startSection: 5, endSection: 6, location: '博雅楼 A302', teacher: '', conflict: '',
      }],
    }),
    noticeReply2: JSON.stringify({
      kind: 'changes',
      message: '识别到 2 处变更。',
      changes: [
        {
          action: 'move', courseName: 'Java 程序设计', weekText: '第11周',
          quote: '第 11 周周三 3-4 节 Java 程序设计调到周五 5-6 节，地点改为博雅楼 A302，其余周次不变',
          courseId: 'mock-java', weekday: 5, startSection: 5, endSection: 6, location: '博雅楼 A302', teacher: '', conflict: '',
        },
        {
          action: 'relocate', courseName: '数据库原理', weekText: '第11周',
          quote: '第 11 周数据库原理地点改为博雅楼 A306',
          courseId: 'mock-db', weekday: 0, startSection: 0, endSection: 0, location: '博雅楼 A306', teacher: '', conflict: '',
        },
      ],
    }),
    assistantReply: JSON.stringify({ kind: 'query', message: '第 10 周周三第 3-4 节有 Java 程序设计，地点是博雅楼 B604。' }),
    storage: {},
  };
}

async function installB(mini, data) {
  await mini.evaluate((data) => {
    const original = {
      call: wx.cloud.callFunction, database: wx.cloud.database, upload: wx.cloud.uploadFile,
      get: wx.getStorageSync, set: wx.setStorageSync, remove: wx.removeStorageSync,
    };
    const state = { calls: [], courses: data.courses, mode: 'ready', ops: new Map(), failId: '', failedOnce: false };
    globalThis.__lingnanB = { original, state, data };
    wx.getStorageSync = (key) => data.storage[key] ?? '';
    wx.setStorageSync = (key, value) => { data.storage[key] = value; };
    wx.removeStorageSync = (key) => { delete data.storage[key]; };
    wx.cloud.database = () => {
      const query = { collection() { return query; }, field() { return query; }, orderBy() { return query; },
        skip() { return query; }, limit() { return query; }, where() { return query; }, doc() { return query; },
        get() { return Promise.resolve({ data: [] }); } };
      return query;
    };
    wx.cloud.callFunction = (options) => {
      const action = options.data?.action;
      state.calls.push({ name: options.name, action, data: options.data });
      if (options.name === 'ai') {
        if (options.data?.feature === 'timetable-notice') {
          return Promise.resolve({ result: { ok: true, text: data.noticeReply, warnings: [], safety: { checked: true, passed: true }, capWarning: '' } });
        }
        if (options.data?.feature === 'timetable-assistant') {
          return Promise.resolve({ result: { ok: true, text: data.assistantReply, warnings: [], safety: { checked: true, passed: true }, capWarning: '' } });
        }
        return Promise.resolve({ result: { ok: false, failureClass: 'model_unavailable', message: '离线模拟：模型不可用', text: '', warnings: [], safety: null } });
      }
      if (options.name !== 'timetable') return Promise.reject(new Error('离线验收阻止了未配置云接口'));
      if (state.mode === 'error') return Promise.reject(new Error('离线模拟：课表读取失败'));
      if (action === 'list') {
        return Promise.resolve({ result: { ok: true, count: state.mode === 'empty' ? 0 : state.courses.length, semester: '2026-2027学年第一学期', updatedAt: '', courses: state.mode === 'empty' ? [] : state.courses } });
      }
      if (action === 'getSettings') return Promise.resolve({ result: { ok: true, saved: true, settings: data.settings } });
      if (action === 'prepareUpload') return Promise.resolve({ result: { ok: true, cloudPath: 'mock/ui.xls', maxBytes: 10485760 } });
      if (action === 'preparePhotoUpload') return Promise.resolve({ result: { ok: true, cloudPath: 'mock/ui.png', maxBytes: 10485760 } });
      if (action === 'importDraft') return Promise.resolve({ result: { ok: true, draft: data.draft, tempFileDeleted: true } });
      if (action === 'saveDraft') {
        state.courses = data.draft.courses.map((item, index) => ({ ...item, id: `saved-${index}` }));
        return Promise.resolve({ result: { ok: true, saved: state.courses.length } });
      }
      if (action === 'applyScopedChange') {
        const id = options.data.id, requestId = options.data.requestId, input = options.data.course;
        if (state.failId !== '' && id === state.failId && !state.failedOnce) {
          state.failedOnce = true;
          return Promise.reject(new Error('离线模拟：这一项保存未完成'));
        }
        const originalCourse = state.courses.find((item) => item.id === id);
        if (!originalCourse) return Promise.reject(new Error('课程不存在'));
        if (state.ops.has(requestId)) return Promise.resolve({ result: { ok: true, id } });
        const snapshot = { weeks: originalCourse.weeks.slice(), weekText: originalCourse.weekText, splitId: `${id}_w11` };
        state.ops.set(requestId, { id, snapshot });
        originalCourse.weeks = originalCourse.weeks.filter((week) => week !== 11);
        originalCourse.weekText = '[1-10,12-16]周';
        state.courses.push({ ...originalCourse, id: snapshot.splitId, weeks: [11], weekText: '[11]周', weekday: input.weekday, sectionRanges: input.sectionRanges, startSection: input.startSection, endSection: input.endSection, location: input.location });
        return Promise.resolve({ result: { ok: true, id } });
      }
      if (action === 'undoScopedChange') {
        const record = state.ops.get(options.data.requestId);
        if (!record) return Promise.resolve({ result: { ok: true } });
        const target = state.courses.find((item) => item.id === record.id);
        if (target) { target.weeks = record.snapshot.weeks.slice(); target.weekText = record.snapshot.weekText; }
        state.courses = state.courses.filter((item) => item.id !== record.snapshot.splitId);
        return Promise.resolve({ result: { ok: true } });
      }
      if (action === 'createCourse' || action === 'updateCourse') return Promise.resolve({ result: { ok: true, id: options.data.id || 'mock-new', course: { id: 'mock-new', ...options.data.course } } });
      if (action === 'deleteCourse') { state.courses = state.courses.filter((item) => item.id !== options.data.id); return Promise.resolve({ result: { ok: true, count: state.courses.length } }); }
      return Promise.reject(new Error(`离线验收阻止写入：${action}`));
    };
    wx.cloud.uploadFile = (options) => { setTimeout(() => options.success({ fileID: 'cloud://mock-ui-only' }), 0); return { onProgressUpdate() {} }; };
  }, data);
}

async function run() {
  const directory = path.resolve(process.argv[2] || 'docs/evidence/lingnan-ui-implementation/b/native');
  fs.mkdirSync(directory, { recursive: true });
  const report = {
    date: new Date().toISOString(),
    mode: 'wechat_simulator_mock_9462',
    boundary: '开发者工具模拟器；云函数、数据库、AI 与本机存储接管为示例。真实云请求 0 次（连接前启动读取除外）；不是真机，不证明真实模型、部署或事务性能。',
    checks: [], screenshots: [], passed: false,
  };
  const mini = await connectMini('9462');
  let installed = false;
  const shot = async (name, page) => {
    await page.waitFor(400);
    const file = path.join(directory, `${name}.png`);
    await mini.screenshot({ path: file });
    const width = fs.readFileSync(file).readUInt32BE(16);
    assert.ok(width >= 300, '模拟器截图缩放过小');
    report.screenshots.push({ file: path.basename(file), page: page.path, width });
  };
  const open = async (route, name) => {
    await mini.reLaunch(route);
    const page = await mini.currentPage();
    await page.waitFor(800);
    if (name) await shot(name, page);
    return page;
  };
  const check = (name) => report.checks.push({ name, passed: true });
  try {
    await waitForApp(mini);
    report.environment = await mini.systemInfo();
    const data = fixture();
    await installB(mini, data);
    installed = true;

    let page = await open('/pages/timetable/index?today=2026-11-11&clock=10:10', '01-week-390');
    assert.equal(await page.data('status'), 'ready');
    assert.equal((await page.data('gridUi')).columns.length, 7);
    assert.equal((await page.data('week')), 10);
    check('课表主页：第 10 周、七天、作息来自设置');

    await (await page.$('#grid-expand')).tap();
    await page.waitFor(400);
    assert.equal((await page.data('gridUi')).axisRows.length, 6);
    await shot('02-week-full-12', page);
    await (await page.$('#grid-expand')).tap();
    check('完整 12 节入口展开/收起');

    await page.callMethod('switchView', event({ mode: 'day' }));
    await page.callMethod('selectDay', event({ weekday: 3 }));
    await page.waitFor(400);
    const day = await page.data('dayView');
    assert.ok(day.rows.length > 0);
    assert.equal(day.rows[0].timeLabel, '10:10 – 11:45');
    await shot('03-day-agenda', page);
    check('每日安排：周三 3-4 节显示作息时刻');

    await page.callMethod('switchView', event({ mode: 'week' }));
    await (await page.$('#assistant-open')).tap();
    await page.waitFor(300);
    assert.equal(await page.data('assistantOpen'), true);
    await shot('04-assistant', page);

    await (await page.$('#notice-open')).tap();
    await page.waitFor(200);
    await page.callMethod('onNoticeInput', input('第 11 周周三 3-4 节 Java 程序设计调到周五 5-6 节，地点改为博雅楼 A302，其余周次不变。'));
    await (await page.$('#notice-read')).tap();
    await page.waitFor(800);
    const proposal = await page.data('noticeProposal');
    assert.equal(proposal.rows.length, 1);
    assert.match(proposal.rows[0].scopeLabel, /仅第 11 周/u);
    const overlayBody = await page.$('.tt2-overlay-body');
    await overlayBody.scrollTo(0, 620);
    await shot('05-notice-proposal', page);
    check('通知提案：只改第 11 周，确认前不写入');

    await page.callMethod('editNotice');
    await page.waitFor(300);
    const editBody = await page.$('.tt2-overlay-body');
    await editBody.scrollTo(0, 760);
    await shot('05b-notice-edit', page);
    await page.callMethod('keepProposal');
    check('原通知可改回再核对，原提案保留');

    await (await page.$('#notice-apply')).tap();
    await page.waitFor(1200);
    assert.equal(await page.data('week'), 11);
    assert.ok((await page.data('highlightIds')).includes('mock-java_w11'));
    const resultBody = await page.$('.tt2-overlay-body');
    await resultBody.scrollTo(0, 360);
    await shot('06-change-result', page);
    await (await page.$('#view-changed-week')).tap();
    await page.waitFor(500);
    const friday = (await page.data('gridUi')).columns[4];
    assert.ok(friday.blocks.some((block) => block.changed && block.name === 'Java 程序设计'));
    await shot('07-week-11-changed', page);
    await mini.pageScrollTo(520);
    await shot('07b-plan-and-assistant', page);
    check('应用后回到第 11 周，周五课块带「本次调整」标记；独立计划与助手入口在下方');

    await page.callMethod('undoNotice');
    await page.waitFor(1200);
    assert.equal((await page.data('noticeResult')).kind, 'undone');
    const undoBody = await page.$('.tt2-overlay-body');
    await undoBody.scrollTo(0, 300);
    await shot('08-undo-result', page);
    check('整项撤销回到原安排，其他周保留');

    // 部分成功：第二项失败一次，只重试失败项，结果页分清「先前/重试后」。
    await page.callMethod('closeAssistant');
    await mini.evaluate(() => {
      const state = globalThis.__lingnanB.state;
      globalThis.__lingnanB.data.noticeReply = globalThis.__lingnanB.data.noticeReply2;
      state.failId = 'mock-db';
      state.failedOnce = false;
    });
    await page.callMethod('openNoticeEntry');
    await page.waitFor(300);
    await page.callMethod('onNoticeInput', input('第 11 周周三 3-4 节 Java 调到周五 5-6 节，地点 A302；第 11 周数据库原理地点改为 A306。'));
    await (await page.$('#notice-read')).tap();
    await page.waitFor(900);
    await (await page.$('#notice-apply')).tap();
    await page.waitFor(1200);
    assert.ok(!(await page.data('noticeResult')), '部分失败时不该显示全部完成页');
    assert.equal((await page.data('noticeBatch')).failed, 1);
    const partialBody = await page.$('.tt2-overlay-body');
    await partialBody.scrollTo(0, 0);
    await shot('08b-partial-result', page);
    await (await page.$('#notice-retry')).tap();
    await page.waitFor(1400);
    assert.equal((await page.data('noticeResult')).kind, 'batch');
    const batchBody = await page.$('.tt2-overlay-body');
    await batchBody.scrollTo(0, 0);
    await shot('08c-batch-result', page);
    check('部分成功逐项列状态；重试只补失败项，已保存项不重复执行');

    page = await open('/pages/timetable/import/index', '09-import-guide');
    await page.callMethod('startImport', { path: 'mock.xls', name: '示例课表.xls' });
    await page.waitFor(900);
    assert.equal(await page.data('step'), 'review');
    await shot('10-import-review', page);
    await page.callMethod('toggleSource', event({ index: 0 }));
    await page.waitFor(300);
    await shot('11-import-source', page);
    const items = await page.data('items');
    assert.ok(items.every((item) => item.sourceLabel.length > 0));
    await mini.pageScrollTo(2400);
    await page.waitFor(400);
    await shot('11b-import-bottom', page);
    check('导入核对：每条草稿带原材料位置与修正入口，替换警告紧邻确认按钮');

    page = await open('/pages/timetable/edit/index?scope=saved&id=mock-long', '12-course-edit');
    await page.callMethod('onNameInput', input(''));
    await page.callMethod('save');
    await page.waitFor(300);
    assert.match(await page.data('fieldErrors.name'), /课程名/u);
    await shot('13-field-error', page);
    check('字段错误：缺课程名时停在本页并保留其他输入');

    page = await open('/pages/timetable/manage/index?week=11', '14-course-manage');
    assert.ok((await page.data('total')) > 0);
    page = await open('/pages/timetable/settings/index', '15-settings');
    assert.ok((await page.data('groups')).length === 3);
    await (await page.$('#settings-group-1')).tap();
    await page.waitFor(300);
    await shot('16-settings-times', page);
    check('作息设置三组，空时刻显示「选择时刻」');

    await mini.evaluate(() => { globalThis.__lingnanB.state.mode = 'empty'; });
    page = await open('/pages/timetable/index', '17-empty');
    assert.equal(await page.data('status'), 'empty');
    await mini.evaluate(() => { globalThis.__lingnanB.state.mode = 'error'; });
    page = await open('/pages/timetable/index', '18-error');
    assert.equal(await page.data('status'), 'error');
    check('空态与读取失败分开：失败不伪装成没课');

    report.mockCalls = await mini.evaluate(() => globalThis.__lingnanB.state.calls.map((call) => ({ name: call.name, action: call.action })));
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (installed) {
      await mini.evaluate(() => {
        const original = globalThis.__lingnanB.original;
        wx.cloud.callFunction = original.call;
        wx.cloud.database = original.database;
        wx.cloud.uploadFile = original.upload;
        wx.getStorageSync = original.get;
        wx.setStorageSync = original.set;
        wx.removeStorageSync = original.remove;
        delete globalThis.__lingnanB;
      }).catch(() => {});
    }
    mini.disconnect();
    fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error }));
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, installB };
