/**
 * G1 PoC 脚本的离线自检测试（Issue #112）。
 *
 * 重点不是「镜像实现」，而是**证明校验器真的会拒绝坏数据**：每个校验点都配一个负例，
 * 把素材包或事件故意改坏，断言自检确实报错。全部用例不触网、不调用模型、不消耗配额。
 */
const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let poc;
before(async () => {
  poc = require('../scripts/poc-project-defense.cjs');
});

const REAL_PACKAGE = path.resolve(__dirname, '../docs/evidence/project-defense-g0');
const FROZEN_AT = '2026-09-30';

/** 事实卡夹具：条目 id 用 <prefix><n>。 */
function cardFixture(id, prefix) {
  return [
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
}

function sampleFixture(id, cardId, prefix, n, answerOverride) {
  return {
    id,
    cardId,
    type: 'clear-grounded',
    typeLabel: '清晰且有依据',
    answer: answerOverride ?? `${id} 的回答正文，编号 ${n}。`,
    expectedFeedback: '预期反馈。',
    citableSpans: [`${prefix}1：第一条事实`],
    mustPreserveUnverified: [`${prefix}2：第二条事实待验证`],
    decisionReason: '判定理由。',
    frozenAt: FROZEN_AT,
  };
}

/** 在临时目录里搭一个最小素材包；overrides 用于按需破坏某一条约束。 */
function fixture(t, mutate) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'wx-match-defense-g1-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== tempRoot || !path.basename(root).startsWith('wx-match-defense-g1-')) {
      throw new Error('Refuse to remove an unexpected fixture path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const files = {
    'sources.json': JSON.stringify({
      schemaVersion: 1,
      frozenAt: FROZEN_AT,
      materials: [
        { id: 'FC-1', bodyFile: 'fact-card-1-timetable.md' },
        { id: 'FC-2', bodyFile: 'fact-card-2-typing-game.md' },
      ],
    }),
    'fact-card-1-timetable.md': cardFixture('FC-1', 'F'),
    'fact-card-2-typing-game.md': cardFixture('FC-2', 'D'),
    'samples-development.json': JSON.stringify({
      schemaVersion: 1,
      set: 'development',
      frozenAt: FROZEN_AT,
      tuningAllowed: true,
      question: { id: 'Q', text: '开发问题？' },
      samples: [1, 2, 3, 4, 5, 6].map((n) => sampleFixture(`CS1-${n}`, n <= 3 ? 'FC-1' : 'FC-2', n <= 3 ? 'F' : 'D', n)),
    }),
    'samples-heldout.json': JSON.stringify({
      schemaVersion: 1,
      set: 'heldout',
      frozenAt: FROZEN_AT,
      tuningAllowed: false,
      question: { id: 'HQ', text: '留出问题？' },
      samples: [sampleFixture('HS-1', 'FC-1', 'F', 11), sampleFixture('HS-2', 'FC-2', 'D', 12)],
    }),
    'rubric.md': '# 评价表\n',
    'abnormal-cases.md': '# 异常样例\n',
    'budget.md': '# 预算\n',
  };
  const read = (name) => JSON.parse(files[name]);
  const write = (name, data) => { files[name] = JSON.stringify(data); };
  if (mutate) mutate({ files, read, write });

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

/** 跑自检并只关心错误列表（警告另算）。 */
async function errorsOf(root) {
  const result = await poc.planCheck({ packageDir: root });
  return result.errors;
}

test('真实冻结素材包：离线自检 0 错误，且装配可重复', async () => {
  const first = await poc.planCheck({ packageDir: REAL_PACKAGE });
  assert.deepEqual(first.errors, []);
  assert.equal(first.stats.samples.development, 6);
  assert.equal(first.stats.samples.heldout, 2);
  assert.ok(first.stats.maxInputChars <= poc.LIMITS.maxInputChars);
  // 同输入同输出：连跑两次指纹一致。
  const second = await poc.planCheck({ packageDir: REAL_PACKAGE });
  assert.equal(first.stats.assemblySha256, second.stats.assemblySha256);
});

test('真实冻结素材包的每个请求都在服务端上限之内', async () => {
  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  for (const request of [...result.sampleRequests, ...result.sessionRequests, ...result.abnormalRequests]) {
    assert.deepEqual(poc.checkEnvelope(request.event), []);
    assert.ok(request.event.messages.length <= poc.LIMITS.maxMessages);
  }
});

test('留出样例的 8 个请求里只出现它自己的回答', async () => {
  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  const heldout = result.sampleRequests.filter((item) => item.set === 'heldout');
  assert.equal(heldout.length, 2);
  const devAnswers = result.pkg.sets.development.samples.map((sample) => sample.answer.slice(0, 40));
  for (const request of heldout) {
    const body = poc.serverInputText(request.event);
    for (const answer of devAnswers) assert.ok(!body.includes(answer), '留出样例请求里混入了开发样例回答');
  }
});

test('重答步骤的空文本消息由运行时守卫替换为显式占位（负例）', async () => {
  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  const reanswer = result.sessionRequests.find((item) => item.step === 'R5');
  // 已知缺陷留档：装配阶段 R5 会带一条 text 为空串的 assistant 消息，
  // 服务端对空 text 一律拒绝，因此这一步只要执行就必然 invalid_request。
  const emptyBefore = reanswer.event.messages.filter((message) => message.text.trim() === '');
  assert.equal(emptyBefore.length, 1, 'R5 应当保留一条空文本消息，否则本条负例失去意义');
  assert.deepEqual(poc.checkEnvelope(reanswer.event), [], '本地 checkEnvelope 不会拦空 text——这正是缺陷逃过离线自检的原因');

  // 运行时守卫必须把它换成非空占位；且不得改动原 event（装配指纹覆盖装配阶段）。
  const guard = poc.sanitizeEventMessages(reanswer.event);
  assert.equal(guard.replaced, 1);
  assert.ok(guard.messages.every((message) => message.text.trim() !== ''));
  assert.equal(guard.messages.length, reanswer.event.messages.length);
  assert.ok(guard.messages.some((message) => message.text === poc.EMPTY_REPLY_PLACEHOLDER));
  assert.equal(reanswer.event.messages.filter((message) => message.text.trim() === '').length, 1, '守卫不得就地改写装配阶段的消息');

  // 正常请求不该被守卫改动。
  const untouched = poc.sanitizeEventMessages(result.sampleRequests[0].event);
  assert.equal(untouched.replaced, 0);
});

test('checkEnvelope 会拒绝超窗、超条数与非法角色（负例）', () => {
  const base = () => ({ action: 'chat', system: '系统', messages: [{ role: 'user', text: '问题' }] });
  assert.deepEqual(poc.checkEnvelope(base()), []);

  const tooMany = base();
  tooMany.messages = Array.from({ length: poc.LIMITS.maxMessages + 1 }, () => ({ role: 'user', text: 'x' }));
  assert.ok(poc.checkEnvelope(tooMany).some((error) => error.includes('超过 20 条')));

  const longOne = base();
  longOne.messages = [{ role: 'user', text: 'x'.repeat(poc.LIMITS.maxMessageChars + 1) }];
  assert.ok(poc.checkEnvelope(longOne).some((error) => error.includes('单条上限')));

  const longTotal = base();
  longTotal.system = 'x'.repeat(poc.LIMITS.maxInputChars);
  longTotal.messages = [{ role: 'user', text: 'y'.repeat(10) }];
  assert.ok(poc.checkEnvelope(longTotal).some((error) => error.includes('超过服务端上限')));

  const badRole = base();
  badRole.messages = [{ role: 'tool', text: 'x' }];
  assert.ok(poc.checkEnvelope(badRole).some((error) => error.includes('不在允许集合内')));

  const emptyMessages = base();
  emptyMessages.messages = [];
  assert.ok(poc.checkEnvelope(emptyMessages).some((error) => error.includes('非空数组')));
});

test('引用抽取与引用存在性核对（含未知条目负例）', async () => {
  const pkg = await poc.loadPackage(REAL_PACKAGE);
  assert.deepEqual(poc.extractCitations('依据 F1 与 D7，另外 INV-2 也适用；F1 重复出现。'), ['F1', 'D7', 'INV-2']);

  const good = poc.checkCitations('F1 成立，D7 未测试，INV-2 说明不等于真机通过。', pkg);
  assert.deepEqual(good.unknown, []);
  assert.equal(good.cardOf.F1, 'FC-1');
  assert.equal(good.cardOf.D7, 'FC-2');

  const bad = poc.checkCitations('依据 F99 与 Z1 可以证明。', pkg);
  assert.deepEqual(bad.unknown, ['F99', 'Z1']);
  // 普通英文词与缩写不该被当成材料引用（引用 id 必须是「大写字母 + 数字」或 INV-*）
  assert.deepEqual(poc.extractCitations('这个 AI 功能 OK，UI 也还行。'), []);
  assert.deepEqual(poc.extractCitations('见 F1 与 INV-A。'), ['F1', 'INV-A']);
});

test('留出样例被改坏时自检报错（负例：tuningAllowed 与正文重复）', async (t) => {
  const tuned = fixture(t, ({ read, write }) => {
    const held = read('samples-heldout.json');
    held.tuningAllowed = true;
    write('samples-heldout.json', held);
  });
  assert.ok((await errorsOf(tuned)).some((error) => error.includes('tuningAllowed')));

  const duplicated = fixture(t, ({ read, write }) => {
    const held = read('samples-heldout.json');
    held.samples[0].answer = read('samples-development.json').samples[0].answer;
    write('samples-heldout.json', held);
  });
  assert.ok((await errorsOf(duplicated)).some((error) => error.includes('回答正文与某个开发样例重复')));

  const sameId = fixture(t, ({ read, write }) => {
    const held = read('samples-heldout.json');
    held.samples[0].id = 'CS1-1';
    write('samples-heldout.json', held);
  });
  assert.ok((await errorsOf(sameId)).some((error) => error.includes('样例 id 重复')));
});

test('样例引用不存在的条目、或引用不属于本卡时自检报错（负例）', async (t) => {
  const unknown = fixture(t, ({ read, write }) => {
    const dev = read('samples-development.json');
    dev.samples[0].citableSpans = ['F99：不存在的事实'];
    write('samples-development.json', dev);
  });
  assert.ok((await errorsOf(unknown)).some((error) => error.includes('不存在的条目 id F99')));

  const crossCard = fixture(t, ({ read, write }) => {
    const dev = read('samples-development.json');
    dev.samples[0].citableSpans = ['D1：属于另一张卡'];// CS1-1 的 cardId 是 FC-1
    write('samples-development.json', dev);
  });
  assert.ok((await errorsOf(crossCard)).some((error) => error.includes('不属于它自己的事实卡')));
});

test('样例数量不对时自检报错（负例）', async (t) => {
  const five = fixture(t, ({ read, write }) => {
    const dev = read('samples-development.json');
    dev.samples = dev.samples.slice(0, 5);
    write('samples-development.json', dev);
  });
  assert.ok((await errorsOf(five)).some((error) => error.includes('开发样例应为 6 个')));

  const oneHeldout = fixture(t, ({ read, write }) => {
    const held = read('samples-heldout.json');
    held.samples = held.samples.slice(0, 1);
    write('samples-heldout.json', held);
  });
  assert.ok((await errorsOf(oneHeldout)).some((error) => error.includes('留出样例应为 2 个')));
});

test('纪律提示词掺入样例回答时自检报错（负例：样例不得写进提示词）', async () => {
  const pkg = await poc.loadPackage(REAL_PACKAGE);
  // 正例：当前纪律提示词不含任何样例正文；材料与回答的正常重叠（转述事实卡语句）不得误报。
  assert.deepEqual(poc.checkPromptHygiene(pkg), []);

  const heldoutAnswer = pkg.sets.heldout.samples[0].answer;
  const polluted = await poc.planCheck({ packageDir: REAL_PACKAGE, discipline: `${poc.DISCIPLINE}\n示例回答：${heldoutAnswer}` });
  assert.ok(polluted.errors.some((error) => error.includes('纪律提示词里出现了样例 HS-1')));
});

test('异常样例确实按 abnormal-cases.md 构造（含负例检查点）', async () => {
  const pkg = await poc.loadPackage(REAL_PACKAGE);
  assert.deepEqual(poc.checkAbnormalConstruction(pkg), []);
  const requests = poc.buildAbnormalRequests(pkg);
  assert.deepEqual(requests.map((item) => item.id), ['AX-1', 'AX-2', 'AX-3', 'AX-4', 'AX-5', 'AX-6']);

  const answerOf = (id) => requests.find((item) => item.id === id).event.messages[1].text;
  assert.equal(answerOf('AX-1').replace(/[\s。、　]/gu, ''), '');
  assert.ok(answerOf('AX-2').length > 3000);
  assert.ok(answerOf('AX-4').includes('忽略'));
  assert.ok(answerOf('AX-5').includes('等级'));
  assert.equal(requests.find((item) => item.id === 'AX-6').event.timeoutMs, 1);

  // 负例：把长回答缩到 3000 字以下应当被拒。
  const broken = { ...pkg, cards: [{ ...pkg.cards[0], facts: [{ id: 'F1', body: '短' }] }, pkg.cards[1]] };
  assert.ok(poc.checkAbnormalConstruction(broken).some((error) => error.includes('3000 字以上')));
});

test('三类必需失败文案各自独立，且能被检出相同文案（负例）', async (t) => {
  const real = poc.checkFailureMessages(path.resolve(__dirname, '../cloudfunctions/ai/errors.ts'));
  assert.deepEqual(real.problems, []);
  const values = Object.values(real.messages);
  assert.equal(new Set(values).size, 3);
  for (const value of values) assert.ok(value.length > 0);

  const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'wx-match-defense-g1-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broken = path.join(root, 'errors.ts');
  fs.writeFileSync(broken, [
    'const DEFAULTS = {',
    "  model_unavailable: '同一句。',",
    "  content_rejected: '同一句。',",
    "  quota_exhausted: '另一句。',",
    '};',
  ].join('\n'));
  const problems = poc.checkFailureMessages(broken).problems;
  assert.ok(problems.some((problem) => problem.includes('默认文案相同')));
});

test('真实调用默认拒绝花钱，且单批不超过 12 个请求', async () => {
  assert.throws(() => poc.parseArgs(['--samples', '--max-calls=13']), /每批上限/u);
  assert.equal(poc.parseArgs(['--samples']).maxCalls, poc.MAX_CLOUD_REQUESTS_PER_BATCH);

  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  await assert.rejects(
    () => poc.runBatch({ requests: result.sampleRequests, pkg: result.pkg, outBase: path.join(os.tmpdir(), 'never'), allowSpend: false, maxCalls: 12, tag: '' }),
    /--allow-spend/u,
  );
});

test('会话口径：三轮 + 复盘 + 重答，且请求数不超过 5', async () => {
  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  assert.deepEqual(result.sessionRequests.map((item) => item.step), ['R1', 'R2', 'R3', 'R4', 'R5']);
  assert.ok(result.sessionRequests.length <= 5, '一次完整会话最多 5 次模型请求');
  for (const request of result.sessionRequests) assert.deepEqual(poc.checkEnvelope(request.event), []);
  assert.equal(result.sessionRequests[3].stepKind, 'review');
  assert.equal(result.sessionRequests[4].stepKind, 'reanswer');
});

test('--set 能只重跑开发样例（调参后复测不得反复消耗留出样例）', async () => {
  assert.equal(poc.parseArgs(['--samples']).setFilter, 'all');
  assert.equal(poc.parseArgs(['--samples', '--set=development']).setFilter, 'development');
  assert.throws(() => poc.parseArgs(['--samples', '--set=everything']), /--set 只接受/u);

  const result = await poc.planCheck({ packageDir: REAL_PACKAGE });
  const devOnly = result.sampleRequests.filter((request) => request.set === 'development');
  const heldOnly = result.sampleRequests.filter((request) => request.set === 'heldout');
  assert.equal(devOnly.length, 6);
  assert.equal(heldOnly.length, 2);
  // 第一次评测必须把开发集与留出集放在同一批，留出样例的首次结果才在调参之前产生。
  assert.deepEqual(result.sampleRequests.map((item) => item.id), ['CS1-1', 'CS1-2', 'CS1-3', 'CS2-1', 'CS2-2', 'CS2-3', 'HS-1', 'HS-2']);
});
