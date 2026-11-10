const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 目标倒排计划（Issue #90 的第三层）：约束解析、排法、迷你网格、本机存储，以及计划页的编排。
// 这一层**完全不调模型**，所以每个数字都能在这里逐条对：说排不下就必须真的排不下，
// 说按默认排就必须在 dropped 里把没听懂的原话交出来。
const plan = require('../dist/services/goals/plan.js');

const TODAY = '2026-09-29';
const GOAL_DATE = '2026-12-13';
/** 开学日取 2026-09-28（星期一）：这样 TODAY 落在第 1 周，周次断言不依赖别的模块。 */
const SEMESTER_START = '2026-09-28';

/** 一份作息：12 节，默认全空（= 没填，plan 按每节 45 分钟估）。 */
function sectionTimes() {
  return Array.from({ length: 12 }, () => ({ start: '', end: '' }));
}

function settings(overrides = {}) {
  return { semesterName: '', startDate: SEMESTER_START, totalWeeks: 20, sectionTimes: sectionTimes(), ...overrides };
}

/** 一条课程：默认星期一一早，可按需覆盖。 */
let courseSeq = 0;
function course(overrides = {}) {
  courseSeq += 1;
  const startSection = overrides.startSection ?? 1;
  const endSection = overrides.endSection ?? 2;
  return {
    id: `c${courseSeq}`,
    name: overrides.name ?? '课程',
    credits: '',
    teacher: '',
    weekday: overrides.weekday ?? 1,
    startSection,
    endSection,
    sectionRanges: overrides.sectionRanges ?? [{ start: startSection, end: endSection }],
    weeks: overrides.weeks ?? [],
    weeksRecognized: overrides.weeksRecognized ?? false,
    weekText: overrides.weekText ?? '',
    location: '',
    campus: '',
    siteNumber: '',
    note: '',
    warnings: [],
    source: 'manual',
    semester: '',
    rawText: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function build(overrides = {}) {
  return plan.buildPlan({
    goalName: overrides.goalName ?? '英语四级',
    goalDate: overrides.goalDate ?? GOAL_DATE,
    today: overrides.today ?? TODAY,
    courses: overrides.courses ?? [],
    settings: overrides.settings ?? settings(),
    constraints: overrides.constraints ?? plan.emptyConstraints(),
    constraintText: overrides.constraintText,
    variant: overrides.variant,
    now: overrides.now ?? 1,
  });
}

/* ------------------------------------------------------------------ *
 * 一、约束解析：只认那几类说法，别的原话如实交出来
 * ------------------------------------------------------------------ */

test('parseConstraints：「每次别超过 1 小时」读成 60 分钟', () => {
  assert.equal(plan.parseConstraints('听力最弱，每次别超过 1 小时，周末上午不排。').maxMinutesPerBlock, 60);
  assert.equal(plan.parseConstraints('每次别超过 1 小时').maxMinutesPerBlock, 60);
  assert.equal(plan.parseConstraints('最多 1.5 小时').maxMinutesPerBlock, 90);
});

test('parseConstraints：「不超过45分钟」读成 45 分钟（没有空格也要认）', () => {
  assert.equal(plan.parseConstraints('不超过45分钟').maxMinutesPerBlock, 45);
  assert.equal(plan.parseConstraints('每次最多 30 分').maxMinutesPerBlock, 30);
});

test('parseConstraints：周末上午与晚上两个排除项各自独立', () => {
  assert.equal(plan.parseConstraints('周末上午不排').noWeekendMorning, true);
  assert.equal(plan.parseConstraints('周末上午不排').noEvening, false);
  assert.equal(plan.parseConstraints('晚上不排').noEvening, true);
  assert.equal(plan.parseConstraints('晚上不排').noWeekendMorning, false);
  assert.equal(plan.parseConstraints('周二晚上没空').noEvening, true);
  // 只说「周末」「上午」而没说不排，不算约束——这里不猜。
  assert.equal(plan.parseConstraints('周末上午有课').noWeekendMorning, true);
  assert.equal(plan.parseConstraints('周末想多睡').noWeekendMorning, false);
});

test('parseConstraints：「每周 4 段」与最弱项都能读出来', () => {
  assert.equal(plan.parseConstraints('每周 4 段').blocksPerWeek, 4);
  assert.equal(plan.parseConstraints('一周 3 次').blocksPerWeek, 3);
  assert.equal(plan.parseConstraints('听力最弱').focus, '听力');
  assert.equal(plan.parseConstraints('我阅读最差').focus, '阅读');
  assert.equal(plan.parseConstraints('最弱的是听力').focus, '听力');
  // 「精力最差」不是科目，不能被当成 focus。
  assert.equal(plan.parseConstraints('精力最差').focus, '');
});

test('parseConstraints：空文本给默认值，且不假装读到了什么', () => {
  const text = '';
  assert.deepEqual(plan.parseConstraints(text), plan.emptyConstraints());
  assert.deepEqual(plan.parseConstraints('   '), plan.emptyConstraints());
  assert.deepEqual(plan.emptyConstraints(), {
    maxMinutesPerBlock: 60,
    noWeekendMorning: false,
    noEvening: false,
    blocksPerWeek: 4,
    focus: '',
  });
});

test('parseConstraints：听不懂的原话进 dropped，不猜也不假装理解', () => {
  const readout = plan.readConstraints('我周三要去实验室，每次别超过 45 分钟');
  assert.equal(readout.constraints.maxMinutesPerBlock, 45);
  assert.equal(readout.dropped.length, 1);
  assert.match(readout.dropped[0], /周三要去实验室/);
  assert.match(readout.dropped[0], /没听懂/);
  // 读出来的那几条要标出来是按学生说的、还是按默认的。
  assert.equal(readout.recognized.maxMinutesPerBlock, true);
  assert.equal(readout.recognized.blocksPerWeek, false);
  assert.ok(readout.lines.some((line) => line.includes('45 分钟')));

  const allUnknown = plan.readConstraints('随便排吧');
  assert.deepEqual(allUnknown.constraints, plan.emptyConstraints());
  assert.equal(allUnknown.dropped.length, 1);
  assert.equal(allUnknown.lines.length, 1);
  assert.match(allUnknown.lines[0], /默认/);
});

test('parseConstraints：越界的数字被收敛到合理区间，不原样当真', () => {
  assert.equal(plan.parseConstraints('每次别超过 5 分钟').maxMinutesPerBlock, 15);
  assert.equal(plan.parseConstraints('每次最多 8 小时').maxMinutesPerBlock, 180);
  assert.equal(plan.parseConstraints('每周 20 段').blocksPerWeek, 14);
});

/* ------------------------------------------------------------------ *
 * 二、排法：段数、时长、冲突、两条排除项
 * ------------------------------------------------------------------ */

/** 计划里的每一段都不能和有课的时段重叠（按 weekday + 节次逐格比）。 */
function assertNoConflict(blocks, courses) {
  for (const block of blocks) {
    for (const item of courses) {
      if (item.weekday !== block.weekday) continue;
      for (const range of item.sectionRanges) {
        const overlap = range.start <= block.endSection && block.startSection <= range.end;
        assert.equal(
          overlap,
          false,
          `第 ${block.weekday} 天第 ${block.startSection}-${block.endSection} 节排了「${block.topic}」，与「${item.name}」冲突`,
        );
      }
    }
  }
}

test('buildPlan：段数等于 constraints.blocksPerWeek', () => {
  for (const count of [1, 3, 4, 6]) {
    const result = build({ constraints: { ...plan.emptyConstraints(), blocksPerWeek: count } });
    assert.equal(result.blocks.length, count, `想排 ${count} 段就应当拿到 ${count} 段`);
    assert.equal(result.weeklyCount, count);
    assert.equal(result.totalMinutes, result.blocks.reduce((sum, block) => sum + block.minutes, 0));
  }
});

test('buildPlan：每段时长不超过 maxMinutesPerBlock（作息填了也按上限截）', () => {
  const filled = settings();
  // 每节 08:00-08:40（40 分钟），两节连排 80 分钟——超过 60 就必须截到 60 而不是照抄 80。
  filled.sectionTimes = Array.from({ length: 12 }, (unused, index) => {
    const startMinute = 8 * 60 + index * 45;
    const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    return { start: clock(startMinute), end: clock(startMinute + 40) };
  });
  for (const max of [30, 45, 60, 90]) {
    const result = build({ settings: filled, constraints: { ...plan.emptyConstraints(), maxMinutesPerBlock: max } });
    for (const block of result.blocks) {
      assert.ok(
        block.minutes <= max,
        `每段 ${block.minutes} 分钟超过了上限 ${max} 分钟`,
      );
      assert.ok(block.minutes > 0, '不能排出 0 分钟的段');
    }
  }
});

test('buildPlan：与已有课程逐格不冲突', () => {
  const courses = [
    course({ name: 'JSP', weekday: 1, startSection: 1, endSection: 2 }),
    course({ name: '毛概', weekday: 1, startSection: 3, endSection: 4 }),
    course({ name: '网页设计', weekday: 2, startSection: 1, endSection: 2 }),
    course({ name: '高数', weekday: 3, startSection: 5, endSection: 6 }),
  ];
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), blocksPerWeek: 4 } });
  assert.equal(result.blocks.length, 4);
  assertNoConflict(result.blocks, courses);
});

test('buildPlan：只和「这一周会上」的课冲突，别的周次不算', () => {
  // 第 3 周才上的课不该占掉第 1 周的空格。
  const thirdWeekOnly = course({
    name: '实验',
    weekday: 1,
    startSection: 1,
    endSection: 6,
    sectionRanges: [{ start: 1, end: 6 }],
    weeks: [3],
    weeksRecognized: true,
  });
  const result = build({ courses: [thirdWeekOnly], today: TODAY });
  assert.equal(result.week, 1);
  assert.ok(
    result.blocks.some((block) => block.weekday === 1 && block.startSection === 1),
    '第 1 周第 1-2 节没课，应当能排',
  );
});

test('buildPlan：「周末上午不排」时周末的段都在第 5 节之后', () => {
  // 周一到周五全占满，只能往周末排，才能验证这条排除项真的生效。
  const courses = [];
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    for (const start of [1, 3, 5, 7, 9, 11]) {
      courses.push(course({ name: `占位${weekday}-${start}`, weekday, startSection: start, endSection: start + 1 }));
    }
  }
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), noWeekendMorning: true, blocksPerWeek: 4 } });
  const weekend = result.blocks.filter((block) => block.weekday >= 6);
  assert.ok(weekend.length > 0, '工作日满了，应当排到周末');
  for (const block of weekend) {
    assert.ok(
      block.startSection >= 5,
      `周末第 ${block.startSection}-${block.endSection} 节在上午，不应当排`,
    );
  }
  assert.ok(result.rationale.some((line) => line.includes('周末上午')), '依据里要说明这条约束');
});

test('buildPlan：「晚上不排」时没有第 9 节往后的段', () => {
  // 白天全占满，只剩晚上——这时应当宁可少排，也不越过约束。
  const courses = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (const start of [1, 3, 5, 7]) {
      courses.push(course({ name: `白天${weekday}-${start}`, weekday, startSection: start, endSection: start + 1 }));
    }
  }
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), noEvening: true, blocksPerWeek: 4 } });
  for (const block of result.blocks) {
    assert.ok(block.startSection < 9, `第 ${block.startSection} 节属于晚上，不应当排`);
  }
  assert.equal(result.blocks.length, 0, '白天排满且不许排晚上时，应当如实说排不下');
  assert.match(result.headline, /没有能排的空档/);
});

test('buildPlan：rationale 非空，且引用真实的天数 / 分钟 / 周次', () => {
  const result = build({ constraints: { ...plan.emptyConstraints(), focus: '听力', blocksPerWeek: 3 } });
  assert.ok(result.rationale.length >= 2, '依据至少要说清排了哪几段、为什么是这个时长');
  const text = result.rationale.join('\n');
  assert.match(text, /还有 \d+ 天/);
  assert.match(text, /第 1 周|本周/);
  assert.match(text, /\d+ 分钟/);
  // 依据里的数字必须和计划本身对得上，不能是编的。
  assert.ok(text.includes(`还有 ${result.remainingDays} 天`));
  assert.ok(result.blocks.every((block) => text.includes(String(block.minutes))));
});

test('buildPlan：没有空闲段时返回 blocks: []，headline 说明排不下，不硬塞', () => {
  const courses = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (const start of [1, 3, 5, 7, 9, 11]) {
      courses.push(course({ name: `满${weekday}-${start}`, weekday, startSection: start, endSection: start + 1 }));
    }
  }
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), blocksPerWeek: 4 } });
  assert.deepEqual(result.blocks, []);
  assert.equal(result.totalMinutes, 0);
  assert.match(result.headline, /没有能排的空档/);
  assert.match(result.headline, /不硬塞/);
  assert.ok(result.rationale.length >= 2, '排不下也要说清为什么');
});

test('buildPlan：空档不够时如实少排，headline 交代清楚', () => {
  // 只留出一段空档，学生却要 4 段。
  const courses = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (const start of [1, 3, 5, 7, 9, 11]) {
      if (weekday === 3 && start === 5) continue;
      courses.push(course({ name: `满${weekday}-${start}`, weekday, startSection: start, endSection: start + 1 }));
    }
  }
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), blocksPerWeek: 4 } });
  assert.equal(result.blocks.length, 1);
  assert.match(result.headline, /只排得下 1 段/);
  assert.ok(result.rationale.length >= 2);
});

test('buildPlan：目标日已过 / 非法时不排，并说明原因', () => {
  const past = build({ goalDate: '2026-09-01' });
  assert.deepEqual(past.blocks, []);
  assert.match(past.headline, /已经过了/);

  const bad = build({ goalDate: '不是日期' });
  assert.deepEqual(bad.blocks, []);
  assert.match(bad.headline, /合法日期/);
});

test('buildPlan：variant 换一种排法，结果不同但同样合法', () => {
  const constraints = { ...plan.emptyConstraints(), blocksPerWeek: 3 };
  const first = build({ constraints, variant: 0 });
  const second = build({ constraints, variant: 1 });
  assert.equal(first.blocks.length, 3);
  assert.equal(second.blocks.length, 3);
  assert.notDeepEqual(
    first.blocks.map((block) => `${block.weekday}-${block.startSection}`),
    second.blocks.map((block) => `${block.weekday}-${block.startSection}`),
    '换一种排法应当换到别的日子，不能是同一份',
  );
});

test('buildPlan：topic 按 focus 与目标名生成，前两段给最弱项', () => {
  const withFocus = build({ constraints: { ...plan.emptyConstraints(), focus: '听力', blocksPerWeek: 4 } });
  assert.deepEqual(withFocus.blocks.slice(0, 2).map((block) => block.topic), ['听力', '听力']);
  assert.ok(withFocus.blocks.every((block) => block.topic !== ''));

  const noFocus = build({ goalName: '英语四级', constraints: { ...plan.emptyConstraints(), blocksPerWeek: 4 } });
  assert.ok(noFocus.blocks.every((block) => block.topic !== ''), '没写最弱项也要给每段一个动作');
});

/* ------------------------------------------------------------------ *
 * 三、展示用的小函数与迷你网格
 * ------------------------------------------------------------------ */

test('hoursLabel / blockLabel / blockDescribe：文案与设计图一致', () => {
  assert.equal(plan.hoursLabel(210), '共 3.5 小时');
  assert.equal(plan.hoursLabel(180), '共 3 小时');
  assert.equal(plan.hoursLabel(45), '共 45 分钟');
  assert.equal(plan.hoursLabel(0), '共 0 分钟');
  const block = { id: 'b', weekday: 1, startSection: 5, endSection: 6, minutes: 45, topic: '听力', week: 1 };
  assert.equal(plan.blockLabel(block), '听力 45′');
  assert.equal(plan.blockDescribe(block), '周一 5-6 节 · 听力 45′');
});

test('planBlocksForWeek：只取这一周的段', () => {
  const result = build({ constraints: { ...plan.emptyConstraints(), blocksPerWeek: 2 } });
  assert.equal(plan.planBlocksForWeek(result, result.week).length, 2);
  assert.equal(plan.planBlocksForWeek(result, result.week + 1).length, 0);
});

test('planGrid：行是节次对、列是周一到周五，busy / busy2 / plan / free 都对得上', () => {
  const courses = [
    course({ name: 'JSP', weekday: 1, startSection: 1, endSection: 2 }),
    course({ name: '高数', weekday: 2, startSection: 3, endSection: 4 }),
  ];
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), blocksPerWeek: 4 } });
  const grid = plan.planGrid(result, courses, settings(), result.week);

  assert.ok(grid.length >= 5, '至少 5 行，和设计图一样');
  for (const row of grid) assert.equal(row.length, 5, '每周 5 列（周一至周五）');

  // 第 1 行第 1 列：JSP 占着。
  assert.ok(grid[0][0].kind.startsWith('busy'), '周一第 1-2 节有课');
  assert.equal(grid[0][0].label, 'JSP');
  assert.equal(grid[0][0].rowSpan, 1);
  // 第 2 行第 2 列：高数占着。
  assert.ok(grid[1][1].kind.startsWith('busy'));
  assert.equal(grid[1][1].label, '高数');

  const planned = grid.flat().filter((cell) => cell.kind === 'plan');
  assert.equal(planned.length, plan.planBlocksForWeek(result, result.week).length, '每段计划都要画进网格');
  for (const cell of planned) assert.match(cell.label, /^\S+ \d+′$/);
  assert.ok(grid.flat().some((cell) => cell.kind === 'free'), '空着的格子应当是 free');
});

test('planGrid：跨节次的课合并成一格，被盖住的格 rowSpan 为 0', () => {
  const courses = [course({
    name: '连上四节',
    weekday: 1,
    startSection: 1,
    endSection: 4,
    sectionRanges: [{ start: 1, end: 4 }],
  })];
  const result = build({ courses, constraints: { ...plan.emptyConstraints(), blocksPerWeek: 1 } });
  const grid = plan.planGrid(result, courses, settings(), result.week);
  assert.equal(grid[0][0].rowSpan, 2, '1-4 节跨两个大节，应当合并成 2 行');
  assert.equal(grid[1][0].rowSpan, 0, '被合并盖住的下一行不再单独渲染');
});

test('planGrid：没设开学日（算不出周次）时保守地把课都画上', () => {
  const courses = [course({ name: 'JSP', weekday: 1, startSection: 1, endSection: 2, weeks: [5], weeksRecognized: true })];
  const result = build({ courses, settings: { semesterName: '', startDate: '', totalWeeks: 20, sectionTimes: sectionTimes() } });
  assert.equal(result.weekKnown, false);
  const grid = plan.planGrid(result, courses, settings(), result.week);
  assert.equal(grid[0][0].label, 'JSP', '宁可画满，也不假装那周没课');
});

/* ------------------------------------------------------------------ *
 * 四、本机存储：只存本机，读脏数据只丢这一条，写失败要抛
 * ------------------------------------------------------------------ */

function storageStub() {
  const store = new Map();
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
  };
  return { store, wx };
}

test('本机存储：savePlan → loadPlan 往返一致', () => {
  const stub = storageStub();
  globalThis.wx = stub.wx;
  const result = build({ constraints: { ...plan.emptyConstraints(), focus: '听力', blocksPerWeek: 3 } });
  plan.savePlan(result);
  assert.ok(stub.store.has('study-plan/v1'), 'key 必须是 study-plan/v1');
  const loaded = plan.loadPlan();
  assert.notEqual(loaded, null);
  assert.deepEqual(loaded.blocks, result.blocks);
  assert.equal(loaded.totalMinutes, result.totalMinutes);
  assert.deepEqual(loaded.rationale, result.rationale);
  assert.deepEqual(loaded.dropped, result.dropped);
  assert.equal(loaded.goalDate, GOAL_DATE);
  plan.removePlan();
  assert.equal(plan.loadPlan(), null);
  delete globalThis.wx;
});

test('本机存储：脏数据整条丢弃，返回 null 而不是半份计划', () => {
  const stub = storageStub();
  globalThis.wx = stub.wx;
  for (const dirty of [
    '不是 JSON',
    JSON.stringify({ blocks: 'nope' }),
    JSON.stringify({ blocks: [{ weekday: 9, startSection: 1, endSection: 2, minutes: 45, topic: '听力', week: 1 }], goalDate: GOAL_DATE, today: TODAY }),
    JSON.stringify({ blocks: [{ weekday: 1, startSection: 1, endSection: 2, minutes: 45, topic: '听力', week: 1 }] }),
    '',
    null,
  ]) {
    stub.store.set('study-plan/v1', dirty);
    assert.equal(plan.loadPlan(), null, `${JSON.stringify(dirty)} 应当被丢弃`);
  }
  delete globalThis.wx;
});

test('本机存储：写失败与不可用时抛出，不静默丢弃', () => {
  delete globalThis.wx;
  assert.throws(() => plan.savePlan(build()), /无法保存到本机/);

  globalThis.wx = {
    getStorageSync: () => '',
    setStorageSync: () => { throw new Error('quota exceeded'); },
    removeStorageSync: () => {},
  };
  assert.throws(() => plan.savePlan(build()), /保存失败：本机存储不可写/);

  assert.throws(() => plan.savePlan({}), /计划数据不完整/);
  delete globalThis.wx;
});

/* ------------------------------------------------------------------ *
 * 五、计划页：步骤条、加入课表的入参、换一种排法不写库
 * ------------------------------------------------------------------ */

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  // 深拷贝一次：页面代码跑在 vm 的 realm 里，它 setData 进来的数组 / 对象原型与测试不同，
  // 直接 deepEqual 会报「结构相同但不是同一个引用」。JSON 往返把它们换成本 realm 的普通值。
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const plain = value === undefined ? undefined : JSON.parse(JSON.stringify({ value })).value;
      if (key.includes('.')) {
        const parts = key.split('.');
        let target = page.data;
        for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
        target[parts[parts.length - 1]] = plain;
        continue;
      }
      page.data[key] = plain;
    }
  };
  return page;
}

function wxStub() {
  const store = new Map();
  const calls = { toast: [], modal: [], navigate: [], reLaunch: [] };
  const timers = [];
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    showToast: (options) => calls.toast.push(options.title),
    showModal: (options) => calls.modal.push({ title: options.title, content: options.content }),
    navigateTo: (options) => calls.navigate.push(options.url),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (options) => calls.reLaunch.push(options.url),
  };
  return { store, calls, timers, wx };
}

function loadPage(stub, stack = [{}, {}]) {
  globalThis.wx = stub.wx;
  const filename = path.resolve('dist/pages/goals/plan/index.js');
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = instantiate(options); },
    wx: stub.wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout: (fn) => { stub.timers.push(fn); return stub.timers.length; },
    clearTimeout: () => {},
  }, { filename });
  return page;
}

/** 种一个目标日到本机存储里（`goal-days/v1`），模拟学生之前建过。 */
function seedGoal(stub, overrides = {}) {
  const goals = [{
    id: 'g1',
    name: '英语四级',
    date: GOAL_DATE,
    countToday: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }];
  stub.wx.setStorageSync('goal-days/v1', JSON.stringify(goals));
  return goals;
}

/** 给页面装上「读到的课表与作息」，跳过云端（页面在测试里不连网）。 */
function feed(page, courses = [], timetable = settings()) {
  page.courses = courses;
  page.settings = timetable;
}

test('计划页：没选目标时步骤条停在第一步', () => {
  const stub = wxStub();
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.status, 'pick');
  assert.deepEqual(page.data.steps.map((step) => step.state), ['on', '', '', '']);
  page.onCreateGoal();
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/edit/index']);
});

test('计划页：选完目标 → ①②done、③on；排出计划后仍然这样，加入前不会假装已完成', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.status, 'ready');
  assert.deepEqual(page.data.goals.map((goal) => goal.id), ['g1']);

  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  assert.equal(page.data.goalId, 'g1');
  assert.deepEqual(page.data.steps.map((step) => step.state), ['done', 'on', '', '']);
  assert.match(page.data.eyebrow, /目标日 · 英语四级 · 12 月 13 日/);
  assert.match(page.data.headline, /还剩 \d+ 天/);

  feed(page, [course({ name: 'JSP', weekday: 1, startSection: 1, endSection: 2 })]);
  page.showPlan('听力最弱，每次别超过 1 小时，周末上午不排。');
  assert.deepEqual(page.data.steps.map((step) => step.state), ['done', 'done', 'on', '']);
  assert.equal(page.data.gridRows.length >= 5, true);
  assert.ok(page.data.rationale.length >= 2);
  assert.ok(page.data.constraintLines.some((line) => line.includes('60 分钟')));
  assert.equal(page.data.hoursText, '共 4 小时');
});

test('计划页：加入课表（作为计划）只写本机 plan，写入的就是当前这份计划', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page, [course({ name: 'JSP', weekday: 1, startSection: 1, endSection: 2 })]);
  page.showPlan('每周 3 段');

  assert.equal(stub.store.has('study-plan/v1'), false, '看计划阶段不应写库');
  page.onSave();

  const saved = JSON.parse(stub.store.get('study-plan/v1'));
  assert.equal(saved.blocks.length, 3);
  assert.deepEqual(saved.blocks, page.data.plan.blocks);
  assert.equal(saved.goalDate, GOAL_DATE);
  // 计划不是课程：不能往云端课表的 key 里写任何东西。
  assert.equal(stub.store.has('timetable/courses'), false);
  assert.deepEqual(stub.calls.toast, ['已加入课表']);
  assert.equal(stub.timers.length, 1, '保存后延时返回上一页');
  stub.timers[0]();
  assert.deepEqual(stub.calls.navigate, ['back']);
});

test('计划页：换一种排法只重算，不写库', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page);
  page.showPlan('每周 3 段');

  const before = page.data.plan.blocks.map((block) => `${block.weekday}-${block.startSection}`);
  page.onVariant();
  const after = page.data.plan.blocks.map((block) => `${block.weekday}-${block.startSection}`);
  assert.notDeepEqual(after, before, '换一种排法要真的换一天');
  assert.equal(stub.store.has('study-plan/v1'), false, '换一种排法不许写库');
  assert.equal(page.data.steps[2].state, 'on');
});

test('计划页：排不下时不给「加入」的错觉，点保存也不写库', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  const full = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (const start of [1, 3, 5, 7, 9, 11]) {
      full.push(course({ name: `满${weekday}-${start}`, weekday, startSection: start, endSection: start + 1 }));
    }
  }
  feed(page, full);
  page.showPlan('每周 4 段');
  assert.equal(page.data.plan.blocks.length, 0);
  assert.match(page.data.plan.headline, /没有能排的空档/);

  page.onSave();
  assert.equal(stub.store.has('study-plan/v1'), false);
  assert.match(page.data.error, /没有能排的时段/);
});

test('计划页：认不出的原话在页面上照实说，不假装听懂', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page);
  page.showPlan('周四下午要去实验室，晚上不排');
  assert.ok(page.data.dropped.some((line) => line.includes('实验室')));
  assert.ok(page.data.defaultNote.length > 0, '要说明哪些按默认排');
  assert.ok(page.data.plan.blocks.every((block) => block.startSection < 9));
});

test('计划页：带 ?id= 进来时直接选中那个目标日；目标日没了就说没了', () => {
  const stub = wxStub();
  seedGoal(stub);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  assert.equal(page.data.goalId, 'g1');
  assert.deepEqual(page.data.steps.map((step) => step.state), ['done', 'on', '', '']);

  const other = loadPage(stub);
  other.onLoad({ id: 'nope', today: TODAY });
  assert.equal(other.data.status, 'missing');
  assert.match(other.data.headline, /已经不在了/);
});

test('计划页：本机已有计划时如实提示「重新排会覆盖它」', () => {
  const stub = wxStub();
  seedGoal(stub);
  const existing = build({ constraints: { ...plan.emptyConstraints(), blocksPerWeek: 2 } });
  stub.wx.setStorageSync('study-plan/v1', JSON.stringify(existing));
  const page = loadPage(stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasSaved, true);
  assert.match(page.data.savedNote, /覆盖/);

  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page);
  page.showPlan('每周 2 段');
  page.onRemove();
  assert.equal(stub.store.has('study-plan/v1'), false);
  assert.equal(page.data.hasSaved, false);
});

test('计划页四件套与 app.json 注册都在', () => {
  const dir = path.resolve('dist/pages/goals/plan');
  for (const name of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `缺少 ${name}`);
  }
  const appJson = JSON.parse(fs.readFileSync(path.resolve('dist/app.json'), 'utf8'));
  assert.ok(appJson.pages.includes('pages/goals/plan/index'));
  const own = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(own.navigationBarTitleText, '备考计划');
});
