const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const evaluator = require('../scripts/eval-advancement-model.cjs');

test('评测不得接受空题集或无效调用预算后宣称成功', () => {
  for (const args of [['--plan', '--only=not-a-question'], ['--plan', '--max-calls=NaN'], ['--plan', '--max-calls=-1']]) {
    const result = spawnSync(process.execPath, ['scripts/eval-advancement-model.cjs', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
  }
});

test('服务端声称拒答时仍复核原始文字，不能信任 refused 标记', () => {
  const verifier = require('../dist/cloudfunctions/ai/advancement.js');
  const verdict = evaluator.independentVerify(verifier, {
    invoked: true, ok: true, text: '无法核实。报名时间是2027年12月31日。',
    advancement: { refused: true, sources: [] },
  });
  assert.ok(verdict.violations.length > 0);
});

test('续跑保留失败但不跳过未调用、额度拒绝和传输失败题', () => {
  for (const modelCall of [null, { invoked: true, failureClass: 'quota_exhausted' }, { invoked: false }]) {
    assert.equal(evaluator.isCompleteRecord({ expectedBehavior: 'answer', modelCall, done: true }), false);
  }
  assert.equal(evaluator.isCompleteRecord({ expectedBehavior: 'answer', modelCall: { invoked: true, ok: true, failureClass: '' } }), true);
  assert.equal(evaluator.isCompleteRecord({ expectedBehavior: 'refuse', guardCorrect: false }), true);
});
