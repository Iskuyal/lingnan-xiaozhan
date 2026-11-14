const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 跨 tab 意图：A 的 navigation.ts 写入，B 的课表页在课程/设置读完以后消费一次。
// 这里验证消费侧：只预填、不自动发模型；week / plan-week 映射失败有说明；
// 畸形与过期输入无副作用；旧启动 query 不在 onShow 重放。
const nav = require('../dist/ui/navigation.js');

function storageWx(extra = {}) {
  const store = new Map();
  const actions = [];
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => { store.set(key, value); },
    removeStorageSync: (key) => { store.delete(key); },
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    switchTab: (options) => { actions.push(`switchTab:${options.url}`); if (options.success) options.success(); },
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => { if (options.success) options.success({ confirm: true }); },
    actions,
    store,
    ...extra,
  };
  return wx;
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

function loadTimetable(wx, stack = [{}]) {
  globalThis.wx = wx;
  const filename = path.resolve('dist/pages/timetable/index.js');
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

const COURSE = {
  id: 'tc_1', name: '高等数学', teacher: '林加燕', weekday: 1,
  sectionRanges: [{ start: 3, end: 4 }], startSection: 3, endSection: 4,
  weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  weeksRecognized: true, weekText: '[1-18]周', location: '博雅楼 B604', campus: '', siteNumber: '',
  note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '',
  credits: '', createdAt: '', updatedAt: '',
};

function feed() {
  return {
    list: () => ({ ok: true, count: 1, semester: '2026-2027学年第一学期', updatedAt: '', courses: [COURSE] }),
    getSettings: () => ({
      ok: true,
      saved: true,
      settings: { semesterName: '2026-2027学年第一学期', startDate: '2026-09-07', totalWeeks: 18, sectionTimes: [] },
    }),
    // 任何模型调用都会被记录；加载页面时不应出现。
    chat: () => { throw new Error('不应在页面加载时调用模型'); },
  };
}

async function withPage(run) {
  const cloud = cloudStub(feed());
  const wx = storageWx({ cloud });
  const page = loadTimetable(wx);
  try {
    await run(page, wx, cloud);
  } finally {
    delete globalThis.wx;
  }
}

test('assistant 意图：打开助手并预填，只填不发，意图读后即删', async () => {
  await withPage(async (page, wx, cloud) => {
    await nav.openTimetable({ kind: 'assistant', text: '周五有哪些课？' });
    assert.equal(wx.store.has(nav.TIMETABLE_INTENT_KEY), true, '先写入意图再切 tab');
    await page.onShow();
    assert.equal(page.data.assistantOpen, true);
    assert.equal(page.data.assistantInput, '周五有哪些课？');
    assert.equal(cloud.calls.filter((call) => call.data.action === 'chat').length, 0, '只预填，不自动调用模型');
    assert.equal(wx.store.has(nav.TIMETABLE_INTENT_KEY), false, '一次性消费');
  });
});

test('week 意图：切到指定有效周；超出范围只说明，不硬跳到错误周', async () => {
  await withPage(async (page, wx) => {
    await nav.openTimetable({ kind: 'week', week: 11 });
    await page.onShow();
    assert.equal(page.data.week, 11);

    await nav.openTimetable({ kind: 'week', week: 50 });
    await page.onShow();
    assert.equal(page.data.week, 11, '非法周次不改当前周');
    assert.match(page.data.intentNotice, /50.*不在当前课表范围|只有 18 周/u);
  });
});

test('plan-week 意图：按实际日历映射到学期周；映射不了就说明，不强行当第 1 周', async () => {
  await withPage(async (page, wx) => {
    await nav.openTimetable({ kind: 'plan-week', planDate: '2026-11-10' });
    await page.onShow();
    assert.equal(page.data.week, 10, '9/7 起第 10 周是 11/9–11/15，11/10 落在第 10 周');

    await nav.openTimetable({ kind: 'plan-week', planDate: '2027-03-01' });
    await page.onShow();
    assert.equal(page.data.week, 10, '学期外日期不强行改周');
    assert.match(page.data.intentNotice, /不在当前学期范围/u);
  });
});

test('plan-week 意图：没设置开学日时说明原因，不编造周次', async () => {
  const cloud = cloudStub({
    ...feed(),
    getSettings: () => ({ ok: true, saved: false, settings: { semesterName: '', startDate: '', totalWeeks: 18, sectionTimes: [] } }),
  });
  const wx = storageWx({ cloud });
  const page = loadTimetable(wx);
  try {
    await nav.openTimetable({ kind: 'plan-week', planDate: '2026-11-10' });
    await page.onShow();
    assert.equal(page.data.week, 1, '没开学日时仍按第 1 周显示');
    assert.match(page.data.intentNotice, /还没设置开学日/u);
  } finally {
    delete globalThis.wx;
  }
});

test('畸形与过期意图：不打开助手、不改周次，并清掉坏数据', async () => {
  await withPage(async (page, wx) => {
    wx.setStorageSync(nav.TIMETABLE_INTENT_KEY, { id: 'bad', createdAt: Date.now(), intent: { kind: 'week', week: 999 } });
    await page.onShow();
    assert.equal(page.data.assistantOpen, false);
    assert.equal(page.data.week, 1);
    assert.equal(wx.store.has(nav.TIMETABLE_INTENT_KEY), false, '非法意图应被清理');

    wx.setStorageSync(nav.TIMETABLE_INTENT_KEY, {
      id: 'old', createdAt: Date.now() - nav.INTENT_TTL_MS - 1000, intent: { kind: 'assistant', text: '旧问题' },
    });
    await page.onShow();
    assert.equal(page.data.assistantOpen, false, '过期意图不生效');
    assert.equal(wx.store.has(nav.TIMETABLE_INTENT_KEY), false);
  });
});

test('旧启动 query：?ask= 只在进入时生效，onShow 不重放', async () => {
  await withPage(async (page) => {
    page.onLoad({ ask: encodeURIComponent('周三第几节有课？') });
    await page.onShow();
    assert.equal(page.data.assistantOpen, true);
    page.closeAssistant();
    await page.onShow();
    assert.equal(page.data.assistantOpen, false, 'onShow 不应重放旧 query');
  });
});
