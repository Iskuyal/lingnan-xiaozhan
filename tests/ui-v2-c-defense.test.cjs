/**
 * C 分支：项目讲解练习页（设计 31–35、42、56–62、77/78）。
 *
 * 重点守 77/78 的复制记录闭环：复制的内容必须是**当前会话真实已有**的东西——
 * 每轮的问题、原答、已返回的反馈，三轮复盘，以及用过重答时的重答段；
 * 原答逐字照抄，未返回反馈的轮次不出现，空会话不写空剪贴板，复制失败不清会话。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const defense = require('../dist/services/defense/index.js');

const FEEDBACKS = [
  '【引用核对】成立 F1\n【是否对应回答】说清了对象和做法\n【待验证保留】F8 三项未保留\n【追问】请补条目编号',
  '【引用核对】成立 F2\n【是否对应回答】讲了关键环节\n【待验证保留】D3 未测试\n【追问】请说明放弃的做法',
  '【引用核对】成立 F3\n【是否对应回答】边界表达清楚\n【待验证保留】F6 尚未验证\n【追问】请把验证方法讲出来',
];

const ANSWERS = [
  '课表是学生自己从教务系统下载后导入的，不把教务账号密码交给第三方。',
  '关键环节是先解析再逐项核对，放弃的做法是直接整表覆盖，因为改错后无法回退。',
  '验证过的是单份课表导入与课表周视图，未验证的是跨学期导入与冲突合并。',
];

/** 用真实状态机把会话推进到「第 n 轮已拿到反馈」。 */
function sessionWithRounds(rounds) {
  let session = defense.createSession('FC-1');
  for (let index = 0; index < rounds; index += 1) {
    session = defense.submitAnswer(session, ANSWERS[index]);
    session = defense.recordFeedback(session, FEEDBACKS[index]).session;
    if (index < rounds - 1) session = defense.advanceRound(session);
  }
  return session;
}

/** 三轮完成 → 复盘 → 重答并拿到反馈。 */
function sessionWithReanswer() {
  let session = sessionWithRounds(3);
  session = defense.startReanswer(session);
  session = defense.submitAnswer(session, '重答：验证方法是先在真机上跑一遍单周导入，再对照教务系统逐项核对，未验证的跨学期导入不写成已完成。');
  session = defense.recordFeedback(session, '【引用核对】成立 F3、F6\n【是否对应回答】补上了验证方法\n【待验证保留】跨学期导入仍未验证\n【追问】无').session;
  return session;
}

function loadPage() {
  let options;
  const calls = { cloud: 0, clipboard: 0, storage: 0, toasts: [], modal: 0, navigateBack: 0 };
  global.Page = (value) => { options = value; };
  global.wx = {
    cloud: { callFunction() { calls.cloud += 1; return Promise.resolve({ result: {} }); } },
    showToast(payload) { calls.toasts.push(payload && payload.title); },
    // 「复制不等于自动保存」：任何本地/云端写入都应被这两类桩记录下来。
    setStorageSync() { calls.storage += 1; },
    setStorage() { calls.storage += 1; },
    showModal(payload) { calls.modal += 1; if (payload && payload.success) payload.success({ confirm: true }); },
    navigateBack() { calls.navigateBack += 1; },
  };
  delete require.cache[require.resolve('../dist/pages/defense/index.js')];
  const mod = require('../dist/pages/defense/index.js');
  const instance = {
    ...options,
    data: JSON.parse(JSON.stringify(options.data)),
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); },
  };
  instance.onLoad();
  return { instance, calls, mod };
}

/**
 * 页面级：把会话灌进实例（等价于用户真的走过这些回合），再走 77 → 复制。
 * 返回剪贴板收到的文本。
 */
function copyThrough(instance, session, options = {}) {
  let copied = '';
  let clipboardCalls = 0;
  global.wx.setClipboardData = (payload) => {
    clipboardCalls += 1;
    if (options.fail === true) {
      payload.fail?.({ errMsg: 'setClipboardData:fail mocked' });
      return;
    }
    copied = payload.data;
    payload.success?.(payload);
  };
  instance.session = session;
  instance.data.materialName = '课表导入与校对';
  instance.onOpenRecord();
  instance.onCopyReview();
  return { copied, clipboardCalls };
}

// ---------------------------------------------------------------- 纯函数：视图与文本

test('空会话：记录视图为空，文本为空串（页面据此提示无内容，不写空剪贴板）', () => {
  const { mod } = loadPage();
  const view = mod.buildRecordView({ materialName: '课表导入与校对', session: defense.resetSession(), reviewRows: [] });
  assert.equal(view.empty, true);
  assert.deepEqual(view.rounds, []);
  assert.equal(view.reanswer, null);
  assert.equal(mod.practiceRecordText(view), '');
});

test('三轮完成后：记录逐轮包含问题、原答、反馈，且原答与反馈分开标注', () => {
  const { mod } = loadPage();
  const view = mod.buildRecordView({
    materialName: '课表导入与校对',
    session: sessionWithRounds(3),
    reviewRows: [],
  });
  assert.equal(view.empty, false);
  assert.equal(view.rounds.length, 3);
  const text = mod.practiceRecordText(view);

  for (const round of [1, 2, 3]) {
    const dimension = defense.questionFor(round).dimension;
    const question = defense.questionFor(round).text;
    assert.ok(text.includes(`第 ${round} 轮 · ${dimension} · 原答`), `缺少第 ${round} 轮的段头`);
    assert.ok(text.includes(`问题：${question}`), `缺少第 ${round} 轮的问题`);
    // 原答与反馈各自独立成段，先「你的回答」后「材料反馈」，顺序不可颠倒。
    const answerAt = text.indexOf(`你的回答：\n${ANSWERS[round - 1]}`);
    const feedbackAt = text.indexOf(`材料反馈：\n${FEEDBACKS[round - 1]}`);
    assert.ok(answerAt > 0, `第 ${round} 轮原答未逐字出现`);
    assert.ok(feedbackAt > answerAt, `第 ${round} 轮反馈应独立跟随在原答之后`);
  }
});

test('未返回反馈的轮次不出现在记录里，也不补写下一轮问题', () => {
  const { mod } = loadPage();
  // 只完成第 1 轮，第 2/3 轮的问题即使已知也不得写进记录。
  const view = mod.buildRecordView({ materialName: '课表导入与校对', session: sessionWithRounds(1), reviewRows: [] });
  assert.equal(view.rounds.length, 1);
  const text = mod.practiceRecordText(view);
  assert.ok(text.includes(ANSWERS[0]));
  assert.equal(text.includes(ANSWERS[1]), false);
  assert.equal(text.includes(defense.questionFor(2).text), false);
  assert.equal(text.includes(defense.questionFor(3).text), false);
});

test('申请中（有回答、反馈未回）的轮次同样不算完成', () => {
  const { mod } = loadPage();
  let session = sessionWithRounds(1);
  session = defense.advanceRound(session);
  session = defense.submitAnswer(session, ANSWERS[1]); // 停在 pending：answ 有、feedback 还没有
  const text = mod.practiceRecordText(mod.buildRecordView({ materialName: '课表导入与校对', session, reviewRows: [] }));
  assert.ok(text.includes(ANSWERS[0]));
  assert.equal(text.includes(ANSWERS[1]), false, '未返回反馈的回答不得写进记录');
  assert.equal(text.includes(defense.questionFor(2).text), false);
});

test('重答后记录包含重答段，标明沿用第 3 轮问题，并保留重答原答与反馈', () => {
  const { mod } = loadPage();
  const session = sessionWithReanswer();
  const view = mod.buildRecordView({ materialName: '课表导入与校对', session, reviewRows: [] });
  assert.notEqual(view.reanswer, null);
  assert.equal(view.rounds.length, 3);
  const text = mod.practiceRecordText(view);
  const reanswerText = session.answers.find(item => item.round === 4).text;
  const reanswerFeedback = session.feedbacks.find(item => item.round === 4).text;
  assert.ok(text.includes('重答 · 沿用第 3 轮问题'));
  assert.ok(text.includes(`你的重答：\n${reanswerText}`));
  assert.ok(text.includes(`重答反馈：\n${reanswerFeedback}`));
  // 重答不能顶掉三轮本身
  assert.ok(text.includes(`第 3 轮 · ${defense.questionFor(3).dimension} · 原答`));
});

test('原答逐字进入记录：换行、空白与标点都不被改写或截断', () => {
  const { mod } = loadPage();
  const verbatim = '第一行：确认前不写入。\n\n  第二行带两个前导空格，和「引号」。\nF8 三项未保留，不改写。';
  let session = defense.createSession('FC-1');
  session = defense.submitAnswer(session, verbatim);
  session = defense.recordFeedback(session, FEEDBACKS[0]).session;
  const text = mod.practiceRecordText(mod.buildRecordView({ materialName: '课表导入与校对', session, reviewRows: [] }));
  assert.ok(text.includes(verbatim), '原答必须逐字出现，包括换行与空格');
});

test('复盘行只纳入有反馈的行，未完成的结果不臆造', () => {
  const { mod } = loadPage();
  const reviewRows = [
    { dimension: '问题与目标', status: '已反馈', summary: '说清了对象', basis: '成立 F1', followup: '请补编号', excerpt: 'F8 三项' },
    { dimension: '方案及取舍', status: '未完成', summary: '', basis: '', followup: '', excerpt: '' },
    { dimension: '验证与限制', status: '已反馈', summary: '边界清楚', basis: '成立 F3', followup: '请补方法', excerpt: '' },
  ];
  const text = mod.practiceRecordText(mod.buildRecordView({ materialName: '课表导入与校对', session: defense.resetSession(), reviewRows }));
  assert.ok(text.includes('三轮复盘'));
  assert.ok(text.includes('对应回答：说清了对象'));
  assert.equal(text.includes('方案及取舍'), false, '没有反馈的复盘行不应出现');
  assert.ok(text.includes('01 问题与目标：已反馈'));
  assert.ok(text.includes('02 验证与限制：已反馈'), '编号按纳入顺序连续');
});

// ---------------------------------------------------------------- 页面：复制与失败

test('页面：空会话复制只说明没有内容，不写剪贴板、不清会话', () => {
  const { instance } = loadPage();
  const before = JSON.stringify(instance.session);
  let clipboardCalls = 0;
  global.wx.setClipboardData = () => { clipboardCalls += 1; };
  instance.onOpenRecord();
  instance.onCopyReview();
  assert.equal(clipboardCalls, 0, '空会话不得调用 setClipboardData');
  assert.ok(instance.data.copyHint.includes('没有可复制的内容'));
  assert.equal(JSON.stringify(instance.session), before);
  assert.equal(instance.data.copiedOpen, false);
});

test('页面：三轮完成后复制到剪贴板，内容含每轮原答与反馈并进入 78 已复制态', () => {
  const { instance, calls } = loadPage();
  const session = sessionWithRounds(3);
  const { copied, clipboardCalls } = copyThrough(instance, session);
  assert.equal(clipboardCalls, 1);
  for (const round of [1, 2, 3]) {
    // 剪贴板里的原答必须与 session 里的原答**逐字相等**，不是近似包含。
    const verbatim = session.answers.find(item => item.round === round).text;
    assert.ok(copied.includes(`你的回答：\n${verbatim}`), `第 ${round} 轮原答在剪贴板里必须逐字保留`);
    assert.ok(copied.includes(FEEDBACKS[round - 1].split('\n')[0]));
  }
  assert.equal(instance.data.copiedOpen, true);
  assert.equal(instance.data.recordOpen, false);
  // 「复制不等于自动保存」：既不写本地存储，也不调用云端。
  assert.equal(calls.cloud, 0, '复制只读本页内存，不调用云端');
  assert.equal(calls.storage, 0, '复制不得写任何本地存储');
});

test('页面：复制失败时给出失败说明且不清空会话，可以再试一次', () => {
  const { instance, calls } = loadPage();
  const session = sessionWithRounds(2);
  const before = JSON.stringify(session);
  const { clipboardCalls } = copyThrough(instance, session, { fail: true });
  assert.equal(clipboardCalls, 1, '失败路径仍要真的尝试写剪贴板');
  assert.ok(instance.data.copyHint.includes('复制没有成功'));
  assert.equal(instance.data.copiedOpen, false);
  assert.equal(JSON.stringify(instance.session), before, '复制失败不得清空会话');
  assert.equal(instance.session.answers.length, 2);
  assert.equal(instance.session.feedbacks.length, 2);
  assert.equal(calls.cloud, 0);
  assert.equal(calls.storage, 0);

  // 同一会话再试一次成功：内容仍是这两轮
  const retry = copyThrough(instance, instance.session);
  assert.ok(retry.copied.includes(ANSWERS[0]));
  assert.ok(retry.copied.includes(ANSWERS[1]));
});

test('页面：78「继续留在练习中」只关已复制态，会话与草稿都还在', () => {
  const { instance, calls } = loadPage();
  const session = sessionWithRounds(1);
  copyThrough(instance, session);
  assert.equal(instance.data.copiedOpen, true);
  instance.onCloseCopied();
  assert.equal(instance.data.copiedOpen, false);
  assert.equal(instance.session.answers.length, 1, '「继续留在练习中」不得丢会话');
  assert.equal(instance.session.feedbacks.length, 1);
  assert.equal(calls.modal, 0, '返回练习不弹退出确认');
  assert.equal(calls.navigateBack, 0);
});

test('页面：退出确认后才清空会话并返回，取消则原样留下', () => {
  const { instance, calls } = loadPage();
  instance.session = sessionWithRounds(2);
  instance.data.phase = 'review';
  instance.data.recordOpen = true;

  // 先模拟用户取消：会话必须原样保留。
  let captured = null;
  global.wx.showModal = (payload) => { captured = payload; calls.modal += 1; payload.success?.({ confirm: false }); };
  instance.onExit();
  assert.equal(calls.modal, 1);
  assert.ok(captured.content.includes('清空'), '退出前必须说明会清空');
  assert.equal(instance.session.answers.length, 2, '取消退出不得清会话');
  assert.equal(calls.navigateBack, 0);

  // 再确认：会话清空、返回上一页。
  global.wx.showModal = (payload) => { calls.modal += 1; payload.success?.({ confirm: true }); };
  instance.onExit();
  assert.equal(instance.session.answers.length, 0, '确认退出后会话清空');
  assert.equal(instance.session.feedbacks.length, 0);
  assert.equal(instance.data.recordOpen, false);
  assert.equal(calls.navigateBack, 1);
});

test('页面：练习记录页可直接打开且不触发任何云端请求', () => {
  const { instance, calls } = loadPage();
  const session = sessionWithReanswer();
  instance.session = session;
  instance.data.materialName = '课表导入与校对';
  instance.onOpenRecord();
  assert.equal(instance.data.recordOpen, true);
  assert.equal(instance.data.recordView.rounds.length, 3);
  assert.notEqual(instance.data.recordView.reanswer, null);
  assert.equal(calls.cloud, 0);
  instance.onCloseRecord();
  assert.equal(instance.data.recordOpen, false);
  assert.equal(instance.session.answers.length, 4, '关闭记录页不得改动会话');
});

test('wxml：77/78 的入口与 78 的边界说明都在页面里', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/defense/index.wxml'), 'utf8');
  for (const text of ['复制这份练习记录', '本次练习记录', '你的回答', '材料反馈', '你的重答', '重答反馈', '三轮复盘']) {
    assert.ok(wxml.includes(text), `缺少文案：${text}`);
  }
  assert.ok(wxml.includes('未完成的轮次和未返回的反馈不会补写。'));
  assert.ok(wxml.includes('复制不等于本程序自动保存'));
  assert.ok(wxml.includes('defense-record-copy'));
  // 不得给出能力等级或成绩承诺（与 design 34 的边界一致）
  assert.equal(wxml.includes('可以获得职业能力等级'), false);
  assert.equal(wxml.includes('通过率'), false);
});
