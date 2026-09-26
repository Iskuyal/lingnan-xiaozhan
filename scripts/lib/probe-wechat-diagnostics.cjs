function diagnoseMissingProbe(result) {
  const detail = result && typeof result.detail === 'string' ? result.detail : '';
  if (result?.failureClass === 'invalid_request' && detail.includes('这项 AI 维护操作仅向维护者开放')) {
    return {
      kind: 'maintainer_not_allowlisted',
      message: '当前微信账号未通过 AI_ADMIN_OPENIDS 维护者白名单检查，探测没有执行；请核对云函数环境变量后重试。',
    };
  }
  return {
    kind: 'probe_record_missing',
    message: '云函数返回里没有有效的 probe 记录；请检查 ai 云函数版本、请求动作及调用结果。',
  };
}

module.exports = { diagnoseMissingProbe };
