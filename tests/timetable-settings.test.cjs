const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 学期设置与作息时间（设计图 07）。三层一起验：
// 1) 纯函数（分钟换算、此刻在上/下一节、保存前校验）——直接 require 构建产物；
// 2) 云函数（真实入口 + 数据库桩，与 tests/timetable-flow.test.cjs 同一手法）；
// 3) 设置页（构建产物里的页面定义，wx 与云调用换成桩，骨架同 tests/timetable-pages.test.cjs）。
const settings = require('../dist/services/timetable/settings.js');

const FUNCTION_FILE = path.resolve('dist/cloudfunctions/timetable/index.js');

// ---------- 页面与云调用的桩（骨架同 tests/timetable-pages.test.cjs，本文件不改那个文件） ----------

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

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 页面在 vm 语境里创建的对象与主语境原型不同，deepEqual 前先统一成纯结构。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------- 云函数桩运行环境（真实入口 + 内存数据库） ----------

function cloudHarness() {
  const docs = [];
  const context = { openid: '' };

  function match(doc, condition) {
    return Object.entries(condition).every(([key, expected]) => doc[key] === expected);
  }

  const db = {
    command: { neq: (value) => ({ __neq: value }) },
    collection() {
      const state = { condition: null, limit: 100 };
      const api = {
        where(condition) { state.condition = condition; return api; },
        skip() { return api; },
        limit(value) { state.limit = value; return api; },
        orderBy() { return api; },
        async get() {
          const rows = docs.filter((doc) => state.condition === null || match(doc, state.condition));
          return { data: rows.slice(0, state.limit) };
        },
        async add({ data }) {
          const doc = { _id: `doc-${docs.length + 1}`, ...data };
          docs.push(doc);
          return { _id: doc._id };
        },
        async remove() {
          const keep = docs.filter((doc) => state.condition === null || !match(doc, state.condition));
          const removed = docs.length - keep.length;
          docs.length = 0;
          docs.push(...keep);
          return { stats: { removed } };
        },
        doc(id) {
          return {
            async update({ data }) {
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) throw new Error('document not exists');
              Object.assign(doc, data);
              return { stats: { updated: 1 } };
            },
            async remove() {
              const index = docs.findIndex((item) => item._id === id);
              if (index < 0) throw new Error('document not exists');
              docs.splice(index, 1);
              return { stats: { removed: 1 } };
            },
          };
        },
      };
      return api;
    },
  };

  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'dynamic',
    database: () => db,
    getWXContext: () => ({ OPENID: context.openid }),
    async downloadFile() { throw new Error('本测试不涉及云存储下载'); },
    async deleteFile({ fileList }) { return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }; },
  };

  const realRequire = createRequire(FUNCTION_FILE);
  const sandbox = {
    exports: {}, Buffer, console, process,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(FUNCTION_FILE, 'utf8'), sandbox, { filename: FUNCTION_FILE });
  const run = (openid, event) => {
    context.openid = openid;
    return sandbox.exports.main(event);
  };
  return { run, docs };
}

// ---------- 样本 ----------

/** 12 条空作息换成给定时刻：没给的下标留空。 */
function withTimes(times) {
  const base = settings.emptySettings();
  return {
    ...base,
    sectionTimes: base.sectionTimes.map((each, index) => times[index] ?? { start: '', end: '' }),
  };
}

/** 第 1 节 09:00-09:45、第 2 节 09:50-10:35、第 3 节未填、第 4 节 11:00-11:45。 */
const FIXTURE = withTimes([
  { start: '09:00', end: '09:45' },
  { start: '09:50', end: '10:35' },
  { start: '', end: '' },
  { start: '11:00', end: '11:45' },
]);

const EMPTY = settings.emptySettings();

// ---------- 纯函数：分钟换算与单节取值 ----------

test('minutesOfClock：HH:MM 换算成当天第几分钟，非法写法一律 null', () => {
  assert.equal(settings.minutesOfClock('00:00'), 0);
  assert.equal(settings.minutesOfClock('09:05'), 545);
  assert.equal(settings.minutesOfClock('13:00'), 780);
  assert.equal(settings.minutesOfClock('23:59'), 1439);
  assert.equal(settings.minutesOfClock(' 09:05 '), 545, '两侧空白先剪掉');
  for (const bad of ['', '9:05', '08:5', '24:00', '12:60', '08:15:00', '08-15', '08：15', 'aa:bb', '0800']) {
    assert.equal(settings.minutesOfClock(bad), null, `${JSON.stringify(bad)} 应判为非法`);
  }
});

test('sectionTimeAt：没填、只填一半、起止倒置都按「没有这一节」处理', () => {
  assert.deepEqual(settings.sectionTimeAt(FIXTURE, 1), { start: '09:00', end: '09:45' });
  assert.equal(settings.sectionTimeAt(FIXTURE, 3), null, '未填的节返回 null');
  assert.equal(settings.sectionTimeAt(EMPTY, 1), null, '全未填时返回 null');
  assert.equal(settings.sectionTimeAt(withTimes([{ start: '09:00', end: '' }]), 1), null, '只填一半等于没填');
  assert.equal(settings.sectionTimeAt(withTimes([{ start: '10:00', end: '09:00' }]), 1), null, '倒置不算一个区间');
  assert.equal(settings.sectionTimeAt(FIXTURE, 0), null);
  assert.equal(settings.sectionTimeAt(FIXTURE, 13), null);
  assert.equal(settings.sectionTimeAt(FIXTURE, 1.5), null);
});

// ---------- 纯函数：此刻在上 / 下一节 ----------

test('currentSectionAt：正在上、边界那一分钟、课间与没填的节', () => {
  assert.equal(settings.currentSectionAt(FIXTURE, 555), 1, '09:15 在上第 1 节');
  assert.equal(settings.currentSectionAt(FIXTURE, 540), 1, '上课那一分钟算在课内');
  assert.equal(settings.currentSectionAt(FIXTURE, 585), null, '下课那一分钟已经下课');
  assert.equal(settings.currentSectionAt(FIXTURE, 587), null, '课间不属于任何一节');
  assert.equal(settings.currentSectionAt(FIXTURE, 620), 2, '10:20 在上第 2 节');
  assert.equal(settings.currentSectionAt(FIXTURE, 640), null, '第 2 节下课后是课间；第 3 节未填，不猜');
  assert.equal(settings.currentSectionAt(FIXTURE, 670), 4, '11:10 在上第 4 节');
  assert.equal(settings.currentSectionAt(FIXTURE, 720), null, '一天的课都上完了');
  assert.equal(settings.currentSectionAt(EMPTY, 555), null, '一节都没填时返回 null');
});

test('currentSectionAt：同一时刻最多算一节（数据被改重叠时也只给一节）', () => {
  const overlapping = withTimes([{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }]);
  assert.equal(settings.currentSectionAt(overlapping, 570), 1);
  assert.equal(typeof settings.currentSectionAt(overlapping, 570), 'number');
});

test('nextSectionAt：课间给下一节、跳过没填的节、全上完给 null', () => {
  assert.equal(settings.nextSectionAt(FIXTURE, 480), 1, '上课前是第 1 节');
  assert.equal(settings.nextSectionAt(FIXTURE, 555), 1, '正在上的这一节还没结束，就是它');
  assert.equal(settings.nextSectionAt(FIXTURE, 587), 2, '第 1 节下课后的课间给下一节');
  assert.equal(settings.nextSectionAt(FIXTURE, 640), 4, '第 2 节已上完；第 3 节未填要跳过，给第 4 节');
  assert.equal(settings.nextSectionAt(FIXTURE, 700), 4, '正在上的第 4 节还没结束');
  assert.equal(settings.nextSectionAt(FIXTURE, 705), null, '第 4 节下课的那一分钟起就没有下一节了');
  assert.equal(settings.nextSectionAt(FIXTURE, 720), null, '全部上完返回 null');
  assert.equal(settings.nextSectionAt(EMPTY, 555), null, '一节都没填时返回 null');
});

// ---------- 纯函数：保存前校验 ----------

test('validateSettings：起止倒置与重叠都拒绝，并指出是哪几节', () => {
  assert.match(
    settings.validateSettings(withTimes([{ start: '10:00', end: '09:00' }])),
    /第 1 节的结束时刻要晚于起始时刻/u,
  );
  assert.match(
    settings.validateSettings(withTimes([{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }])),
    /第 1 节与第 2 节的作息时间重叠了/u,
  );
  assert.match(
    settings.validateSettings(withTimes([
      { start: '09:00', end: '11:00' },
      { start: '', end: '' },
      { start: '10:00', end: '10:45' },
    ])),
    /第 1 节与第 3 节/u,
    '跨过未填的节也算重叠',
  );
});

test('validateSettings：格式、范围与条数都说清原因；只填一半是合法状态', () => {
  assert.match(settings.validateSettings(withTimes([{ start: '9:00', end: '10:00' }])), /第 1 节的起始时刻/u);
  assert.match(settings.validateSettings(withTimes([{ start: '09:00', end: '25:00' }])), /第 1 节的结束时刻/u);
  assert.match(settings.validateSettings({ ...EMPTY, startDate: '2026-02-30' }), /YYYY-MM-DD/u);
  assert.match(settings.validateSettings({ ...EMPTY, totalWeeks: 31 }), /1-30/u);
  assert.match(settings.validateSettings({ ...EMPTY, totalWeeks: 0 }), /1-30/u);
  assert.match(settings.validateSettings({ ...EMPTY, sectionTimes: [] }), /12 条/u);
  assert.equal(settings.validateSettings(withTimes([{ start: '09:00', end: '' }])), '', '只填起始是合法状态');
  assert.equal(settings.validateSettings(EMPTY), '', '全空也合法：填一半也是合法状态');
});

test('validateSettings：学期名称超过 40 字要拒绝', () => {
  assert.match(settings.validateSettings({ ...EMPTY, semesterName: '一'.repeat(41) }), /40 字/u);
  assert.equal(settings.validateSettings({ ...EMPTY, semesterName: '一'.repeat(40) }), '');
});

// ---------- 纯函数：客户端读写 ----------

test('saveSettings：填写有误在本地就挡住，不发云调用', async () => {
  const cloud = cloudStub({});
  globalThis.wx = baseWx(cloud);
  await assert.rejects(
    () => settings.saveSettings(withTimes([{ start: '10:00', end: '09:00' }])),
    /第 1 节的结束时刻要晚于起始时刻/u,
  );
  await assert.rejects(
    () => settings.saveSettings({ ...EMPTY, startDate: '2026-2-30' }),
    /YYYY-MM-DD/u,
  );
  assert.equal(cloud.calls.length, 0, '本地挡住就不该有云调用');
  delete globalThis.wx;
});

test('saveSettings：合法设置经云函数保存并回读云端结果', async () => {
  const payload = { ...EMPTY, semesterName: '2026-2027学年第一学期', startDate: '2026-08-31', totalWeeks: 20 };
  const cloud = cloudStub({
    saveSettings: (data) => ({ ok: true, saved: true, settings: data.settings }),
  });
  globalThis.wx = baseWx(cloud);
  const saved = await settings.saveSettings(payload);
  assert.equal(cloud.calls.length, 1);
  assert.equal(cloud.calls[0].name, 'timetable');
  assert.deepEqual(cloud.calls[0].data, { action: 'saveSettings', settings: payload });
  assert.deepEqual(saved, payload);
  delete globalThis.wx;
});

test('loadSettings：云函数未部署或集合未建时降级为空设置，并用 loadError 区分读失败', async () => {
  const broken = cloudStub({ getSettings: () => new Error('FUNCTION_NOT_FOUND') });
  globalThis.wx = baseWx(broken);
  const degraded = await settings.loadSettings();
  assert.equal(degraded.semesterName, '');
  assert.equal(degraded.startDate, '');
  assert.equal(degraded.totalWeeks, 20);
  assert.deepEqual(degraded.sectionTimes, EMPTY.sectionTimes);
  assert.equal(typeof degraded.loadError, 'string');
  assert.notEqual(degraded.loadError, '', '读失败要能被调用方认出来');

  const missingCollection = cloudStub({
    getSettings: () => ({ ok: false, error: 'collection.get:fail -502005 database collection not exists' }),
  });
  globalThis.wx = baseWx(missingCollection);
  const missing = await settings.loadSettings();
  assert.notEqual(missing.loadError, undefined, '集合还没建也算读失败');
  assert.deepEqual(missing.sectionTimes, EMPTY.sectionTimes);

  const healthy = cloudStub({ getSettings: () => ({ ok: true, saved: false, settings: EMPTY }) });
  globalThis.wx = baseWx(healthy);
  const read = await settings.loadSettings();
  assert.equal(read.loadError, undefined, '读成功（含「确实还没设置」）不该有 loadError');
  assert.deepEqual(read, EMPTY);
  delete globalThis.wx;
});

// ---------- 云函数：getSettings / saveSettings ----------

test('云函数 getSettings：没有记录返回空设置，保存后按 openid 各自读回', async () => {
  const { run, docs } = cloudHarness();

  const first = await run('openid-a', { action: 'getSettings' });
  assert.equal(first.ok, true);
  assert.equal(first.saved, false, '第一次进来还没有记录');
  assert.deepEqual(first.settings, EMPTY, '空设置与小程序侧同形（totalWeeks 用默认跨度）');

  const payload = { ...EMPTY, semesterName: '2026-2027学年第一学期', startDate: '2026-08-31', totalWeeks: 20 };
  const saved = await run('openid-a', { action: 'saveSettings', settings: payload });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.settings, payload);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].owner, 'openid-a');
  assert.ok(docs[0].createdAt.length > 0);
  assert.equal(docs[0].updatedAt, docs[0].createdAt);

  const readBack = await run('openid-a', { action: 'getSettings' });
  assert.equal(readBack.saved, true);
  assert.deepEqual(readBack.settings, payload);

  const other = await run('openid-b', { action: 'getSettings' });
  assert.equal(other.saved, false, '别人的设置读不到');

  const again = await run('openid-a', { action: 'saveSettings', settings: { ...payload, totalWeeks: 22 } });
  assert.equal(again.ok, true);
  assert.equal(docs.length, 1, '一条记录一个用户：第二次是更新，不是新增');
  assert.equal(docs[0].totalWeeks, 22);
  assert.equal(docs[0].owner, 'openid-a');
});

test('云函数 saveSettings：倒置、重叠、格式与范围都拒绝，被拒的整份不写', async () => {
  const { run, docs } = cloudHarness();

  const inverted = await run('openid-a', { action: 'saveSettings', settings: withTimes([{ start: '10:00', end: '09:00' }]) });
  assert.equal(inverted.ok, false);
  assert.match(inverted.error, /第 1 节的结束时刻要晚于起始时刻/u);

  const overlap = await run('openid-a', {
    action: 'saveSettings',
    settings: withTimes([{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }]),
  });
  assert.equal(overlap.ok, false);
  assert.match(overlap.error, /第 1 节与第 2 节的作息时间重叠了/u);

  const badClock = await run('openid-a', { action: 'saveSettings', settings: withTimes([{ start: '9:00', end: '10:00' }]) });
  assert.equal(badClock.ok, false);
  assert.match(badClock.error, /HH:MM/u);

  const badDate = await run('openid-a', { action: 'saveSettings', settings: { ...EMPTY, startDate: '2026-02-30' } });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /YYYY-MM-DD/u);

  const badWeeks = await run('openid-a', { action: 'saveSettings', settings: { ...EMPTY, totalWeeks: 31 } });
  assert.equal(badWeeks.ok, false);
  assert.match(badWeeks.error, /1-30/u);

  const shortTimes = await run('openid-a', { action: 'saveSettings', settings: { ...EMPTY, sectionTimes: [{ start: '', end: '' }] } });
  assert.equal(shortTimes.ok, false);
  assert.match(shortTimes.error, /12 条/u);

  assert.equal(docs.length, 0, '被拒绝的整份都不写');

  // 只填一半合法：按原样存，不清空也不替学生补另一半。
  const partial = await run('openid-a', { action: 'saveSettings', settings: withTimes([{ start: '09:00', end: '' }]) });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.settings.sectionTimes[0], { start: '09:00', end: '' });
  assert.equal(docs.length, 1);
});

test('云函数 getSettings：历史记录里的脏数据按「没填 / 默认」读出来，不把页面打挂', async () => {
  const { run, docs } = cloudHarness();
  // 直接塞一条不经过校验的记录，模拟老数据或手工改库。
  docs.push({
    _id: 'doc-old',
    owner: 'openid-a',
    semesterName: '  2026-2027学年第一学期  ',
    startDate: '2026-2-30',
    totalWeeks: 99,
    sectionTimes: [{ start: '09:00', end: '09:45' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const result = await run('openid-a', { action: 'getSettings' });
  assert.equal(result.ok, true);
  assert.equal(result.settings.startDate, '', '非法开学日按未设置处理');
  assert.equal(result.settings.totalWeeks, 30, '超过上限收敛到 30');
  assert.equal(result.settings.semesterName, '2026-2027学年第一学期');
  assert.equal(result.settings.sectionTimes.length, 12, '不足 12 条补空');
  assert.deepEqual(result.settings.sectionTimes[0], { start: '09:00', end: '09:45' });
  assert.deepEqual(result.settings.sectionTimes[11], { start: '', end: '' });
});

// ---------- 设置页 ----------

test('设置页：读到的设置填进表单，填开学日与总周数后保存的入参正确', async () => {
  const cloud = cloudStub({
    getSettings: () => ({ ok: true, saved: true, settings: EMPTY }),
    saveSettings: (data) => ({ ok: true, saved: true, settings: data.settings }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/settings', wx);
  // 注入「今天」，预览文案不随真实日期漂移。
  await page.onLoad({ today: '2026-09-21' });
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.totalWeeksText, '20');
  assert.equal(page.data.groups.length, 3, '作息分上午 / 下午 / 晚上三组');
  assert.equal(page.data.groups[0].rows.length, 4);
  assert.equal(page.data.groups[1].rows.length, 6);
  assert.equal(page.data.groups[2].rows[1].last, true, '第 12 节是最后一行');
  assert.equal(page.data.preview, '还没设置开学日，课表按第 1 周显示');
  assert.ok(page.data.preview.length > 0, '预览行必须有文案，不能是空壳');

  page.onSemesterNameInput({ detail: { value: '2026-2027学年第一学期' } });
  page.onStartDateChange({ detail: { value: '2026-08-31' } });
  assert.equal(page.data.startDateHint, '', '8/31 是星期一，不该提示');
  assert.equal(page.data.preview, '今天是第 4 周');
  page.onTotalWeeksInput({ detail: { value: '20' } });
  assert.equal(page.data.totalWeeks, 20);

  await page.save();
  await sleep(450);

  const saves = cloud.calls.filter((call) => call.data.action === 'saveSettings');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].name, 'timetable');
  assert.deepEqual(saves[0].data, {
    action: 'saveSettings',
    settings: {
      semesterName: '2026-2027学年第一学期',
      startDate: '2026-08-31',
      totalWeeks: 20,
      sectionTimes: EMPTY.sectionTimes,
    },
  });
  assert.ok(wx.actions.includes('toast:设置已保存'));
  assert.ok(wx.actions.includes('navigateBack'), '保存成功后返回课表页');
  assert.equal(page.data.saveError, '');
  delete globalThis.wx;
});

test('设置页：非周一的开学日给琥珀提示，快捷 pill 改总周数', async () => {
  const cloud = cloudStub({ getSettings: () => ({ ok: true, saved: false, settings: EMPTY }) });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/settings', wx);
  await page.onLoad({ today: '2026-09-21' });

  page.onStartDateChange({ detail: { value: '2026-09-01' } });
  assert.match(page.data.startDateHint, /不是星期一/u);
  assert.match(page.data.startDateHint, /星期二/u);
  assert.equal(page.data.preview, '今天是第 3 周', '9/21 距 9/1 有 20 天');

  page.chooseWeeks({ currentTarget: { dataset: { weeks: 18 } } });
  assert.equal(page.data.totalWeeksText, '18');
  assert.equal(page.data.totalWeeks, 18);
  page.chooseWeeks({ currentTarget: { dataset: { weeks: 22 } } });
  assert.equal(page.data.totalWeeksText, '22');

  page.onTotalWeeksInput({ detail: { value: '2a2' } });
  assert.equal(page.data.totalWeeksText, '22', '只留数字');

  page.onStartDateChange({ detail: { value: '' } });
  assert.equal(page.data.startDateHint, '');
  assert.equal(page.data.preview, '还没设置开学日，课表按第 1 周显示');
  delete globalThis.wx;
});

test('设置页：按节填作息、清空作息要先确认，填的时刻跟着保存', async () => {
  const cloud = cloudStub({
    getSettings: () => ({ ok: true, saved: false, settings: EMPTY }),
    saveSettings: (data) => ({ ok: true, saved: true, settings: data.settings }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/settings', wx);
  await page.onLoad({ today: '2026-09-21' });

  // 驱动方式与真实控件一致：picker 的 id 是 settings-section-time-N（起始）与 -end（结束）。
  page.onSectionTimeChange({ currentTarget: { dataset: { section: 1, field: 'start' } }, detail: { value: '09:00' } });
  page.onSectionTimeChange({ currentTarget: { dataset: { section: 1, field: 'end' } }, detail: { value: '09:45' } });
  assert.deepEqual(plain(page.data.sectionTimes[0]), { start: '09:00', end: '09:45' });
  assert.equal(page.data.groups[0].rows[0].start, '09:00');
  assert.equal(page.data.groups[0].rows[0].end, '09:45');

  page.onSectionTimeChange({ currentTarget: { dataset: { section: 12, field: 'end' } }, detail: { value: '20:30' } });
  assert.deepEqual(plain(page.data.sectionTimes[11]), { start: '', end: '20:30' });
  assert.equal(page.data.groups[2].rows[1].end, '20:30');

  page.onSectionTimeChange({ currentTarget: { dataset: { section: 2, field: 'start' } }, detail: { value: '不是时刻' } });
  assert.deepEqual(plain(page.data.sectionTimes[1]), { start: '', end: '' }, '非法形状直接忽略');

  await page.save();
  const saves = cloud.calls.filter((call) => call.data.action === 'saveSettings');
  assert.equal(saves.length, 1);
  assert.deepEqual(plain(saves[0].data.settings.sectionTimes[0]), { start: '09:00', end: '09:45' });
  assert.deepEqual(plain(saves[0].data.settings.sectionTimes[11]), { start: '', end: '20:30' });

  page.clearTimes();
  assert.ok(wx.actions.includes('modal:清空作息'), '清空要先确认');
  assert.deepEqual(plain(page.data.sectionTimes[0]), { start: '', end: '' });
  assert.deepEqual(plain(page.data.sectionTimes[11]), { start: '', end: '' });
  assert.ok(wx.actions.includes('toast:已清空，记得保存'), '清空只改本地，要保存才写库');
  await sleep(450);
  delete globalThis.wx;
});

test('设置页：读失败降级为空设置，页面照常可用并说明读不到', async () => {
  const cloud = cloudStub({ getSettings: () => new Error('FUNCTION_NOT_FOUND') });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/settings', wx);
  await page.onLoad({ today: '2026-09-21' });

  assert.equal(page.data.status, 'ready', '读失败也要能进页面，不白屏');
  assert.match(page.data.loadNote, /读不到已保存的设置/u);
  assert.equal(page.data.semesterName, '');
  assert.equal(page.data.totalWeeksText, '20');
  assert.equal(page.data.startDate, '');
  assert.equal(page.data.preview, '还没设置开学日，课表按第 1 周显示');
  assert.equal(page.data.sectionTimes.length, 12);
  delete globalThis.wx;
});

test('设置页：保存失败分「填写有误」与「暂时存不到云端」两类文案', async () => {
  const cloud = cloudStub({ getSettings: () => ({ ok: true, saved: false, settings: EMPTY }) });
  const wx = baseWx(cloud);
  const page = loadPage('timetable/settings', wx);
  await page.onLoad({ today: '2026-09-21' });
  page.onSectionTimeChange({ currentTarget: { dataset: { section: 1, field: 'start' } }, detail: { value: '10:00' } });
  page.onSectionTimeChange({ currentTarget: { dataset: { section: 1, field: 'end' } }, detail: { value: '09:00' } });
  await page.save();
  assert.match(page.data.saveError, /^填写有误：第 1 节的结束时刻要晚于起始时刻$/u);
  assert.equal(cloud.calls.filter((call) => call.data.action === 'saveSettings').length, 0, '本地挡住就不必往返');
  assert.ok(wx.actions.includes('toast:填写有误，请检查设置'));

  // 云端业务校验拒绝：仍是「填写有误」，文案用云端给的原因。
  const rejecting = cloudStub({
    getSettings: () => ({ ok: true, saved: false, settings: EMPTY }),
    saveSettings: () => ({ ok: false, error: '第 5 节的结束时刻要晚于起始时刻' }),
  });
  globalThis.wx = baseWx(rejecting);
  const rejected = loadPage('timetable/settings', globalThis.wx);
  await rejected.onLoad({ today: '2026-09-21' });
  await rejected.save();
  assert.equal(rejected.data.saveError, '填写有误：第 5 节的结束时刻要晚于起始时刻');
  assert.equal(rejected.data.saving, false);

  // 云函数/集合未就绪：另一类文案，不冒充「填写有误」。
  const broken = cloudStub({
    getSettings: () => ({ ok: true, saved: false, settings: EMPTY }),
    saveSettings: () => new Error('FUNCTION_NOT_FOUND'),
  });
  globalThis.wx = baseWx(broken);
  const brokenPage = loadPage('timetable/settings', globalThis.wx);
  await brokenPage.onLoad({ today: '2026-09-21' });
  await brokenPage.save();
  assert.match(brokenPage.data.saveError, /^暂时存不到云端：/u);
  assert.match(brokenPage.data.saveError, /云函数尚未部署|暂时不可用/u);
  assert.equal(brokenPage.data.saving, false);
  assert.ok(brokenPage.data.saveError !== rejected.data.saveError, '两类失败不能是同一句话');
  delete globalThis.wx;
});

// ---------- 红线：模板与模块里不出现任何具体时刻 ----------

/** 去掉注释：注释里出现的时刻（文档举例）不是页面文案。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

test('设置页与设置模块不内置任何具体时刻（学校作息未核实）', () => {
  const files = [
    'miniprogram/pages/timetable/settings/index.ts',
    'miniprogram/pages/timetable/settings/index.wxml',
    'miniprogram/pages/timetable/settings/index.wxss',
    'miniprogram/services/timetable/settings.ts',
  ];
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.resolve(file), 'utf8'));
    const found = source.match(/(?:^|[^0-9])([01]\d|2[0-3]):[0-5]\d/u);
    assert.equal(found, null, `${file} 里出现了具体时刻：${found === null ? '' : found[0]}`);
  }
});

test('设置页模板暴露约定的元素 id（页面测试与其它切片按这些 id 驱动）', () => {
  const source = fs.readFileSync(path.resolve('miniprogram/pages/timetable/settings/index.wxml'), 'utf8');
  for (const id of [
    'settings-semester-name',
    'settings-start-date',
    'settings-total-weeks',
    'settings-clear-times',
    'settings-save',
    'settings-preview',
  ]) {
    assert.ok(source.includes(`id="${id}"`), `模板缺少 id="${id}"`);
  }
  assert.ok(source.includes('id="settings-section-time-{{row.section}}"'), '缺少每节起始时刻的 picker');
  assert.ok(source.includes('id="settings-section-time-{{row.section}}-end"'), '缺少每节结束时刻的 picker');
});
