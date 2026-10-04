/**
 * G3 最小纵向实现（Issue #114）的测试。
 *
 * 分四段：
 * A. 材料单一来源：构建生成器读到的正文必须与 G0 冻结件逐字一致，且客户端展示的编号是冻结件编号的超集；
 * B. 客户端契约与状态机（`dist/services/defense/index.js`，纯逻辑）；
 * C. 页面冒烟（`dist/pages/defense/index.js`）：选材料 → 提交 → 四节反馈上屏；四节不齐不上屏；取消保留草稿；
 * D. 注册与入口：app.json / 四件套 / 首页入口跳转。
 *
 * 仓库约定：测试 require **构建产物**（`npm test` 会先 `npm run build`），模板与源码文本用 fs 读源码。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const generator = require('../scripts/lib/generate-defense-materials.cjs');
const defense = require('../dist/services/defense/index.js');

const FROZEN_DIR = path.join(ROOT, 'docs/evidence/project-defense-g0');

function frozenText(file) {
  return fs.readFileSync(path.join(FROZEN_DIR, file), 'utf8').replace(/\r\n/gu, '\n').trim();
}

// ------------------------------------------------------------------ A. 单一来源

test('材料正文逐字取自 G0 冻结件（漂移守卫）', () => {
  const materials = generator.buildDefenseMaterials(ROOT);
  assert.deepEqual(materials.map((item) => item.id), ['FC-1', 'FC-2']);
  for (const material of materials) {
    assert.equal(material.text, frozenText(material.file), `${material.file} 的正文与冻结件不一致`);
    assert.ok(material.text.length > 200, `${material.id} 正文过短，像是没读全`);
  }
});

test('客户端展示的编号是冻结件里全部编号的超集', () => {
  const materials = generator.buildDefenseMaterials(ROOT);
  const pattern = /(?:^|\|)\s*(INV-[A-Z0-9]+|[A-Z]\d+)\s*(?=\||\s)/gmu;
  for (const material of materials) {
    const inFrozen = new Set();
    for (const match of material.text.matchAll(pattern)) inFrozen.add(match[1]);
    assert.ok(inFrozen.size >= 8, `${material.id} 从冻结件里抽到的编号过少：${inFrozen.size}`);
    const summary = defense.materialById(material.id);
    assert.ok(summary !== null, `${material.id} 在客户端摘要里缺失`);
    for (const id of inFrozen) {
      assert.ok(summary.entries.includes(id), `${material.id} 的客户端编号表缺少 ${id}`);
    }
  }
});

test('生成器渲染的模块只导出 DEFENSE_MATERIALS，且是逐字 JSON', () => {
  const materials = generator.buildDefenseMaterials(ROOT);
  const code = generator.renderDefenseMaterialsModule(materials);
  const sandbox = { module: { exports: {} } };
  // 生成物是纯 CJS 字面量，用 Function 求值即可，不需要写文件。
  // eslint-disable-next-line no-new-func
  new Function('module', code)(sandbox.module);
  assert.deepEqual(Object.keys(sandbox.module.exports), ['DEFENSE_MATERIALS']);
  assert.equal(sandbox.module.exports.DEFENSE_MATERIALS[0].text, frozenText('fact-card-1-timetable.md'));
});

// ------------------------------------------------------------------ B. 契约

test('事件形状：只带 materialId，不发 system（服务端自己重建提示词）', () => {
  const event = defense.defenseChatEvent('FC-1', '问题', '回答');
  assert.equal(event.action, 'chat');
  assert.equal(event.feature, 'project-defense');
  assert.equal(event.materialId, 'FC-1');
  assert.equal('system' in event, false);
  assert.equal('material' in event, false);
  assert.deepEqual(event.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.equal(event.messages[1].text, '回答');
});

test('回答字数窗口：空/过短/过长都拦下来（负例）', () => {
  assert.equal(defense.answerProblem('   '), 'empty');
  assert.equal(defense.answerProblem('太短'), 'too-short');
  assert.equal(defense.answerProblem('字'.repeat(defense.DEFENSE_ANSWER_MAX_CHARS + 1)), 'too-long');
  assert.equal(defense.answerProblem('字'.repeat(defense.DEFENSE_ANSWER_MIN_CHARS)), '');
});

test('四节契约：缺一节、顺序错都不算完整反馈（负例）', () => {
  const full = '【引用核对】a\n【是否对应回答】b\n【待验证保留】c\n【追问】d';
  assert.deepEqual(defense.missingSections(full), []);
  assert.equal(defense.completeFeedback(full), true);

  const missingAsk = '【引用核对】a\n【是否对应回答】b\n【待验证保留】c';
  assert.deepEqual(defense.missingSections(missingAsk), ['【追问】']);
  assert.equal(defense.completeFeedback(missingAsk), false);

  const wrongOrder = '【追问】d\n【引用核对】a\n【是否对应回答】b\n【待验证保留】c';
  assert.ok(defense.missingSections(wrongOrder).length > 0);
  assert.equal(defense.completeFeedback(wrongOrder), false);

  assert.equal(defense.completeFeedback('   '), false);
  const sections = defense.parseSections(full);
  assert.deepEqual(sections.map((section) => section.title), defense.DEFENSE_SECTIONS);
  assert.equal(sections[3].body, 'd');
});

test('失败文案按 failureClass 各自独立，且不改全局 AI_MSG_*（负例）', () => {
  const make = (failureClass) => ({ ok: false, failureClass, message: '服务端文案', text: '', capWarning: '', safety: null, warnings: [], citations: [], advancement: null });
  const model = defense.defenseFailureCopy(make('model_unavailable'), '');
  const quota = defense.defenseFailureCopy(make('quota_exhausted'), '');
  const rejected = defense.defenseFailureCopy(make('content_rejected'), '');
  const unverified = defense.defenseFailureCopy(make('citation_unverified'), '');
  const titles = [model.title, quota.title, rejected.title, unverified.title];
  assert.equal(new Set(titles).size, titles.length, '四类标题必须互不相同');
  assert.equal(quota.retryable, false, '额度用尽不应显示成可立即重试');
  assert.equal(model.retryable, true);
  assert.ok(model.body.includes('没有被判定'), '模型不可用时不得写成学生没讲清楚');

  const transport = defense.defenseFailureCopy(null, '网络超时');
  assert.equal(transport.retryable, true);
  assert.ok(transport.body.includes('网络超时'));
});

test('状态机：失败不推进轮次、不产生反馈，也不留上一轮旧结果（负例）', () => {
  let session = defense.createSession('FC-1');
  assert.equal(session.phase, 'practice');
  assert.equal(session.round, 1);

  session = defense.submitAnswer(session, '回答一');
  assert.equal(session.phase, 'pending');
  assert.equal(session.round, 1, '提交不得推进轮次');

  // 四节不齐 → 不上屏、进 failure、不写 feedbacks
  const bad = defense.recordFeedback(session, '只有一节【引用核对】');
  assert.equal(bad.accepted, false);
  assert.equal(bad.session.phase, 'failure');
  assert.equal(bad.session.round, 1);
  assert.equal(bad.session.feedbacks.length, 0);

  // 失败态下拿不到任何反馈
  assert.equal(defense.currentFeedback(bad.session), null);

  // 取消（等待态）→ 回到作答态且保留草稿
  const cancelled = defense.cancelPending(defense.submitAnswer(defense.createSession('FC-1'), '草稿'));
  assert.equal(cancelled.phase, 'practice');
  assert.equal(cancelled.draft, '草稿');
});

test('状态机：三轮 → 复盘 → 重答一次 → 结束；失败后重试不丢已完成轮次', () => {
  const full = (index) => `【引用核对】${index}\n【是否对应回答】b\n【待验证保留】c\n【追问】问${index}`;
  let session = defense.createSession('FC-2');

  for (const round of [1, 2, 3]) {
    session = defense.submitAnswer(session, `第 ${round} 轮回答`);
    const result = defense.recordFeedback(session, full(round));
    assert.equal(result.accepted, true, `第 ${round} 轮四节齐全应当被接受`);
    session = result.session;
    assert.equal(session.answers.length, round);
    if (round < 3) {
      assert.equal(session.phase, 'feedback');
      assert.equal(defense.currentFeedback(session), full(round), '当前轮反馈应当可读');
      session = defense.advanceRound(session);
      assert.equal(session.round, round + 1);
    }
  }
  assert.equal(session.phase, 'review');
  assert.equal(defense.advanceRound(session).round, 3, '复盘态不得再推进轮次');

  session = defense.startReanswer(session);
  assert.equal(session.phase, 'reanswer');
  assert.equal(session.round, defense.DEFENSE_REANSWER_ROUND);
  assert.equal(defense.startReanswer(session), session, '重答只允许一次');

  // 重答这轮失败：轮次与已完成的反馈都要在，且没有可显示的旧结果
  const failed = defense.recordFeedback(defense.submitAnswer(session, '重答内容'), '半截');
  assert.equal(failed.session.phase, 'failure');
  assert.equal(failed.session.feedbacks.length, 3, '失败不得清空已完成的三轮反馈');
  assert.equal(defense.currentFeedback(failed.session), null, '失败态不得显示旧反馈');

  // 重试成功 → 结束
  const done = defense.recordFeedback(defense.submitAnswer(failed.session, '重答内容'), full('重答'));
  assert.equal(done.session.phase, 'done');
  assert.equal(done.session.answers.length, 4);
});

test('resetSession 清空材料选择、回答与反馈（退出即不保存）', () => {
  let session = defense.createSession('FC-1');
  session = defense.recordFeedback(defense.submitAnswer(session, '回答'), '【引用核对】a\n【是否对应回答】b\n【待验证保留】c\n【追问】d').session;
  const reset = defense.resetSession();
  assert.equal(reset.phase, 'materials');
  assert.equal(reset.materialId, '');
  assert.deepEqual(reset.answers, []);
  assert.deepEqual(reset.feedbacks, []);
  assert.deepEqual(session.feedbacks.length, 1, 'reset 不得就地改写旧会话对象');
});

// ------------------------------------------------------------------ C. 页面冒烟

/** 用 global 桩加载编译后的页面，返回可调用的实例。 */
function loadDefensePage(cloudResult) {
  const calls = { cloud: 0, clipboard: 0, modal: 0, navigateBack: 0 };
  let captured = null;
  global.Page = (options) => { captured = options; };
  global.wx = {
    cloud: {
      callFunction() {
        calls.cloud += 1;
        return Promise.resolve({ result: cloudResult });
      },
    },
    setClipboardData(options) { calls.clipboard += 1; if (options && options.success) options.success(); },
    showToast() {},
    showModal(options) { calls.modal += 1; if (options && options.success) options.success({ confirm: true }); },
    navigateBack() { calls.navigateBack += 1; },
  };
  delete require.cache[require.resolve('../dist/pages/defense/index.js')];
  require('../dist/pages/defense/index.js');
  assert.ok(captured !== null, '页面模块应当在加载时调用 Page()');
  const instance = Object.assign({}, captured, {
    data: JSON.parse(JSON.stringify(captured.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
  return { instance, calls };
}

const fullFeedback = '【引用核对】成立 F1\n【是否对应回答】是\n【待验证保留】F8 三项未保留\n【追问】请补条目编号';

test('页面：选材料 → 提交 → 四节反馈上屏；失败态不显示旧结果', async () => {
  const { instance, calls } = loadDefensePage({ ok: true, failureClass: '', message: '', text: fullFeedback, capWarning: '', safety: { checked: true }, warnings: [], citations: [], advancement: null });
  instance.onLoad();
  assert.equal(instance.data.phase, 'materials');

  instance.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
  assert.equal(instance.data.phase, 'practice');
  assert.equal(instance.data.round, 1);
  assert.equal(instance.data.materialEntries.includes('F8'), true);

  // 太短：只提示，不花钱
  instance.onAnswerInput({ detail: { value: '太短' } });
  instance.onSubmit();
  assert.equal(calls.cloud, 0, '字数不足不得发起云调用');
  assert.ok(instance.data.hint.includes('至少'));

  // 正常提交
  instance.onAnswerInput({ detail: { value: '课表是学生自己从教务系统下载后导入的，不用拿教务账号密码。' } });
  instance.onSubmit();
  assert.equal(instance.data.phase, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.cloud, 1);
  assert.equal(instance.data.phase, 'feedback');
  assert.equal(instance.data.sections.length, 4);
  assert.equal(instance.data.ask, '请补条目编号');

  // 四节不齐的返回：不上屏、进失败态，且不显示上一轮内容
  const second = loadDefensePage({ ok: true, failureClass: '', message: '', text: '【引用核对】只有一节', capWarning: '', safety: { checked: true }, warnings: [], citations: [], advancement: null });
  second.instance.onLoad();
  second.instance.onPickMaterial({ currentTarget: { dataset: { id: 'FC-2' } } });
  second.instance.onAnswerInput({ detail: { value: '这是一个打字练习小游戏的设计，状态有三种，计时从第一次键入开始。' } });
  second.instance.onSubmit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(second.instance.data.phase, 'failure');
  assert.deepEqual(second.instance.data.sections, []);
  assert.ok(second.instance.data.failureBody.includes('【'));

  // 取消等待：保留草稿、回到作答态
  const third = loadDefensePage({ ok: true, failureClass: '', message: '', text: fullFeedback, capWarning: '', safety: { checked: true }, warnings: [], citations: [], advancement: null });
  third.instance.onLoad();
  third.instance.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
  third.instance.onAnswerInput({ detail: { value: '课表是学生自己从教务系统下载后导入的，不用拿教务账号密码。' } });
  third.instance.onSubmit();
  third.instance.onCancelPending();
  assert.equal(third.instance.data.phase, 'practice');
  assert.equal(third.instance.data.answer.includes('教务系统'), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(third.instance.data.phase, 'practice', '取消后回来的结果不得上屏');

  // 退出：清空会话并返回
  third.instance.onExit();
  assert.equal(third.calls.modal, 1);
  assert.equal(third.calls.navigateBack, 1);
  delete global.Page;
  delete global.wx;
});

test('页面：失败态保留回答，且额度用尽不显示成可重试', async () => {
  const { instance } = loadDefensePage({ ok: false, failureClass: 'quota_exhausted', message: '额度已用尽', text: '', capWarning: '', safety: null, warnings: [], citations: [], advancement: null });
  instance.onLoad();
  instance.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
  instance.onAnswerInput({ detail: { value: '课表是学生自己从教务系统下载后导入的，不用拿教务账号密码。' } });
  instance.onSubmit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.data.phase, 'failure');
  assert.equal(instance.data.failureRetryable, false);
  assert.equal(instance.data.answer.includes('教务系统'), true, '失败必须保留已写内容');
  instance.onUnload();
  delete global.Page;
  delete global.wx;
});

// ------------------------------------------------------------------ D. 注册与入口

test('页面已注册且四件套都在构建产物里', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/defense/index'), 'app.json 应当注册答辩练习页面');
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(ROOT, `dist/pages/defense/index.${ext}`)), `dist/pages/defense/index.${ext} 应当存在`);
  }
});

test('首页入口指向答辩练习，且文案不承诺等级或成绩', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.ok(wxml.includes('bindtap="openDefense"'), '首页应当有答辩练习入口');
  assert.ok(wxml.includes('项目讲解与答辩练习'), '入口标题应当写明功能名');
  const ts = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.ts'), 'utf8');
  assert.ok(/openDefense\(\)[\s\S]{0,120}\/pages\/defense\/index/u.test(ts), 'openDefense 应当跳转到答辩练习页');

  const pageWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/defense/index.wxml'), 'utf8');
  for (const forbidden of ['职业能力等级', '通过率', '面试保证']) {
    // 页面上只允许以「不输出……」的否定形式出现，不得作为承诺出现
    assert.ok(!pageWxml.includes(`可以获得${forbidden}`), `页面不得承诺 ${forbidden}`);
  }
  assert.ok(pageWxml.includes('不输出职业能力等级'), '页面应当明确写出不输出等级');
});

test('答辩练习材料注入构建产物（云函数侧同一份冻结正文）', () => {
  const bundle = path.join(ROOT, 'dist/cloudfunctions/ai/defense-materials.js');
  assert.ok(fs.existsSync(bundle), 'dist/cloudfunctions/ai/defense-materials.js 应当由构建生成');
  const loaded = require(bundle);
  assert.deepEqual(loaded.DEFENSE_MATERIALS.map((item) => item.id), ['FC-1', 'FC-2']);
  assert.equal(loaded.DEFENSE_MATERIALS[0].text, frozenText('fact-card-1-timetable.md'));
});

test('服务端按 materialId 取材料，并对该正文做四节与引用校验', () => {
  const cloud = require('../dist/cloudfunctions/ai/defense.js');
  const materials = cloud.loadDefenseMaterials();
  assert.ok(Array.isArray(materials) && materials.length === 2, '服务端应当加载到两份材料');
  assert.deepEqual(materials.map((item) => item.id), ['FC-1', 'FC-2']);
  assert.equal(materials[0].text, frozenText('fact-card-1-timetable.md'));
  assert.equal(materials[1].text, frozenText('fact-card-2-typing-game.md'));
  assert.equal(cloud.loadDefenseMaterials()[0].kind, 'owned', '材料性质要能传到服务端');

  const good = cloud.verifyDefenseAnswer('【引用核对】F1\n【是否对应回答】b\n【待验证保留】c\n【追问】d', materials[0].text);
  assert.deepEqual(good.problems, []);
  const bad = cloud.verifyDefenseAnswer('【引用核对】F99\n【是否对应回答】b\n【待验证保留】c\n【追问】d', materials[0].text);
  assert.ok(bad.problems.some((problem) => problem.includes('unknown_citation(F99)')), '材料里没有 F99，应当被拦下');
  const short = cloud.verifyDefenseAnswer('【引用核对】F1', materials[0].text);
  assert.ok(short.problems.some((problem) => problem.includes('missing_section')));
});

test('客户端与服务端的 feature 名一致（跨包复制的常量必须同名）', () => {
  const cloud = require('../dist/cloudfunctions/ai/defense.js');
  assert.equal(defense.DEFENSE_FEATURE, cloud.DEFENSE_FEATURE);
});
