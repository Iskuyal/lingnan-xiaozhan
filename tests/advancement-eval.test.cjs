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

test('升学首评遇到传输失败、未知费用或未检测内容时停止后续付费请求', () => {
  const known = { invoked: true, ok: true, failureClass: '', usage: { costYuan: 0.001, estimated: false, usageUnknown: false }, safety: { checked: true } };
  for (const patch of [
    { invoked: false }, { usage: null }, { usage: { costYuan: 0.001, usageUnknown: true } },
    { usage: { costYuan: 0.001, estimated: true } }, { usage: { costYuan: NaN } },
    { safety: { checked: false } },
  ]) assert.notEqual(evaluator.stopReason({ ...known, ...patch }), '', JSON.stringify(patch));
  assert.equal(evaluator.stopReason(known), '');
  assert.equal(evaluator.stopReason({ ...known, ok: false, failureClass: 'citation_unverified' }), '', '已知费用的引用降级继续如实采集，不重试');
});

test('升学首评按模型费用与含审核的月账本增量中较大值限制子预算', () => {
  const baseline = { month: '2026-10', costYuan: 1 };
  const within = { month: '2026-10', costYuan: 1.01 };
  assert.equal(evaluator.budgetStopReason(baseline, within, 0.01, 0.05), '');
  assert.notEqual(evaluator.budgetStopReason(baseline, { month: '2026-10', costYuan: 1.06 }, 0.01, 0.05), '');
  assert.notEqual(evaluator.budgetStopReason(baseline, within, 0.05, 0.05), '');
  for (const current of [null, { month: '2026-10', costYuan: NaN }, { month: '2026-11', costYuan: 1.01 }, { month: '2026-10', costYuan: 0.99 }]) {
    assert.notEqual(evaluator.budgetStopReason(baseline, current, 0.01, 0.05), '');
  }
});
