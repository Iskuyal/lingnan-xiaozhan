const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 课程管理页（设计图 08）的行为测试：与 tests/timetable-pages.test.cjs 同一套骨架——
// 用 vm 加载构建产物里的页面定义，把 wx 与云函数调用换成桩，只验证页面编排。
// 云函数本身的归属校验在 tests/timetable-flow.test.cjs 里对真实入口验证。
const PAGE_DIR = path.resolve('miniprogram/pages/timetable/manage');

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let target = page.data;
        for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
        target[parts[parts.length - 1]] = value;
        continue;
      }
      page.data[key] = value;
    }
  };
  return page;
}

function loadPage(route, wx, stack = [{}, {}]) {
  globalThis.wx = wx;
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = instantiate(options); },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout,
    clearTimeout,
  }, { filename });
  return page;
}

/**
 * vm 里造出来的数组与主 realm 的 Array 不是同一个原型，严格深比较会因此判不等
 * （既有测试比的是服务层在主 realm 造出来的数组，所以没碰到这一条）。
 * 比较前先拷成主 realm 的数组。
 */
function list(value, mapper) {
  return mapper === undefined ? Array.from(value) : Array.from(value, mapper);
}

/** 云函数桩：按 action 返回预设结果，并记录调用。 */
function cloudStub(handlers) {
  const calls = [];
  return {
    calls,
    callFunction(options) {
      calls.push({ name: options.name, data: options.data });
      const handler = handlers[options.data.action];
      if (handler === undefined) return Promise.reject(new Error(`未预设的 action：${options.data.action}`));
      const result = typeof handler === 'function' ? handler(options.data) : handler;
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ result });
    },
  };
}

/**
 * wx 桩：与既有骨架一致（actions 里记 modal:标题）。
 * 额外记下 showModal 的完整参数，便于断言「确认文案里带门数」；
 * autoConfirm=false 时模拟学生点了取消（取消不得产生任何写入）。
 */
function baseWx(cloud, extra = {}, autoConfirm = true) {
  const actions = [];
  const modals = [];
  return {
    cloud,
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => {
      actions.push(`modal:${options.title}`);
      modals.push(options);
      if (typeof options.success === 'function') options.success({ confirm: autoConfirm, cancel: !autoConfirm });
    },
    actions,
    modals,
    ...extra,
  };
}

/** 一条已保存课程；测试只关心统计与展示口径，其余字段给足默认值。 */
function course(patch) {
  return {
    id: 'tc_x',
    name: '课程',
    credits: '',
    teacher: '',
    weekday: 1,
    startSection: 1,
    endSection: 2,
    sectionRanges: [{ start: 1, end: 2 }],
    weeks: [1],
    weeksRecognized: true,
    weekText: '[1]周',
    location: '',
    campus: '',
    siteNumber: '',
    note: '',
    warnings: [],
    source: 'excel',
    semester: '2026-2027学年第一学期',
    rawText: '',
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

/**
 * 四个状态各一条：导入 + 待核对（周次未识别）+ 手工（无教师）+ 只在第 1 周的课。
 * 第 4 周在读 = 高等数学 + 体育（三）+ 我的大学生活我做主 = 3 门。
 */
function fourCourses() {
  return [
    course({
      id: 'tc_1',
      name: '高等数学',
      teacher: '林加燕',
      weekday: 1,
      startSection: 5,
      endSection: 6,
      sectionRanges: [{ start: 5, end: 6 }],
      weeks: [2, 3, 4],
      weekText: '[2-4]周',
    }),
    course({
      id: 'tc_2',
      name: '体育（三）',
      weekday: 4,
      startSection: 3,
      endSection: 4,
      sectionRanges: [{ start: 3, end: 4 }],
      weeks: [],
      weeksRecognized: false,
      weekText: '',
      warnings: ['周次未识别，已按每周展示'],
    }),
    course({
      id: 'tc_3',
      name: '我的大学生活我做主',
      weekday: 3,
      startSection: 3,
      endSection: 4,
      sectionRanges: [{ start: 3, end: 4 }],
      weeks: [1, 2, 3, 4, 5],
      weekText: '[1-5]周',
      source: 'manual',
    }),
    course({
      id: 'tc_4',
      name: '玩转 AI',
      teacher: '黄比悉',
      weekday: 1,
      startSection: 1,
      endSection: 2,
      sectionRanges: [{ start: 1, end: 2 }],
      weeks: [1],
      weekText: '[1]周',
    }),
  ];
}

function feedOf(courses) {
  return {
    ok: true,
    count: courses.length,
    semester: '2026-2027学年第一学期',
    updatedAt: '2026-09-20T10:00:00.000Z',
    courses,
  };
}

function load(cloud, week = '4', autoConfirm = true) {
  const wx = baseWx(cloud, {}, autoConfirm);
  const page = loadPage('timetable/manage', wx);
  page.onLoad(week === null ? {} : { week });
  return { page, wx };
}

test('课程管理页：统计数字与数据一致，筛选只影响显示不影响数据', async () => {
  const courses = fourCourses();
  const cloud = cloudStub({ list: () => feedOf(courses) });
  const { page } = load(cloud, '4');

  await page.onShow();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.semesterText, '2026-2027学年第一学期');
  assert.equal(page.data.total, 4, '共 N 门课程 = 云端的课程条数');
  assert.equal(page.data.weekInCount, 3, '第 4 周在读 = 高等数学 + 体育（三）+ 我的大学生活我做主');
  assert.equal(page.data.reviewCount, 1, '待核对 = warnings 非空');
  assert.equal(page.data.manualCount, 1, '手工 = source 为 manual');
  assert.equal(page.data.importedCount, 3, '导入 = 来源不是手工（含 Excel 与截图识别）');
  assert.equal(page.data.rows.length, 4, '默认筛选是全部');

  // 列表顺序：星期、节次、课程名（与主页列表同一口径）。
  assert.deepEqual(list(page.data.rows, (row) => row.id), ['tc_4', 'tc_1', 'tc_3', 'tc_2']);

  // 副行：星期 · 节次 · 周次 · 教师；缺的字段不显示，不补占位。
  const math = page.data.rows.find((row) => row.id === 'tc_1');
  assert.equal(math.sub, '星期一 · 第 5-6 节 · 第 2-4 周 · 林加燕');
  const manual = page.data.rows.find((row) => row.id === 'tc_3');
  assert.equal(manual.sub, '星期三 · 第 3-4 节 · 第 1-5 周', '教师未填就不写这一段');
  assert.equal(manual.manual, true);
  const review = page.data.rows.find((row) => row.id === 'tc_2');
  assert.equal(review.sub, '星期四 · 第 3-4 节 · 周次待核对');
  assert.equal(review.needsReview, true);

  // 课程色条用的是色板实色（按课程名稳定取色，与周网格同一口径）。
  const palette = require('../dist/services/timetable/palette.js');
  assert.equal(math.solid, palette.courseColor('高等数学').solid);
  assert.equal(review.solid, palette.courseColor('体育（三）').solid);
  assert.notEqual(math.solid, review.solid, '同名恒同色、异名不同色（这两个名字恰好不同色）');

  // 筛选：只换显示的行，课程数据、统计与选中态都不动。
  page.selectFilter({ currentTarget: { dataset: { key: 'review' } } });
  assert.equal(page.data.filter, 'review');
  assert.deepEqual(list(page.data.rows, (row) => row.id), ['tc_2']);
  assert.equal(page.data.courses.length, 4, '筛选不改课程数据');
  assert.equal(page.data.total, 4);
  assert.equal(page.data.weekInCount, 3);

  page.selectFilter({ currentTarget: { dataset: { key: 'manual' } } });
  assert.deepEqual(list(page.data.rows, (row) => row.id), ['tc_3']);

  page.selectFilter({ currentTarget: { dataset: { key: 'imported' } } });
  assert.deepEqual(list(page.data.rows, (row) => row.id), ['tc_4', 'tc_1', 'tc_2'], '导入 = 非手工的三门');

  page.selectFilter({ currentTarget: { dataset: { key: 'all' } } });
  assert.equal(page.data.rows.length, 4);
  delete globalThis.wx;
});

test('课程管理页：没带入口周次时按第 1 周统计', async () => {
  const courses = [
    course({ id: 'tc_a', name: '只在第 2 周', weeks: [2], weekText: '[2]周' }),
    course({ id: 'tc_b', name: '每周都要上', weeks: [], weeksRecognized: false, weekText: '' }),
  ];
  const cloud = cloudStub({ list: () => feedOf(courses) });

  const first = load(cloud, null);
  await first.page.onShow();
  assert.equal(first.page.data.weekInCount, 1, '第 1 周只有「每周都要上」');

  const second = load(cloud, '2');
  await second.page.onShow();
  assert.equal(second.page.data.weekInCount, 2, '入口带了第 2 周就按第 2 周统计');
  delete globalThis.wx;
});

test('课程管理页：全选与取消全选只作用于当前筛选下的行', async () => {
  const courses = fourCourses();
  const cloud = cloudStub({ list: () => feedOf(courses) });
  const { page } = load(cloud, '4');
  await page.onShow();

  assert.equal(page.data.selectedCount, 0);
  assert.equal(page.data.allSelected, false);

  page.toggleSelectAll();
  assert.deepEqual(list(page.data.selectedIds), ['tc_4', 'tc_1', 'tc_3', 'tc_2']);
  assert.equal(page.data.selectedCount, 4);
  assert.equal(page.data.allSelected, true);
  assert.equal(page.data.rows.every((row) => row.selected), true, '选中行整行高亮');

  page.toggleSelectAll();
  assert.deepEqual(list(page.data.selectedIds), []);
  assert.equal(page.data.allSelected, false);

  // 单行勾选：再点一次取消。
  page.toggleRow({ currentTarget: { dataset: { id: 'tc_1' } } });
  assert.deepEqual(list(page.data.selectedIds), ['tc_1']);
  assert.equal(page.data.rows.find((row) => row.id === 'tc_1').selected, true);
  page.toggleRow({ currentTarget: { dataset: { id: 'tc_1' } } });
  assert.deepEqual(list(page.data.selectedIds), []);

  // 筛选到「待核对」后全选：只选中看得见的那一行。
  page.selectFilter({ currentTarget: { dataset: { key: 'review' } } });
  page.toggleSelectAll();
  assert.deepEqual(list(page.data.selectedIds), ['tc_2']);
  assert.equal(page.data.allSelected, true);
  assert.equal(page.data.selectedCount, 1);
  delete globalThis.wx;
});

test('课程管理页：删除所选先弹确认，确认后逐个调用云函数、重新拉取并清空选中', async () => {
  const courses = fourCourses();
  const cloud = cloudStub({
    list: () => feedOf(courses),
    deleteCourse: (data) => ({ ok: true, id: data.id, count: 2 }),
  });
  const { page, wx } = load(cloud, '4');
  await page.onShow();

  page.toggleRow({ currentTarget: { dataset: { id: 'tc_2' } } });
  page.toggleRow({ currentTarget: { dataset: { id: 'tc_4' } } });
  assert.deepEqual(list(page.data.selectedIds), ['tc_2', 'tc_4']);

  const task = page.deleteSelected();
  assert.ok(wx.actions.includes('modal:删除所选课程'), '删除前必须二次确认');
  assert.match(wx.modals[0].content, /2 门/u, '确认文案里带门数');
  assert.match(wx.modals[0].content, /无法撤销/u);
  await task;
  await new Promise((resolve) => setImmediate(resolve));

  // 入参就是选中的那两条 id 的集合（顺序按勾选顺序），逐个调用。
  const deleted = cloud.calls.filter((call) => call.data.action === 'deleteCourse').map((call) => call.data.id);
  assert.deepEqual(deleted.sort(), ['tc_2', 'tc_4']);
  assert.equal(deleted.length, 2, '只删选中的，没勾的一门都不动');

  assert.equal(cloud.calls.filter((call) => call.data.action === 'list').length, 2, '删除后重新拉取列表');
  assert.deepEqual(list(page.data.selectedIds), [], '删除后清空选中');
  assert.equal(page.data.selectedCount, 0);
  assert.ok(wx.actions.includes('toast:已删除 2 门课程'));
  delete globalThis.wx;
});

test('课程管理页：取消确认不调用删除，也不动选中态', async () => {
  const courses = fourCourses();
  const cloud = cloudStub({
    list: () => feedOf(courses),
    deleteCourse: (data) => ({ ok: true, id: data.id, count: 3 }),
  });
  const { page, wx } = load(cloud, '4', false);
  await page.onShow();

  page.toggleRow({ currentTarget: { dataset: { id: 'tc_1' } } });
  page.deleteSelected();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(wx.actions.includes('modal:删除所选课程'));
  assert.equal(cloud.calls.filter((call) => call.data.action === 'deleteCourse').length, 0, '取消后不得产生任何删除调用');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'list').length, 1, '取消后不重新拉取');
  assert.deepEqual(list(page.data.selectedIds), ['tc_1'], '取消后选中态原样');
  delete globalThis.wx;
});

test('课程管理页：部分失败如实报出「N 门成功、M 门失败」', async () => {
  const courses = fourCourses();
  const cloud = cloudStub({
    list: () => feedOf(courses),
    deleteCourse: (data) => (data.id === 'tc_2' ? new Error('课表服务暂时不可用') : { ok: true, id: data.id, count: 3 }),
  });
  const { page, wx } = load(cloud, '4');
  await page.onShow();

  page.toggleRow({ currentTarget: { dataset: { id: 'tc_1' } } });
  page.toggleRow({ currentTarget: { dataset: { id: 'tc_2' } } });
  await page.deleteSelected();
  await new Promise((resolve) => setImmediate(resolve));

  const failure = wx.modals.find((modal) => /门失败/u.test(modal.content));
  assert.ok(failure !== undefined, '部分失败必须报出来，不能笼统说成功');
  assert.match(failure.content, /1 门成功、1 门失败/u);
  assert.match(failure.content, /课表服务暂时不可用/u, '失败原因要如实带上');
  assert.equal(wx.actions.some((action) => action.startsWith('toast:已删除')), false, '部分失败不能只报成功');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'deleteCourse').length, 2, '一条失败不影响另一条');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'list').length, 2, '失败也要以云端为准重新拉取');
  assert.deepEqual(list(page.data.selectedIds), []);
  delete globalThis.wx;
});

test('课程管理页：读不到课表时给错误与重试，不静默显示旧数据', async () => {
  const cloud = cloudStub({ list: () => new Error('云函数调用失败') });
  const { page } = load(cloud, '4');
  await page.onShow();
  assert.equal(page.data.status, 'error');
  assert.match(page.data.errorMessage, /云函数调用失败/u);
  delete globalThis.wx;
});

test('课程管理页：没有课程与筛选后为空是两种文案', async () => {
  const empty = cloudStub({ list: () => feedOf([]) });
  const first = load(empty, '4');
  await first.page.onShow();
  assert.equal(first.page.data.status, 'empty', '没有课程是空态');
  assert.equal(first.page.data.showActions, false, '空态不摆动作条');

  const onlyExcel = [course({ id: 'tc_1', name: '高等数学', weeks: [1] })];
  const cloud = cloudStub({ list: () => feedOf(onlyExcel) });
  const { page } = load(cloud, '4');
  await page.onShow();
  assert.equal(page.data.status, 'ready', '有课程时筛选为空不是空态');
  page.selectFilter({ currentTarget: { dataset: { key: 'manual' } } });
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.courses.length, 1, '筛选为空不动数据');
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.showActions, false, '没有可操作的行就不摆动作条');

  page.resetFilter();
  assert.equal(page.data.filter, 'all');
  assert.equal(page.data.rows.length, 1, '从筛选空态一键回到全部');
  delete globalThis.wx;
});

test('课程管理页：从入口返回上页，直接打开则回到课表', () => {
  const cloud = cloudStub({});
  for (const [stack, expected] of [
    [[{}, {}], ['navigateBack']],
    [[{}], ['reLaunch:/pages/timetable/index']],
  ]) {
    const wx = baseWx(cloud);
    const page = loadPage('timetable/manage', wx, stack);
    page.goBack();
    assert.deepEqual(wx.actions, expected);
  }
  delete globalThis.wx;
});

test('课程管理页：模板与样式的硬规则（id、文案、不出现具体时刻）', () => {
  const wxml = fs.readFileSync(path.join(PAGE_DIR, 'index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(PAGE_DIR, 'index.wxss'), 'utf8');
  const page = fs.readFileSync(path.join(PAGE_DIR, 'index.ts'), 'utf8');

  for (const id of [
    'manage-list',
    'manage-select-all',
    'manage-delete-selected',
    'manage-filter-all',
    'manage-filter-review',
    'manage-filter-manual',
    'manage-filter-excel',
    'manage-back',
  ]) {
    assert.ok(wxml.includes(`id="${id}"`), `页面缺少元素 id：${id}`);
  }

  // 动作条与后果说明：文案照设计图 08。
  assert.match(wxml, /删除所选 \{\{selectedCount\}\} 门/u);
  assert.match(wxml, /取消全选/u);
  assert.match(wxml, /全选/u);
  assert.match(wxml, /删除会连同这些课的全部分段一起删掉，无法撤销/u);
  assert.match(wxml, /class="mg-total-num">\{\{total\}\}/u);
  assert.match(wxml, /class="mg-total-label">门课程已保存/u);
  assert.match(wxml, /本周开课/u);
  assert.match(wxml, /待核对 \{\{reviewCount\}\}/u);
  assert.match(wxml, /手工 \{\{manualCount\}\}/u);
  assert.match(wxml, /导入 \{\{importedCount\}\}/u);
  assert.match(wxml, /待核对/u);
  assert.match(wxml, /手工/u);
  // 状态标签跟在副行末尾（设计图 08 的写法），不是跟在课程名后面。
  assert.match(wxml, /class="mg-sub">\{\{item\.sub\}\}<text[^>]*mg-chip-review/u);
  assert.match(wxml, /<\/text><text[^>]*mg-chip-plain/u);

  // 两种空态各用各的文案，返回课表的入口 id 都在。
  assert.match(wxml, /还没有课程/u);
  assert.match(wxml, /这个筛选下没有课程/u);

  // 学校作息未核实：全链路不出现任何具体上课时刻。
  for (const [name, source] of [['index.wxml', wxml], ['index.wxss', wxss], ['index.ts', page]]) {
    assert.doesNotMatch(source, /\d{1,2}:\d{2}/u, `${name} 里出现了具体时刻`);
  }
});

test('课程管理页：行内编辑不改变勾选，取消单门删除不写入', async () => {
  const cloud = cloudStub({ list: () => feedOf(fourCourses()) });
  const { page, wx } = load(cloud, '4', false);
  await page.onShow();
  const id = page.data.courses[0].id;
  page.toggleRow({ currentTarget: { dataset: { id } } });
  const selected = list(page.data.selectedIds);
  page.editRow({ currentTarget: { dataset: { id } } });
  assert.ok(wx.actions.includes(`navigateTo:/pages/timetable/edit/index?id=${encodeURIComponent(id)}`));
  assert.deepEqual(list(page.data.selectedIds), selected);
  await page.deleteRow({ currentTarget: { dataset: { id } } });
  assert.ok(wx.modals[0].content.includes(page.data.courses[0].name));
  assert.equal(cloud.calls.filter(item => item.data.action !== 'list').length, 0);
  assert.deepEqual(list(page.data.selectedIds), selected);
  delete globalThis.wx;
});

test('课程管理页：确认单门删除只删除指向的课程，然后重读', async () => {
  let courses = fourCourses();
  const id = courses[1].id;
  const deleted = [];
  const cloud = cloudStub({
    list: () => feedOf(courses),
    deleteCourse: data => {
      deleted.push(data.id);
      courses = courses.filter(item => item.id !== data.id);
      return { ok: true };
    },
  });
  const { page } = load(cloud);
  await page.onShow();
  await page.deleteRow({ currentTarget: { dataset: { id } } });
  assert.deepEqual(deleted, [id]);
  assert.equal(page.data.courses.some(item => item.id === id), false);
  assert.equal(page.data.deleting, false);
  delete globalThis.wx;
});
