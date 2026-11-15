const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const notice = require('../dist/services/timetable/notice.js');
const planner = require('../dist/services/goals/plan.js');
const brief = require('../dist/services/timetable/brief.js');
const { emptySettings } = require('../dist/services/timetable/settings.js');

const plain = (value) => JSON.parse(JSON.stringify(value));
function course(extra = {}) {
  return { id: 'math', name: '数学', credits: '', teacher: '', weekday: 2,
    startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }],
    weeks: [11, 12, 13], weeksRecognized: true, weekText: '11-13', location: 'A',
    campus: '', siteNumber: '', note: '', warnings: [], source: 'manual', semester: '',
    rawText: '', createdAt: '', updatedAt: '', ...extra };
}
function reply(changes, courses = [course()]) {
  return notice.parseNoticeReply(JSON.stringify({ kind: 'changes', changes }), courses, 20);
}
function loadPage(route, timetable) {
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  const localRequire = createRequire(filename);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (definition) => { page = definition; }, exports: {}, console,
    wx: { showToast() {} }, getCurrentPages: () => [{}],
    require: (name) => name.endsWith('/timetable/index') ? { ...localRequire(name), ...timetable } :
      name.endsWith('/goals/index') ? { ...localRequire(name), loadGoals: () => [] } :
      name.endsWith('/timetable/settings') ? { ...localRequire(name), loadSettings: async () => emptySettings() } : localRequire(name),
  }, { filename });
  page.data = plain(page.data);
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

test('通知：同课停课后改地点保留两项变更，逐步快照可完整撤销', () => {
  const courses = [course()];
  const result = reply([
    { action: 'cancel', courseId: 'math', weekText: '第12周' },
    { action: 'relocate', courseId: 'math', location: 'B' },
  ]);
  const steps = notice.applyPlan(result.changes, courses, 20);
  assert.deepEqual(steps[1].input.weeks, [11, 13]);
  assert.equal(steps[1].input.location, 'B');
  assert.deepEqual(steps[1].before.weeks, [11, 13]);
  assert.deepEqual(courses[0].weeks, [11, 12, 13], '纯函数不修改入参');
  const inverse = notice.invertPlan(steps.map((s) => ({ ...s, after: s.input })));
  assert.deepEqual(inverse[0].input.weeks, [11, 13]);
  assert.deepEqual(inverse[1].input.weeks, [11, 12, 13]);
});

test('通知：不能确定的临时范围必须阻塞，明确周次走限定接口而非整条更新', () => {
  for (const action of ['relocate', 'move']) {
    const scoped = reply([{ action, courseId: 'math', weekday: 3, location: 'B', weekText: '第12周' }]);
    assert.equal(scoped.changes[0].blocked, '');
    assert.equal(notice.applyPlan(scoped.changes, [course()], 20)[0].kind, 'scoped');
    for (const timing of [{ quote: '仅第十二周临时调整' }, { quote: '从第11周起调整' }]) {
      const result = reply([{ action, courseId: 'math', weekday: 3, location: 'B', ...timing }]);
      assert.equal(result.kind, 'changes');
      assert.equal(result.changes[0].defaultChecked, false);
      assert.match(result.changes[0].blocked, /周次|临时/u);
      assert.equal(notice.applyPlan(result.changes, [course()], 20).length, 0);
    }
  }
});

function noticePage(timetable, changes) {
  const page = loadPage('timetable', timetable);
  page.data.courses = [];
  page.data.weekOptions = Array.from({ length: 20 }, (_, i) => i + 1);
  page.data.noticeProposal = { rows: reply(changes, []).changes.map((c, index) => ({ ...c, index, checked: true })), checkedCount: changes.length };
  page.load = async () => {};
  return page;
}
const add = (name) => ({ action: 'add', courseName: name, weekday: 3, startSection: 3, endSection: 4, weekText: '12' });

test('通知：部分成功后重试只写剩余项，撤销覆盖同一批已成功的全部变更', async () => {
  const saved = [];
  let fail = true;
  const page = noticePage({
    createCourse: async (input) => {
      if (input.name === 'B' && fail) { fail = false; throw new Error('暂时不可用'); }
      const item = course({ ...input, id: input.name }); saved.push(item); return item;
    },
    deleteCourse: async (id) => saved.splice(saved.findIndex((c) => c.id === id), 1),
  }, [add('A'), add('B')]);
  await page.applyNotice();
  assert.deepEqual(plain(page.data.noticeProposal.rows.map((r) => r.checked)), [false, true]);
  await page.applyNotice();
  assert.deepEqual(saved.map((c) => c.name), ['A', 'B']);
  await page.undoNotice();
  assert.deepEqual(saved, []);
});

test('通知：写入在途时连续点应用只执行一次', async () => {
  let writes = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = noticePage({ createCourse: async (input) => { writes += 1; await gate; return course(input); } }, [add('A')]);
  const first = page.applyNotice();
  const second = page.applyNotice();
  release();
  await Promise.all([first, second]);
  assert.equal(writes, 1);
});

test('通知：撤销中途失败保留未完成逆操作，重试不重放已成功步骤', async () => {
  const calls = [];
  let fail = true;
  const page = loadPage('timetable', { deleteCourse: async (id) => {
    calls.push(id); if (id === 'A' && fail) { fail = false; throw new Error('断网'); }
  } });
  page.load = async () => {};
  page.undoStack = ['A', 'B'].map((courseId) => ({ kind: 'create', courseId, before: null }));
  await page.undoNotice();
  assert.equal(page.undoStack.length, 1);
  await page.undoNotice();
  assert.deepEqual(calls, ['B', 'A', 'A']);
  assert.equal(page.undoStack.length, 0);
});

test('计划：本周只排今天到目标日之间的日期', () => {
  const result = planner.buildPlan({ goalName: '考试', goalDate: '2026-11-11', today: '2026-11-10',
    courses: [], settings: { ...emptySettings(), startDate: '2026-09-21', totalWeeks: 20 },
    constraints: planner.emptyConstraints() });
  assert.ok(result.blocks.length > 0);
  assert.ok(result.blocks.every((b) => b.weekday >= 2 && b.weekday <= 3));
});

test('计划：有当前时刻时不排已经开始的今日时段，时刻未知则从明天排', () => {
  const input = { goalName: '考试', goalDate: '2026-11-11', today: '2026-11-10', clockMinutes: 12 * 60,
    courses: [], settings: { ...emptySettings(), startDate: '2026-09-21', totalWeeks: 20 },
    constraints: planner.emptyConstraints() };
  const unknown = planner.buildPlan(input);
  assert.ok(unknown.blocks.every((b) => b.weekday === 3));
  input.settings.sectionTimes[4] = { start: '14:00', end: '14:45' };
  input.settings.sectionTimes[5] = { start: '14:50', end: '15:35' };
  const known = planner.buildPlan(input);
  assert.ok(known.blocks.some((b) => b.weekday === 2 && b.startSection === 5));
  assert.ok(known.blocks.every((b) => b.weekday !== 2 || b.startSection === 5));
});

test('计划：周末上午可以排、晚上不排，不会串用另一子句的否定词', () => {
  const result = planner.readConstraints('周末上午可以排，晚上不排');
  assert.equal(result.constraints.noWeekendMorning, false);
  assert.equal(result.constraints.noEvening, true);
});

test('简报：只填早课作息时不能把时间未知的晚课说成已经上完', () => {
  const settings = emptySettings();
  settings.sectionTimes[0] = { start: '08:15', end: '08:55' };
  settings.sectionTimes[1] = { start: '09:00', end: '09:40' };
  const result = brief.buildTodayBrief({ today: '2026-11-10', clockMinutes: 600, goals: [], settings,
    courses: [course({ startSection: 9, endSection: 10, sectionRanges: [{ start: 9, end: 10 }] })] });
  assert.ok(result.sentences.every((s) => !s.includes('已经上完')));
});

test('简报：重叠课程包住的小课结束后仍不算空闲', () => {
  const settings = emptySettings();
  for (let i = 0; i < 8; i += 1) settings.sectionTimes[i] = {
    start: `${String(8 + i).padStart(2, '0')}:00`, end: `${String(8 + i).padStart(2, '0')}:40`,
  };
  const result = brief.buildTodayBrief({ today: '2026-11-10', clockMinutes: 400, goals: [], settings,
    courses: [course({ id: 'long', startSection: 1, endSection: 6, sectionRanges: [{ start: 1, end: 6 }] }),
      course({ id: 'short', startSection: 3, endSection: 4, sectionRanges: [{ start: 3, end: 4 }] }),
      course({ id: 'next', startSection: 7, endSection: 8, sectionRanges: [{ start: 7, end: 8 }] })] });
  assert.equal(result.rows.filter((r) => r.kind === 'free').length, 0);
});

test('首页：课表读取失败明确显示未知，不能断言今天没课', async () => {
  const page = loadPage('home', { listCourses: async () => { throw new Error('断网'); } });
  await page.loadToday();
  assert.match(page.data.brief.headline, /读取|读到|暂时/u);
  assert.ok(page.data.brief.sentences.every((s) => !s.includes('没有安排课程')));
});

test('首页：已有课程但今日无课，与完全没有课表分别展示', async () => {
  const page = loadPage('home', { listCourses: async () => ({ courses: [course()] }) });
  page.fixedToday = '2026-11-14'; // 周六，已有周二课程。
  await page.loadToday();
  assert.equal(page.data.hero.mode, 'class');
  assert.match(page.data.hero.title, /今天没有课/);
  assert.equal(page.data.hero.key, '');
  const empty = loadPage('home', { listCourses: async () => ({ courses: [] }) });
  empty.fixedToday = '2026-11-14';
  await empty.loadToday();
  assert.equal(empty.data.hero.mode, 'empty');
});
