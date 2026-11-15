/**
 * C 分支原生截图与状态核对（端口 9463，避开 A=9461 / B=9462）。
 *
 * 为什么自己写一个而不是复用 scripts/verify-lingnan-ui.cjs：那个是公共验证脚本（A 维护），
 * 覆盖的是旧路由与旧视觉。C 的五个页面有九个计划页状态、四个答辩阶段、体测缺项等，
 * 需要按状态逐个进页面截图，还要能在同一台模拟器里连续跑完。这里用 miniprogram-automator
 * 直连（经 scripts/lib/mini-connect.cjs 补 Jimp 兼容），一次启动、逐屏截图、逐屏核对文案。
 *
 * 前置：微信开发者工具已登录。脚本会自己在需要时拉起自动化会话（见 ensureAutomation）。
 * 用法：
 *   node scripts/ui-v2-c-capture.cjs --out docs/evidence/lingnan-ui-implementation/c/native
 *   node scripts/ui-v2-c-capture.cjs --only 12-goals,25-calendar
 *   node scripts/ui-v2-c-capture.cjs --check          只核对文案，不落盘截图
 *   node scripts/ui-v2-c-capture.cjs --width 320 --out ..../native-320   窄屏核对
 *
 * 场景的 data 覆盖走页面实例 setData（不写存储）；需要真实存储形状的用 seed 先写 goal-days/v1。
 *
 * 三条实测出来的硬约束（2026-11-13，别改回去）：
 * 1. `cli auto` 必须用分离进程启动（Start-Process 的等价物），前台调用返回后端口会被回收。
 * 2. 截图分辨率随 IDE 项目窗口大小变化：窗口 280x600 只能截出 149x321；
 *    先经 scripts/lib/ui-capture-window.ps1 把窗口放大，才能拿到 371x802 这种可用图。
 * 3. 模拟器是同一个页面栈，reLaunch 之前页面栈为空时截不到图，必须先 reLaunch 一次。
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { installOfflineUiSession, restoreOfflineUiSession } = require('./lib/offline-ui-session.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = process.env.WECHAT_AUTO_PORT || '9463';
const CLI = process.env.WECHAT_CLI || path.join('D:\\微信web开发者工具', 'cli.bat');
/** 放大后的 IDE 窗口尺寸；太小会让截图变成 149x321 那种缩略图。 */
const WINDOW = { width: 1720, height: 1080 };

function parseArgs(argv) {
  const options = { out: '', only: null, width: 390, check: false, useSession: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      index += 1;
      options.out = argv[index] || '';
    } else if (arg === '--only') {
      index += 1;
      options.only = (argv[index] || '').split(',').map((part) => part.trim()).filter(Boolean);
    } else if (arg === '--width') {
      index += 1;
      options.width = Number(argv[index]) || 390;
    } else if (arg === '--check') options.check = true;
    else if (arg === '--use-session') options.useSession = true;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 目标日种子：一条未来、一条更远、一条已过期，覆盖三组分组。 */
const GOALS_SEED = JSON.stringify([
  { id: 'exam', name: '英语考试', date: '2026-12-19', countToday: true, createdAt: 1, updatedAt: 1 },
  { id: 'speech', name: '普通话水平测试', date: '2027-03-08', countToday: false, createdAt: 2, updatedAt: 2 },
  { id: 'old', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 3, updatedAt: 3 },
]);

/** 体测七项齐全的虚构输入（设计 27 的排版示例数值）。 */
const FITNESS_FULL = {
  heightCm: '175',
  weightKg: '61.3',
  vitalCapacity: '4300',
  sprint50: '7.0',
  sitAndReach: '17.7',
  standingLongJump: '248',
  strength: '15',
  distanceRun: '3′42″',
};

/** 缺长跑一项（设计 63）。 */
const FITNESS_MISSING = Object.assign({}, FITNESS_FULL, { distanceRun: '' });

/** 计划页截图用的目标日（与 GOALS_SEED 的第一条一致）。 */
const PLAN_GOAL = { id: 'exam', name: '英语考试', date: '2026-12-19', countToday: true, createdAt: 1, updatedAt: 1 };

/**
 * 计划页状态推进：在模拟器 App 上下文里**调用页面自己的方法**把状态走到位，
 * 不伪造 data 字段（`screen` 是推导字段，直接 setData 出来的屏截图就不算数了）。
 *
 * 为什么不用 callMethod：callMethod 只能调页面方法、拿不到实例字段 `courses`/`settings`，
 * 而计划页必须读课表才肯排；`mini.evaluate(fn, ...args)` 能在 App 上下文里取到页面实例，
 * 参数要平铺传（第三个以后的参数都会进 fn 的实参）。
 *
 * mode：
 * - rules    → showRules()                     设计 49
 * - preview  → pickGoal + showPlan(明确约束)     设计 16
 * - saved    → 上面再 onSave()                  设计 17
 * - conflict → 保存后换一份「盖住计划段」的课表再核对  设计 18
 * - expired  → 保存后删掉目标日再核对            设计 40
 * - clarify  → showPlan(含义不清的一句)          设计 64
 */
function planAdvance(goal, mode) {
  const SETTINGS = { semesterStart: '', totalWeeks: 0, sectionTimes: [] };
  const CLEAR = '每次不超过45分钟，每周3段，听力最弱';
  const VAGUE = '周末尽量别太早。';
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.showPlan !== 'function') return { error: 'not a plan page' };

  page.courses = [];
  page.settings = SETTINGS;
  page.coursesKnown = true;
  try {
    wx.removeStorageSync('study-plan/v1');
  } catch (error) {
    /* 本来就没有 */
  }
  page.pickGoal(goal);
  if (mode === 'rules') {
    page.showRules();
    return { screen: page.data.screen };
  }
  if (mode === 'clarify') {
    page.showPlan(VAGUE);
    return { screen: page.data.screen, heroTitle: page.data.heroTitle };
  }
  page.showPlan(CLEAR);
  if (mode === 'preview') {
    return {
      screen: page.data.screen,
      blocks: page.data.plan === null ? 0 : page.data.plan.blocks.length,
      totalMinutes: page.data.plan === null ? 0 : page.data.plan.totalMinutes,
      statCells: page.data.statCells,
    };
  }
  page.onSave();
  // onSave 会弹「已保存到本机」toast，2 秒内会盖住证据图；这里主动收掉。
  try {
    wx.hideToast();
  } catch (error) {
    /* 模拟器没有 toast 时无须处理 */
  }
  const plan = page.data.plan;
  if (mode === 'saved') {
    return { screen: page.data.screen, savedView: page.data.savedView };
  }
  if (mode === 'conflict') {
    page.courses = (plan === null ? [] : plan.blocks).map((block, index) => ({
      id: 'added-' + index,
      name: '新增课程' + (index + 1),
      teacher: '',
      location: '',
      weekday: block.weekday,
      startSection: block.startSection,
      endSection: block.endSection,
      weeks: [],
      sectionRanges: [{ start: block.startSection, end: block.endSection }],
      source: 'manual',
      semester: '2026-2027-1',
    }));
    page.coursesKnown = true;
    page.showSavedPlan(plan);
    return {
      screen: page.data.screen,
      conflicts: page.data.conflictItems.length,
      heroTitle: page.data.heroTitle,
    };
  }
  if (mode === 'expired') {
    wx.removeStorageSync('goal-days/v1');
    page.showSavedPlan(plan);
    return { screen: page.data.screen, savedExpired: page.data.savedExpired };
  }
  return { screen: page.data.screen };
}

/**
 * 答辩练习逐轮推进：在 App 上下文里**调用页面自己的方法**走完三轮作答。
 *
 * 为什么一轮一个 evaluate：`onSubmit()` 之后是 `requestFeedback().then(...)` 的异步链，
 * 微任务要等这一轮 evaluate 返回、栈清空后才跑完；所以每轮之间必须回到宿主侧 sleep，
 * 不能在同一个函数里连跑三轮（那样第二、三轮读到的是还没写入的 session）。
 *
 * 云调用用**固定回包**替换 `wx.cloud.callFunction`：四节齐全、内容固定、
 * 不连真实模型、不产生任何真实 AI 调用。这满足「证据图必须是真实会话内容」，
 * 又不违反「不调用真实业务 AI」的约束。
 */
function defenseAdvance(round) {
  const SECTIONS = ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'];
  const ANSWERS = [
    '这个功能给正在准备比赛的同学用，解决的是材料分散、说不清项目目标的问题。先说一句总述。',
    '关键环节是三段式引导与材料回核；放弃的是自由聊天，因为那样说不清依据，也没法回查。',
    '采集和三轮流程在本地录过屏；模型反馈的质量还没做系统评测，只做过抽查，这是当前的限制。',
  ];
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.onBegin !== 'function') return { error: 'not a defense page' };

  if (round === 0) {
    page.onBegin();
    wx.cloud.callFunction = () => Promise.resolve({
      result: {
        ok: true,
        text: [
          SECTIONS[0] + ' 材料第 1.1 条与「材料分散」这一说法可以对上，其余部分材料里没有直接依据。',
          SECTIONS[1] + ' 回答点到了目标与对象，还差一句「不做什么」的边界。',
          SECTIONS[2] + ' 「说不清项目目标」这句没有给出可回核的条目编号。',
          SECTIONS[3] + ' 你说这个功能给准备比赛的同学用，材料里哪一条能对上？',
        ].join('\n'),
        safety: { provider: 'stub', api: 'stub', passed: true, checked: true, detail: '' },
        warnings: [],
        citations: [],
        capWarning: '',
        failureClass: '',
        message: '',
        detail: '',
        advancement: null,
      },
    });
  } else {
    page.onNextRound();
  }

  page.data.answer = ANSWERS[round];
  page.data.answerCount = ANSWERS[round].length;
  page.onSubmit();
  return { phase: page.data.phase, round: page.data.round };
}

/**
 * 设计 15：AI 约束草稿屏。课表可读 + 模型返回一份结构化约束，页面进 draft 屏。
 * 回包形状按 services/goals/intent.ts 的解析契约给，不连真实模型。
 */
function planDraft(goal) {
  const SETTINGS = { semesterStart: '', totalWeeks: 0, sectionTimes: [] };
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.showPlan !== 'function') return { error: 'not a plan page' };
  page.courses = [];
  page.settings = SETTINGS;
  page.coursesKnown = true;
  try {
    wx.removeStorageSync('study-plan/v1');
  } catch (error) {
    /* 本来就没有 */
  }
  // parsePlanIntent 的调用约束：只认 kind/minutes/sessions/focus/excludedDays/excludedPeriods/unhandled，
  // 且 quote 必须是情况原话的连续子串；四节安全检测必须 checked && passed。
  const SITUATION = '每次不超过45分钟，每周3段，听力最弱';
  wx.cloud.callFunction = () => Promise.resolve({
    result: {
      ok: true,
      text: JSON.stringify({
        kind: 'constraints',
        minutes: { value: 45, quote: '每次不超过45分钟' },
        sessions: { value: 3, quote: '每周3段' },
        focus: { value: '听力', quote: '听力最弱' },
        excludedDays: [],
        excludedPeriods: [],
      }),
      warnings: [],
      citations: [],
      capWarning: '',
      failureClass: '',
      message: '',
      detail: '',
      safety: { provider: 'stub', api: 'stub', passed: true, checked: true, detail: '' },
      advancement: null,
    },
  });
  page.pickGoal(goal);
  // 这条是规范说法：三个 quote 都能在原句里逐字找到。
  page.data.constraintText = SITUATION;
  // aiDraftReady 只能由 understandAi() 置位（showPlan 是规则路径，不经模型）。
  // 它是 async：这里只起步，等待交给宿主侧 sleep。
  page.understandAi();
  return { started: true };
}

/** 设计 30-answer：升学模型解释。固定回包，带来源编号与适用范围。 */
function advancementAnswer() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.ask !== 'function') return { error: 'not an advancement page' };
  wx.cloud.callFunction = () => Promise.resolve({
    result: {
      ok: true,
      text: '按已存政策，网上预报名一般在 1 月上旬开始，具体以省教育考试院当年公告为准。[S1]',
      warnings: [],
      citations: [],
      capWarning: '',
      failureClass: '',
      message: '',
      detail: '',
      safety: { provider: 'stub', api: 'stub', passed: true, checked: true, detail: '' },
      advancement: {
        corpusVersion: 'stub',
        verified: true,
        refused: false,
        violations: [],
        sources: [{
          id: 'S1',
          title: '广东省 2026 年普通专升本招生工作规定',
          publisher: '广东省教育考试院',
          publishedAt: '2025-12-01',
          applicableYear: '2026',
          applicableRegion: '广东省',
          collectedAt: '2026-01-05',
          sourceUrl: 'https://example.invalid/stub',
          quote: '网上预报名时间：1 月上旬。',
        }],
      },
    },
  });
  page.ask('2026年广东普通专升本什么时候网上预报名？');
  return { modelPhase: page.data.modelPhase, hasResult: page.data.hasResult };
}

/** 三轮作答的 steps（每轮一个 evaluate，中间由宿主 sleep 让微任务落地）。 */
function defenseSteps(rounds) {
  const steps = [];
  for (let index = 0; index < rounds; index += 1) steps.push({ evaluate: { fn: defenseAdvance, args: [index] }, sleep: 900 });
  return steps;
}

/**
 * 设计 29-clarify：升学问答的范围澄清态。
 * 这类问题在检索层就没有出处（`canAskModel` 为假），所以**不请求模型**，
 * 页面直接把「需要先确认范围」与可点选项摆出来——正好是 29 这张图的状态。
 */
function advancementClarify() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.ask !== 'function') return { error: 'not an advancement page' };
  page.ask('什么时候报名？');
  return {
    behavior: page.data.result === null ? '' : page.data.result.behavior,
    choices: page.data.result === null ? 0 : page.data.result.choices.length,
    modelPhase: page.data.modelPhase,
  };
}

/**
 * 设计 33-pending：答辩「正在生成反馈」的等待态。
 *
 * 把 `wx.cloud.callFunction` 换成一个**永不落地**的 Promise，
 * 请求就一直停在 pending，页面自然显示计时与「停止等待」入口。
 * 这一屏本来就该是等待中，不需要伪造别的字段。
 */
function defensePending() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.onBegin !== 'function') return { error: 'not a defense page' };
  page.onBegin();
  wx.cloud.callFunction = () => new Promise(() => {});
  const answer = '这个功能给正在准备比赛的同学用，解决材料分散、说不清项目目标的问题。';
  page.data.answer = answer;
  page.data.answerCount = answer.length;
  page.onSubmit();
  return { phase: page.data.phase, round: page.data.round };
}

/** 设计 42-material：材料查阅浮层（在练习态点「查看材料」）。 */
function defenseMaterial() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.onBegin !== 'function') return { error: 'not a defense page' };
  page.onBegin();
  page.onOpenMaterial();
  return { materialOpen: page.data.materialOpen, rows: page.data.materialRows.length };
}

/** 从复盘进入重答（设计 60）。上下文里的云调用已被前面的三轮替换成固定回包。 */
function defenseStartReanswer() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.onStartReanswer !== 'function') return { error: 'not a defense page' };
  page.onStartReanswer();
  return { phase: page.data.phase, round: page.data.round };
}

/** 提交这次重答（设计 61 完成态）。 */
function defenseSubmitReanswer() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.onSubmit !== 'function') return { error: 'not a defense page' };
  const answer = '材料第 1.1 条与「材料分散」可以对上；验证方式是让同学按条目编号回查一遍。';
  page.data.answer = answer;
  page.data.answerCount = answer.length;
  page.onSubmit();
  return { phase: page.data.phase, round: page.data.round };
}

/**
 * 设计 43-ai-unavailable：AI 这次没整理出约束。
 *
 * 关键在**课表读得到、模型失败**：先把课表云函数替换成空课表的成功回包，
 * 再让 `ai` 云函数返回业务失败（model_unavailable）。此时 `understandAi` 走到
 * `reply.kind !== 'constraints'` 分支 → `aiOutcome='unavailable'` → 页面进 43 屏，
 * 已输入的情况原样保留、没有保存任何计划。
 */
function planUnavailable(goal) {
  const SETTINGS = { semesterStart: '', totalWeeks: 0, sectionTimes: [] };
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page || typeof page.understandAi !== 'function') return { error: 'not a plan page' };
  page.courses = [];
  page.settings = SETTINGS;
  page.coursesKnown = true;
  try {
    wx.removeStorageSync('study-plan/v1');
  } catch (error) {
    /* 本来就没有 */
  }
  page.pickGoal(goal);
  page.setData({ constraintText: '每次不超过45分钟，每周3段，听力最弱' });
  wx.cloud.callFunction = (options) => {
    const name = options === null || options === undefined ? '' : options.name;
    if (name === 'timetable') {
      return Promise.resolve({ result: { ok: true, courses: [], semester: '', updatedAt: '', count: 0, settings: null } });
    }
    return Promise.resolve({
      result: {
        ok: false,
        failureClass: 'model_unavailable',
        message: '这次没能把情况整理成约束，稍后再试，或直接用基础规则排程。',
        detail: '',
        text: '',
        safety: null,
        warnings: [],
        citations: [],
        capWarning: '',
        advancement: null,
      },
    });
  };
  page.understandAi();
  return { started: true };
}

/**
 * 场景表。expect 里每一项都要在页面 data 的 JSON 里出现；
 * 页面 data 里没有的纯静态文案（写在 WXML 里的句子）用 wxmlExpect 走文件内容核对。
 */
function scenarios() {
  return [
    {
      name: '12-goals',
      route: '/pages/goals/index',
      seed: GOALS_SEED,
      expect: ['英语考试'],
      wxmlExpect: ['每个目标', '天后', '未到期', '今天', '已过期'],
    },
    {
      name: '55-goals-empty',
      route: '/pages/goals/index',
      seed: '[]',
      expect: ['hasGoals'],
      wxmlExpect: ['下一个目标', '新建目标日'],
    },
    {
      name: '13-goal-edit',
      route: '/pages/goals/edit/index',
      wxmlExpect: ['目标名称', '目标日期', '保存目标日'],
    },
    {
      name: '54-goal-delete',
      route: '/pages/goals/edit/index?id=exam',
      seed: GOALS_SEED,
      wxmlExpect: ['删除目标日'],
    },
    {
      name: '14-plan-input',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      wxmlExpect: ['说说情况', '核对约束', '预览计划'],
    },
    {
      name: '49-basic-rules',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'rules'] },
      expectScreen: 'rules',
      expect: ['ruleMinuteOptions'],
      wxmlExpect: ['基础规则', '每周安排次数'],
    },
    {
      name: '15-ai-draft',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planDraft, args: [PLAN_GOAL] },
      evaluateSleep: 2500,
      expectScreen: 'draft',
      // heroTitle（“这是你的意思吗”）在 data 里，WXML 只能核静态文案。
      expect: ['aiDraftReady', '"aiDraftReady":true'],
      wxmlExpect: ['识别到的约束', 'AI 草稿', '确认后才生成预览'],
    },
    {
      name: '16-preview',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'preview'] },
      expectScreen: 'preview',
      minBlocks: 1,
      expect: ['预览计划', '总学习时长', '这样安排'],
      wxmlExpect: ['已检查已知课程与不可用时段'],
    },
    {
      name: '17-saved',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'saved'] },
      expectScreen: 'saved',
      minBlocks: 1,
      expect: ['按保存时的课表检查'],
      wxmlExpect: ['离线可查看', '这份计划的依据'],
    },
    {
      name: '18-conflict',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'conflict'] },
      expectScreen: 'conflict',
      minBlocks: 1,
      expect: ['conflictItems'],
      wxmlExpect: ['没有自动改动', '请核对后决定是否重新生成'],
    },
    {
      name: '40-expired-plan',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'expired'] },
      expectScreen: 'expired',
      minBlocks: 1,
      // 「历史记录」是 WXML 里的三元表达式分支文本，不在 data 里。
      wxmlExpect: ['历史记录', '只供回看', '选择一个有效目标'],
    },
    {
      name: '64-constraint-clarify',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planAdvance, args: [PLAN_GOAL, 'clarify'] },
      expectScreen: 'clarify',
      expect: ['clarifyQuote'],
      wxmlExpect: ['不会悄悄忽略限制', '返回修改这句话'],
    },
    {
      name: '25-calendar',
      route: '/pages/calendar/index',
      wxmlExpect: ['校历与考试', '以本校通知为准'],
    },
    {
      name: '26-fitness',
      route: '/pages/fitness/index',
      wxmlExpect: ['缺项就留空', '不上传、不保存'],
    },
    {
      name: '27-fitness-result',
      route: '/pages/fitness/index',
      data: { sex: 'male', band: 'freshman', form: FITNESS_FULL },
      action: 'calculate',
      expect: ['total'],
      wxmlExpect: ['估算'],
    },
    {
      name: '63-fitness-missing',
      route: '/pages/fitness/index',
      data: { sex: 'male', band: 'freshman', form: FITNESS_MISSING },
      action: 'calculate',
      expect: ['items', 'total'],
      wxmlExpect: ['未填'],
    },
    {
      name: '28-advancement',
      route: '/pages/advancement/index',
      wxmlExpect: ['依据', '原文'],
    },
    {
      name: '30-answer',
      route: '/pages/advancement/index',
      evaluate: { fn: advancementAnswer, args: [] },
      evaluateSleep: 3500,
      // 答案卡在首屏之下：不滚动就只能截到引言与示例。
      scrollTo: 640,
      expect: ['"modelPhase":"ready"', '"hasResult":true'],
      wxmlExpect: ['对应原文', 'AI 解释'],
    },
    {
      name: '29-clarify',
      route: '/pages/advancement/index',
      evaluate: { fn: advancementClarify, args: [] },
      // 澄清卡在输入框与示例按钮之下，首屏只有引言；滚到结果区才截得到。
      scrollTo: 700,
      expect: ['"behavior":"clarify"'],
      wxmlExpect: ['需要先确认范围'],
    },
    {
      name: '31-defense',
      route: '/pages/defense/index',
      wxmlExpect: ['练习'],
    },
    {
      name: '32-practice',
      route: '/pages/defense/index',
      start: 'onBegin',
      wxmlExpect: ['你的回答'],
    },
    {
      name: '33-pending',
      route: '/pages/defense/index',
      evaluate: { fn: defensePending, args: [] },
      expect: ['"phase":"pending"'],
      wxmlExpect: ['正在生成反馈', '停止等待，保留回答'],
    },
    {
      name: '34-feedback',
      route: '/pages/defense/index',
      steps: defenseSteps(1),
      expect: ['"phase":"feedback"'],
      wxmlExpect: ['这一轮，反馈已返回', '依据材料'],
    },
    {
      name: '35-recap',
      route: '/pages/defense/index',
      steps: defenseSteps(3),
      expect: ['"phase":"review"'],
      wxmlExpect: ['这次，说得更有依据了', '三轮练习结束'],
    },
    {
      name: '42-material',
      route: '/pages/defense/index',
      evaluate: { fn: defenseMaterial, args: [] },
      expect: ['"materialOpen":true'],
      wxmlExpect: ['材料'],
    },
    {
      name: '60-reanswer',
      route: '/pages/defense/index',
      steps: defenseSteps(3),
      action: 'onStartReanswer',
      expect: ['"phase":"reanswer"'],
      wxmlExpect: ['把验证方法也讲出来', '本次仅一次'],
    },
    {
      name: '61-reanswer-result',
      route: '/pages/defense/index',
      steps: [...defenseSteps(3), { evaluate: { fn: defenseStartReanswer, args: [] }, sleep: 500 }, { evaluate: { fn: defenseSubmitReanswer, args: [] }, sleep: 1200 }],
      expect: ['"phase":"done"'],
      wxmlExpect: ['这次练习完成了', '重答后的反馈'],
    },
    {
      name: '43-ai-unavailable',
      route: '/pages/goals/plan/index',
      seed: GOALS_SEED,
      evaluate: { fn: planUnavailable, args: [PLAN_GOAL] },
      evaluateSleep: 2500,
      expectScreen: 'unavailable',
      expect: ['"aiOutcome":"unavailable"'],
      wxmlExpect: ['已保留的情况', '不会自动重复请求'],
    },
    {
      name: '77-practice-record',
      route: '/pages/defense/index',
      steps: defenseSteps(3),
      action: 'onOpenRecord',
      // recordView 必须是真内容：三轮都齐、empty 为 false。
      expect: ['"empty":false'],
      wxmlExpect: ['把这次练习带走', '本次练习记录'],
    },
    {
      name: '78-copied-record',
      route: '/pages/defense/index',
      steps: defenseSteps(3),
      action: 'onCopyReview',
      hideToast: true,
      wxmlExpect: ['已复制当前记录'],
    },
    {
      // 62 是系统弹窗（wx.showModal），放在最后：弹窗不点掉会影响后面的场景。
      name: '62-exit',
      route: '/pages/defense/index',
      steps: defenseSteps(3),
      action: 'onExit',
      expect: ['"phase":"review"'],
    },
  ];
}

/** 从 WXML 源文件里核对静态文案，避免依赖渲染树取文本。 */
function wxmlText(route) {
  // route 可能带查询串（?id=exam），去掉后再拼文件路径。
  const clean = route.split('?')[0].replace(/^\//, '');
  const file = path.join(ROOT, 'miniprogram', `${clean}.wxml`);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 证据图最小宽度：低于这个值说明 IDE 窗口没放大，模拟器面板被压成了缩略图。 */
const MIN_SHOT_WIDTH = 300;

/** 读 PNG 头里的宽高，用于截图尺寸自检（避免 149x321 的缩略图混进证据目录）。 */
function pngSize(file) {
  try {
    const head = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 };
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 端口是否已经在 listen（自动化会话活着）。 */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** IDE 项目名：必须与 A（wx-match）、B 区分开，否则按标题找窗口会放大别人的 IDE。 */
const PROJECT_NAME = 'wx-match-c';

/** 把 dist 复制到独立项目目录。必须每次全新复制：IDE 会缓存编译产物，共用目录会串味。 */
function syncProject(project) {
  const scratch = path.resolve(ROOT, '.scratch');
  const relative = path.relative(scratch, path.resolve(project));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('截图项目必须位于本仓库 .scratch 内');
  fs.rmSync(project, { recursive: true, force: true });
  fs.cpSync(DIST, project, { recursive: true });
  for (const name of ['project.config.json', 'project.private.config.json']) {
    const from = path.join(DIST, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(project, name));
  }
  // 改 projectname：只有 C 的窗口叫 wx-match-c，放大窗口时不会误伤 A/B。
  const configFile = path.join(project, 'project.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.projectname = PROJECT_NAME;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

/**
 * 放大 IDE 项目窗口，否则截图只有 149x321 那种缩略尺寸。
 * 关键：窗口可能被最小化（rect -32000,-32000,160x28）。此时 simulate 面板停在极小的默认尺寸，
 * 且 MoveWindow 对最小化窗口无效 —— 必须先 ShowWindow(SW_RESTORE) 还原再改几何。
 * 窗口标题取自打开项目时的 projectname；本 worktree 实际出现过 `wx-match` 与 `wx-match-c` 两种，
 * 所以先精确匹配 PROJECT_NAME，找不到再退回 `^wx-match` 前缀（本机只有本 worktree 的项目窗口）。
 */
function resizeWindow() {
  const script = path.join(ROOT, 'scripts', 'lib', 'ui-capture-window.ps1');
  if (!fs.existsSync(script)) return;
  // 用 powershell.exe：本机 PATH 里没有 pwsh（spawnSync pwsh ENOENT）。
  const shell = process.env.WECHAT_PS_SHELL || 'powershell';
  const call = (extra) => {
    const out = execFileSync(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Action',
        'prepare',
        '-Width',
        String(WINDOW.width),
        '-Height',
        String(WINDOW.height),
        ...extra,
      ],
      { stdio: 'pipe', timeout: 30000, encoding: 'utf8' },
    );
    return String(out).trim();
  };
  let out = '';
  let matched = '';
  try {
    out = call(['-Title', PROJECT_NAME]);
    matched = PROJECT_NAME;
  } catch (first) {
    try {
      out = call(['-Title', '', '-Matches', '^wx-match']);
      matched = '^wx-match';
    } catch (second) {
      const error = second || first;
      const detail = error && error.stderr ? String(error.stderr).trim().split('\n')[0] : error.message;
      console.log(`[capture] 窗口放大失败（继续，截图可能偏小）：${detail}`);
      return;
    }
  }
  console.log(`[capture] 窗口已放大到 ${WINDOW.width}x${WINDOW.height}（匹配 ${matched}，原 ${out}）`);
}

/**
 * 保证自动化会话在线。
 * 关键 1：`cli auto` 必须用分离进程启动。前台 `& cli.bat auto` 一返回端口就被回收（TimeWait），
 * 之后 connectMini 必然 Failed connecting。
 * 关键 2：**每次都要换新项目目录**。IDE 按 project 路径缓存编译产物，复用同名目录会一直跑旧代码
 * （曾经出现：源码已改、截出来还是旧界面）。所以按 dist 指纹派生目录名，内容变了就换新目录。
 */
function projectDir() {
  const hash = crypto.createHash('sha1').update(fingerprint()).digest('hex').slice(0, 10);
  return path.join(ROOT, '.scratch', `capture-project-${hash}`);
}

function fingerprint() {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      parts.push(`${path.relative(DIST, full)}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(DIST);
  return parts.join('\n');
}

/** IDE 里当前打开的项目路径记录：换项目前要先 close，否则 IDE 仍跑旧代码。 */
const CURRENT_FILE = path.join(ROOT, '.scratch', 'capture-current-project.txt');

function currentProject() {
  try {
    return fs.readFileSync(CURRENT_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function rememberProject(project) {
  fs.writeFileSync(CURRENT_FILE, project, 'utf8');
}

function closeProject(project) {
  if (project === '' || !fs.existsSync(project)) return;
  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', CLI, 'close', '--project', project], {
      stdio: 'pipe',
      timeout: 30000,
      windowsHide: true,
    });
    console.log(`[capture] 已关闭旧项目 ${path.basename(project)}`);
  } catch (error) {
    console.log(`[capture] 关闭旧项目失败（继续）：${error.message.split('\n')[0]}`);
  }
}

async function ensureAutomation() {
  const portAlready = await portOpen(PORT);
  const project = projectDir();
  const projectConfig = path.join(project, 'project.config.json');
  if (portAlready && fs.existsSync(projectConfig) && currentProject() === project) {
    console.log(`[capture] 复用已在监听的自动化端口 ${PORT}（项目 ${path.basename(project)}）`);
    resizeWindow();
    return;
  }
  if (portAlready) {
    console.log(`[capture] 端口 ${PORT} 在线但项目不是当前 dist 指纹，重开项目`);
    closeProject(currentProject());
    await sleep(1500);
  }
  syncProject(project);
  console.log(`[capture] 启动自动化会话，端口 ${PORT}，项目 ${path.basename(project)}`);
  // .bat 不能直接 spawn（Windows 上会 EINVAL），必须经 cmd.exe /c 启动。
  const comspec = process.env.ComSpec || 'cmd.exe';
  const child = spawn(
    comspec,
    ['/c', CLI, 'auto', '--project', project, '--auto-port', String(PORT), '--trust-project'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (await portOpen(PORT)) {
      rememberProject(project);
      await sleep(4000);
      resizeWindow();
      return;
    }
  }
  throw new Error(
    `自动化端口 ${PORT} 在 120s 内没有起来。手动排查：\n` +
      `  "${CLI}" auto --project "${project}" --auto-port ${PORT} --trust-project\n` +
      `若报 401 / access token，说明 IDE 的 CLI 访问令牌校验被重新打开了（见 .scratch/NATIVE-CAPTURE-NOTES.md）。`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.out === '' ? '' : path.resolve(ROOT, options.out);
  if (!options.check && outDir !== '') ensureDir(outDir);

  if (!fs.existsSync(path.join(DIST, 'app.json'))) {
    console.error('[capture] dist/ 尚未构建：先跑 node scripts/ui-v2-c-run.cjs');
    return 2;
  }

  process.env.WECHAT_AUTO_PORT = PORT;
  try {
    if (!options.useSession) await ensureAutomation();
  } catch (error) {
    console.error(`[capture] ${error && error.message ? error.message : error}`);
    return 2;
  }

  const { connectMini } = require('./lib/mini-connect.cjs');
  let mini;
  try {
    mini = await connectMini(PORT);
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    console.error(`\n[capture] 自动化会话在线但连接失败，通常是页面栈为空；先 reLaunch 一次再试。`);
    return 2;
  }

  const results = [];
  try {
    await mini.evaluate(installOfflineUiSession);
    const all = scenarios();
    const list = options.only === null ? all : all.filter((item) => options.only.includes(item.name));
    if (list.length === 0) {
      console.error(`[capture] --only 没匹配到场景：${options.only.join(',')}`);
      return 2;
    }
    for (const scene of list) {
      const record = { name: scene.name, route: scene.route, ok: false, missing: [], error: '' };
      try {
        if (scene.seed !== undefined) {
          await mini.callWxMethod('setStorageSync', 'goal-days/v1', scene.seed);
        }
        const page = await mini.reLaunch(scene.route);
        await sleep(700);
        if (scene.start !== undefined) {
          await page.callMethod(scene.start);
          await sleep(600);
        }
        // calls：需要带参数的方法调用（计划页的 pickGoal/showPlan 都吃参数）。
        for (const call of scene.calls || []) {
          await page.callMethod(call.method, ...(call.args || []));
          await sleep(call.wait === undefined ? 700 : call.wait);
        }
        // steps：需要多轮 async 落地的场景（答辩三轮作答，每轮之间要回宿主侧让微任务跑完）。
        for (const step of scene.steps || []) {
          if (step.evaluate !== undefined) {
            await mini.evaluate(step.evaluate.fn, ...(step.evaluate.args || []));
          }
          if (step.action !== undefined) {
            await page.callMethod(step.action, ...(step.args || []));
          }
          if (step.data !== undefined) {
            await page.setData(step.data);
          }
          await sleep(step.sleep === undefined ? 500 : step.sleep);
        }
        // evaluate：在 App 上下文里调用页面方法推进状态（计划页必须走这条，见 planAdvance 注释）。
        let advanced = null;
        if (scene.evaluate !== undefined) {
          advanced = await mini.evaluate(scene.evaluate.fn, ...(scene.evaluate.args || []));
          await sleep(scene.evaluateSleep === undefined ? 900 : scene.evaluateSleep);
        }
        if (scene.data !== undefined) {
          await page.setData(scene.data);
          await sleep(300);
        }
        if (scene.action !== undefined) {
          await page.callMethod(scene.action);
          await sleep(500);
        }
        // hideToast：复制/保存成功会弹 toast，2 秒内盖住证据图，截图前主动收掉。
        if (scene.hideToast === true) {
          await mini.evaluate(function hideToastForShot() {
            try {
              wx.hideToast();
            } catch (error) {
              /* 模拟器没有 toast 时无须处理 */
            }
          });
          await sleep(300);
        }
        // 页面自己会在生成后滚动到结果卡片（`scrollToResult`）；证据图要的是首屏，先回到顶部。
        // 内容真的在首屏之下时（升学答案卡）用 scene.scrollTo 指定位置，
        // 否则截到的是首屏的说明文字。
        if (scene.scrollTo !== undefined) {
          await mini.pageScrollTo(scene.scrollTo).catch(() => {});
          await sleep(600);
        } else if (scene.scrollTop !== false) {
          await mini.pageScrollTo(0).catch(() => {});
          await sleep(400);
        }
        if (!options.check && outDir !== '') {
          const file = path.join(outDir, `${scene.name}.png`);
          await mini.screenshot({ path: file });
          record.file = path.relative(ROOT, file).replace(/\\/g, '/');
          // 尺寸自检：IDE 窗口被最小化时截图只有 149x321，肉眼很难一眼看出，
          // 但证据图必须够大才能核 390px 布局。小于 300 宽直接记成失败。
          const size = pngSize(file);
          record.size = size;
          if (size.width < MIN_SHOT_WIDTH) {
            record.missing.push(`size:${size.width}x${size.height}（< ${MIN_SHOT_WIDTH} 宽，模拟器窗口太小）`);
          }
        }
        const snapshot = await page.data();
        const flat = JSON.stringify(snapshot);
        const source = wxmlText(scene.route);
        // 状态断言：screen 是推导字段，截出来的屏必须真的是那一屏，不能只看文案。
        if (scene.expectScreen !== undefined && snapshot.screen !== scene.expectScreen) {
          record.missing.push(`screen:${scene.expectScreen}（实际 ${snapshot.screen}）`);
        }
        if (scene.minBlocks !== undefined) {
          const blocks = snapshot.plan === null || snapshot.plan === undefined ? 0 : snapshot.plan.blocks.length;
          if (!(blocks >= scene.minBlocks)) record.missing.push(`blocks:>=${scene.minBlocks}（实际 ${blocks}）`);
        }
        if (advanced !== null && advanced !== undefined) record.advanced = advanced;
        for (const needle of scene.expect || []) {
          if (!flat.includes(needle)) record.missing.push(`data:${needle}`);
        }
        for (const needle of scene.wxmlExpect || []) {
          if (!source.includes(needle)) record.missing.push(`wxml:${needle}`);
        }
        record.ok = record.missing.length === 0;
        console.log(
          `[capture] ${record.ok ? 'ok  ' : '缺文'} ${scene.name}` +
            (record.ok ? (record.file === undefined ? '' : ` → ${record.file}`) : ` 缺：${record.missing.join('、')}`),
        );
      } catch (error) {
        record.error = error && error.message ? error.message : String(error);
        console.log(`[capture] 失败 ${scene.name}：${record.error}`);
      }
      results.push(record);
    }
  } finally {
    // 先卸载尚在等待的练习页，再恢复平台方法；全部种子始终只在内存。
    await mini.reLaunch('/pages/campus/index').catch(() => {});
    await mini.evaluate(restoreOfflineUiSession).catch(() => {});
    if (options.useSession) mini.disconnect();
    else await mini.close().catch(() => {});
  }

  const report = {
    capturedAt: new Date().toISOString(),
    port: PORT,
    width: options.width,
    mode: options.check ? 'check' : 'capture',
    dist: path.relative(ROOT, DIST).replace(/\\/g, '/'),
    results,
  };
  const reportDir = outDir === '' ? path.join(ROOT, '.scratch') : outDir;
  ensureDir(reportDir);
  const reportPath = path.join(reportDir, 'capture-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const failed = results.filter((item) => !item.ok);
  console.log(
    `[capture] ${results.length - failed.length}/${results.length} 场景通过；报告 ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`,
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[capture] ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
