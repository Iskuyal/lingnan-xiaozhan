const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 页面行为测试：用 vm 加载构建产物里的页面定义，把 wx 与云函数调用替换成桩。
// 云函数本身的行为在 tests/timetable-flow.test.cjs 里对真实入口验证，这里只验证页面编排。
const cloudParse = require('../dist/cloudfunctions/timetable/parse.js');
const draftStore = require('../dist/services/timetable/draft.js');

const STANDARD_FIXTURE = '2026-2027学年第一学期班级课表.xls';

function realDraft() {
  return cloudParse.parseWorkbook(fs.readFileSync(path.resolve('tests/fixtures/timetable', STANDARD_FIXTURE)), STANDARD_FIXTURE);
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

test('周课表主页：读云端课程、按周切换、删除后重新读取', async () => {
  const courses = [
    { id: 'tc_1', name: '高等数学', teacher: '林加燕', weekday: 1, sectionRanges: [{ start: 1, end: 2 }], startSection: 1, endSection: 2, weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', credits: '1.5', createdAt: '', updatedAt: '2026-09-18T10:00:00.000Z' },
    { id: 'tc_2', name: '体育一', teacher: '陈壮寿', weekday: 3, sectionRanges: [{ start: 7, end: 8 }], startSection: 7, endSection: 8, weeks: [6, 7], weeksRecognized: true, weekText: '[6-7]周', location: '篮球1号场', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', credits: '1', createdAt: '', updatedAt: '2026-09-18T10:00:00.000Z' },
  ];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: courses.length, semester: '2026-2027学年第一学期', updatedAt: '2026-09-18T10:00:00.000Z', courses }),
    deleteCourse: (data) => ({ ok: true, id: data.id, count: 1 }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);

  await page.onShow();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.count, 2);
  assert.equal(page.data.semesterText, '2026-2027学年第一学期');
  assert.equal(page.data.weekOptions.length, 20);
  assert.equal(page.data.week, 1);
  assert.equal(page.data.view.total, 1, '第 1 周只有高等数学');
  // 网格与列表同源：网格按节次落位（高等数学在星期一第 1-2 节）
  assert.deepEqual(page.data.grid.columns[0].blocks.map((block) => block.name), ['高等数学']);
  assert.equal(page.data.grid.columns[0].blocks[0].start, 1);
  assert.equal(page.data.grid.columns[0].blocks[0].end, 2);
  assert.equal(page.data.grid.placed, 1);
  assert.deepEqual(page.data.grid.hasCourseWeekdays, [1], '第 1 周只有星期一有课');
  assert.deepEqual(page.data.grid.columns.map((column) => column.narrow), [false, true, true, true, true, true, true],
    '有课的天不收窄、没课的天收窄（版式规则 1）');

  page.selectWeek({ detail: { value: '5' } });
  assert.equal(page.data.week, 6);
  assert.equal(page.data.view.total, 1, '第 6 周只有体育一');
  assert.deepEqual(page.data.grid.columns[2].blocks.map((block) => block.name), ['体育一'], '体育一在星期三');
  assert.equal(page.data.grid.columns[2].blocks[0].start, 7, '第 7-8 节');
  page.previousWeek();
  assert.equal(page.data.week, 5);
  assert.equal(page.data.view.total, 0, '第 5 周没有课');
  assert.equal(page.data.view.weekLabel, '第 5 周');
  assert.equal(page.data.grid.total, 0, '网格口径跟着周次走');
  assert.deepEqual(page.data.grid.columns.map((column) => column.narrow), [true, true, true, true, true, true, true],
    '整周没课时所有列都收窄');

  page.removeCourse({ currentTarget: { dataset: { id: 'tc_1', name: '高等数学' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cloud.calls.filter((call) => call.data.action === 'deleteCourse').map((call) => call.data.id), ['tc_1']);
  assert.equal(cloud.calls.filter((call) => call.data.action === 'list').length, 2, '删除后重新读取云端');
  assert.ok(wx.actions.includes('modal:删除课程'));
  delete globalThis.wx;
});

test('周课表主页：读取失败显示错误与重试，不静默显示旧数据', async () => {
  const cloud = cloudStub({ list: () => new Error('云函数调用失败') });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  assert.equal(page.data.status, 'error');
  assert.match(page.data.errorMessage, /云函数调用失败/u);
  delete globalThis.wx;
});

test('导入页：引导文案写清只能从聊天记录选文件，且解析前不写任何数据', async () => {
  const draft = realDraft();
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
    saveDraft: (data) => ({ ok: true, saved: data.courses.length }),
  });
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/课表.xls', name: '课表.xls', size: 2048 }] }),
  });
  wx.cloud.uploadFile = (options) => {
    // 真实 wx.cloud.uploadFile 一定回传 fileID；页面必须用它（不是 cloudPath）继续调用云函数。
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  assert.equal(page.data.step, 'guide');
  assert.match(page.data.fileGuide, /聊天记录/u, '必须写明只能从微信聊天记录选择');
  assert.match(page.data.fileGuide, /文件传输助手/u, '给出可操作的中转办法');
  assert.match(page.data.fileGuide, /不能浏览/u, '说明小程序不能浏览手机本地文件');
  assert.match(page.data.offlineNote, /联网/u);

  page.chooseFile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'review');
  assert.equal(page.data.items.length, draft.courses.length);
  assert.equal(page.data.blockedCount, 0);
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveDraft').length, 0, '确认前不写任何数据');
  assert.equal(cloud.calls[0].data.action, 'prepareUpload');
  assert.equal(cloud.calls[1].data.action, 'importDraft');
  assert.equal(cloud.calls[1].data.fileName, '课表.xls');
  assert.equal(
    cloud.calls[1].data.fileID,
    'cloud://test-env.test-bucket/timetable-imports/abc/x.xls',
    'importDraft 必须传上传返回的 fileID',
  );
  assert.equal(cloud.calls[1].data.cloudPath, undefined, '不得再把裸 cloudPath 当 fileID 传下去');

  page.confirmSave();
  await new Promise((resolve) => setImmediate(resolve));
  const saves = cloud.calls.filter((call) => call.data.action === 'saveDraft');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].data.courses.length, draft.courses.length);
  assert.equal(saves[0].data.semester, '2026-2027学年第一学期');
  assert.equal(draftStore.hasDraft(), false, '保存后清空草稿');
  delete globalThis.wx;
});

test('导入页：缺少聊天记录选文件 API 时说明替代方案并留在引导页', () => {
  const cloud = cloudStub({});
  const modals = [];
  const wx = baseWx(cloud, {
    chooseMessageFile: undefined,
    showModal: (options) => modals.push(options),
  });
  const page = loadPage('timetable/import', wx);
  page.onLoad();

  try {
    assert.doesNotThrow(() => page.chooseFile(), '缺少 API 不应抛出 TypeError');
    assert.equal(page.data.step, 'guide', '保持在可选截图或返回课表的引导页');
    assert.equal(cloud.calls.length, 0, '缺少本地选文件能力时不应调用云函数');
    assert.equal(modals.length, 1, '应展示可读说明');
    assert.match(modals[0].content, /不支持.*聊天记录/u);
    assert.match(modals[0].content, /截图.*手工录入/u);
  } finally {
    delete globalThis.wx;
  }
});

test('取消选文件/图片不是失败：不报错、不打诊断日志，从确认页发起时回到确认页', async () => {
  const draft = realDraft();
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
  });
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => options.fail({ errMsg: 'chooseMessageFile:fail cancel' }),
    chooseMedia: (options) => options.fail({ errMsg: 'chooseMedia:fail cancel' }),
  });
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const page = loadPage('timetable/import', wx);
    page.onLoad();
    assert.equal(page.data.step, 'guide');
    page.chooseFile();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.data.step, 'guide', '取消选文件后应停留在引导页');
    assert.equal(page.data.errorMessage, '', '取消不该给出错误文案');
    page.choosePhoto();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.data.step, 'guide', '取消选图片后应停留在引导页');
    assert.equal(page.data.errorMessage, '');
    assert.deepEqual(logged, [], `取消是正常操作，不该产生诊断日志：${logged.join(' | ')}`);

    // 从确认页发起的重选被取消：回到确认页，草稿不丢。
    draftStore.setDraft(draft);
    page.restoreReviewIfDraft();
    assert.equal(page.data.step, 'review');
    page.chooseFile();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.data.step, 'review', '从确认页发起的重选被取消，应回到确认页');
    assert.deepEqual(logged, [], '确认页发起后被取消同样不该打日志');
  } finally {
    console.error = originalError;
    draftStore.clearDraft();
    delete globalThis.wx;
  }
});

test('导入页：缺节次的条目在确认页标出，修正或删除前不能保存', async () => {
  const draft = realDraft();
  draft.courses[0].sectionRanges = [];
  draft.courses[0].startSection = 0;
  draft.courses[0].endSection = 0;
  draft.courses[0].warnings = ['节次待核对'];
  const modals = [];
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
    saveDraft: () => ({ ok: true, saved: 1 }),
  });
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/课表.xls', name: '课表.xls', size: 2048 }] }),
    showModal: (options) => {
      modals.push(options);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
  });
  wx.cloud.uploadFile = (options) => {
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onUpdateProgress: undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.chooseFile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.blockedCount, 1);
  assert.match(page.data.items[0].blocking, /节次待补全/u);
  assert.equal(page.data.items[0].rawText.length > 0, true, '待核对条目要带上原文');

  page.confirmSave();
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveDraft').length, 0, '有待补全的条目时不写入');
  assert.ok(modals.some((modal) => modal.title === '还有待补全的课程'));

  // 删除该条后可以保存
  const totalBeforeDelete = page.data.items.length;
  page.deleteItem({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.blockedCount, 0);
  assert.equal(page.data.items.length, totalBeforeDelete - 1);
  page.confirmSave();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveDraft').length, 1);
  delete globalThis.wx;
});

test('导入页：放弃导入不写入任何数据', async () => {
  const draft = realDraft();
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
    saveDraft: () => ({ ok: true, saved: 1 }),
  });
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/课表.xls', name: '课表.xls', size: 2048 }] }),
  });
  wx.cloud.uploadFile = (options) => {
    // 真实 wx.cloud.uploadFile 一定回传 fileID；页面必须用它（不是 cloudPath）继续调用云函数。
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.chooseFile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'review');

  page.abandon();
  assert.equal(draftStore.hasDraft(), false);
  assert.equal(wx.actions.includes('navigateBack'), true);
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveDraft').length, 0, '放弃后不写任何数据');
  delete globalThis.wx;
});

test('导入页：格式不符与解析失败都给出可理解的提示，不进入确认页', async () => {
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: false, error: '未识别出课表矩阵：文件里没有找到「星期一 … 星期日」表头行与可解析的课程单元格' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/import', wx);
  page.onLoad();

  // 先试一个格式不符的文件：本地就挡下，不发起任何云端调用
  Object.assign(wx, { chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/成绩.txt', name: '成绩.txt', size: 10 }] }) });
  page.chooseFile();
  assert.equal(page.data.step, 'error');
  assert.match(page.data.errorMessage, /只支持/u);
  assert.equal(cloud.calls.length, 0, '格式不符不应上传');

  // 再试一个非课表矩阵的 Excel：云端解析失败，不进确认页
  Object.assign(wx, { chooseMessageFile: (options) => options.success({ tempFiles: [{ path: '/tmp/成绩.xlsx', name: '成绩.xlsx', size: 2048 }] }) });
  wx.cloud.uploadFile = (options) => {
    // 真实 wx.cloud.uploadFile 一定回传 fileID；页面必须用它（不是 cloudPath）继续调用云函数。
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };
  page.chooseFile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'error');
  assert.match(page.data.errorMessage, /未识别出课表矩阵/u);
  assert.equal(draftStore.hasDraft(), false);
  delete globalThis.wx;
});

test('编辑页：手工新增走云函数写入，缺课程名不提交', async () => {
  const cloud = cloudStub({
    createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/edit', wx, [{}]);
  page.onLoad({ scope: 'new', semester: encodeURIComponent('2026-2027学年第一学期') });
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.title, '新增课程');

  page.save();
  assert.equal(cloud.calls.length, 0, '缺课程名不提交');
  assert.ok(wx.actions.some((action) => action.startsWith('toast:') && action.includes('课程名')));

  page.onNameInput({ detail: { value: '大学美育' } });
  page.onTeacherInput({ detail: { value: '程晓明' } });
  page.onLocationInput({ detail: { value: '博雅楼-D102-多媒体课' } });
  page.onWeekdayChange({ detail: { value: '4' } });
  page.onStartChange({ detail: { value: '8' } });
  page.onEndChange({ detail: { value: '9' } });
  page.onWeeksInput({ detail: { value: '4-5' } });
  page.save();
  await new Promise((resolve) => setImmediate(resolve));
  const created = cloud.calls.find((call) => call.data.action === 'createCourse');
  assert.ok(created, '应调用云函数新增课程');
  assert.equal(created.data.semester, '2026-2027学年第一学期');
  assert.deepEqual(created.data.course.sectionRanges, [{ start: 9, end: 10 }]);
  assert.equal(created.data.course.weekday, 5);
  assert.deepEqual(created.data.course.weeks, [4, 5]);
  assert.equal(created.data.course.source, 'manual');
  delete globalThis.wx;
});

test('编辑页：修改已保存课程与修正导入草稿共用表单', async () => {
  const course = { id: 'tc_1', name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 2, startSection: 5, endSection: 6, sectionRanges: [{ start: 5, end: 6 }], weeks: [4, 5, 7, 8], weeksRecognized: true, weekText: '[4-5,7-8]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '高等数学 1.5 林加燕 [4-5,7-8]周 5-6节 崇礼楼-306 清远校区 44', createdAt: '', updatedAt: '' };
  const cloud = cloudStub({
    list: () => ({ ok: true, count: 1, semester: course.semester, updatedAt: '', courses: [course] }),
    updateCourse: (data) => ({ ok: true, id: data.id }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/edit', wx, [{}]);
  await page.onLoad({ scope: 'saved', id: 'tc_1' });
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.title, '修改课程');
  assert.equal(page.data.form.name, '高等数学');
  assert.equal(page.data.form.startIndex, 4);
  assert.equal(page.data.form.weeksText, '4-5、7-8');
  assert.equal(page.data.deletable, true);

  page.onNameInput({ detail: { value: '高等数学（改）' } });
  page.save();
  await new Promise((resolve) => setImmediate(resolve));
  const updated = cloud.calls.find((call) => call.data.action === 'updateCourse');
  assert.equal(updated.data.id, 'tc_1');
  assert.equal(updated.data.course.name, '高等数学（改）');
  assert.deepEqual(updated.data.course.weeks, [4, 5, 7, 8]);

  // 草稿修正：只改内存草稿，原文保留
  const draft = realDraft();
  const target = draft.courses[0];
  draftStore.setDraft(draft);
  const draftPage = loadPage('timetable/edit', wx, [{}]);
  draftPage.onLoad({ scope: 'draft', index: '0' });
  assert.equal(draftPage.data.status, 'ready');
  assert.equal(draftPage.data.title, '修正课程');
  assert.equal(draftPage.data.form.name, target.name);
  assert.ok(draftPage.data.rawText.length > 0, '修正草稿时要能看到原文');
  draftPage.onNameInput({ detail: { value: '改名后的课程' } });
  draftPage.save();
  assert.equal(draftStore.getDraft().courses[0].name, '改名后的课程');
  assert.equal(draftStore.getDraft().courses[0].rawText, target.rawText, '原文保留');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'updateCourse').length, 1, '草稿修正不直接写库');
  draftStore.clearDraft();
  delete globalThis.wx;
});

test('编辑页：找不到课程时显示缺失状态，不发写入请求', async () => {
  const cloud = cloudStub({ list: () => ({ ok: true, count: 0, semester: '', updatedAt: '', courses: [] }) });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/edit', wx, [{}]);
  await page.onLoad({ scope: 'saved', id: 'tc_missing' });
  assert.equal(page.data.status, 'error');
  assert.match(page.data.errorMessage, /不在已保存的课表里/u);

  const draftPage = loadPage('timetable/edit', wx, [{}]);
  draftPage.onLoad({ scope: 'draft', index: '3' });
  assert.equal(draftPage.data.status, 'error');
  assert.match(draftPage.data.errorMessage, /草稿里找不到/u);
  delete globalThis.wx;
});

test('课表页面模板里不出现具体时刻（学校作息未核实）', () => {
  const templates = [
    'miniprogram/pages/timetable/index.wxml',
    'miniprogram/pages/timetable/import/index.wxml',
    'miniprogram/pages/timetable/edit/index.wxml',
  ];
  for (const file of templates) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(!/\d{1,2}:\d{2}/u.test(text), `${file}: 不应出现时刻`);
    assert.ok(!/\d{1,2}\s*[点時时]/u.test(text), `${file}: 不应出现「点/时」时刻`);
  }
  // 课表按节次展示这一点要写在页面上；具体时刻只来自用户填写的作息。
  const main = fs.readFileSync(path.resolve(templates[0]), 'utf8');
  assert.match(main, /按节次展示/u);
  assert.match(main, /具体时刻只来自你填写的作息|未填作息/u);
});

// 品牌红 (#c41c23) 上的正文色 #2b2422 对比度约 2.5:1（WCAG AA 正文要 4.5:1）。
// 新设计里助手入口是白底卡片，红底只留给主按钮与图标；主按钮必须写明白字。
test('课表主页：红底主按钮写明白字，手工新增用次级样式', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/index.wxml'), 'utf8');
  assert.match(wxml, /id="assistant-open"[^>]*class="[^"]*tt2-assistant-entry/u, '助手入口应是白底卡片');

  const wxss = fs.readFileSync(path.resolve('miniprogram/ui/timetable/page.wxss'), 'utf8');
  assert.match(wxss, /\.tt2-btn-primary\s*\{[^}]*background:\s*#c41c23[^}]*color:\s*#ffffff/u);
  assert.match(wxss, /\.tt2-orb\s*\{[^}]*background:\s*#c41c23[^}]*color:\s*#ffffff/u);

  const manual = wxml.match(/<button[^>]*id="manual-add"[^>]*>/u);
  assert.ok(manual !== null, '空态的「手工新增课程」按钮应当存在');
  assert.match(manual[0], /class="[^"]*tt2-btn-secondary/u, '次级动作要用次级按钮样式');
});

// 无课的星期也保留；已确认设计采用等宽七天和横向滚动，节次轴始终在滚动区域外。
test('周网格保留完整七天，节次轴独立于横向滚动区域', () => {
  for (const file of ['miniprogram/pages/timetable/index.wxml', 'miniprogram/pages/timetable/import/index.wxml']) {
    const wxml = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(!/wx:if="\{\{!column\.narrow\}\}"/u.test(wxml), `${file}: 不得跳过空白天`);
    assert.match(wxml, /class="grid-axis"[\s\S]*?<\/view>\s*<scroll-view class="grid-scroll"/u, `${file}: 节次轴不随课程横向滚动`);
    assert.match(wxml, /scroll-x/u);
    assert.match(wxml, /wx:for="\{\{(?:gridUi|draftGridUi)\.columns\}\}"/u);
    assert.doesNotMatch(wxml, /column\.narrow \?/u, `${file}: 七天采用相同列宽`);
  }
  // 设计图 02/51：7 列 × 74px，不再按「有课/没课」收窄。
  const wxss = fs.readFileSync(path.resolve('miniprogram/ui/timetable/page.wxss'), 'utf8');
  assert.match(wxss, /\.grid-col\s*\{[^}]*width:\s*74px/u);
  assert.match(wxss, /\.grid-th\s*\{[^}]*width:\s*74px/u);
});

test('周课表主页：填了开学日与作息后，日期、今日列、速查条与详情弹层都到位', async () => {
  /** 作息只填第 5、6 节（13:00–13:45 / 13:50–14:35），这样 13:10 一定落在第 5 节。 */
  const slot = (start, end) => ({ start, end });
  const sectionTimes = Array.from({ length: 12 }, () => slot('', ''));
  sectionTimes[4] = slot('13:00', '13:45');
  sectionTimes[5] = slot('13:50', '14:35');
  const courses = [
    { id: 'tc_1', name: '高等数学', teacher: '林加燕', weekday: 1, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', credits: '1.5', createdAt: '', updatedAt: '2026-09-18T10:00:00.000Z' },
    { id: 'tc_2', name: '体育一', teacher: '陈壮寿', weekday: 3, sectionRanges: [{ start: 7, end: 8 }], startSection: 7, endSection: 8, weeks: [6, 7], weeksRecognized: true, weekText: '[6-7]周', location: '篮球1号场', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', credits: '1', createdAt: '', updatedAt: '2026-09-18T10:00:00.000Z' },
  ];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: courses.length, semester: '2026-2027学年第一学期', updatedAt: '2026-09-18T10:00:00.000Z', courses }),
    getSettings: () => ({
      ok: true,
      saved: true,
      settings: { semesterName: '2026-2027学年第一学期', startDate: '2026-08-31', totalWeeks: 20, sectionTimes },
    }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  page.onLoad({ today: '2026-09-21', clock: '13:10' });
  await page.onShow();

  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.week, 4, '开学日 8/31 到 9/21 是第 4 周');
  assert.equal(page.data.weekRange, '9/21 – 9/27');
  assert.equal(page.data.grid.columns[0].dateLabel, '21', '表头带日期');
  assert.equal(page.data.grid.columns[0].today, true, '今天列高亮');
  assert.equal(page.data.grid.columns[2].today, false, '今天只有一天');
  assert.equal(page.data.todayBar.kind, 'current');
  assert.equal(page.data.todayBar.name, '高等数学');
  assert.equal(page.data.todayBar.timeLabel, '13:00 – 14:35', '时刻只来自用户填的作息');
  assert.equal(page.data.settingsError, '');

  // 点课块 → 详情弹层；弹层的修改/删除走既有入口
  page.openSheet({ currentTarget: { dataset: { id: 'tc_1' } } });
  assert.equal(page.data.sheetOpen, true);
  assert.equal(page.data.sheetCourse.name, '高等数学');
  assert.equal(page.data.sheetCourse.sectionLabel, '第 5-6 节');
  assert.equal(page.data.sheetCourse.sourceLabel, '导入（Excel）');
  page.closeSheet();
  assert.equal(page.data.sheetOpen, false);

  // 入口：课表设置与课程管理（管理页带上正在看的周次）
  page.openSettings();
  page.openManage();
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/settings/index'));
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/manage/index?week=4'));
  delete globalThis.wx;
});

test('周课表主页：同格两门课时弹层列出全部成员', async () => {
  const courses = [
    { id: 'tc_a', name: '习近平新时代中国特色社会主义思想概论', teacher: '', weekday: 2, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, weeks: [4], weeksRecognized: true, weekText: '[4]周', location: '', campus: '', siteNumber: '', note: '', warnings: [], source: 'excel', semester: '', rawText: '', credits: '', createdAt: '', updatedAt: '' },
    { id: 'tc_b', name: '形势与政策', teacher: '', weekday: 2, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, weeks: [4], weeksRecognized: true, weekText: '[4-8]周', location: '', campus: '', siteNumber: '', note: '', warnings: [], source: 'excel', semester: '', rawText: '', credits: '', createdAt: '', updatedAt: '' },
  ];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: courses.length, semester: '', updatedAt: '', courses }),
    // 开学日 8/31 + 今天 9/21 = 第 4 周，同格的两门课才落在当前这一周
    getSettings: () => ({
      ok: true,
      saved: true,
      settings: { semesterName: '', startDate: '2026-08-31', totalWeeks: 20, sectionTimes: Array.from({ length: 12 }, () => ({ start: '', end: '' })) },
    }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  page.onLoad({ today: '2026-09-21', clock: '13:10' });
  await page.onShow();

  const block = page.data.grid.columns[1].blocks[0];
  assert.equal(block.count, 2, '同格两门折叠成一块');
  page.openSheet({ currentTarget: { dataset: { id: block.primaryId } } });
  assert.equal(page.data.sheetMembers.length, 2, '弹层要列出同一格的全部课程');
  page.pickSheetMember({ currentTarget: { dataset: { id: 'tc_b' } } });
  assert.equal(page.data.sheetCourse.name, '形势与政策', '点成员切换弹层内容');
  delete globalThis.wx;
});

test('周课表主页：设置读不到时不显示日期与速查条，但课表照常可用', async () => {
  const courses = [
    { id: 'tc_1', name: '高等数学', teacher: '林加燕', weekday: 1, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, weeks: [1], weeksRecognized: true, weekText: '[1]周', location: '崇礼楼-306', campus: '', siteNumber: '', note: '', warnings: [], source: 'excel', semester: '', rawText: '', credits: '', createdAt: '', updatedAt: '' },
  ];
  // 桩里没有 getSettings：云函数未部署/集合未建的真实情形（没有开学日 → 退回第 1 周）。
  const cloud = cloudStub({ list: () => ({ ok: true, count: 1, semester: '', updatedAt: '', courses }) });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  page.onLoad({ today: '2026-09-21', clock: '13:10' });
  await page.onShow();

  assert.equal(page.data.status, 'ready', '设置读不到不能把整页拖进错误态');
  assert.equal(page.data.weekRange, '', '没开学日就不显示日期区间');
  assert.equal(page.data.todayBar, null, '没作息就不显示速查条');
  assert.deepEqual(page.data.grid.columns.map((column) => column.dateLabel), ['', '', '', '', '', '', '']);
  assert.deepEqual(page.data.grid.columns.map((column) => column.today), [false, false, false, false, false, false, false]);
  assert.ok(page.data.settingsError !== '', '要如实说明设置读不到的原因');
  assert.equal(page.data.grid.columns[0].blocks[0].name, '高等数学', '课表本体照常渲染');
  delete globalThis.wx;
});

test('周课表主页：首页把问题带进来（?ask=）时打开助手并填进输入框，但不自动发送', async () => {
  const courses = [
    { id: 'tc_1', name: '高等数学', teacher: '林加燕', weekday: 1, sectionRanges: [{ start: 1, end: 2 }], startSection: 1, endSection: 2, weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周', location: '崇礼楼-306', campus: '', siteNumber: '', note: '', warnings: [], source: 'excel', semester: '', rawText: '', credits: '', createdAt: '', updatedAt: '' },
  ];
  // 桩里只有 list：只要真的发出了任何 callFunction，就会因为「未预设的 action」被记录到 calls 里。
  const cloud = cloudStub({ list: () => ({ ok: true, count: courses.length, semester: '', updatedAt: '', courses }) });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  const question = '周三第几节有课？';
  // 首页 `sendAsk` 用 encodeURIComponent 拼 URL（中文与「？」都得转义），
  // 而 wx.navigateTo 的 query 是原样转义串、不会自动解码 —— 所以这里按首页的真实产物注入。
  page.onLoad({ today: '2026-09-21', clock: '13:10', ask: encodeURIComponent(question) });

  assert.equal(page.data.assistantOpen, true, '带 ask 进来要直接把助手面板打开');
  assert.equal(page.data.assistantInput, question, '问题要解码后原样填进输入框');
  assert.ok(page.data.assistantMessages.length >= 1, '打开助手时该有欢迎语');
  assert.equal(cloud.calls.length, 0, '只填不发：进入页面时不能发出任何请求');
  assert.equal(wx.actions.length, 0, '也不该弹 toast/跳转');

  // 直接传原文（没有 % 转义）也要能用：拿 url 手拼参数时会这样。
  const plain = loadPage('timetable', baseWx(cloudStub({ list: () => ({ ok: true, count: 0, semester: '', updatedAt: '', courses: [] }) })));
  plain.onLoad({ ask: question });
  assert.equal(plain.data.assistantInput, question, '没转义的原文也要能用');

  // 解不开的转义（文本里本来就有裸 %）不能把问题弄丢：按原文填进去。
  const broken = loadPage('timetable', baseWx(cloudStub({ list: () => ({ ok: true, count: 0, semester: '', updatedAt: '', courses: [] }) })));
  broken.onLoad({ ask: '正确率 90% 的题怎么做？' });
  assert.equal(broken.data.assistantInput, '正确率 90% 的题怎么做？', '解码失败要按原文保留，不能丢问题或显示乱码');

  // 空 ask 不打开助手（与 today?/clock? 一样，参数只是可选项）
  const idle = loadPage('timetable', baseWx(cloudStub({ list: () => ({ ok: true, count: 0, semester: '', updatedAt: '', courses: [] }) })));
  idle.onLoad({ ask: '   ' });
  assert.equal(idle.data.assistantOpen, false, '空白 ask 不打扰');
  delete globalThis.wx;
});

/** 贴通知闭环用的课表：与设计图 02 同一套例子（停课 / 改地点 / 与已有课撞车的补课）。 */
const NOTICE_COURSES = [
  { id: 'tc_math', name: '高等数学', teacher: '林加燕', weekday: 1, sectionRanges: [{ start: 1, end: 2 }], startSection: 1, endSection: 2, weeks: [11, 12, 13], weeksRecognized: true, weekText: '[11-13]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', credits: '1.5', createdAt: '', updatedAt: '' },
  { id: 'tc_culture', name: '中华传统文化精粹', teacher: '周敏', weekday: 5, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, weeks: [13], weeksRecognized: true, weekText: '[13]周', location: '博雅楼-B201', campus: '清远校区', siteNumber: '20', note: '', warnings: [], source: 'manual', semester: '2026-2027学年第一学期', rawText: '', credits: '1', createdAt: '', updatedAt: '' },
];

function noticeReply() {
  return JSON.stringify({
    kind: 'changes',
    message: '识别到 2 处变更。',
    changes: [
      { action: 'cancel', courseName: '高等数学', weekText: '第12周', quote: '第 12 周周一全天停课', title: '', courseId: '', weekday: 1, startSection: 0, endSection: 0, location: '', teacher: '', conflict: '' },
      { action: 'add', courseName: '高等数学', weekText: '第13周', quote: '第 13 周周五 5-6 节补课', title: '', courseId: '', weekday: 5, startSection: 5, endSection: 6, location: '', teacher: '', conflict: '' },
    ],
  });
}

const CHECKED_SAFETY = { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: true, detail: '' };

/** ai 云函数的成功返回（`callAi` 读的是 `response.result`）。 */
function aiReply(text) {
  return { ok: true, failureClass: '', message: '', text, capWarning: '', safety: CHECKED_SAFETY, warnings: [] };
}

test('贴通知闭环：识别只出提案不写库，勾选后按条写入，撤销把课表还原', async () => {
  let courses = NOTICE_COURSES.map((course) => ({ ...course }));
  const writes = [];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: courses.length, semester: '2026-2027学年第一学期', updatedAt: '', courses }),
    // ai 云函数桩：真正的 AI 调用也走 wx.cloud.callFunction({ name:'ai', data:{action:'chat'} })，这里按 action 接住。
    chat: (data) => {
      writes.push({ action: 'chat', feature: data.feature });
      return aiReply(noticeReply());
    },
    createCourse: (data) => {
      writes.push({ action: 'createCourse', name: data.course.name, weeks: data.course.weeks });
      const created = { ...data.course, id: 'tc_new', semester: data.semester };
      courses = courses.concat([created]);
      return { ok: true, course: created };
    },
    updateCourse: (data) => {
      writes.push({ action: 'updateCourse', id: data.id, weeks: data.course.weeks });
      courses = courses.map((course) => (course.id === data.id ? { ...data.course, id: course.id } : course));
      return { ok: true, id: data.id };
    },
    deleteCourse: (data) => {
      writes.push({ action: 'deleteCourse', id: data.id });
      courses = courses.filter((course) => course.id !== data.id);
      return { ok: true, count: courses.length };
    },
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  assert.equal(writes.length, 0, '读取页面不会写库');

  page.openAssistant();
  page.toggleNotice();
  page.onNoticeInput({ detail: { value: '第 12 周周一全天停课；第 13 周周五 5-6 节补高数。' } });
  await page.readNotice();
  // 识别完：只出提案，一条都没写
  assert.deepEqual(writes.map((write) => write.action), ['chat'], '点「识别变更」只问 AI，不写库');
  assert.equal(writes[0].feature, 'timetable-notice', '走独立的 feature 名');
  assert.equal(page.data.noticeProposal.rows.length, 2);
  assert.equal(page.data.noticeProposal.rows[0].checked, true, '停课无冲突，默认勾选');
  assert.equal(page.data.noticeProposal.rows[1].checked, false, '补课撞了中华传统文化精粹，默认不勾');
  assert.match(page.data.noticeProposal.rows[1].conflict, /中华传统文化精粹/u);
  assert.equal(page.data.noticeProposal.checkedCount, 1, '应用按钮上的条数跟着勾选走');

  await page.applyNotice();
  assert.deepEqual(writes.map((write) => write.action), ['chat', 'updateCourse'], '只写勾选的那一条');
  assert.deepEqual(writes[1].weeks, [11, 13], '停课只去掉第 12 周');
  assert.equal(page.data.noticeToast.text, '已更新 1 处，课表已同步');
  assert.equal(page.data.noticeToast.canUndo, true, '10 秒内可撤销');

  // 撤销：把停掉的那一周还回去
  await page.undoNotice();
  assert.deepEqual(writes.map((write) => write.action), ['chat', 'updateCourse', 'updateCourse']);
  assert.deepEqual(writes[2].weeks, [11, 12, 13], '写回应用前的周次');
  assert.equal(page.data.noticeToast.text, '已撤销，课表回到应用前');
  assert.equal(page.data.noticeToast.canUndo, false);
  delete globalThis.wx;
});

test('贴通知：失败时如实报「已应用 K 处，第 J 处失败」，不谎报全部成功', async () => {
  let courses = NOTICE_COURSES.map((course) => ({ ...course }));
  const writes = [];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: courses.length, semester: '2026-2027学年第一学期', updatedAt: '', courses }),
    chat: () => aiReply(noticeReply()),
    updateCourse: (data) => {
      writes.push({ action: 'updateCourse', id: data.id });
      courses = courses.map((course) => (course.id === data.id ? { ...data.course, id: course.id } : course));
      return { ok: true, id: data.id };
    },
    // 第 2 处新增故意失败
    createCourse: () => new Error('超出可保存的课程条数'),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.toggleNotice();
  page.onNoticeInput({ detail: { value: '第 12 周周一全天停课；第 13 周周五 5-6 节补高数。' } });
  await page.readNotice();
  // 把冲突那条也勾上（学生坚持要加），于是 2 条都要写
  page.toggleNoticeRow({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.noticeProposal.checkedCount, 2);
  await page.applyNotice();

  assert.equal(writes.length, 1, '第 1 处写成功、第 2 处失败就停在这里');
  assert.match(page.data.noticeError, /^已应用 1 处，第 2 处失败/u);
  assert.match(page.data.noticeError, /超出可保存的课程条数/u);
  assert.equal(page.data.noticeToast.text, '已更新 1 处，还有 1 处没写进去');
  assert.equal(page.data.noticeToast.canUndo, true, '已应用的那处仍然可以撤销');
  page.onUnload();
  delete globalThis.wx;
});

test('贴通知：解析不出来就说清楚，且不写库、不弹提案', async () => {
  const writes = [];
  const cloud = cloudStub({
    list: () => ({ ok: true, count: NOTICE_COURSES.length, semester: '', updatedAt: '', courses: NOTICE_COURSES }),
    // 模型返回一段没法解析的话（不是 JSON）
    chat: () => aiReply('这段通知提到了调课，但没说清是哪一周。'),
    createCourse: () => { writes.push('createCourse'); return { ok: true }; },
    updateCourse: () => { writes.push('updateCourse'); return { ok: true }; },
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.toggleNotice();
  page.onNoticeInput({ detail: { value: '调课，详情见群公告。' } });
  await page.readNotice();

  assert.equal(page.data.noticeProposal, null, '解析不出来就不摆提案卡');
  assert.match(page.data.noticeError, /没有生成任何变更|没有写入/u);
  assert.deepEqual(writes, [], '更不能写库');
  delete globalThis.wx;
});

test('贴通知：冲突项未勾选时可点开勾上（学生坚持要加），阻塞项点了也不勾', async () => {
  const cloud = cloudStub({
    list: () => ({ ok: true, count: NOTICE_COURSES.length, semester: '', updatedAt: '', courses: NOTICE_COURSES }),
    chat: () => aiReply(noticeReply()),
  });
  const page = loadPage('timetable', baseWx(cloud));
  await page.onShow();
  page.openAssistant();
  page.toggleNotice();
  page.onNoticeInput({ detail: { value: '第 12 周周一全天停课；第 13 周周五 5-6 节补高数。' } });
  await page.readNotice();

  // 冲突条：点一下就能勾上，再点取消
  page.toggleNoticeRow({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.noticeProposal.rows[1].checked, true);
  assert.equal(page.data.noticeProposal.checkedCount, 2);
  page.toggleNoticeRow({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.noticeProposal.rows[1].checked, false);
  assert.equal(page.data.noticeProposal.checkedCount, 1);

  // 人为把第 0 条标成阻塞：它根本写不进去，点了也不该被勾上
  page.setData({ noticeProposal: { rows: page.data.noticeProposal.rows.map((row) => (row.index === 0 ? { ...row, blocked: '原文里没写清哪一周' } : row)), checkedCount: 1 } });
  page.toggleNoticeRow({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.noticeProposal.rows[0].checked, true, '原本勾着的保持原样');
  assert.match(page.data.noticeError, /没写清哪一周/u, '要把为什么点不动说清楚');
  page.onUnload();
  delete globalThis.wx;
});

test('贴通知：模板按设计图 09 摆出粘贴框、金色提案卡、勾选框、冲突提示与撤销提示条', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/index.wxml'), 'utf8');
  // 粘贴区带「来自班群通知」的小字说明（文案全部在 WXML 里，WXSS 不出现中文）
  assert.match(wxml, /class="tt2-paste"/u);
  assert.match(wxml, /你粘贴的班群通知/u);
  assert.match(wxml, /id="notice-input"/u, '要有真正的粘贴输入框');
  // 金色提案卡：卡片头 + 全局 ai-tag 金标签（不重复定义）
  assert.match(wxml, /class="tt2-proposal"/u);
  assert.match(wxml, /识别到 \{\{noticeProposal\.rows\.length\}\} 处变更/u);
  assert.match(wxml, /class="ai-tag">AI 提案 · 待确认/u);
  // 勾选：已勾是红底打勾，未勾是白底描边
  assert.match(wxml, /class="tt2-check \{\{item\.checked \? 'on' : ''\}\}"/u);
  // 差异行 + 冲突提示 + 原文引用（原文：前缀写在 WXML 里）
  assert.match(wxml, /class="tt2-diff-old"/u);
  assert.match(wxml, /class="tt2-diff-new"/u);
  assert.match(wxml, /class="tt2-warn"/u);
  assert.match(wxml, /class="tt2-quote">原文：/u);
  // 两个按钮：逐条修改（白底红字）+ 应用 N 处变更（红底，0 条禁用）
  assert.match(wxml, /id="notice-expand"[^>]*class="[^"]*btn-secondary/u);
  assert.match(wxml, /id="notice-apply"[^>]*class="[^"]*btn-primary/u);
  assert.match(wxml, /disabled="\{\{noticeProposal\.checkedCount === 0 \|\| noticeReading\}\}"/u);
  // 深色撤销提示条 + 金色「撤销」
  assert.match(wxml, /id="notice-toast" class="tt2-toast"/u);
  assert.match(wxml, /id="notice-undo" class="tt2-toast-undo"[^>]*bindtap="undoNotice">撤销/u);
  // 脚注：确认前不写入 / 10 秒内可撤销
  const ts = fs.readFileSync(path.resolve('miniprogram/pages/timetable/index.ts'), 'utf8');
  assert.match(ts, /确认前不写入课表，应用后 10 秒内可撤销/u);
  // 10 秒窗口本身定义在 notice.ts 里，页面只引用，不重复写魔数。
  assert.match(ts, /NOTICE_UNDO_MS/u);
  assert.match(fs.readFileSync(path.resolve('miniprogram/services/timetable/notice.ts'), 'utf8'), /NOTICE_UNDO_MS = 10000/u);

  // 这些样式在共享样式表里（wxss.test 另有令牌回退与中文泄漏的全量校验）
  const wxss = fs.readFileSync(path.resolve('miniprogram/ui/timetable/page.wxss'), 'utf8');
  for (const rule of ['.tt2-paste {', '.tt2-proposal {', '.tt2-proposal-head {', '.tt2-check {', '.tt2-diff-old {', '.tt2-diff-new {', '.tt2-warn {', '.tt2-quote {', '.tt2-btn-primary {', '.tt2-btn-secondary {', '.tt2-toast {', '.tt2-toast-undo {']) {
    assert.ok(wxss.includes(rule), '缺少样式 ' + rule);
  }
  assert.match(wxss, /\.tt2-proposal \{[^}]*border:\s*1px solid #e7d3a0[^}]*border-radius:\s*14px/u);
  assert.match(wxss, /\.tt2-quote \{[^}]*border-left:\s*2px solid #e7d3a0/u);
  assert.match(wxss, /\.tt2-toast \{[^}]*background:\s*#2b2422/u);
  assert.match(wxss, /\.tt2-toast-undo \{[^}]*color:\s*#f2c96b/u);
});
