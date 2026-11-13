/**
 * C 分支：学习计划页九种界面状态（设计稿 14 输入 / 49 基础规则 / 15 约束核对 /
 * 64 约束澄清 / 43 AI 不可用 / 16 预览 / 17 已保存 / 18 冲突 / 40 过期快照）。
 *
 * 与 tests/goals-plan.test.cjs 同一套骨架（vm 加载构建产物 + wx 桩 + 本机存储）：
 * 那支测试守的是业务不变量（排得下 / 排不下 / 不写云端 / 迟到回复作废），
 * 这里守的是**这一轮界面**的契约：
 * - `screen` 九种取值各有真实入口，且每种屏的导航标题与 h1 与设计稿一致；
 * - `dropped` / `problems` 必须上屏（澄清态不能静默按默认排）；
 * - 基础规则五组控件只映射既有 PlanConstraints 字段，不新增存储结构；
 * - 去课表走公共意图桥 `openTimetable`，意图是 `plan-week`，没有 switchTab 时退回 navigateTo；
 * - 迟到响应（页面退出 / 令牌变化）不上屏、不写库。
 *
 * 主题规则（WXSS 不含中文、令牌必须带回退值）由 tests/wxss.test.cjs 统一守，这里只查 import 与分屏结构。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const planService = require('../dist/services/goals/plan.js');

const TODAY = '2026-09-28';
const GOAL_DATE = '2026-12-13';
const SEMESTER_START = '2026-09-28';
const PLAN_KEY = 'study-plan/v1';
const INTENT_KEY = 'lingnan/ui-timetable-intent/v1';

/** AI 支路的原话与固定响应（与 services/goals/intent.ts 的解析器对齐）。 */
const INTENT_TEXT = '周二没空，周末上午有兼职，每次半小时，听力最弱，一周安排三回';
/** 基础规则能读通的正常原话：4 段 × 60 分钟，不作弊也不猜。 */
const NORMAL_TEXT = '听力最弱，每次别超过 1 小时，周末上午不排。';
/** 有一句没听懂 → 澄清态（dropped 非空）。 */
const CLARIFY_TEXT = '周四下午要去实验室，晚上不排';
/** 数值越界 → 澄清态（problems 非空）。 */
const PROBLEM_TEXT = '每次 200 分钟';

function sectionTimes() {
  return Array.from({ length: 12 }, () => ({ start: '', end: '' }));
}

function settings(overrides = {}) {
  return { semesterName: '', startDate: SEMESTER_START, totalWeeks: 20, sectionTimes: sectionTimes(), ...overrides };
}

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
    weekText: '',
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

/** 直接造一份结构合法的计划快照（绕过页面），用于「已保存 / 冲突 / 过期」三屏。 */
function storedPlan(overrides = {}) {
  return planService.buildPlan({
    goalName: overrides.goalName ?? '英语四级',
    goalId: overrides.goalId ?? 'g1',
    goalDate: overrides.goalDate ?? GOAL_DATE,
    today: overrides.today ?? TODAY,
    courses: overrides.courses ?? [],
    settings: overrides.settings ?? settings(),
    constraints: overrides.constraints ?? { ...planService.emptyConstraints(), focus: '听力' },
    constraintText: overrides.constraintText ?? NORMAL_TEXT,
    variant: overrides.variant,
    now: overrides.now ?? 1,
  });
}

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
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

/**
 * 本机存储 + 导航 + 标题桩。
 * `tabs: false` 时不提供 `switchTab`，用来验证「宿主没有 tab 能力时退回 navigateTo」。
 */
function wxStub(options = {}) {
  const store = new Map();
  const calls = { toast: [], modal: [], navigate: [], reLaunch: [], switchTab: [], title: [], scroll: [] };
  const timers = [];
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    showToast: (payload) => calls.toast.push(payload.title),
    showModal: (payload) => calls.modal.push({ title: payload.title, content: payload.content }),
    navigateTo: (payload) => calls.navigate.push(payload.url),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (payload) => calls.reLaunch.push(payload.url),
    setNavigationBarTitle: (payload) => calls.title.push(payload.title),
    nextTick: (callback) => callback(),
    pageScrollTo: (payload) => calls.scroll.push(payload),
  };
  if (options.tabs !== false) {
    wx.switchTab = (payload) => {
      calls.switchTab.push(payload.url);
      payload.success?.();
    };
  }
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

function seedGoal(stub, overrides = {}) {
  const goals = [{
    id: 'g1', name: '英语四级', date: GOAL_DATE, countToday: false, createdAt: 1, updatedAt: 1, ...overrides,
  }];
  stub.wx.setStorageSync('goal-days/v1', JSON.stringify(goals));
  return goals;
}

/** 给页面装上「读到的课表与作息」，跳过云端。 */
function feed(page, courses = [], timetable = settings()) {
  page.courses = courses;
  page.settings = timetable;
  page.coursesKnown = true;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function intentFixture() {
  return { kind: 'constraints', minutes: { value: 30, quote: '每次半小时' }, sessions: { value: 3, quote: '一周安排三回' },
    focus: { value: '听力', quote: '听力最弱' }, excludedDays: [{ days: [2], quote: '周二没空' }],
    excludedPeriods: [{ days: [6, 7], period: 'morning', quote: '周末上午有兼职' }], unhandled: [] };
}

/**
 * 课表云函数桩：`model` 是当前那次 AI 回复（可以是 promise / 函数），
 * 课表与作息永远按「读到了」返回；其余 action 直接抛错，防止页面偷偷写云端。
 */
function cloudStub(stub, model) {
  const requests = [];
  const safeReply = { ok: true, text: JSON.stringify(intentFixture()), safety: {
    provider: 'fixture', api: 'fixture', passed: true, checked: true, detail: '' } };
  const state = { model };
  stub.wx.cloud = { callFunction: async ({ name, data }) => {
    requests.push({ name, data });
    if (name === 'ai') return { result: typeof state.model === 'function' ? await state.model() : await state.model };
    if (data.action === 'list') return { result: { ok: true, courses: [], semester: '', count: 0, updatedAt: '' } };
    if (data.action === 'getSettings') return { result: { ok: true, saved: true, settings: settings() } };
    throw new Error('不允许写入云端：' + data.action);
  } };
  return { requests, state, safeReply, aiCount: () => requests.filter((item) => item.name === 'ai').length };
}

/** 断言当前屏：`screen` 判别字段、导航标题、h1，以及真的把标题写到了导航栏上。 */
function expectScreen(page, stub, screen, navTitle, heroTitle) {
  assert.equal(page.data.screen, screen, `期望停在 ${screen} 屏`);
  assert.equal(page.data.navTitle, navTitle);
  assert.equal(page.data.heroTitle, heroTitle);
  assert.equal(stub.calls.title.at(-1), navTitle, '运行时标题要真的写到导航栏');
}

/* ------------------------------------------------------------------ *
 * 一、九屏各有真实入口，标题与 h1 与设计稿一致
 * ------------------------------------------------------------------ */

test('计划页九屏：输入 → 基础规则 → AI 草稿 → 澄清 → AI 不可用，五个入口都从真实操作走进', async () => {
  const stub = wxStub();
  seedGoal(stub);
  const cloud = cloudStub(stub, null);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });

  // 14 输入：默认入口，三步条停在第 1 步。
  expectScreen(page, stub, 'input', '安排学习计划', '这一周，你想怎么学？');
  assert.match(page.data.heroLead, /说说空闲时间和薄弱项/u);
  assert.deepEqual(page.data.stepBar.map((step) => step.state), ['on', '', '']);

  // 49 基础规则：五组控件默认值与设计稿一致。
  page.showRules();
  expectScreen(page, stub, 'rules', '基础规则设置', '自己定，也能安排清楚。');
  assert.equal(page.data.ruleMinutes, 60);
  assert.equal(page.data.ruleBlocks, 4);
  assert.deepEqual(page.data.ruleMinuteOptions.filter((option) => option.on).map((option) => option.key), [60]);
  assert.equal(page.data.ruleBlockOptions.length, 5);
  assert.deepEqual(page.data.ruleWeekdays.map((option) => option.key), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(page.data.ruleWeekdays.some((option) => option.on), false);
  assert.deepEqual(page.data.rulePeriodRows.map((row) => row.label), ['周六', '周日']);
  assert.equal(page.data.rulePeriodRows[0].options.length, 3);
  assert.equal(page.data.rulePeriodRows[0].options.some((option) => option.on), false);
  assert.equal(page.data.stepBar[0].state, 'on');

  // 回到输入态再走 AI 支路。
  page.hideRules();
  expectScreen(page, stub, 'input', '安排学习计划', '这一周，你想怎么学？');
  cloud.state.model = cloud.safeReply;
  page.onConstraintInput({ detail: { value: INTENT_TEXT } });
  await page.understandAi();

  // 15 约束核对：每条附原话，确认前不生成、不写库。
  expectScreen(page, stub, 'draft', '核对学习约束', '这是你的意思吗？');
  assert.equal(page.data.aiEvidence.length, 5);
  assert.ok(page.data.aiEvidence.every((item) => item.quote !== '' && item.value !== ''));
  assert.deepEqual(page.data.stepBar.map((step) => step.state), ['done', 'on', '']);
  assert.equal(page.data.plan, null);
  assert.equal(stub.store.has(PLAN_KEY), false, '核对阶段不许写库');

  // 64 澄清：有一句没听懂就停在澄清态，把原话和原因都摆出来。
  page.editAiInput();
  expectScreen(page, stub, 'input', '安排学习计划', '这一周，你想怎么学？');
  feed(page);
  page.showPlan(CLARIFY_TEXT);
  expectScreen(page, stub, 'clarify', '有一句还需确认', '有一句，还需要说具体一点。');
  assert.equal(page.data.clarifyQuote, '周四下午要去实验室');
  assert.match(page.data.clarifyReason, /没听懂/u);
  assert.deepEqual(page.data.stepBar.map((step) => step.state), ['done', 'on', '']);
  assert.equal(page.data.plan, null);
  assert.equal(stub.store.has(PLAN_KEY), false);

  // 43 AI 不可用：原话保留，主按钮改成「用基础规则设置」。
  page.editAiInput();
  page.onConstraintInput({ detail: { value: INTENT_TEXT } });
  cloud.state.model = { ok: false, failureClass: 'quota_exhausted', message: '本次 AI 用量已达上限' };
  await page.understandAi();
  expectScreen(page, stub, 'unavailable', '约束暂时没整理好', '这次先手动安排。');
  assert.ok(page.data.aiMessage.length > 0);
  assert.equal(page.data.constraintText, INTENT_TEXT, '原话必须原样保留');
  assert.equal(page.data.plan, null);
  assert.equal(stub.store.has(PLAN_KEY), false);

  // 从不可用直接转基础规则，是设计 43 的合法出路。
  page.onRulesFromAi();
  expectScreen(page, stub, 'rules', '基础规则设置', '自己定，也能安排清楚。');
  delete globalThis.wx;
});

test('计划页九屏：预览 → 已保存 → 冲突 → 过期快照，四屏都由真实状态推导', async () => {
  const stub = wxStub();
  seedGoal(stub);
  cloudStub(stub, null);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page);

  // 16 预览：统计三格、计划段、未保存标记。
  page.showPlan(NORMAL_TEXT);
  expectScreen(page, stub, 'preview', '预览学习计划', '这一周，这样安排。');
  assert.equal(page.data.plan.blocks.length, 4);
  assert.deepEqual(page.data.statCells.map((cell) => `${cell.value}${cell.unit}${cell.caption}`), ['4次本周安排', '240分钟总学习时长', '0已知冲突']);
  assert.equal(page.data.planItems.length, 4);
  assert.deepEqual(
    [page.data.planItems[0].weekday, page.data.planItems[0].day, page.data.planItems[0].title,
      page.data.planItems[0].window, page.data.planItems[0].minutes],
    ['周二', '29', '听力', '第 1–2 节内', '学习 60 分钟'],
  );
  assert.equal(page.data.planMinutesText, '60');
  assert.match(page.data.planRangeText, /9 月 28 日 — 4 日/u);
  assert.ok(page.data.gridRows.length >= 5);
  assert.deepEqual(page.data.stepBar.map((step) => step.state), ['done', 'done', 'on']);
  assert.equal(stub.store.has(PLAN_KEY), false, '预览阶段不写库');

  // 17 已保存：h1 用计划里读得出的弱项，依据四行都在。
  page.onSave();
  expectScreen(page, stub, 'saved', '本周学习计划', '给听力，留好时间。');
  assert.deepEqual(stub.calls.toast, ['已保存到本机']);
  assert.equal(page.data.savedRows.length, 4);
  assert.deepEqual(page.data.evidenceRows.map((row) => row.key), ['约束来源', '每次 / 每周', '避开', '原计划日期']);
  assert.equal(page.data.evidenceRows[0].value, '基础规则，未请求 AI');
  assert.equal(page.data.savedGoalMissing, false);
  assert.equal(page.data.stepBar.length, 3);

  // 18 冲突：保存后课表新增一门撞上时段的课，原计划不动。
  const stored = stub.store.get(PLAN_KEY);
  page.courses = [course({ name: '高等数学', weekday: 2, startSection: 1, endSection: 2 })];
  page.coursesKnown = true;
  page.refreshScreen();
  expectScreen(page, stub, 'conflict', '计划需要核对', '有一处时间撞上了。');
  assert.equal(page.data.conflictItems.length, 1);
  assert.match(page.data.conflictItems[0].noteTitle, /周.第 1–2 节与新课程冲突/u);
  assert.match(page.data.conflictItems[0].course, /高等数学/u);
  assert.equal(page.data.conflictRestTitle, '另外 3 次练习');
  assert.match(page.data.conflictRestNote, /未发现已知课程冲突/u);
  assert.equal(page.data.heroLead, '原计划仍在，没有自动改动。');
  assert.equal(stub.store.get(PLAN_KEY), stored, '发现冲突不改存储');

  // 40 过期快照：目标日被删后只剩历史，不再当作本周有效安排。
  const orphanStub = wxStub();
  orphanStub.wx.setStorageSync(PLAN_KEY, JSON.stringify(storedPlan({ today: '2026-11-10' })));
  orphanStub.wx.setStorageSync('goal-days/v1', '[]');
  const orphan = loadPage(orphanStub);
  orphan.onLoad({ today: TODAY });
  expectScreen(orphan, orphanStub, 'expired', '历史学习计划', '计划还在，时间已经过去了。');
  assert.equal(orphan.data.savedGoalMissing, true);
  assert.match(orphan.data.heroLead, /保存于/u);
  assert.equal(orphan.data.savedRows.length > 0, true);
  delete globalThis.wx;
});

/* ------------------------------------------------------------------ *
 * 二、基础规则：五组控件只映射既有 PlanConstraints
 * ------------------------------------------------------------------ */

test('计划页基础规则：控件映射到 PlanConstraints 的既有字段，不新增存储结构', () => {
  const stub = wxStub();
  seedGoal(stub);
  cloudStub(stub, null);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  page.showRules();

  page.onRuleMinutes({ currentTarget: { dataset: { value: 30 } } });
  page.onRuleBlocks({ currentTarget: { dataset: { value: 3 } } });
  page.onRuleFocusInput({ detail: { value: '听力' } });
  page.onRuleWeekday({ currentTarget: { dataset: { value: 4 } } });
  page.onRulePeriod({ currentTarget: { dataset: { weekday: 6, start: 1, end: 4 } } });
  page.onRulePeriod({ currentTarget: { dataset: { weekday: 7, start: 1, end: 4 } } });
  page.onRuleNoEvening();

  assert.equal(page.data.ruleMinutes, 30);
  assert.equal(page.data.ruleBlocks, 3);
  assert.deepEqual(page.data.ruleWeekdays.filter((option) => option.on).map((option) => option.key), [4]);

  const constraints = JSON.parse(JSON.stringify(page.ruleConstraints()));
  assert.deepEqual(constraints, {
    maxMinutesPerBlock: 30,
    blocksPerWeek: 3,
    focus: '听力',
    noWeekendMorning: true,
    noEvening: true,
    excludedWeekdays: [4],
    blockedSections: [
      { weekday: 6, start: 1, end: 4 },
      { weekday: 7, start: 1, end: 4 },
    ],
  });

  const lines = page.ruleLines();
  assert.match(lines[0], /每段不超过 30 分钟/u);
  assert.match(lines[1], /每周 3 段/u);
  assert.ok(lines.includes('最弱的是听力'));
  assert.ok(lines.includes('周四不排'));
  assert.ok(lines.includes('周六上午不排'));
  assert.ok(lines.includes('周末上午一律不排'));
  assert.ok(lines.includes('晚上一律不排'));

  // 再点一次就是取消，映射随之收回——不残留「点了但没生效」的状态。
  page.onRuleWeekday({ currentTarget: { dataset: { value: 4 } } });
  page.onRulePeriod({ currentTarget: { dataset: { weekday: 6, start: 1, end: 4 } } });
  page.onRuleNoEvening();
  const relaxed = JSON.parse(JSON.stringify(page.ruleConstraints()));
  assert.equal(relaxed.excludedWeekdays, undefined);
  assert.equal(relaxed.noWeekendMorning, false, '只剩周日时不再算「周末上午不排」');
  assert.equal(relaxed.noEvening, false);
  assert.deepEqual(relaxed.blockedSections, [{ weekday: 7, start: 1, end: 4 }]);
  delete globalThis.wx;
});

/* ------------------------------------------------------------------ *
 * 三、规则生成 / 成稿约束 / 迟到响应
 * ------------------------------------------------------------------ */

test('计划页基础规则：按规则生成预览走纯规则，不请求模型也不写云端', async () => {
  const stub = wxStub();
  seedGoal(stub);
  const cloud = cloudStub(stub, null);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  page.showRules();
  page.onRuleMinutes({ currentTarget: { dataset: { value: 45 } } });
  page.onRuleBlocks({ currentTarget: { dataset: { value: 2 } } });
  page.onRuleFocusInput({ detail: { value: '阅读' } });
  page.onRuleWeekday({ currentTarget: { dataset: { value: 4 } } });
  await page.generateRules();

  assert.equal(page.data.screen, 'preview');
  assert.equal(page.data.plan.origin, 'rules');
  assert.equal(page.data.plan.blocks.length, 2);
  assert.ok(page.data.plan.blocks.every((block) => block.weekday !== 4 && block.minutes <= 45));
  assert.match(page.data.plan.constraintText, /每段不超过 45 分钟/u);
  assert.match(page.data.plan.constraintText, /每周 2 段/u);
  assert.match(page.data.plan.constraintText, /最弱的是阅读/u);
  assert.equal(cloud.aiCount(), 0, '基础规则不许请求模型');
  assert.deepEqual(cloud.requests.filter((item) => !['list', 'getSettings'].includes(item.data.action)), []);
  assert.equal(stub.store.has(PLAN_KEY), false);
  assert.deepEqual(stub.timers, [], '生成后不自动跳走');
  delete globalThis.wx;
});

test('计划页：dropped / problems 必须上屏，澄清态不静默按默认排', () => {
  const stub = wxStub();
  seedGoal(stub);
  cloudStub(stub, null);
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  page.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(page);

  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/goals/plan/index.wxml'), 'utf8');
  assert.match(wxml, /\{\{dropped\}\}/u, '没听懂的原话要渲染到模板里');
  assert.match(wxml, /class="gp-error/u, '错误 / 澄清原因用 .gp-error 上屏');
  assert.match(wxml, /\{\{clarifyReason\}\}/u);

  // 有一句没听懂：原话进 dropped，理由进 error，页面停在澄清屏。
  page.showPlan(CLARIFY_TEXT);
  assert.ok(page.data.dropped.some((line) => line.includes('实验室')));
  assert.match(page.data.error, /实验室/u);
  assert.equal(page.data.screen, 'clarify');
  assert.equal(page.data.plan, null);
  assert.ok(stub.calls.scroll.some((options) => options.selector === '.gp-error'), '自动定位到那句原因');

  // 数值越界：problems 也要上屏，不能把 200 分钟静默放宽成 180。
  const problemStub = wxStub();
  seedGoal(problemStub);
  cloudStub(problemStub, null);
  const problemPage = loadPage(problemStub);
  problemPage.onLoad({ id: 'g1', today: TODAY });
  problemPage.onPickGoal({ currentTarget: { dataset: { id: 'g1' } } });
  feed(problemPage);
  problemPage.showPlan(PROBLEM_TEXT);
  assert.equal(problemPage.data.screen, 'clarify');
  assert.match(problemPage.data.error, /180/u);
  assert.match(problemPage.data.error, /200/u);
  assert.equal(problemPage.data.plan, null);
  assert.equal(problemStub.store.has(PLAN_KEY), false);
  delete globalThis.wx;
});

test('计划页：去课表走公共意图桥，意图是 plan-week 且带计划生成那天', async () => {
  const tabStub = wxStub();
  tabStub.wx.setStorageSync(PLAN_KEY, JSON.stringify(storedPlan({ today: '2026-11-10' })));
  tabStub.wx.setStorageSync('goal-days/v1', JSON.stringify([
    { id: 'g1', name: '英语四级', date: GOAL_DATE, countToday: false, createdAt: 1, updatedAt: 1 },
  ]));
  cloudStub(tabStub, null);
  const page = loadPage(tabStub);
  page.onLoad({ id: 'g1', today: '2026-11-11' });
  page.onViewWeek();
  await flush();
  assert.deepEqual(tabStub.calls.switchTab, ['/pages/timetable/index'], '课表是 tab 页，必须 switchTab');
  assert.deepEqual(tabStub.calls.navigate, [], '有 tab 能力时不再 navigateTo');
  const stored = tabStub.store.get(INTENT_KEY);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.intent)), { kind: 'plan-week', planDate: '2026-11-10' });

  // 宿主没有 switchTab（例如老基础库 / 只跑页面逻辑的测试宿主）：退回旧路由，别把按钮点死。
  const legacyStub = wxStub({ tabs: false });
  legacyStub.wx.setStorageSync(PLAN_KEY, JSON.stringify(storedPlan({ today: '2026-11-10' })));
  legacyStub.wx.setStorageSync('goal-days/v1', JSON.stringify([
    { id: 'g1', name: '英语四级', date: GOAL_DATE, countToday: false, createdAt: 1, updatedAt: 1 },
  ]));
  cloudStub(legacyStub, null);
  const legacy = loadPage(legacyStub);
  legacy.onLoad({ id: 'g1', today: '2026-11-11' });
  legacy.onViewWeek();
  assert.deepEqual(legacyStub.calls.navigate, ['/pages/timetable/index?planDate=2026-11-10']);
  delete globalThis.wx;
});

test('计划页：迟到响应不上屏——页面退出与令牌变化两种情形都作废', async () => {
  // 情形一：请求在途时退出页面。
  const exitStub = wxStub();
  seedGoal(exitStub);
  let releaseExit;
  const exitDeferred = new Promise((resolve) => { releaseExit = resolve; });
  const exitCloud = cloudStub(exitStub, () => exitDeferred);
  const exitPage = loadPage(exitStub);
  exitPage.onLoad({ id: 'g1', today: TODAY });
  exitPage.onConstraintInput({ detail: { value: INTENT_TEXT } });
  const exiting = exitPage.understandAi();
  await flush();
  assert.equal(exitCloud.aiCount(), 1, '真的发出了请求');
  exitPage.onUnload();
  releaseExit(exitCloud.safeReply);
  await exiting;
  assert.equal(exitPage.data.aiDraftReady, false);
  assert.equal(exitPage.data.aiEvidence.length, 0);
  assert.equal(exitPage.data.plan, null);
  assert.equal(exitStub.store.has(PLAN_KEY), false);

  // 情形二：请求在途时改了原话（令牌 + 文本都变了）。
  const editStub = wxStub();
  seedGoal(editStub);
  let releaseEdit;
  const editDeferred = new Promise((resolve) => { releaseEdit = resolve; });
  const editCloud = cloudStub(editStub, () => editDeferred);
  const editPage = loadPage(editStub);
  editPage.onLoad({ id: 'g1', today: TODAY });
  editPage.onConstraintInput({ detail: { value: INTENT_TEXT } });
  const pending = editPage.understandAi();
  await flush();
  editPage.onConstraintInput({ detail: { value: '晚上不排' } });
  releaseEdit(editCloud.safeReply);
  await pending;
  assert.equal(editPage.data.constraintText, '晚上不排', '新输入不被旧回复覆盖');
  assert.equal(editPage.data.aiDraftReady, false);
  assert.equal(editPage.data.aiEvidence.length, 0);
  assert.equal(editPage.data.aiDraft === null || editPage.data.aiDraft === undefined, true);
  assert.equal(editPage.data.plan, null);
  assert.equal(editStub.store.has(PLAN_KEY), false);
  delete globalThis.wx;
});

/* ------------------------------------------------------------------ *
 * 四、换排法 / 保存 / 重开不额外请求模型；模板与样式契约
 * ------------------------------------------------------------------ */

test('计划页：确认后换排法、保存、重开都不再请求模型，保存只写本机', async () => {
  const stub = wxStub();
  seedGoal(stub);
  const cloud = cloudStub(stub, null);
  cloud.state.model = cloud.safeReply;
  const page = loadPage(stub);
  page.onLoad({ id: 'g1', today: TODAY });
  page.onConstraintInput({ detail: { value: INTENT_TEXT } });
  await page.understandAi();
  await page.confirmAiPlan();
  assert.equal(page.data.plan.origin, 'ai-constraints');
  assert.equal(cloud.aiCount(), 1);

  const before = page.data.plan.blocks.map((block) => `${block.weekday}-${block.startSection}`);
  page.onVariant();
  const after = page.data.plan.blocks.map((block) => `${block.weekday}-${block.startSection}`);
  assert.notDeepEqual(after, before, '换一个安排要真的换一天');
  assert.equal(cloud.aiCount(), 1, '换排法不请求模型');

  page.onSave();
  assert.equal(page.data.screen, 'saved');
  assert.equal(cloud.aiCount(), 1, '保存不请求模型');
  const saved = JSON.parse(stub.store.get(PLAN_KEY));
  assert.deepEqual(saved.blocks, page.data.plan.blocks);
  assert.equal(stub.store.has('timetable/courses'), false, '计划不是课程，不写云端课表缓存');

  const reopened = loadPage(stub);
  reopened.onLoad({ id: 'g1', today: TODAY });
  assert.equal(reopened.data.screen, 'saved');
  assert.equal(reopened.data.plan.origin, 'ai-constraints');
  assert.equal(cloud.aiCount(), 1, '重开不请求模型');
  assert.equal(stub.store.get(PLAN_KEY), JSON.stringify(saved), '重开不改存储');
  delete globalThis.wx;
});

test('计划页：模板按 screen 分屏、WXSS 只导入共享样式，设计原话都在', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/goals/plan/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.resolve('miniprogram/pages/goals/plan/index.wxss'), 'utf8');
  const ts = fs.readFileSync(path.resolve('miniprogram/pages/goals/plan/index.ts'), 'utf8');

  // 九屏各有一个分支，判别字段是 screen——不是把九个 if 堆在业务字段上。
  for (const screen of ['input', 'rules', 'draft', 'clarify', 'unavailable', 'preview', 'saved', 'conflict', 'expired']) {
    assert.ok(wxml.includes(`screen === '${screen}'`), `模板缺少 ${screen} 分屏`);
  }
  // 判别字段是多行联合类型：九个取值都要在类型里出现。
  const screenUnion = ts.match(/type Screen =[\s\S]*?;/u);
  assert.ok(screenUnion !== null, 'index.ts 缺少 Screen 判别类型');
  for (const screen of ['loading', 'pick', 'missing', 'input', 'rules', 'draft', 'clarify',
    'unavailable', 'preview', 'saved', 'conflict', 'expired']) {
    assert.ok(screenUnion[0].includes(`'${screen}'`), `Screen 类型缺少 ${screen} 取值`);
  }

  // 共享样式：C 专用件从 study.wxss 来，别在这里复制一份。
  assert.equal(wxss.split(/\r?\n/u)[0].trim(), '@import "../../../ui/study/study.wxss";');

  // 设计稿原话：入口、边界与出路都要在模板里看得见。
  for (const copy of [
    '只发送目标名称和这段情况', '课表不发送', '整理我的学习约束',
    '识别结果先给你核对，不会直接创建或保存计划。',
    '确认这些约束，生成预览', '只生成预览，不会保存或改动正式课程。',
    '保存这份计划', '换一个安排', '只保存本机计划，不加入正式课程。',
    '按这些规则生成预览', '返回 AI 整理入口',
    '澄清后再生成预览', '返回修改这句话', '自己选择不可用时段',
    '用基础规则设置', '返回修改情况',
    '去课表查看本周安排', '重新生成计划',
    '按最新课表重新生成', '先保留这份计划',
    '只供回看；不再作为本周有效安排。不会自动创建目标或重新排程。',
  ]) {
    assert.ok(wxml.includes(copy), `模板缺少设计原话：${copy}`);
  }

  // 旧业务入口的 id 全部保留（既有测试与埋点都按 id 找）。
  for (const id of [
    'plan-constraint', 'plan-generate', 'plan-generate-rules', 'plan-ai-message', 'plan-ai-draft',
    'plan-ai-confirm', 'plan-ai-edit', 'plan-variant', 'plan-save', 'plan-remove',
    'plan-open-goals', 'plan-create-goal', 'saved-plan-card', 'saved-plan-week',
    'saved-plan-regenerate', 'saved-plan-remove',
  ]) {
    assert.ok(wxml.includes(`id="${id}"`), `模板缺少 id：${id}`);
  }
});
