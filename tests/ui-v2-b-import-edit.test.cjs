const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 导入核对与课程编辑（设计图 68 / 76 / 79 / 52）：
// 每条草稿都有来源与修正入口；修正只改草稿、不要求重选文件；
// 字段错误在保存前说清，且不写任何数据。
const cloudParse = require('../dist/cloudfunctions/timetable/parse.js');
const draftStore = require('../dist/services/timetable/draft.js');

const FIXTURE = '2026-2027学年第一学期班级课表.xls';

function realDraft() {
  return cloudParse.parseWorkbook(fs.readFileSync(path.resolve('tests/fixtures/timetable', FIXTURE)), FIXTURE);
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

function loadPage(route, wx, stack = [{}]) {
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
    switchTab: (options) => { actions.push(`switchTab:${options.url}`); if (options.success) options.success(); },
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => { actions.push(`modal:${options.title}`); if (options.success) options.success({ confirm: true, cancel: false }); },
    actions,
    ...extra,
  };
}

test('导入核对：每条草稿都有来源与修正入口；修正后返回不需要重选文件', async () => {
  const draft = realDraft();
  const cloud = cloudStub({
    prepareUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.xls', maxBytes: 10485760 }),
    importDraft: () => ({ ok: true, draft, tempFileDeleted: true }),
    saveDraft: (data) => ({ ok: true, saved: data.courses.length }),
  });
  let chooseCount = 0;
  const wx = baseWx(cloud, {
    chooseMessageFile: (options) => { chooseCount += 1; options.success({ tempFiles: [{ path: '/tmp/课表.xls', name: '课表.xls', size: 2048 }] }); },
  });
  wx.cloud.uploadFile = (options) => {
    options.success({ fileID: `cloud://test-env.test-bucket/${options.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };

  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.chooseFile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'review');
  assert.ok(page.data.items.length > 0);
  for (const item of page.data.items) {
    assert.ok(item.sourceLabel.length > 0, `草稿 ${item.index} 缺少原材料位置`);
    assert.equal(item.nameMissing, item.name.trim() === '');
  }

  page.fixItem({ currentTarget: { dataset: { index: 1 } } });
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/edit/index?scope=draft&index=1'));

  // 修正一条非首条草稿：课程名与地点都改，原文与来源位置保留。
  const before = draftStore.getDraft().courses[1];
  const edit = loadPage('timetable/edit', wx, [{}, {}]);
  edit.onLoad({ scope: 'draft', index: '1' });
  assert.equal(edit.data.status, 'ready');
  edit.onNameInput({ detail: { value: '改名后的课程' } });
  edit.onLocationInput({ detail: { value: '博雅楼 C301' } });
  edit.save();
  const after = draftStore.getDraft().courses[1];
  assert.equal(after.name, '改名后的课程');
  assert.equal(after.location, '博雅楼 C301');
  assert.equal(after.rawText, before.rawText, '原文保留');
  assert.equal(after.sourceRowLabel, before.sourceRowLabel, '来源位置保留');
  assert.equal(after.sourceWeekdayLabel, before.sourceWeekdayLabel);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(wx.actions.includes('navigateBack'));

  // 回到核对页：onShow 重新读内存草稿，不要求重选文件。
  page.onShow();
  assert.equal(page.data.items[1].name, '改名后的课程');
  assert.equal(page.data.items[1].locationText, '博雅楼 C301');
  assert.equal(chooseCount, 1, '修正草稿不应再次拉起文件选择器');

  // 替换前取消：放弃导入不写库，草稿清空。
  page.abandon();
  assert.equal(draftStore.hasDraft(), false);
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveDraft').length, 0, '放弃导入不写任何数据');
  delete globalThis.wx;
});

test('导入核对：整表替换警告紧邻最终按钮，固定动作区给最后一条留出空间', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/import/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.resolve('miniprogram/ui/timetable/page.wxss'), 'utf8');
  assert.match(wxml, /class="imp2-dock"[\s\S]*?保存会替换当前已保存的课表[\s\S]*?id="confirm-save"/u);
  assert.match(wxml, /保存前不会写入任何数据/u);
  assert.match(wxss, /\.imp2-dock\s*\{[^}]*position:\s*fixed/u);
  assert.match(wxss, /\.imp2-review-page\s*\{[^}]*padding-bottom:\s*calc\(220px \+ env\(safe-area-inset-bottom\)\)/u);
});

test('课程编辑：字段错误先说清，修正前不写入；改对后才保存', async () => {
  const cloud = cloudStub({
    createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/edit', wx, [{}]);
  page.onLoad({ scope: 'new', semester: encodeURIComponent('2026-2027学年第一学期') });
  assert.equal(page.data.status, 'ready');

  page.save();
  assert.equal(cloud.calls.length, 0, '缺课程名不写库');
  assert.match(page.data.fieldErrors.name, /课程名/u);
  assert.match(page.data.saveError, /还不能保存/u);
  assert.equal(page.data.errorCount, 1);

  page.onNameInput({ detail: { value: '大学美育' } });
  assert.equal(page.data.fieldErrors.name, '');
  assert.equal(page.data.errorCount, 0);

  page.onStartInput({ detail: { value: '3' } });
  page.onEndInput({ detail: { value: '2' } });
  page.save();
  assert.equal(cloud.calls.length, 0, '结束节小于起始节不写库');
  assert.match(page.data.fieldErrors.sections, /结束节不能小于起始节|节次/u);

  page.onEndInput({ detail: { value: '4' } });
  page.save();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.calls.filter((call) => call.data.action === 'createCourse').length, 1);
  assert.equal(page.data.fieldErrors.sections, '');
  delete globalThis.wx;
});
