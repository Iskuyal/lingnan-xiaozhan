const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 导入确认页的双视图（设计图 09）：列表看细节（节次 / 周次 / 地点 / 原文 / 修正 / 删除），
// 课表看落位。草稿 → 网格的映射是纯函数，直接 require 构建产物验算；页面行为沿用
// tests/timetable-pages.test.cjs 的骨架（vm 加载构建产物 + wx / 云函数桩）。
const draftGrid = require('../dist/pages/timetable/import/draft-grid.js');
const draftStore = require('../dist/services/timetable/draft.js');
const cloudParse = require('../dist/cloudfunctions/timetable/parse.js');

const STANDARD_FIXTURE = '2026-2027学年第一学期班级课表.xls';

function realDraft() {
  return cloudParse.parseWorkbook(fs.readFileSync(path.resolve('tests/fixtures/timetable', STANDARD_FIXTURE)), STANDARD_FIXTURE);
}

/** 一条草稿课程；默认是「周一第 1-4 节、第 1-2 周」的干净条目，用例只覆盖关心的字段。 */
function draftCourse(overrides) {
  return {
    draftId: 'd0',
    name: '高等数学',
    credits: '1.5',
    teacher: '林加燕',
    weekday: 1,
    startSection: 1,
    endSection: 4,
    sectionRanges: [{ start: 1, end: 4 }],
    weeks: [1, 2],
    weeksRecognized: true,
    weekText: '[1-2]周',
    location: '崇礼楼-306',
    campus: '',
    siteNumber: '',
    note: '',
    warnings: [],
    source: 'excel',
    rawText: '高等数学 1.5 林加燕 [1-2]周 1-4节 崇礼楼-306',
    sourceRowLabel: '一',
    sourceWeekdayLabel: '星期一',
    ...overrides,
  };
}

function draftOf(courses) {
  return {
    meta: {
      sheetName: '数据表',
      fileName: '课表.xls',
      school: '某某职业技术学院',
      semester: '2026-2027学年第一学期',
      exportedAt: '',
      department: '',
      grade: '',
      major: '',
      className: '25软件技术(专升本)2班',
    },
    courses,
    problems: [],
    stats: { sheets: 1, cells: 9, entries: 9, courses: courses.length, duplicates: 0, warnings: 0 },
  };
}

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

function baseWx(cloud, extra = {}) {
  const actions = [];
  return {
    cloud,
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => {
      actions.push(`modal:${options.title}`);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
    actions,
    ...extra,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 页面数据来自 vm 里的另一个 realm，`deepStrictEqual` 会因原型不同判不等；
 * 断言前先过一遍 JSON，把两边都拉回本 realm 的普通对象。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 走「选文件 → 解析 → 确认页」，返回确认页与它的桩。 */
async function reviewPage(draft, extra = {}, handlers = {}) {
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
    saveDraft: (data) => ({ ok: true, saved: data.courses.length }),
    ...handlers,
  });
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/课表.xls', name: '课表.xls', size: 2048 }] }),
    ...extra,
  });
  wx.cloud.uploadFile = (options) => {
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.chooseFile();
  await flush();
  await flush();
  return { page, wx, cloud };
}

function writtenActions(cloud) {
  return cloud.calls.filter((call) => ['saveDraft', 'createCourse', 'updateCourse', 'deleteCourse'].includes(call.data.action));
}

test('草稿→网格：缺节次不落格、同格多门折叠、周次未识别按每周展示', () => {
  const draft = draftOf([
    draftCourse({ draftId: 'd0', name: '高等数学', weekday: 1, sectionRanges: [{ start: 1, end: 4 }], weeks: [4, 5] }),
    draftCourse({ draftId: 'd1', name: '劳动教育（一）', weekday: 1, sectionRanges: [{ start: 1, end: 4 }], weeks: [4] }),
    draftCourse({
      draftId: 'd2',
      name: '体育（三）',
      weekday: 4,
      sectionRanges: [{ start: 3, end: 4 }],
      weeks: [],
      weeksRecognized: false,
      weekText: '4',
      warnings: ['原文只有一个「4」，没识别成教学周，已按每周展示'],
    }),
    draftCourse({
      draftId: 'd3',
      name: '待定',
      weekday: 2,
      startSection: 0,
      endSection: 0,
      sectionRanges: [],
      warnings: ['节次待核对'],
      rawText: '待定 三 5-6 教师待补',
    }),
  ]);
  const result = draftGrid.buildDraftGrid(draft);

  assert.equal(result.layout.columns.length, 7, '网格始终是 7 天');
  assert.equal(result.layout.placed, 3, '缺节次的草稿不落格');
  assert.equal(result.unplaced, 1);
  assert.equal(result.unplacedBlocked, 1, '未落格且待补全的条数单独给出，避免同一件事说两遍');

  const monday = result.layout.columns[0];
  assert.deepEqual(monday.blocks.map((block) => [block.name, block.count]), [['高等数学', 2]], '同格两门折叠成一块');
  assert.deepEqual(monday.blocks[0].ids, ['d0', 'd1'], '折叠块记下同格的每一门（草稿没有 id，用 draftId）');
  assert.equal(monday.narrow, false, '有课的天不收窄');

  const thursday = result.layout.columns[3];
  assert.deepEqual(thursday.blocks.map((block) => block.name), ['体育（三）'], '周次未识别的草稿按每周展示，落进网格');
  assert.equal(thursday.blocks[0].needsReview, true, '待核对草稿块要能被标成琥珀虚线框');
  assert.equal(thursday.blocks[0].start, 3);
  assert.equal(thursday.blocks[0].end, 4);

  assert.equal(result.layout.columns[1].blocks.length, 0, '缺节次的草稿不猜位置，不落进星期二');
  assert.equal(result.layout.columns[1].narrow, true, '没课的天收窄（版式规则 1）');
  assert.ok(
    result.layout.columns.every((column) => column.narrow === (column.blocks.length === 0)),
    '列宽只取决于这一列有没有课',
  );

  // 星期越界的草稿也画不出来，且与「待补全」是同一类：不落格但不报「落位之外」。
  const strayed = draftGrid.buildDraftGrid(draftOf([draftCourse({ draftId: 'd9', weekday: 0, weeks: [] })]));
  assert.equal(strayed.layout.placed, 0);
  assert.equal(strayed.unplaced, 1);
  assert.equal(strayed.unplacedBlocked, 1);
});

test('草稿→网格：映射用 draftId 当临时 id，课程名缺失用占位名，不筛周次', () => {
  const semester = '2026-2027学年第一学期';
  const mapped = draftGrid.toCourse(draftCourse({ draftId: 'd0', weeks: [7, 8], weeksRecognized: true }), 0, semester);
  assert.equal(mapped.id, 'd0', '草稿没有 id，用 draftId 当临时 id');
  assert.equal(mapped.name, '高等数学');
  assert.equal(mapped.semester, semester);
  assert.deepEqual(mapped.weeks, [], '导入页的网格不筛周次');
  assert.equal(mapped.weeksRecognized, true);
  assert.equal(mapped.sectionRanges.length, 1, '节次原样交给 buildGrid');
  assert.equal(mapped.id === draftGrid.toCourse(draftCourse({ draftId: '' }), 3, semester).id, false);
  assert.equal(draftGrid.toCourse(draftCourse({ draftId: '' }), 3, semester).id, 'draft-3', '没有 draftId 时按序编号');
  assert.equal(draftGrid.toCourse(draftCourse({ name: '' }), 1, semester).name, '课程名未识别', '与列表同一套占位名');

  // 周次在第 1 周之外的课同样落格：这张网格回答的是「落在星期几第几节」。
  const layout = draftGrid.buildDraftGrid(draftOf([draftCourse({ draftId: 'd0', weeks: [7, 8] })])).layout;
  assert.equal(layout.placed, 1);
  assert.deepEqual(layout.columns[0].blocks.map((block) => block.primaryId), ['d0']);
});

test('导入页：列表 / 课表切换只改视图，不改草稿、不写库', async () => {
  const draft = realDraft();
  const { page, cloud } = await reviewPage(draft);
  assert.equal(page.data.step, 'review');
  assert.equal(page.data.draftView, 'list', '默认是列表视图（设计图 09）');
  const itemsBefore = plain(page.data.items);
  const coursesBefore = plain(draftStore.getDraft().courses);

  page.switchView({ currentTarget: { dataset: { mode: 'grid' } } });
  assert.equal(page.data.draftView, 'grid');
  assert.deepEqual(plain(page.data.items), itemsBefore, '切视图不改列表条目');
  assert.deepEqual(plain(draftStore.getDraft().courses), coursesBefore, '切视图不改内存草稿');
  assert.equal(page.data.draftGrid.columns.length, 7, '课表视图拿到的是网格');
  assert.equal(page.data.draftGrid.placed, coursesBefore.length, '真实样本每一门都落格');
  assert.deepEqual(writtenActions(cloud), [], '切视图不写任何数据');

  page.switchView({ currentTarget: { dataset: { mode: 'list' } } });
  assert.equal(page.data.draftView, 'list');
  page.switchView({ currentTarget: { dataset: { mode: '表格' } } });
  assert.equal(page.data.draftView, 'list', '不认识的视图名不改视图');
  delete globalThis.wx;
});

test('导入页：未识别的行可以补录或跳过，两者都不写库', async () => {
  const draft = realDraft();
  const target = draft.courses[0];
  const rawText = target.rawText;
  const total = draft.courses.length;
  target.name = '';
  target.sectionRanges = [];
  target.startSection = 0;
  target.endSection = 0;
  target.warnings = ['没读出课程名'];
  const before = plain(draft.courses);
  const { page, wx, cloud } = await reviewPage(draft);

  assert.equal(page.data.blockedCount, 1);
  const blocked = page.data.items.find((item) => item.blocking !== '');
  assert.ok(blocked, '未识别的行要能被挑出来');
  assert.equal(blocked.rawText, rawText, '未识别的行要带上原文');
  assert.ok(rawText.length > 0);
  assert.equal(page.data.draftGrid.placed, total - 1, '未识别的行不落格');

  // 补录：打开这条草稿的修正表单（草稿态），回来时 onShow 会刷新确认页。
  page.fixItem({ currentTarget: { dataset: { index: blocked.index } } });
  assert.ok(
    wx.actions.includes(`navigateTo:/pages/timetable/edit/index?scope=draft&index=${blocked.index}`),
    '补录要打开这条草稿的修正表单',
  );

  // 跳过：只从内存草稿里去掉这一行。
  page.skipItem({ currentTarget: { dataset: { index: blocked.index } } });
  assert.equal(page.data.blockedCount, 0);
  assert.equal(page.data.items.length, total - 1);
  assert.deepEqual(
    plain(draftStore.getDraft().courses),
    before.filter((_, index) => index !== blocked.index),
    '被跳过的那条已离开草稿',
  );
  assert.equal(draftStore.hasDraft(), true, '其余草稿仍留在内存里');
  assert.deepEqual(writtenActions(cloud), [], '补录与跳过都不写库');
  delete globalThis.wx;
});

test('导入页：缺节次时确认保存仍被拦，课表视图改成一行说明', async () => {
  const draft = realDraft();
  draft.courses[0].sectionRanges = [];
  draft.courses[0].startSection = 0;
  draft.courses[0].endSection = 0;
  draft.courses[0].warnings = ['节次待核对'];
  const modals = [];
  const { page, cloud } = await reviewPage(draft, {
    showModal: (options) => {
      modals.push(options);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
  });

  assert.equal(page.data.blockedCount, 1);
  assert.match(page.data.items[0].blocking, /节次待补全/u, '沿用 blockingReason 的口径');
  assert.match(page.data.metaLine, /^其中 \d+ 门待核对、1 门需要补全，补全后才能保存$/u);

  page.switchView({ currentTarget: { dataset: { mode: 'grid' } } });
  assert.match(page.data.gridHintWarn, /1 条待补全/u, '缺节次的草稿在课表视图里给一行说明');
  assert.match(page.data.gridHintWarn, /切到列表/u);
  assert.equal(
    page.data.draftGrid.placed,
    page.data.items.length - 1,
    '缺节次的草稿不落格，其余照常落位',
  );

  page.confirmSave();
  assert.equal(writtenActions(cloud).length, 0, '有待补全的条目仍不能保存');
  assert.ok(modals.some((modal) => modal.title === '还有待补全的课程'));
  delete globalThis.wx;
});

test('导入页：删除草稿只改内存草稿，不写库', async () => {
  const draft = realDraft();
  const total = draft.courses.length;
  const before = plain(draft.courses);
  const { page, wx, cloud } = await reviewPage(draft);

  page.deleteItem({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.items.length, total - 1);
  assert.deepEqual(
    plain(draftStore.getDraft().courses),
    before.filter((_, index) => index !== 1),
    '草稿里只剩没被删的那些',
  );
  assert.equal(draftStore.hasDraft(), true, '其余草稿仍在内存里');
  assert.equal(page.data.courseCount, total - 1, '课程数跟着草稿走');
  assert.deepEqual(writtenActions(cloud), [], '删除只动内存草稿');
  assert.ok(wx.actions.some((action) => action.startsWith('toast:')));
  delete globalThis.wx;
});

test('导入页：元信息卡列出学期 / 班级 / 来源文件 / 解析结果与待核对统计', async () => {
  const draft = realDraft();
  const { page } = await reviewPage(draft);
  const rows = page.data.metaRows;

  assert.deepEqual(plain(rows).map((row) => row.key), ['学期', '班级', '来源文件', '解析结果']);
  assert.equal(rows[0].value, '2026-2027学年第一学期');
  assert.equal(rows[1].value, draft.meta.className);
  assert.equal(rows[2].value, draft.meta.fileName);
  assert.equal(
    rows[3].value,
    `${draft.stats.courses} 门课程（文件里 ${draft.stats.entries} 条课条目，按大节去重后 ${draft.stats.courses} 门）`,
    '解析结果要写清「文件里 N 条、去重后 M 门」',
  );
  assert.match(page.data.metaLine, /^其中 \d+ 门待核对、0 门需要补全，可以保存$/u);
  assert.equal(page.data.semesterText, '2026-2027学年第一学期');
  delete globalThis.wx;
});

test('导入页：确认页模板保留既有入口 id，双视图与草稿虚线框写在模板里', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/import/index.wxml'), 'utf8');
  for (const id of ['draft-list', 'confirm-save', 'abandon-import', 'file-guide', 'choose-file', 'back-from-import', 'import-error']) {
    assert.ok(wxml.includes(`id="${id}"`), `模板缺少 ${id}`);
  }
  for (const needed of ['data-mode="list"', 'data-mode="grid"', '原文：', '保存会替换当前已保存的课表', '保存前不会写入任何数据']) {
    assert.ok(wxml.includes(needed), `模板缺少「${needed}」`);
  }
  assert.match(wxml, /bindtap="fixItem">补录</u, '未识别的行要点名「补录」');
  assert.match(wxml, /bindtap="skipItem">跳过</u, '未识别的行要点名「跳过」');
  assert.ok(!/\d{1,2}:\d{2}/u.test(wxml), '确认页不出现具体时刻（学校作息未核实）');
});
