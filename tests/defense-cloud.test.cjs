/**
 * 「项目讲解与答辩练习」（feature = project-defense）的服务端契约测试。
 *
 * 与仓库其它云函数测试同一约定：跑**编译产物** `dist/cloudfunctions/ai/defense.js`，
 * 不 require 源码（`.ts` 在 Node 里跑不起来）。跑之前先 `npm run build`。
 *
 * 覆盖的是这一层的可机检部分：四节标题齐不齐 / 顺序对不对、引用编号有没有出处、
 * 材料条目编号的抽取口径、以及系统提示词的组成。**不覆盖**语义判定
 * （把「待验证」说成「已完成」这类错误仍须人工按 rubric 判读）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'dist', 'cloudfunctions', 'ai', 'defense.js');
assert.ok(fs.existsSync(MODULE_PATH), `缺少构建产物 ${MODULE_PATH}，请先跑 npm run build`);

const { DEFENSE_FEATURE, DEFENSE_DISCIPLINE, defenseMaterialIds, defenseSystem, verifyDefenseAnswer } = require(MODULE_PATH);

/** 四节标题（契约原文，不引用模块内部常量——测试要独立钉住这串字）。 */
const SECTIONS = ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'];

/**
 * 测试用材料：形态与 `docs/evidence/project-defense-g0/fact-card-*.md` 一致（Markdown 表格）。
 * 刻意把「正文里的普通英文数字」也放进来（xlsx@0.20.3、wx.chooseMessageFile、9 月 27 日），
 * 它们不得被当成可引用条目编号。
 */
const MATERIAL = [
  '# 事实卡（测试用）',
  '',
  '| id | 事实 | 状态 |',
  '| --- | --- | --- |',
  '| F1 | 只能用 `wx.chooseMessageFile` 从微信聊天记录选文件，路径：教务系统下载 → 发到微信 → 小程序里选 | 已完成 |',
  '| INV-2 | 「已完成」只表示仓库内有代码或测试记录，**不等于真机通过** | — |',
  '| D7 | 设计情景：打字游戏（维护者原创，无代码与运行记录） | 待验证 |',
  '',
  '| 备注 | F1 的复核记录见 p4-b/verification.json | — |',
  '',
  '正文另起一段：解析用 xlsx@0.20.3，选文件用 wx.chooseMessageFile，复核日期 9 月 27 日。',
].join('\n');

/** 四节齐全、引用都能回核到材料条目的回答。 */
const GOOD_ANSWER = [
  '【引用核对】学生说「只能用微信聊天记录选文件」：成立（F1）。学生说「真机验收已通过」：不成立（INV-2：材料写的是各轮验收均为模拟器，不等于真机通过）。',
  '【是否对应回答】本次反馈针对的是学生写出的「导入流程已完成」这一句断言。',
  '【待验证保留】D7 仍是维护者原创的设计情景，保持「待验证」不动。',
  '【追问】你说「解析在云函数里做」，材料里对应的是哪一条条目编号？请补上依据。',
].join('\n');

test('feature 名与四节标题是契约原文', () => {
  assert.equal(DEFENSE_FEATURE, 'project-defense');
  assert.equal(typeof DEFENSE_DISCIPLINE, 'string');
  for (const section of SECTIONS) {
    assert.ok(DEFENSE_DISCIPLINE.includes(section), `固定纪律提示词缺少 ${section}`);
  }
  // 四节在纪律里的出现顺序与契约一致。
  const positions = SECTIONS.map((section) => DEFENSE_DISCIPLINE.indexOf(section));
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, '四节标题在纪律提示词里的顺序不对');
});

test('defenseMaterialIds 只认行首或表格竖线后的条目编号，去重且保持顺序', () => {
  assert.deepEqual(defenseMaterialIds(MATERIAL), ['F1', 'INV-2', 'D7']);
  // 正文里的普通英文数字与日期不得变成可引用编号。
  for (const noise of ['xlsx@0.20.3', 'wx.chooseMessageFile', '9 月 27 日', 'INV-', 'p4-b']) {
    assert.ok(!defenseMaterialIds(MATERIAL).includes(noise), `${noise} 不该被当成条目编号`);
  }
  assert.deepEqual(defenseMaterialIds(''), []);
});

test('defenseMaterialIds 去重但保留首次出现的顺序', () => {
  const duplicated = ['| D7 | 先出现 |', '| D7 | 再次出现 |', '| F1 | 后出现 |'].join('\n');
  assert.deepEqual(defenseMaterialIds(duplicated), ['D7', 'F1']);
});

test('defenseSystem 同时含固定纪律、材料正文与四节标题', () => {
  const system = defenseSystem('X');
  assert.ok(system.includes(DEFENSE_DISCIPLINE), 'system 必须包含固定纪律提示词');
  assert.ok(system.includes('X'), 'system 必须包含材料正文');
  for (const section of SECTIONS) assert.ok(system.includes(section), `system 缺少 ${section}`);
  assert.ok(system.includes('=== 项目材料开始 ===') && system.includes('=== 项目材料结束 ==='), '材料分隔标记缺失');
  // 纪律里的指代已改成服务端下发（PoC 版写的是「下面的项目材料」）。
  assert.ok(DEFENSE_DISCIPLINE.includes('服务端下发的项目材料'));
  assert.ok(!DEFENSE_DISCIPLINE.includes('依据下面的项目材料'));
});

test('四节齐全且引用都存在 → ok: true、problems: []', () => {
  const verdict = verifyDefenseAnswer(GOOD_ANSWER, MATERIAL);
  assert.deepEqual(verdict, { ok: true, problems: [] });
});

test('缺【追问】→ ok: false，problems 指明缺的是哪一节', () => {
  const withoutFollowUp = GOOD_ANSWER.split('\n').slice(0, 3).join('\n');
  const verdict = verifyDefenseAnswer(withoutFollowUp, MATERIAL);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('【追问】')), `problems 未指明缺【追问】：${JSON.stringify(verdict.problems)}`);
});

test('四节顺序错（【追问】放到最前）→ ok: false', () => {
  const reordered = [SECTIONS[3] + '你说「已完成」，依据是哪一条？', ...GOOD_ANSWER.split('\n').slice(0, 3)].join('\n');
  const verdict = verifyDefenseAnswer(reordered, MATERIAL);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('【追问】')), `problems 未指出顺序问题：${JSON.stringify(verdict.problems)}`);
});

test('引用材料里不存在的编号 → problems 含 unknown_citation(F99)', () => {
  const unknown = [
    '【引用核对】学生说「已真机验收通过」：成立（F99）。',
    '【是否对应回答】针对学生写出的验收断言。',
    '【待验证保留】无。',
    '【追问】这条依据的条目编号是什么？',
  ].join('\n');
  const verdict = verifyDefenseAnswer(unknown, MATERIAL);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.includes('unknown_citation(F99)'), `problems 未含 unknown_citation(F99)：${JSON.stringify(verdict.problems)}`);
});

test('空文本 → problems 含 empty_answer', () => {
  // 判据就是 `text.trim() === ''`（含全角空格 U+3000 这类空白）。
  // **只有标点**的文本（PoC 的 AX-1 例子 `'   \n　。、  '`）按这个判据不算空，
  // 它走四节与引用校验——「没有可核对的内容」是留给模型自己说的话，不是校验器的判据。
  for (const blank of ['', '   ', '\n\t　']) {
    const verdict = verifyDefenseAnswer(blank, MATERIAL);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.includes('empty_answer'), `problems 未含 empty_answer：${JSON.stringify(verdict.problems)}`);
  }
});

test('ok 恒等于 problems 为空', () => {
  const cases = [GOOD_ANSWER, '', '【引用核对】只有一节。', GOOD_ANSWER.replace('D7', 'D99')];
  for (const answer of cases) {
    const verdict = verifyDefenseAnswer(answer, MATERIAL);
    assert.equal(verdict.ok, verdict.problems.length === 0);
  }
});

test('problems 不含回答正文（它要进 citation_unverified 的 detail）', () => {
  const verdict = verifyDefenseAnswer('【引用核对】F99 有点长的一句回答正文，不该出现在 problems 里。', MATERIAL);
  assert.equal(verdict.ok, false);
  for (const problem of verdict.problems) {
    assert.ok(!problem.includes('有点长的一句回答正文'), `problems 混入了回答正文：${problem}`);
  }
});
