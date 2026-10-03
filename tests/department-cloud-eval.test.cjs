const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const fs = require('node:fs');
const os = require('node:os');
const evaluator = require('../scripts/eval-department-cloud.cjs');

function withBank(change, run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'department-eval-'));
  const bank = { datasetId: 'test-bank', frozenAt: '2026-10-03', source: 'maintainer_design', judgeRules: { supportedAnswer: '有据回答全部子问', missingExplained: '缺失范围明确', unsupportedDisplay: '有无无依据断言分别判定' }, questions: Array.from({ length: 10 }, (_, i) => ({ id: `case-${i + 1}`, kind: 'base', q: '校学生会组织架构是什么？', expectedDepartmentId: 'student-union', expectedAnswer: '主席团+工作部门', sourceRefs: [{ departmentId: 'student-union', field: 'unitNote', value: '组织架构为“主席团+工作部门”模式，设 5 大部门。' }], missingFields: [] })) };
  change(bank);
  const file = path.join(folder, 'questions.json');
  fs.writeFileSync(file, JSON.stringify(bank));
  try { run(file); } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.match(path.basename(folder), /^department-eval-/u);
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('独立题集计划按冻结顺序读取，绑定题集与实际构建产物，不触发云调用', () => {
  withBank(() => {}, file => {
    const result = spawnSync(process.execPath, ['scripts/eval-department-cloud.cjs', '--plan', `--questions=${file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.datasetId, 'test-bank');
    assert.deepEqual(report.rows.map(r=>r.id), Array.from({ length: 10 }, (_, i)=>`case-${i + 1}`));
    assert.match(report.questionSetSha256, /^[0-9a-f]{64}$/u);
    for (const file of ['client/qa.js', 'client/departments.js', 'cloud/rag.js', 'cloud/department-corpus.js', 'cloud/index.js']) assert.match(report.buildHashes[file], /^[0-9a-f]{64}$/u);
    assert.equal(report.cloudAttempts, 0);
  });
});

test('无效独立题集在连接与计费前拒绝：少题、重号、空题、假部门、未冻结、来源不符', () => {
  const changes = [
    [b=>b.questions.pop(), /至少10/u],
    [b=>b.questions[1].id=b.questions[0].id, /重复/u],
    [b=>b.questions[0].q='  ', /题面/u],
    [b=>b.questions[0].expectedDepartmentId='fake', /部门/u],
    [b=>delete b.frozenAt, /冻结/u],
    [b=>b.questions[0].sourceRefs[0].value='伪造组织架构', /来源/u],
  ];
  for (const [change, pattern] of changes) withBank(change, file => {
    const result = spawnSync(process.execPath, ['scripts/eval-department-cloud.cjs', `--questions=${file}`, '--max-calls=10'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /WebSocket|自动化端口/u);
  });
});

test('部门云端评测：无效预算在连接和计费前拒绝', () => {
  const result = spawnSync(process.execPath, ['scripts/eval-department-cloud.cjs', '--max-calls=-1'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /max-calls/);
  assert.doesNotMatch(result.stderr, /9420|WebSocket|自动化端口/);
});

test('部门云端评测：离线计划覆盖冻结10题，使用产品请求且不提前注入检索结果', () => {
  const result = spawnSync(process.execPath, ['scripts/eval-department-cloud.cjs', '--plan'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.rows.length, 10);
  for (const row of plan.rows) {
    assert.equal(row.event.action, 'chat');
    assert.equal(row.event.feature, 'department-qa');
    assert.equal(row.event.messages.at(-1).text, row.q);
    assert.doesNotMatch(row.event.system, /^【部门动态检索结果】/m);
  }
});

test('首次采集按序、串行，保留模型/上屏/来源，遇记账或额度停止且不自动评分', async () => {
  for (const fault of [{ ok: false, failureClass: 'quota_exhausted' }, { ok: true, text: '原始模型', safety: { checked: true }, warnings: ['用量记账失败'] }]) {
    const report = { cloudAttempts: 0, stoppedReason: '', rows: Array.from({ length: 10 }, (_, i) => ({ id: `test-${i}`, q: '测试', expectedDepartmentId: 'student-union', event: { number: i }, done: false, scores: { supportedAnswer: null, missingExplained: null, unsupportedDisplay: null } })) };
    const calls = [], saved = [];
    let active = 0;
    await evaluator.collect(report, { maxCalls: 10 }, async event => {
      assert.equal(active++, 0);
      calls.push(event.number);
      await Promise.resolve(); active--;
      return { result: event.number ? fault : { ok: true, text: '原始模型', safety: { checked: true }, citations: [{ title: '原始来源' }], usage: { totalTokens: 15 }, elapsedMs: 50 }, elapsedMs: 70 };
    }, row => saved.push(JSON.parse(JSON.stringify(row))), { guardTurn: text => ({ text: '实际上屏', modelText: text, warning: '展示警示', citations: [] }) }, async () => {});
    assert.deepEqual(calls, [0, 1]);
    assert.equal(report.cloudAttempts, 2);
    assert.ok(report.stoppedReason);
    assert.equal(saved[0].rawModelText, '原始模型');
    assert.equal(saved[0].displayText, '实际上屏');
    assert.equal(saved[0].displayWarning, '展示警示');
    assert.equal(saved[0].clientElapsedMs, 70);
    assert.equal(saved[0].serverElapsedMs, 50);
    assert.equal(saved[0].usage.totalTokens, 15);
    assert.equal(saved[0].scores.supportedAnswer, null);
    assert.equal(report.rows[2].execution, undefined);
    assert.ok(report.rows[2].notCalledReason);
  }
});

test('传输失败保留未知耗时，不继续下一题或把未知费用记0', async () => {
  const report = { cloudAttempts: 0, stoppedReason: '', rows: [{ id: 'a', event: {} }, { id: 'b', event: {} }] };
  await evaluator.collect(report, { maxCalls: 2 }, async () => { throw Error('bridge failure'); }, () => {}, { guardTurn: () => { throw Error('不应展示模型'); } }, async () => {});
  assert.equal(report.cloudAttempts, 1);
  assert.equal(report.rows[0].execution, 'transport_failed');
  assert.equal(report.rows[0].clientElapsedMs, null);
  assert.equal(report.rows[0].usage, null);
  assert.equal(report.rows[1].notCalledReason, 'transport_failed');
});

test('核账状态未确认或预算缺失时，真实调用保持停止', () => {
  assert.throws(() => evaluator.validateBudget('', 1), /budget/u);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'department-eval-'));
  try {
    const file = path.join(folder, 'budget.json');
    fs.writeFileSync(file, JSON.stringify({ accountingReconciled: false }));
    assert.throws(() => evaluator.validateBudget(file, 1), /核账/u);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.match(path.basename(folder), /^department-eval-/u);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('采集保留原始来源，但上屏重放必须经过产品callAi的同一解析和来源筛选', () => {
  const qa = require('../dist/pages/departments/qa.js');
  const row = { q: '校学生会近期动态？', expectedDepartmentId: 'student-union' };
  evaluator.applyResult(row, { elapsedMs: 150, result: { ok: true, text: '原始模型扩写举办方', safety: { checked: true, passed: true }, citations: [null, { title: '伪造' }], usage: { totalTokens: 10 } } }, qa);
  assert.equal(row.rawCitations.length, 2);
  assert.deepEqual(row.displayCitations, []);
  assert.equal(row.rawModelText, '原始模型扩写举办方');
  assert.equal(row.clientElapsedMs, 150);
});

test('来源字段的JSON键顺序无关紧要，错误字段值仍拒绝', () => {
  withBank(bank => {
    const source = require('../dist/services/departments.js').departments.find(d=>d.id==='student-union').activities[0];
    bank.questions[0].sourceRefs = [{ departmentId: 'student-union', field: 'activities', value: { sourceUrl: source.sourceUrl, publishedAt: source.publishedAt, title: source.title } }];
  }, file => {
    assert.doesNotThrow(() => evaluator.loadBank(file, true, require('../dist/services/departments.js').departments));
  });
});

test('来源快照绑定校验实际文件字节及产品资料，错误哈希不能进入采集', () => {
  withBank(bank => {
    bank.sourceSnapshotFile = 'source-snapshot.json';
    bank.sourceSnapshotSha256 = '0'.repeat(64);
  }, file => {
    fs.writeFileSync(path.join(path.dirname(file), 'source-snapshot.json'), JSON.stringify({ departments: require('../dist/services/departments.js').departments }));
    assert.throws(() => evaluator.loadBank(file, true, require('../dist/services/departments.js').departments), /快照哈希/u);
  });
});

test('75秒后晚到云答案保留原模型与费用，但不能冒充实际客户端上屏', () => {
  const row = { q: '校学生会下设哪些部门？', expectedDepartmentId: 'student-union' };
  evaluator.applyResult(row, { elapsedMs: 80000, result: { ok: true, text: '权益部、文娱部、器材部、体育部、学创部', safety: { checked: true }, usage: { totalTokens: 25 } } }, require('../dist/pages/departments/qa.js'));
  assert.equal(row.done, false);
  assert.equal(row.displayTurn, null);
  assert.equal(row.displayText, '');
  assert.equal(row.rawModelText.includes('权益部'), true);
  assert.equal(row.cloudElapsedMs, 80000);
  assert.equal(row.clientElapsedMs, 75000);
  assert.equal(row.usage.totalTokens, 25);
  assert.equal(row.execution, 'client_timeout');
  assert.ok(row.failureMessage);
});
