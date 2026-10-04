const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

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
