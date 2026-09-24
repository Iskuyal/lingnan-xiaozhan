/** Security regression tests run the compiled cloud-function entrypoints. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHarness, openAiTextResponse } = require('./ai-harness.cjs');

const STUDENT_A = 'student-a-openid';
const STUDENT_B = 'student-b-openid';

function wechatOk() {
  return {
    msgSecCheck: async () => ({ errCode: 0 }),
    imgSecCheck: async () => ({ errCode: 0 }),
  };
}

function chatEvent() {
  return { action: 'chat', feature: 'timetable-assistant', messages: [{ role: 'user', text: '今天有课吗' }] };
}

function photoFileId(openid) {
  const hash = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `cloud://example.bucket/timetable-imports/${hash}/mtest-12345678.png`;
}

function visionEvent(fileID) {
  return {
    action: 'vision',
    feature: 'timetable-screenshot',
    image: { fileID },
    messages: [{ role: 'user', text: '识别这张课表' }],
  };
}

test('SEC-01: 他人图片、裸路径、跨目录和无身份均在下载前被拒绝', async () => {
  for (const [openid, fileID] of [
    [STUDENT_A, photoFileId(STUDENT_B)],
    [STUDENT_A, 'timetable-imports/file.png'],
    [STUDENT_A, photoFileId(STUDENT_A).replace('/mtest-', '/../mtest-')],
    ['', photoFileId(STUDENT_A)],
  ]) {
    const h = createHarness({
      openid,
      downloadFile: async () => ({ fileContent: Buffer.from('fake-image') }),
      respond: () => openAiTextResponse('{}'),
    });
    const result = await h.main(visionEvent(fileID));
    assert.equal(result.ok, false, `必须拒绝：${fileID}`);
    assert.equal(result.failureClass, 'invalid_request');
    assert.equal(h.cloud.downloadFile.length, 0, '拒绝应早于云存储下载');
    assert.ok(!JSON.stringify(result).includes(fileID), '响应不得回显完整 fileID');
  }
});

test('SEC-01: 图片归属校验覆盖独立审核动作', async () => {
  const h = createHarness({
    openid: STUDENT_A,
    env: { AI_ADMIN_OPENIDS: STUDENT_A },
    downloadFile: async () => ({ fileContent: Buffer.from('fake-image') }),
  });
  const result = await h.main({ action: 'moderateImage', image: { fileID: photoFileId(STUDENT_B) } });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'invalid_request');
  assert.equal(h.cloud.downloadFile.length, 0);
});

test('SEC-02: 普通用户不能调用运维、独立审核动作或读取全局用量', async () => {
  const h = createHarness({ openid: STUDENT_B, env: { AI_ADMIN_OPENIDS: STUDENT_A }, security: wechatOk() });
  for (const event of [
    { action: 'usage', OPENID: STUDENT_A, admin: true },
    { action: 'probe', OPENID: STUDENT_A, admin: true },
    { action: 'moderateText', text: '测试' },
    { action: 'moderateImage', image: { base64: 'aGVsbG8=', mimeType: 'image/png' } },
  ]) {
    const response = await h.main(event);
    assert.equal(response.ok, false, `${event.action} 应被拒绝`);
    assert.equal(response.failureClass, 'invalid_request');
    assert.equal(response.usageSummary, null, '失败响应不能泄露全局用量');
  }
  assert.equal(h.cloud.msgSecCheck.length, 0);
  assert.equal(h.cloud.imgSecCheck.length, 0);
});

test('SEC-02: 探测动作受独立冷却限制', async () => {
  const h = createHarness({ openid: STUDENT_A, env: { AI_ADMIN_OPENIDS: STUDENT_A }, security: wechatOk() });
  const first = await h.main({ action: 'probe' });
  assert.equal(first.ok, true);
  const calls = h.cloud.msgSecCheck.length + h.cloud.imgSecCheck.length;
  const second = await h.main({ action: 'probe' });
  assert.equal(second.ok, false);
  assert.equal(second.failureClass, 'quota_exhausted');
  assert.equal(h.cloud.msgSecCheck.length + h.cloud.imgSecCheck.length, calls, '第二次不消耗内容安全配额');
});

test('SEC-02: 按用户限制一分钟和每日调用，拒绝发生在内容安全与模型之前', async () => {
  const h = createHarness({
    openid: STUDENT_B,
    env: { AI_ADMIN_OPENIDS: STUDENT_A, AI_USER_MINUTE_LIMIT: '2', AI_USER_DAILY_LIMIT: '3' },
    security: wechatOk(),
    respond: () => openAiTextResponse('今天没有课'),
  });
  assert.equal((await h.main(chatEvent())).ok, true);
  assert.equal((await h.main(chatEvent())).ok, true);
  const calls = h.http.length;
  const checks = h.cloud.msgSecCheck.length;
  const third = await h.main(chatEvent());
  assert.equal(third.failureClass, 'quota_exhausted');
  assert.equal(h.http.length, calls);
  assert.equal(h.cloud.msgSecCheck.length, checks);

  const daily = createHarness({
    openid: STUDENT_B,
    env: { AI_USER_MINUTE_LIMIT: '100', AI_USER_DAILY_LIMIT: '2' },
    security: wechatOk(),
    respond: () => openAiTextResponse('今天没有课'),
  });
  assert.equal((await daily.main(chatEvent())).ok, true);
  assert.equal((await daily.main(chatEvent())).ok, true);
  assert.equal((await daily.main(chatEvent())).failureClass, 'quota_exhausted');
});

test('SEC-02: 用量记录只存不可逆用户标识，普通响应不含全局汇总', async () => {
  const h = createHarness({ openid: STUDENT_B, security: wechatOk(), respond: () => openAiTextResponse('无课') });
  const response = await h.main(chatEvent());
  assert.equal(response.ok, true);
  assert.equal(response.usageSummary, null);
  const expected = crypto.createHash('sha256').update(STUDENT_B).digest('hex');
  for (const record of h.records) {
    assert.equal(record.userKey, expected);
    assert.ok(!JSON.stringify(record).includes(STUDENT_B));
  }

  const month = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
  const blocked = createHarness({
    openid: STUDENT_B,
    monthly: { [month]: { month, calls: 99, costYuan: 50, failures: 0 } },
    security: wechatOk(),
  });
  const denied = await blocked.main(chatEvent());
  assert.equal(denied.failureClass, 'quota_exhausted');
  assert.equal(denied.usageSummary, null);
  assert.ok(!denied.detail.includes('50'), '普通用户不应得到全局金额');
});

test('SEC-02: 无微信身份的业务调用不消耗内容安全或模型额度', async () => {
  const h = createHarness({ openid: '', security: wechatOk(), respond: () => openAiTextResponse('不应调用') });
  const response = await h.main(chatEvent());
  assert.equal(response.ok, false);
  assert.equal(response.failureClass, 'invalid_request');
  assert.equal(h.cloud.msgSecCheck.length, 0);
  assert.equal(h.http.length, 0);
});
