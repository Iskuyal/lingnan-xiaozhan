const { test } = require('node:test');
const assert = require('node:assert/strict');

// 目标日的日期算法与本机存储（Issue #90）。
// 只吃「现在」与存储里的原始值，不碰小程序运行时：页面看到的文案由这里决定，
// 所以今天 / 昨天 / 跨月 / 跨年 / 闰日 / 非法值 / 删除后重建都要在这层钉住。
const goals = require('../dist/services/goals/index.js');

/** 存储桩：把 wx 的本机存储换成一个 Map，并记录 get/set 次数。 */
function storageStub() {
  const store = new Map();
  const counts = { get: 0, set: 0 };
  const wx = {
    getStorageSync: (key) => {
      counts.get += 1;
      return store.has(key) ? store.get(key) : '';
    },
    setStorageSync: (key, value) => {
      counts.set += 1;
      store.set(key, value);
    },
  };
  return { store, counts, wx };
}

function useStorage() {
  const stub = storageStub();
  globalThis.wx = stub.wx;
  return stub;
}

function clearStorage() {
  delete globalThis.wx;
}

/** 北京时间某一天的毫秒时间戳；默认取当天正午，避免落在日界线上。 */
function noon(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 3600 * 1000 + 12 * 3600 * 1000;
}

function goal(overrides = {}) {
  return {
    id: 'g1',
    name: '计算机二级考试',
    date: '2026-12-05',
    countToday: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('日期合法性：格式、真实日历、闰年都要判对', () => {
  for (const good of ['2026-09-29', '2026-12-05', '2028-02-29', '2000-02-29']) {
    assert.equal(goals.isValidDate(good), true, `${good} 应当合法`);
  }
  for (const bad of ['', '   ', '2026-9-29', '2026/09/29', '20260929', '2026-13-01', '2026-02-30', '2026-02-29', '1899-01-01', '不是日期', null, undefined, 20260929]) {
    assert.equal(goals.isValidDate(bad), false, `${String(bad)} 应当被拒绝`);
  }
});

test('今天是按 Asia/Shanghai 算的日历日，与设备时区无关', () => {
  // UTC 15:59:59 还是北京时间的当天 23:59:59；一分钟后进入第二天。
  assert.equal(goals.shanghaiToday(Date.UTC(2026, 8, 29, 15, 59, 59)), '2026-09-29');
  assert.equal(goals.shanghaiToday(Date.UTC(2026, 8, 29, 16, 0, 0)), '2026-09-30');
  // 北京时间 2027 年元旦：UTC 还是 2026-12-31。
  assert.equal(goals.shanghaiToday(Date.UTC(2026, 11, 31, 16, 0, 0)), '2027-01-01');
});

test('日历日差：跨月、跨年、闰日都不差一天', () => {
  assert.equal(goals.diffDays('2026-09-29', '2026-09-29'), 0);
  assert.equal(goals.diffDays('2026-09-29', '2026-09-30'), 1);
  assert.equal(goals.diffDays('2026-09-29', '2026-12-05'), 67);
  assert.equal(goals.diffDays('2026-09-29', '2026-09-25'), -4);
  assert.equal(goals.diffDays('2026-12-31', '2027-01-01'), 1);
  assert.equal(goals.diffDays('2027-01-01', '2026-12-31'), -1);
  assert.equal(goals.diffDays('2028-02-28', '2028-03-01'), 2);
  assert.equal(goals.diffDays('2026-02-28', '2026-03-01'), 1);
  assert.equal(goals.diffDays('nope', '2026-09-30'), null);
});

test('状态只看日历日差：今天、明天、昨天都不出现多一天或少一天', () => {
  const now = noon('2026-09-29');
  assert.deepEqual(
    { kind: goals.statusOf(goal({ date: '2026-09-29' }), now).kind, label: goals.statusOf(goal({ date: '2026-09-29' }), now).label },
    { kind: 'today', label: '就是今天' },
  );
  const tomorrowOff = goals.statusOf(goal({ date: '2026-09-30', countToday: false }), now);
  assert.equal(tomorrowOff.kind, 'upcoming');
  assert.equal(tomorrowOff.days, 1);
  assert.equal(tomorrowOff.label, '还有 1 天');
  const tomorrowOn = goals.statusOf(goal({ date: '2026-09-30', countToday: true }), now);
  assert.equal(tomorrowOn.days, 2);
  assert.equal(tomorrowOn.label, '还有 2 天');
  const yesterday = goals.statusOf(goal({ date: '2026-09-28' }), now);
  assert.equal(yesterday.kind, 'expired');
  assert.equal(yesterday.days, 1);
  assert.equal(yesterday.label, '已过期 1 天');
  assert.equal(yesterday.diffDays, -1);
});

test('计入当天不改变状态：今天永远是「就是今天」，跨年与闰日同样成立', () => {
  const now = noon('2026-12-31');
  for (const countToday of [false, true]) {
    const today = goals.statusOf(goal({ date: '2026-12-31', countToday }), now);
    assert.equal(today.kind, 'today', `countToday=${countToday} 时今天仍是今天`);
    assert.equal(today.label, '就是今天');
    const nextYear = goals.statusOf(goal({ date: '2027-01-01', countToday }), now);
    assert.equal(nextYear.kind, 'upcoming');
    assert.equal(nextYear.days, countToday ? 2 : 1);
  }
  // 闰日：2028-02-29 存在，2026-02-29 不存在（非法日期不给天数，也不抛异常）。
  const leapNow = noon('2028-02-28');
  assert.equal(goals.statusOf(goal({ date: '2028-02-29' }), leapNow).label, '还有 1 天');
  assert.equal(goals.statusOf(goal({ date: '2026-02-29' }), leapNow).label, '日期待核对');
});

test('分组：三组各自排序，未到期与已过期都按日期、今天按创建时间', () => {
  const now = noon('2026-09-29');
  const groups = goals.groupGoals([
    goal({ id: 'a', name: '较远', date: '2026-12-05' }),
    goal({ id: 'b', name: '较近', date: '2026-10-01' }),
    goal({ id: 'c', name: '乙今天', date: '2026-09-29', createdAt: 30, updatedAt: 30 }),
    goal({ id: 'd', name: '甲今天', date: '2026-09-29', createdAt: 10, updatedAt: 10 }),
    goal({ id: 'e', name: '刚过期', date: '2026-09-28' }),
    goal({ id: 'f', name: '过期更久', date: '2026-09-01' }),
  ], now);
  assert.deepEqual(groups.upcoming.map((row) => row.id), ['b', 'a']);
  // 今天这一组按创建时间：先建的排前面（不用按名称排序，见下一条测试）
  assert.deepEqual(groups.today.map((row) => row.id), ['d', 'c']);
  assert.deepEqual(groups.expired.map((row) => row.id), ['e', 'f']);
  assert.equal(groups.upcoming[0].meta, '2026-10-01 · 不计入当天');
  assert.equal(groups.today[0].meta, '2026-09-29');
});

test('排序不依赖 localeCompare：同日同创建时间按 id 兜底，结果与运行平台无关', () => {
  const now = noon('2026-09-29');
  const groups = goals.groupGoals([
    goal({ id: 'z', name: '乙', date: '2026-09-29', createdAt: 5, updatedAt: 5 }),
    goal({ id: 'a', name: '甲', date: '2026-09-29', createdAt: 5, updatedAt: 5 }),
  ], now);
  // 若用 name.localeCompare，Windows 与 CI（不同 ICU）会给出相反的顺序——CI 已经抓到过一次
  assert.deepEqual(groups.today.map((row) => row.id), ['a', 'z']);
});

test('首页入口只挑今天或最近的未到期，不拿过期的事当安排', () => {
  const now = noon('2026-09-29');
  assert.equal(goals.nearestGoal([], now), null);
  assert.equal(goals.nearestGoal([goal({ id: 'e', date: '2026-09-01' })], now), null);
  const picked = goals.nearestGoal([
    goal({ id: 'e', date: '2026-09-01' }),
    goal({ id: 'far', date: '2026-12-05' }),
    goal({ id: 'near', date: '2026-10-01' }),
  ], now);
  assert.equal(picked.id, 'near');
  const todayFirst = goals.nearestGoal([
    goal({ id: 'near', date: '2026-10-01' }),
    goal({ id: 'today', date: '2026-09-29' }),
  ], now);
  assert.equal(todayFirst.id, 'today');
  assert.equal(todayFirst.label, '就是今天');
});

test('输入校验：空名称、超长、空日期、非法日期都不放行', () => {
  assert.equal(goals.validateInput({ name: '', date: '2026-12-05', countToday: false }), '请填写事项名称');
  assert.equal(goals.validateInput({ name: '   ', date: '2026-12-05', countToday: false }), '请填写事项名称');
  assert.equal(goals.validateInput({ name: 'x'.repeat(31), date: '2026-12-05', countToday: false }), `事项名称最多 ${goals.MAX_NAME_LENGTH} 字`);
  assert.equal(goals.validateInput({ name: '考试', date: '', countToday: false }), '请选择目标日期');
  assert.equal(goals.validateInput({ name: '考试', date: '2026-02-30', countToday: false }), '目标日期要用 YYYY-MM-DD 的合法日期');
  assert.equal(goals.validateInput({ name: '考试', date: '2026-12-05', countToday: false }), '');
});

test('本机存储：新建后重进能读回，字段与顺序稳定', () => {
  const stub = useStorage();
  try {
    const created = goals.addGoal({ name: '  计算机二级考试 ', date: '2026-12-05', countToday: true }, 1000);
    assert.match(created.id, /^goal-/);
    assert.equal(created.name, '计算机二级考试');
    assert.equal(created.countToday, true);
    assert.equal(created.createdAt, 1000);
    // 「退出重进」= 重新读一次存储，而不是用内存里的数组。
    const loaded = goals.loadGoals();
    assert.equal(loaded.length, 1);
    assert.deepEqual({ ...loaded[0] }, { ...created });
    assert.equal(stub.counts.set, 1);
  } finally {
    clearStorage();
  }
});

test('本机存储：修改只改目标条目，删除后重建是新的一条', () => {
  useStorage();
  try {
    const first = goals.addGoal({ name: '四级报名截止', date: '2026-09-25', countToday: false }, 1000);
    const second = goals.addGoal({ name: '体测补测', date: '2026-09-29', countToday: false }, 2000);
    const updated = goals.updateGoal(first.id, { name: '四级报名截止（改）', date: '2026-09-26', countToday: true }, 3000);
    assert.equal(updated.id, first.id);
    assert.equal(updated.createdAt, 1000);
    assert.equal(updated.updatedAt, 3000);
    const after = goals.loadGoals();
    assert.equal(after.length, 2);
    assert.equal(after[0].name, '四级报名截止（改）');
    assert.equal(after[1].name, '体测补测');

    assert.equal(goals.removeGoal(first.id), true);
    assert.equal(goals.removeGoal(first.id), false);
    assert.deepEqual(goals.loadGoals().map((item) => item.id), [second.id]);

    // 删除后重建：同名同日期，但是新 id、新创建时间，不会把旧记录「复活」。
    const rebuilt = goals.addGoal({ name: '四级报名截止（改）', date: '2026-09-26', countToday: true }, 4000);
    assert.notEqual(rebuilt.id, first.id);
    assert.equal(rebuilt.createdAt, 4000);
    assert.equal(goals.loadGoals().length, 2);
  } finally {
    clearStorage();
  }
});

test('本机存储：脏数据只丢坏记录，不整页失败', () => {
  const stub = useStorage();
  try {
    // 1) 不是 JSON 的字符串
    stub.store.set('goal-days/v1', '{不是 JSON');
    assert.deepEqual(goals.loadGoals(), []);
    // 2) 不是数组
    stub.store.set('goal-days/v1', JSON.stringify({ name: 'x' }));
    assert.deepEqual(goals.loadGoals(), []);
    // 3) 数组里混着缺字段、非法日期、重复 id 的条目
    stub.store.set('goal-days/v1', JSON.stringify([
      { id: 'ok', name: '正常', date: '2026-12-05', countToday: false, createdAt: 1, updatedAt: 1 },
      { id: 'bad-date', name: '日期非法', date: '2026-02-30' },
      { name: '缺 id 但有日期', date: '2026-10-01' },
      { id: 'ok', name: '重复 id', date: '2026-11-01' },
      { id: 'no-name', name: '   ', date: '2026-11-01' },
      'not-an-object',
      null,
    ]));
    const loaded = goals.loadGoals();
    assert.deepEqual(loaded.map((item) => item.id), ['ok', loaded[1].id]);
    assert.equal(loaded[1].name, '缺 id 但有日期');
    assert.equal(loaded[1].countToday, false);
  } finally {
    clearStorage();
  }
});

test('上限与保存失败都给可读原因，不静默丢弃', () => {
  const stub = useStorage();
  try {
    const many = [];
    for (let index = 0; index < goals.MAX_GOALS; index += 1) {
      many.push(goal({ id: `g${index}`, date: '2026-12-05' }));
    }
    goals.saveGoals(many);
    assert.throws(() => goals.addGoal({ name: '第 51 个', date: '2026-12-05', countToday: false }), /最多保存/);

    // 写失败（存储配额或环境异常）要抛出，由页面提示。
    globalThis.wx = { getStorageSync: () => '', setStorageSync: () => { throw new Error('quota'); } };
    assert.throws(() => goals.saveGoals([]), /本机存储不可写/);
    // 没有存储能力时：读回空列表、写入抛出，都不崩。
    clearStorage();
    assert.deepEqual(goals.loadGoals(), []);
    assert.throws(() => goals.saveGoals([]), /无法保存到本机/);
    assert.equal(stub.counts.set > 0, true);
  } finally {
    clearStorage();
  }
});

test('读取异常时新增、修改、删除都不覆盖旧数据，恢复读取后可以继续新增', () => {
  const stub = useStorage();
  try {
    goals.saveGoals([goal({ id: 'keep', name: '保留目标' })]);
    const before = stub.store.get('goal-days/v1');
    const read = stub.wx.getStorageSync;
    stub.wx.getStorageSync = () => { throw new Error('read failed'); };
    assert.deepEqual(goals.loadGoals(), [], '只读展示仍可降级');
    assert.throws(() => goals.addGoal({ name: '新目标', date: '2026-12-06', countToday: false }), /读取.*重试/);
    assert.throws(() => goals.updateGoal('keep', { name: '改名', date: '2026-12-06', countToday: false }), /读取.*重试/);
    assert.throws(() => goals.removeGoal('keep'), /读取.*重试/);
    assert.equal(stub.store.get('goal-days/v1'), before);
    stub.wx.getStorageSync = read;
    goals.addGoal({ name: '新目标', date: '2026-12-06', countToday: false });
    assert.deepEqual(goals.loadGoals().map((entry) => entry.name), ['保留目标', '新目标']);
  } finally { clearStorage(); }
});
