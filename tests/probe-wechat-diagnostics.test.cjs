const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseMissingProbe } = require('../scripts/lib/probe-wechat-diagnostics.cjs');

test('探测结果缺失时，仅将明确的维护者白名单拒绝归因到账号权限', () => {
  const denied = diagnoseMissingProbe({
    failureClass: 'invalid_request',
    detail: '这项 AI 维护操作仅向维护者开放',
  });
  assert.equal(denied.kind, 'maintainer_not_allowlisted');
  assert.match(denied.message, /AI_ADMIN_OPENIDS/u);

  const unknown = diagnoseMissingProbe({ failureClass: 'invalid_request', detail: '未知动作' });
  assert.equal(unknown.kind, 'probe_record_missing', '其他参数错误不能误判为白名单问题');
});
