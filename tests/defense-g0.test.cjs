const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let checkPackage;
let extractBody;
let extractFacts;
let MAX_BODY_CHARS;
before(async () => {
  ({ checkPackage, extractBody, extractFacts, MAX_BODY_CHARS } = await import('../scripts/check-defense-g0.mjs'));
});

const REAL_PACKAGE = path.resolve(__dirname, '../docs/evidence/project-defense-g0');

/** 在临时目录里搭一个最小素材包，供各用例按需破坏某一条约束。 */
function fixture(t, overrides = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'wx-match-defense-g0-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== tempRoot || !path.basename(root).startsWith('wx-match-defense-g0-')) {
      throw new Error('Refuse to remove an unexpected fixture path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const card = (id, prefix) => [
    `# 事实卡 ${id}`,
    '',
    '## 不变量',
    '',
    '| id | 不变量 | 状态 |',
    '| --- | --- | --- |',
    `| INV-${prefix} | 本卡是素材，不是功能上线声明 | — |`,
    '',
    '## 事实表',
    '',
    '| id | 事实 | 状态 |',
    '| --- | --- | --- |',
    `| ${prefix}1 | 第一条事实 | 已完成 |`,
    `| ${prefix}2 | 第二条事实 | 待验证 |`,
    '',
    '## 边界',
    '',
    '- 边界说明。',
  ].join('\n');

  const sample = (id, cardId, prefix, n) => ({
    id,
    cardId,
    type: 'clear-grounded',
    typeLabel: '清晰且有依据',
    answer: `${id} 的回答正文，编号 ${n}。`,
    expectedFeedback: '预期反馈。',
    citableSpans: [`${prefix}1：第一条事实`],
    mustPreserveUnverified: [`${prefix}2：第二条事实待验证`],
    decisionReason: '判定理由。',
    frozenAt: '2026-09-30',
  });

  const files = {
    'sources.json': JSON.stringify({
      schemaVersion: 1,
      frozenAt: '2026-09-30',
      materials: [
        { id: 'FC-1', bodyFile: 'fact-card-1-timetable.md' },
        { id: 'FC-2', bodyFile: 'fact-card-2-typing-game.md' },
      ],
    }),
    'fact-card-1-timetable.md': card('FC-1', 'F'),
    'fact-card-2-typing-game.md': card('FC-2', 'D'),
    'samples-development.json': JSON.stringify({
      schemaVersion: 1,
      set: 'development',
      frozenAt: '2026-09-30',
      tuningAllowed: true,
      question: { id: 'Q', text: '问题' },
      samples: [
        sample('CS1-1', 'FC-1', 'F', 1),
        sample('CS1-2', 'FC-1', 'F', 2),
        sample('CS1-3', 'FC-1', 'F', 3),
        sample('CS2-1', 'FC-2', 'D', 4),
        sample('CS2-2', 'FC-2', 'D', 5),
        sample('CS2-3', 'FC-2', 'D', 6),
      ],
    }),
    'samples-heldout.json': JSON.stringify({
      schemaVersion: 1,
      set: 'heldout',
      frozenAt: '2026-09-30',
      tuningAllowed: false,
      question: { id: 'HQ', text: '留出问题' },
      samples: [
        sample('HS-1', 'FC-1', 'F', 7),
        sample('HS-2', 'FC-2', 'D', 8),
      ],
    }),
    'rubric.md': '职业 录用 教师认可 100% 至少 5 个 不得 润色',
    'budget.md': '不超过 4 次、加 1 次、每批 12 次、月度 50 元；G0 不运行真实调用。',
  };
  Object.assign(files, overrides);

  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    fs.writeFileSync(path.resolve(root, name), content);
  }
  return root;
}

test('G0 素材包：真实目录通过全部约束', () => {
  const { errors } = checkPackage(REAL_PACKAGE);
  assert.deepEqual(errors, []);
});

test('G0 素材包：真实样例数量为 6 个开发 + 2 个留出', () => {
  const dev = JSON.parse(fs.readFileSync(path.join(REAL_PACKAGE, 'samples-development.json'), 'utf8'));
  const held = JSON.parse(fs.readFileSync(path.join(REAL_PACKAGE, 'samples-heldout.json'), 'utf8'));
  assert.equal(dev.samples.length, 6);
  assert.equal(held.samples.length, 2);
  assert.equal(held.tuningAllowed, false);
});

test('G0 校验：最小合规素材包通过', (t) => {
  const { errors } = checkPackage(fixture(t));
  assert.deepEqual(errors, []);
});

test('G0 校验：引用不存在的事实 id 被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.samples[0].citableSpans = ['F9：不存在的事实'];
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /CS1-1/.test(e) && /不存在/.test(e)), errors.join(' | '));
});

test('G0 校验：引用别的卡的事实 id 被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.samples.find((s) => s.id === 'CS2-1').citableSpans = ['F1：属于 FC-1 的事实'];
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /CS2-1/.test(e) && /不属于它自己的事实卡/.test(e)), errors.join(' | '));
});

test('G0 校验：开发样例数量错误被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.samples.pop();
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /开发样例应为 6 个/.test(e)), errors.join(' | '));
});

test('G0 校验：留出样例被标为可用于调整时拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-heldout.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.tuningAllowed = true;
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /留出样例不得用于调整|tuningAllowed/.test(e)), errors.join(' | '));
});

test('G0 校验：重复的回答正文被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.samples[1].answer = data.samples[0].answer;
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /回答正文重复/.test(e)), errors.join(' | '));
});

test('G0 校验：空的「待验证」被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.samples[0].mustPreserveUnverified = [];
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /待验证」为空/.test(e)), errors.join(' | '));
});

test('G0 校验：冻结日期不一致被拒绝', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'samples-development.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.frozenAt = '2026-10-01';
  fs.writeFileSync(file, JSON.stringify(data));
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /frozenAt/.test(e)), errors.join(' | '));
});

test('G0 校验：超过正文长度上限被拒绝', (t) => {
  const longFact = `| F1 | ${'字'.repeat(MAX_BODY_CHARS + 50)} | 已完成 |`;
  const root = fixture(t, {
    'fact-card-1-timetable.md': [
      '# 事实卡 FC-1', '', '## 事实表', '',
      '| id | 事实 | 状态 |', '| --- | --- | --- |', longFact,
    ].join('\n'),
  });
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /超过上限/.test(e)), errors.join(' | '));
});

test('G0 校验：rubric 缺少禁止项被拒绝', (t) => {
  const root = fixture(t, { 'rubric.md': '只有 100%' });
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /rubric\.md 缺少必要条件/.test(e)), errors.join(' | '));
});

test('G0 校验：budget 缺少预算口径被拒绝', (t) => {
  const root = fixture(t, { 'budget.md': '这里没有数字。' });
  const { errors } = checkPackage(root);
  assert.ok(errors.some((e) => /budget\.md 缺少预算口径/.test(e)), errors.join(' | '));
});

test('正文口径：忽略表格与强调符号，只计可见正文', () => {
  const markdown = ['## 事实表', '', '| id | 事实 | 状态 |', '| --- | --- | --- |', '| F1 | 内容 | 已完成 |', '', '## 边界', '', '- 说明'].join('\n');
  const body = extractBody(markdown);
  assert.equal(body.counted, true);
  assert.equal(body.chars, [...'事实表id事实状态F1内容已完成'].length);
  assert.ok(body.rawChars > body.chars, '含表格符号的计数应更大');
});

test('条目解析：表格行与不变量都能识别，且不把表头当成条目', () => {
  const markdown = [
    '## 不变量', '',
    '| id | 不变量 | 状态 |', '| --- | --- | --- |', '| INV-1 | 声明 | — |', '',
    '## 事实表', '',
    '| id | 事实 | 状态 |', '| --- | --- | --- |', '| F1 | 事实一 | 已完成 |', '| F2 | 事实二 | 待验证 |',
  ].join('\n');
  const facts = extractFacts(markdown, 'FC-1');
  assert.deepEqual(facts.map((f) => f.id), ['INV-1', 'F1', 'F2']);
  assert.equal(facts[0].invariant, true);
  assert.equal(facts[1].invariant, false);
});
