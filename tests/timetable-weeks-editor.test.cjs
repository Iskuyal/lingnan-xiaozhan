const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 周次编辑器（课程新增 / 修改页，设计图 06）的纯函数层与页面接线。
// 纯函数层不碰存储、不碰小程序运行时：只吃「已有周次」与「用户动作」，吐「新的周次和显示状态」。
const editor = require('../dist/services/timetable/weeks-editor.js');
const palette = require('../dist/services/timetable/palette.js');

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

/* ---------- 起止周 / 单双周 / 全学期 ---------- */

test('起止周：合法区间逐周展开，倒置与越界返回空数组且不抛异常', () => {
  assert.deepEqual(editor.weeksFromRange(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(editor.weeksFromRange(5, 5), [5], '起止同周就是一周');
  assert.equal(editor.weeksFromRange(1, 30).length, 30, '上限 30 周仍可展开');

  assert.deepEqual(editor.weeksFromRange(5, 4), [], '起止倒置');
  assert.deepEqual(editor.weeksFromRange(0, 5), [], '起始小于 1');
  assert.deepEqual(editor.weeksFromRange(1, 31), [], '结束大于 30');
  assert.deepEqual(editor.weeksFromRange(1.5, 3), [], '非整数');
  assert.deepEqual(editor.weeksFromRange(Number.NaN, 3), [], 'NaN');
  assert.deepEqual(editor.weeksFromRange('1', 3), [], '字符串不是周次');
  assert.deepEqual(editor.weeksFromRange(undefined, undefined), [], '缺省值');

  assert.equal(editor.isValidRange(4, 16), true);
  assert.equal(editor.isValidRange(5, 4), false);
  assert.equal(editor.isValidRange(0, 4), false);
  assert.equal(editor.isValidRange(4, 31), false);
  assert.equal(editor.isValidRange(null, 4), false);
});

test('单双周与全学期：以 20 周网格为界，单双各 10 个', () => {
  assert.deepEqual(editor.weeksByParity('odd'), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  assert.deepEqual(editor.weeksByParity('even'), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.deepEqual(editor.weeksByParity('odd', 8), [1, 3, 5, 7], '跨度可传，用于测试与将来的短学期');
  assert.deepEqual(editor.weeksByParity('odd', 1), [1]);
  assert.deepEqual(editor.weeksByParity('even', 1), [], '一节跨度里没有双周');

  assert.deepEqual(editor.weeksAll(), range(1, 20));
  assert.deepEqual(editor.weeksAll(0), [], '零跨度是空集，不是整学期');
  assert.deepEqual(editor.weeksAll(6), range(1, 6));
});

test('周次集合的规整：去重、排序、丢掉越界与非整数', () => {
  assert.deepEqual(editor.normalizeWeeks([5, 4, 4, 30, 0, 31, 2.5, '6', null]), [4, 5, 30]);
  assert.deepEqual(editor.normalizeWeeks([]), []);
  assert.deepEqual(editor.normalizeWeeks([1, 2, 3]), [1, 2, 3]);
});

test('自选网格逐周勾选：加一格、去掉一格，越界格子不动集合', () => {
  assert.deepEqual(editor.toggleWeek([4, 5], 6), [4, 5, 6]);
  assert.deepEqual(editor.toggleWeek([4, 5], 4), [5], '再点一次取消');
  assert.deepEqual(editor.toggleWeek([5, 4, 4], 3), [3, 4, 5], '合并时去重并排序');
  assert.deepEqual(editor.toggleWeek([4], 0), [4], '第 0 周不是教学周');
  assert.deepEqual(editor.toggleWeek([4], 31), [4], '超过 30 周不动集合');
  assert.deepEqual(editor.toggleWeek([], 20), [20]);
});

/* ---------- 编辑状态与周次集合的互转 ---------- */

test('从已有周次反推显示状态：起止周、单双周、是否自选', () => {
  const all = editor.editorFromWeeks(range(1, 20));
  assert.equal(all.mode, 'all');
  assert.equal(all.start, 1);
  assert.equal(all.end, 20);
  assert.equal(all.dirty, false);

  const odd = editor.editorFromWeeks(editor.weeksByParity('odd'));
  assert.equal(odd.mode, 'odd', '整份单周要认出来，不是「自选」');
  assert.equal(odd.start, 1);
  assert.equal(odd.end, 19);

  const even = editor.editorFromWeeks(editor.weeksByParity('even'));
  assert.equal(even.mode, 'even');
  assert.equal(even.start, 2);
  assert.equal(even.end, 20);

  const custom = editor.editorFromWeeks([4, 5, 7, 8, 9, 10]);
  assert.equal(custom.mode, 'custom', '不连续、也不是整份单双周');
  assert.equal(custom.start, 4, '起止周取最小与最大，供输入框显示');
  assert.equal(custom.end, 10);

  const empty = editor.editorFromWeeks([]);
  assert.deepEqual(empty.weeks, []);
  assert.equal(empty.start, null, '没选周次时输入框留空，而不是替用户填 1');
  assert.equal(empty.end, null);
  assert.equal(empty.dirty, false);
  assert.equal(empty.rangeInvalid, false, '没填过不算填错');
});

test('不变量：没动过就原样保留原集合，改过之后才按参数重算', () => {
  const original = [4, 5, 7, 8, 9, 10];
  const state = editor.editorFromWeeks(original);
  assert.deepEqual(state.weeks, original, '未改动时 weeks 就是记录里的周次，不按 4-10 重算');
  assert.equal(state.dirty, false);

  // 只切到「自选」不是改动：已勾的格子不会被清掉，也不算改过。
  const toCustom = editor.setMode(state, 'custom');
  assert.deepEqual(toCustom.weeks, original, '切换改法不丢已选');
  assert.equal(toCustom.dirty, false);

  // 用户真的改了起止周：按参数重算。
  const byRange = editor.setRange(state, 5, 6);
  assert.deepEqual(byRange.weeks, [5, 6]);
  assert.equal(byRange.dirty, true);
  assert.equal(byRange.mode, 'custom');
  assert.equal(byRange.rangeInvalid, false);

  // 用户点了网格：在已选之上增删，起止周跟着变成最小 / 最大。
  const byGrid = editor.toggleGridWeek(state, 11);
  assert.deepEqual(byGrid.weeks, [4, 5, 7, 8, 9, 10, 11]);
  assert.equal(byGrid.start, 4);
  assert.equal(byGrid.end, 11);
  assert.equal(byGrid.dirty, true);

  // 原状态不被就地改写：纯函数只返回新对象。
  assert.deepEqual(state.weeks, original);
});

test('快捷改法：全学期 / 清空 / 单周 / 双周都写在同一份周次上', () => {
  const state = editor.editorFromWeeks([5]);

  const all = editor.setMode(state, 'all');
  assert.deepEqual(all.weeks, range(1, 20));
  assert.deepEqual([all.start, all.end], [1, 20]);
  assert.equal(all.dirty, true);

  const odd = editor.setMode(state, 'odd');
  assert.deepEqual(odd.weeks, editor.weeksByParity('odd'));
  assert.deepEqual([odd.start, odd.end], [1, 19]);

  const even = editor.setMode(state, 'even');
  assert.deepEqual(even.weeks, editor.weeksByParity('even'));
  assert.deepEqual([even.start, even.end], [2, 20]);

  const cleared = editor.clearGrid(all);
  assert.deepEqual(cleared.weeks, []);
  assert.equal(cleared.start, null, '清空后输入框也空，不留下 1-20 的假区间');
  assert.equal(cleared.dirty, true);
});

test('起止周填错：按空集处理并给出可判定的 rangeInvalid，不抛异常', () => {
  const state = editor.editorFromWeeks([4, 5, 6]);
  const inverted = editor.setRange(state, 8, 3);
  assert.deepEqual(inverted.weeks, [], '倒置按空集处理');
  assert.equal(inverted.rangeInvalid, true);
  assert.deepEqual([inverted.start, inverted.end], [8, 3], '原文留在输入框里，不替用户改');

  const over = editor.setRange(state, 1, 31);
  assert.deepEqual(over.weeks, []);
  assert.equal(over.rangeInvalid, true);

  const half = editor.setRange(state, 5, null);
  assert.deepEqual(half.weeks, [], '只填了一头也是不完整的区间');
  assert.equal(half.rangeInvalid, true);
});

test('网格与快捷按钮的显示状态：20 格、勾选与对勾，模式 pill 的选中', () => {
  const state = editor.toggleGridWeek(editor.editorFromWeeks([]), 6);
  const cells = editor.gridCells(state);
  assert.equal(cells.length, 20, '自选网格固定 1-20 格');
  assert.deepEqual(cells.slice(0, 3).map((cell) => cell.week), [1, 2, 3]);
  assert.equal(cells[5].week, 6);
  assert.equal(cells[5].on, true);
  assert.equal(cells[4].on, false);
  assert.deepEqual(editor.gridCells(state, 4).map((cell) => cell.week), [1, 2, 3, 4]);

  const pills = editor.modePills(editor.editorFromWeeks(editor.weeksByParity('even')));
  assert.deepEqual(pills.map((pill) => pill.key), ['all', 'odd', 'even', 'custom']);
  assert.deepEqual(pills.map((pill) => pill.label), ['全学期', '单周', '双周', '自选']);
  assert.deepEqual(pills.filter((pill) => pill.on).map((pill) => pill.key), ['even']);
});

test('网格的淡显：起止周区间之外的格子淡显，区间内未勾选的是普通态', () => {
  // 设计图 06 的读法：4-16 区间里第 6 周没勾（普通态），1-3 与 17-20 在区间外（淡显）。
  const cells = editor.gridCells(editor.editorFromWeeks([4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  assert.equal(cells[0].outside, true, '第 1 周在区间外');
  assert.equal(cells[2].outside, true, '第 3 周在区间外');
  assert.equal(cells[3].outside, false, '第 4 周是区间起点');
  assert.equal(cells[5].outside, false, '第 6 周在区间内，只是没勾');
  assert.equal(cells[15].outside, false, '第 16 周是区间终点');
  assert.equal(cells[16].outside, true, '第 17 周在区间外');
  assert.equal(editor.gridCells(editor.editorFromWeeks([]))[0].outside, false, '没选周次时不淡显任何格子');
});

test('合并写法由系统生成：顿号分隔的紧凑写法，空集是空文本', () => {
  assert.equal(editor.weeksTextOf(editor.editorFromWeeks([4, 5, 7, 8, 9, 10])), '4-5、7-10');
  assert.equal(editor.weeksTextOf(editor.editorFromWeeks([6])), '6');
  assert.equal(editor.weeksTextOf(editor.editorFromWeeks([])), '', '空集没有写法，对应「每周」');
});

/* ---------- 页面接线 ---------- */

/** 页面桩：setData 支持 'a.b' 形式的键，与微信的写法一致。 */
function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!key.includes('.')) {
        page.data[key] = value;
        continue;
      }
      const parts = key.split('.');
      let target = page.data;
      for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
      target[parts[parts.length - 1]] = value;
    }
  };
  return page;
}

function loadEditPage(wx, stack = [{}]) {
  globalThis.wx = wx;
  const filename = path.resolve('dist/pages/timetable/edit/index.js');
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

function baseWx(cloud) {
  const actions = [];
  return {
    cloud,
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => actions.push(`modal:${options.title}`),
    actions,
  };
}

const tapWeek = (page, week) => page.onWeeksGridTap({ currentTarget: { dataset: { week } } });

test('编辑页接线：起止周、网格与快捷改法写同一份周次，保存时合并成一种写法', async () => {
  const cloud = cloudStub({ createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }) });
  const wx = baseWx(cloud);
  const page = loadEditPage(wx);
  page.onLoad({ scope: 'new' });
  assert.equal(page.data.status, 'ready');

  page.onNameInput({ detail: { value: '线性代数' } });
  page.onWeekdayTap({ currentTarget: { dataset: { index: 2 } } });
  page.onStartCommit({ detail: { value: '3' } });
  page.onEndCommit({ detail: { value: '4' } });
  assert.equal(page.data.form.weekdayIndex, 2);
  assert.deepEqual([page.data.form.startIndex, page.data.form.endIndex], [2, 3]);

  // 起止周：两个数字输入
  page.onWeeksStartCommit({ detail: { value: '5' } });
  page.onWeeksEndCommit({ detail: { value: '6' } });
  assert.deepEqual(page.data.weeksEditor.weeks, [5, 6]);
  assert.equal(page.data.weeksError, '', '完整区间不该报错');

  // 自选网格逐周勾选：与起止周是同一份周次
  tapWeek(page, 8);
  assert.deepEqual(page.data.weeksEditor.weeks, [5, 6, 8]);
  assert.deepEqual([page.data.weeksStartText, page.data.weeksEndText], ['5', '8'], '起止周跟着网格走');
  assert.equal(page.data.form.weeksText, '5-6、8', '合并写法由系统生成');
  assert.equal(page.data.weeksGrid[5].on, true);
  assert.equal(page.data.weeksGrid[6].on, false, '第 7 周没勾上');

  // 颜色：自动 → 手动 c4
  assert.equal(page.data.colorMode, 'auto');
  page.onColorManual();
  page.onColorPick({ currentTarget: { dataset: { key: 'c4' } } });
  assert.equal(page.data.colorMode, 'manual');
  assert.equal(page.data.colorKey, 'c4');
  assert.equal(page.data.colorName, '松绿');
  assert.deepEqual(page.data.colorSwatches.filter((item) => item.on).map((item) => item.key), ['c4']);

  page.save();
  await new Promise((resolve) => setImmediate(resolve));
  const created = cloud.calls.find((call) => call.data.action === 'createCourse');
  assert.ok(created, '应调用云函数新增课程');
  assert.deepEqual(created.data.course.weeks, [5, 6, 8]);
  assert.equal(created.data.course.weekText, '5-6、8');
  assert.equal(created.data.course.color, 'c4');
  assert.equal(created.data.course.weekday, 3);
  assert.deepEqual(created.data.course.sectionRanges, [{ start: 3, end: 4 }]);
  delete globalThis.wx;
});

test('编辑页接线：按课程名自动配色时不写 color，色块按名字取色', () => {
  const cloud = cloudStub({ createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }) });
  const page = loadEditPage(baseWx(cloud));
  page.onLoad({ scope: 'new' });
  page.onNameInput({ detail: { value: '大学美育' } });
  const expected = palette.colorIndexFor('大学美育');
  assert.equal(page.data.colorIndex, expected, '自动模式下按课程名取色');
  assert.deepEqual(page.data.colorSwatches.filter((item) => item.on).map((item) => item.key), [palette.colorAt(expected).key]);
  assert.equal(page.data.colorName, palette.colorAt(expected).name);

  page.onWeeksMode({ currentTarget: { dataset: { mode: 'all' } } });
  assert.deepEqual(page.data.weeksEditor.weeks, Array.from({ length: 20 }, (_, index) => index + 1));
  page.save();
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    const created = cloud.calls.find((call) => call.data.action === 'createCourse');
    assert.equal(created.data.course.color, '', '自动配色存空字符串，取色始终由课程名决定');
    delete globalThis.wx;
  });
});

test('编辑页接线：打开已保存课程不动编辑器就原样保留周次，原文与待核对项在琥珀提示里', async () => {
  const course = {
    id: 'tc_1', name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 2,
    startSection: 5, endSection: 6, sectionRanges: [{ start: 5, end: 6 }],
    weeks: [4, 5, 7, 8, 9, 10], weeksRecognized: true, weekText: '[4-5,7-10]周',
    location: '崇礼楼 306', campus: '清远校区', siteNumber: '44', note: '1班',
    warnings: ['节次原文 5-6 与识别结果一致，备用'], source: 'excel',
    semester: '2026-2027学年第一学期', rawText: '高等数学 1.5 林加燕 [4-5,7-10]周 5-6节 崇礼楼 306',
    createdAt: '', updatedAt: '',
  };
  const cloud = cloudStub({
    list: () => ({ ok: true, count: 1, semester: course.semester, updatedAt: '', courses: [course] }),
    updateCourse: (data) => ({ ok: true, id: data.id }),
  });
  const page = loadEditPage(baseWx(cloud));
  await page.onLoad({ scope: 'saved', id: 'tc_1' });
  assert.equal(page.data.status, 'ready');

  assert.deepEqual(page.data.weeksEditor.weeks, course.weeks, '不动编辑器就原样保留原集合');
  assert.equal(page.data.weeksEditor.dirty, false);
  assert.deepEqual([page.data.weeksStartText, page.data.weeksEndText], ['4', '10'], '起止周按最小 / 最大显示');
  assert.equal(page.data.form.note, '1班', '备注可编辑，初值来自记录');
  assert.equal(page.data.hasOriginal, true, '导入来的记录要能看到原文');
  assert.match(page.data.calloutText, /原文已保留/u);
  assert.match(page.data.calloutText, /节次原文 5-6/u);
  assert.match(page.data.rawText, /高等数学/u, '原文行只读保留');
  assert.match(page.data.warningText, /节次原文/u);

  page.onNameInput({ detail: { value: '高等数学（改）' } });
  page.save();
  await new Promise((resolve) => setImmediate(resolve));
  const updated = cloud.calls.find((call) => call.data.action === 'updateCourse');
  assert.deepEqual(updated.data.course.weeks, course.weeks);
  assert.equal(updated.data.course.note, '1班');
  assert.equal(updated.data.course.color, '');
  delete globalThis.wx;
});

test('编辑页接线：迷你预览 7 列 × 6 行，只画正在编辑的这节课，块高与颜色取当前值', async () => {
  const cloud = cloudStub({ createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }) });
  const page = loadEditPage(baseWx(cloud));
  page.onLoad({ scope: 'new' });
  page.onNameInput({ detail: { value: '体育（三）' } });
  page.onWeekdayTap({ currentTarget: { dataset: { index: 0 } } });
  page.onStartCommit({ detail: { value: '3' } });
  page.onEndCommit({ detail: { value: '4' } });

  assert.equal(page.data.miniColumns.length, 7, '7 列');
  assert.equal(page.data.miniColumns[0].cells.length, 6, '6 行（每行两节）');
  const placed = page.data.miniColumns[0].cells.filter((cell) => cell.block);
  assert.equal(placed.length, 1, '只画一节课的块');
  // 页面模块自己造的数组与测试文件不同源，按长度比而不是 deepEqual。
  const otherBlocks = page.data.miniColumns
    .slice(1)
    .reduce((total, column) => total + column.cells.filter((cell) => cell.block).length, 0);
  assert.equal(otherBlocks, 0, '别的天不画块');
  assert.match(page.data.miniColumns[0].cells[1].style, /^height:\d+rpx;--blk-tint:rgba\(/u, '块高按跨行数算，颜色取当前色');
  delete globalThis.wx;
});
