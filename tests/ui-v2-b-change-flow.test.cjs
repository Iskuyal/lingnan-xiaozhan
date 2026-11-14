const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 限定周次调课闭环（设计图 09 / 10 / 39 / 71 / 72 / 73）：
// 只改指定周、其他周保留；应用后回到第 11 周并标出目标课程；
// 部分失败只重试失败项；撤销失败保留可重试状态；重复点击不重复写。
const CHECKED_SAFETY = { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: true, detail: '' };

function aiReply(text) {
  return { ok: true, failureClass: '', message: '', text, capWarning: '', safety: CHECKED_SAFETY, warnings: [] };
}

function course(overrides) {
  return {
    id: 'tc_java', name: 'Java 程序设计', teacher: '示例教师', weekday: 3,
    sectionRanges: [{ start: 3, end: 4 }], startSection: 3, endSection: 4,
    weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    weeksRecognized: true, weekText: '[1-16]周', location: '博雅楼 B604', campus: '', siteNumber: '',
    note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '',
    credits: '', createdAt: '', updatedAt: '',
    ...overrides,
  };
}

function replyText() {
  return JSON.stringify({
    kind: 'changes',
    message: '识别到 2 处变更。',
    changes: [
      {
        action: 'move', courseName: 'Java 程序设计', weekText: '第11周', quote: '第 11 周周三 3-4 节 Java 程序设计调到周五 5-6 节，地点改为博雅楼 A302，其余周次不变',
        courseId: 'tc_java', weekday: 5, startSection: 5, endSection: 6, location: '博雅楼 A302', teacher: '', conflict: '',
      },
      {
        action: 'relocate', courseName: '数据库原理', weekText: '第11周', quote: '第 11 周数据库原理地点改为博雅楼 A306',
        courseId: 'tc_db', weekday: 0, startSection: 0, endSection: 0, location: '博雅楼 A306', teacher: '', conflict: '',
      },
    ],
  });
}

function cloudFor(state) {
  const calls = [];
  return {
    calls,
    callFunction(options) {
      calls.push({ name: options.name, data: options.data });
      const action = options.data.action;
      if (options.name === 'ai' && action === 'chat') return Promise.resolve({ result: aiReply(replyText()) });
      if (action === 'list') {
        return Promise.resolve({
          result: { ok: true, count: state.courses.length, semester: '2026-2027学年第一学期', updatedAt: '', courses: state.courses.map((item) => ({ ...item })) },
        });
      }
      if (action === 'getSettings') {
        return Promise.resolve({
          result: { ok: true, saved: true, settings: { semesterName: '2026-2027学年第一学期', startDate: '2026-09-07', totalWeeks: 18, sectionTimes: [] } },
        });
      }
      if (action === 'applyScopedChange') {
        const index = state.applyCount++;
        state.requestIds.push(options.data.requestId);
        if (state.failAt !== null && index === state.failAt) return Promise.reject(new Error('服务端暂时不可用'));
        const id = options.data.id;
        const original = state.courses.find((item) => item.id === id);
        if (original === undefined) return Promise.reject(new Error('课程不存在'));
        if (!original.weeks.includes(11)) {
          // 同一操作重试：已经拆过就不再拆一次。
          return Promise.resolve({ result: { ok: true, id, requestId: options.data.requestId } });
        }
        original.weeks = original.weeks.filter((week) => week !== 11);
        original.weekText = '[1-10,12-16]周';
        const input = options.data.course;
        const split = {
          ...original,
          id: `${id}_w11`,
          weeks: [11],
          weekText: '[11]周',
          weekday: input.weekday,
          sectionRanges: input.sectionRanges,
          startSection: input.startSection,
          endSection: input.endSection,
          location: input.location,
        };
        state.courses.push(split);
        return Promise.resolve({ result: { ok: true, id, requestId: options.data.requestId } });
      }
      if (action === 'undoScopedChange') {
        const index = state.undoCount++;
        if (state.failUndo > 0) {
          state.failUndo -= 1;
          return Promise.reject(new Error('撤销写入失败'));
        }
        state.courses = state.initial.map((item) => ({ ...item, weeks: item.weeks.slice() }));
        return Promise.resolve({ result: { ok: true } });
      }
      return Promise.reject(new Error(`未预设的 action：${action}`));
    },
  };
}

function baseWx(cloud) {
  const actions = [];
  const store = new Map();
  return {
    cloud,
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => { store.set(key, value); },
    removeStorageSync: (key) => { store.delete(key); },
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    switchTab: (options) => { actions.push(`switchTab:${options.url}`); if (options.success) options.success(); },
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => { actions.push(`modal:${options.title}`); if (options.success) options.success({ confirm: true }); },
    actions,
    store,
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

function loadPage(wx) {
  globalThis.wx = wx;
  const filename = path.resolve('dist/pages/timetable/index.js');
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = instantiate(options); },
    wx,
    getCurrentPages: () => [{}],
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    Date,
  }, { filename });
  return page;
}

function stateFor() {
  const initial = [
    course(),
    course({ id: 'tc_db', name: '数据库原理', weekday: 3, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6, location: '博雅楼 A302' }),
  ];
  return { initial, courses: initial.map((item) => ({ ...item, weeks: item.weeks.slice() })), applyCount: 0, undoCount: 0, failAt: null, failUndo: 0, requestIds: [] };
}

async function openProposal(page) {
  page.openAssistant();
  page.toggleNotice();
  page.onNoticeInput({ detail: { value: '第 11 周周三 3-4 节 Java 程序设计调到周五 5-6 节，地点改为博雅楼 A302；第 11 周数据库原理地点改为博雅楼 A306。' } });
  await page.readNotice();
}

test('修改通知后重新识别失败：旧提案失效，不能按旧内容写课', async () => {
  const state = stateFor();
  const cloud = cloudFor(state);
  const wx = baseWx(cloud);
  const page = loadPage(wx);
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  await openProposal(page);
  assert.ok(page.data.noticeProposal);
  const call = cloud.callFunction;
  cloud.callFunction = (options) => options.name === 'ai'
    ? Promise.reject(new Error('新通知识别失败')) : call(options);
  await page.readNoticeText('改为第12周周五上课');
  assert.equal(page.data.noticeProposal, null);
  await page.applyNotice();
  assert.equal(state.applyCount, 0);
});

test('重核空白或超长新通知也作废旧提案，不能应用不匹配原文的改动', async () => {
  for (const text of ['', '新'.repeat(4001)]) {
    const state = stateFor();
    const wx = baseWx(cloudFor(state));
    const page = loadPage(wx);
    page.onLoad({ today: '2026-11-11', clock: '10:00' });
    await page.onShow();
    await openProposal(page);
    page.editNotice();
    page.setData({ noticeDraft: text });
    await page.rereadNotice();
    assert.equal(page.data.noticeProposal, null);
    await page.applyNotice();
    assert.equal(state.applyCount, 0);
  }
});

test('识别等待时更改原通知，迟到回复不能恢复旧提案或写入旧改动', async () => {
  const state = stateFor();
  const cloud = cloudFor(state);
  let respond;
  const original = cloud.callFunction;
  cloud.callFunction = (options) => options.name === 'ai'
    ? new Promise((resolve) => { respond = resolve; }) : original(options);
  const wx = baseWx(cloud);
  const page = loadPage(wx);
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  const pending = openProposal(page);
  page.onNoticeInput({ detail: { value: '新通知取消调课，不修改课程' } });
  respond({ result: aiReply(replyText()) });
  await pending;
  assert.equal(page.data.noticeProposal, null);
  assert.equal(page.data.noticeInput, '新通知取消调课，不修改课程');
  assert.equal(page.data.noticeReading, false);
  await page.applyNotice();
  assert.equal(state.applyCount, 0);
});

test('正在应用通知时保持原文和提案锁定，不允许新解析清除写入批次', async () => {
  const state = stateFor();
  const cloud = cloudFor(state);
  const page = loadPage(baseWx(cloud));
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  await openProposal(page);
  const text = page.data.noticeInput;
  const proposal = JSON.stringify(page.data.noticeProposal);
  const beforeCalls = cloud.calls.length;
  page.setData({ noticeApplying: true });
  page.onNoticeInput({ detail: { value: '写入中改成另一份通知' } });
  page.editNotice();
  await page.readNoticeText('写入中请求新解析');
  assert.equal(page.data.noticeInput, text);
  assert.equal(JSON.stringify(page.data.noticeProposal), proposal);
  assert.equal(cloud.calls.length, beforeCalls);
});

test('限定第 11 周调课：只拆这一周，其他周保留；保存后回到第 11 周并标出目标课程', async () => {
  const state = stateFor();
  const cloud = cloudFor(state);
  const wx = baseWx(cloud);
  const page = loadPage(wx);
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  assert.equal(page.data.week, 10, '11/11 是第 10 周');

  await openProposal(page);
  assert.equal(page.data.noticeProposal.rows.length, 2);
  assert.equal(page.data.noticeProposal.checkedCount, 2);

  await page.applyNotice();
  assert.equal(cloud.calls.filter((call) => call.data.action === 'updateCourse').length, 0, '限定周次不走整条更新');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'applyScopedChange').length, 2);

  assert.equal(page.data.week, 11, '保存后留在对应周');
  assert.ok(page.data.highlightIds.includes('tc_java_w11'), '拆出来的第 11 周课程要标出');
  assert.match(page.data.changeStrip.label, /仅第 11 周/u);
  assert.equal(page.data.noticeResult.kind, 'changed');
  assert.equal(page.data.noticeResult.week, 11);

  const java = page.data.courses.find((item) => item.id === 'tc_java');
  assert.equal(java.weeks.includes(11), false, '原课保留其他周，不含第 11 周');
  assert.equal(java.weeks.includes(10), true);
  assert.equal(java.weeks.includes(12), true);
  const split = page.data.courses.find((item) => item.id === 'tc_java_w11');
  assert.deepEqual(split.weeks, [11]);
  assert.equal(split.weekday, 5);

  const friday = page.data.gridUi.columns[4];
  assert.ok(friday.blocks.some((block) => block.changed && block.name === 'Java 程序设计'), '周五课块要有本次调整标记');
  assert.ok(page.data.scrollLeft > 0, '靠后的周五列要滚进可视区');
});

test('撤销：整项恢复原安排；撤销失败时保留可重试状态，重复点击不重复写', async () => {
  const state = stateFor();
  const cloud = cloudFor(state);
  const wx = baseWx(cloud);
  const page = loadPage(wx);
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  await openProposal(page);

  const first = page.applyNotice();
  const second = page.applyNotice();
  assert.equal(second, undefined, '写入中重复点击应直接返回');
  await first;
  assert.equal(cloud.calls.filter((call) => call.data.action === 'applyScopedChange').length, 2, '重复点击不重复写');

  state.failUndo = 1;
  await page.undoNotice();
  assert.match(page.data.noticeToast.text, /撤销没做完/u);
  assert.equal(page.data.noticeToast.canUndo, true, '失败后仍可再次撤销');
  assert.ok(page.undoStack.length > 0, '未完成的撤销步骤保留');

  await page.undoNotice();
  assert.equal(page.data.noticeResult.kind, 'undone');
  assert.equal(page.data.noticeResult.week, 11);
  assert.equal(page.data.highlightIds.length, 0);
  assert.equal(page.data.changeStrip, null);
  const java = page.data.courses.find((item) => item.id === 'tc_java');
  assert.equal(java.weeks.includes(11), true, '撤销后第 11 周恢复');
  assert.equal(page.data.courses.some((item) => item.id === 'tc_java_w11'), false);
});

test('部分成功：已保存项不重复执行，重试只处理失败项，结果页分清「先前/重试后」', async () => {
  const state = stateFor();
  state.failAt = 1;
  const cloud = cloudFor(state);
  const wx = baseWx(cloud);
  const page = loadPage(wx);
  page.onLoad({ today: '2026-11-11', clock: '10:00' });
  await page.onShow();
  await openProposal(page);

  await page.applyNotice();
  assert.equal(page.data.noticeResult, null, '部分失败不装作全部完成');
  assert.equal(page.data.noticeBatch.saved, 1);
  assert.equal(page.data.noticeBatch.failed, 1);
  assert.match(page.data.noticeError, /已应用 1 处，第 2 处失败/u);
  assert.match(page.data.noticeToast.text, /还有 1 处没写进去/u);
  assert.equal(page.data.noticeProposal.rows[0].status, 'saved');
  assert.equal(page.data.noticeProposal.rows[1].status, 'failed');
  const retryId = page.data.noticeProposal.rows[1].requestId;
  assert.ok(retryId, '失败项要保留可重试的操作编号');

  await page.retryNotice();
  assert.equal(page.data.noticeResult.kind, 'batch');
  assert.equal(page.data.noticeResult.rows.find((row) => row.name === 'Java 程序设计').status, '先前已保存');
  assert.equal(page.data.noticeResult.rows.find((row) => row.name === '数据库原理').status, '重试后已保存');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'applyScopedChange').length, 3, '重试只补失败的那一项');
  assert.equal(page.data.noticeProposal.rows[1].requestId, retryId, '重试沿用同一操作编号');
  assert.equal(page.data.courses.filter((item) => item.id === 'tc_java_w11').length, 1, '已保存项没有重复拆课');
});
