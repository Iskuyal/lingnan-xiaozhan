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
  // 课表按节次展示这一点要写在页面上
  const main = fs.readFileSync(path.resolve(templates[0]), 'utf8');
  assert.match(main, /按节次展示/u);
  assert.match(main, /不显示具体时刻|尚未核实/u);
});
