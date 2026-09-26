const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendAttemptRecord, makeAttemptRecord, parseOptions } = require('../scripts/lib/ai-smoke-records.cjs');

test('AI 冒烟记录将模型不可用标成可重试，并保留失败响应', () => {
  const record = makeAttemptRecord({
    smokeAt: '2026-09-25T00:00:00.000Z',
    runId: 'test-run',
    attempt: 2,
    attempts: 3,
    request: { action: 'chat', feature: 'e2e-check', text: '固定测试文本' },
    result: { ok: false, failureClass: 'model_unavailable', message: '模型暂时不可用，请稍后再试。', detail: '空响应' },
  });

  assert.equal(record.retryable, true);
  assert.equal(record.ok, false);
  assert.equal(record.failureClass, 'model_unavailable');
  assert.equal(record.attempt, 2);
  assert.equal(record.response.detail, '空响应');
});

test('AI 冒烟 JSONL 追加保存连续运行，不覆盖之前的失败记录', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-match-smoke-'));
  const filename = path.join(folder, 'ai-smoke.jsonl');
  try {
    appendAttemptRecord(filename, { attempt: 1, ok: false, failureClass: 'model_unavailable' });
    appendAttemptRecord(filename, { attempt: 2, ok: true, failureClass: null });
    const rows = fs.readFileSync(filename, 'utf8').trim().split(/\r?\n/u).map((row) => JSON.parse(row));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].failureClass, 'model_unavailable');
    assert.equal(rows[1].ok, true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('AI 冒烟次数默认一次，并限制在 1 到 5 次之间', () => {
  assert.deepEqual(parseOptions([]), { attempts: 1 });
  assert.deepEqual(parseOptions(['--attempts=3']), { attempts: 3 });
  assert.throws(() => parseOptions(['--attempts=0']), /1 到 5/u);
  assert.throws(() => parseOptions(['--attempts=6']), /1 到 5/u);
});
