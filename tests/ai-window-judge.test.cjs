/**
 * 内容安全窗口云端探针的判定逻辑（`scripts/lib/ai-window-judge.cjs`）。
 *
 * 这两个判定的价值在于**能区分修复前后**：桩值取自审计报告实测的两种返回值形状
 * （修复前的 `ok: true` + `checked: false`，修复后的拒绝 / 全检），
 * 因此判定写错时这条测试会先失败，不用等到云端跑一次才发现。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judgeLongOutput, judgeOversizeInput } = require('../scripts/lib/ai-window-judge.cjs');

const INPUT_LIMIT = 20000;
const OUTPUT_LIMIT = 40000;

/** 修复后的超长输入返回值（本地桩实测形状）。 */
function rejectedOversize(overrides = {}) {
  return {
    ok: false,
    failureClass: 'invalid_request',
    detail: '本次输入共 32006 字（其中 system 14 字），超过一次内容安全检测能覆盖的 20000 字（2000×10）：未过检的文字不能送进模型，请调用方精简历史或材料后重试。',
    message: '本次对话或材料太长，超出单次安全检测能覆盖的范围，请精简后重试（或清空对话重新开始）。',
    safety: null,
    usage: null,
    warnings: [],
    ...overrides,
  };
}

test('超长输入：修复后的拒绝形状通过（拒绝早于检测，无子调用）', () => {
  const verdict = judgeOversizeInput(rejectedOversize(), INPUT_LIMIT);
  assert.equal(verdict.pass, true, verdict.reasons.join('；'));
});

test('超长输入：修复前「检一半就放行」的形状必须被判不通过', () => {
  // 审计探针 1 的实测形状：请求成功、标了 checked=false、用量非空（真的调了模型）。
  const verdict = judgeOversizeInput(rejectedOversize({
    ok: true,
    failureClass: '',
    safety: { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: false, detail: '…仅检测了前 20000 字' },
    usage: { totalTokens: 10, costYuan: 0.0001 },
    warnings: ['内容安全检测未完整执行（checked=false）：…'],
  }), INPUT_LIMIT);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes('期望被拒')), verdict.reasons.join('；'));
  assert.ok(verdict.reasons.some((reason) => reason.includes('用量不为空')), verdict.reasons.join('；'));
  assert.ok(verdict.reasons.some((reason) => reason.includes('检测结论')), verdict.reasons.join('；'));
});

test('超长输入：分类写错或 detail 没写上限都不通过', () => {
  const wrongClass = judgeOversizeInput(rejectedOversize({ failureClass: 'content_rejected' }), INPUT_LIMIT);
  assert.equal(wrongClass.pass, false);
  assert.ok(wrongClass.reasons.some((reason) => reason.includes('invalid_request')), wrongClass.reasons.join('；'));

  const noLimit = judgeOversizeInput(rejectedOversize({ detail: '输入太长' }), INPUT_LIMIT);
  assert.equal(noLimit.pass, false);
  assert.ok(noLimit.reasons.some((reason) => reason.includes('20000')), noLimit.reasons.join('；'));
});

test('长输出：整段检完才返回的形状通过', () => {
  const verdict = judgeLongOutput({
    ok: true,
    failureClass: '',
    text: '好'.repeat(25006),
    safety: { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: true, detail: '安全' },
    warnings: [],
  }, INPUT_LIMIT, OUTPUT_LIMIT);
  assert.equal(verdict.pass, true, verdict.reasons.join('；'));
  assert.equal(verdict.covered, true);
});

test('长输出：修复前「尾部未检就上屏」的形状必须被判不通过', () => {
  const verdict = judgeLongOutput({
    ok: true,
    failureClass: '',
    text: '好'.repeat(25006),
    safety: { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: false, detail: '文本共 25006 字，仅检测了前 20000 字' },
    warnings: ['内容安全检测未完整执行（checked=false）：…'],
  }, INPUT_LIMIT, OUTPUT_LIMIT);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.covered, true);
  assert.ok(verdict.reasons.some((reason) => reason.includes('checked')), verdict.reasons.join('；'));
  assert.ok(verdict.reasons.some((reason) => reason.includes('没检全')), verdict.reasons.join('；'));
});

test('长输出：模型没写够 2 万字时如实报「未覆盖」，不算通过', () => {
  const verdict = judgeLongOutput({
    ok: true,
    failureClass: '',
    text: '好'.repeat(12000),
    safety: { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: true, detail: '安全' },
    warnings: [],
  }, INPUT_LIMIT, OUTPUT_LIMIT);
  assert.equal(verdict.covered, false, '没到窗口就是没验证到');
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reasons[0].includes('未达到检测窗口'), verdict.reasons.join('；'));
});

test('长输出：超过分片上限被 internal 拒绝，算符合修复后的 fail-closed 行为', () => {
  const verdict = judgeLongOutput({
    ok: false,
    failureClass: 'internal',
    detail: '模型输出 45000 字，超过一次检测能覆盖的 40000 字（2000×20）：为避免未经检测的文字上屏，本次不返回结果。',
    text: '',
    safety: null,
    warnings: [],
  }, INPUT_LIMIT, OUTPUT_LIMIT);
  assert.equal(verdict.pass, true, verdict.reasons.join('；'));
  assert.ok(verdict.reasons[0].includes('fail-closed'), verdict.reasons.join('；'));
});
