/**
 * 失物招领云函数纯逻辑测试（LF-3 阶段,先写无效输入与状态流转用例再实现,框架第 12 节）。
 *
 * 覆盖三类纯逻辑模块(编译产物,无外部依赖,直接加载):
 * - validate: 字段白名单、长度、枚举、时间范围、图片 fileID、联系方式记号;
 * - state: 帖子与认领的状态迁移合法性;
 * - security: 敏感信息检测与私密特征隔离判断。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const validate = require('../dist/cloudfunctions/lost-found/validate.js');
const state = require('../dist/cloudfunctions/lost-found/state.js');
const security = require('../dist/cloudfunctions/lost-found/security.js');

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function postInput(overrides = {}) {
  return {
    type: 'found',
    category: '校园卡',
    title: '捡到一张校园卡',
    description: '在图书馆二楼捡到，已交服务台',
    timeRange: { start: '2026-09-25', end: '2026-09-26' },
    locationArea: '清远校区 · 图书馆',
    images: [],
    verificationTraits: '卡套背面有蓝色贴纸',
    agree: true,
    ...overrides,
  };
}

test('validatePost：合法输入通过', () => {
  const result = validate.validatePost(postInput());
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('validatePost：空标题、超长标题、空描述、超长描述全部拒绝', () => {
  for (const overrides of [
    { title: '' },
    { title: '长'.repeat(31) },
    { description: '' },
    { description: '长'.repeat(501) },
  ]) {
    const result = validate.validatePost(postInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('validatePost：非法枚举（type/category/status）拒绝', () => {
  for (const overrides of [
    { type: 'stolen' },
    { type: '' },
    { category: '钱包（不在白名单）' },
    { category: '' },
  ]) {
    const result = validate.validatePost(postInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('validatePost：时间范围倒置、未来时间拒绝', () => {
  for (const overrides of [
    { timeRange: { start: '2026-09-26', end: '2026-09-25' } },
    { timeRange: { start: '2099-01-01', end: '2099-01-02' } },
  ]) {
    const result = validate.validatePost(postInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('validatePost：图片超 3 张、非法 fileID 前缀、非法扩展名拒绝', () => {
  for (const overrides of [
    { images: ['a', 'b', 'c', 'd'].map((s) => `cloud://env.bucket/lost-found/h/${s}.png`) },
    { images: ['cloud://env.bucket/elsewhere/h/x.png'] },
    { images: ['cloud://env.bucket/lost-found/h/x.gif'] },
  ]) {
    const result = validate.validatePost(postInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('validatePost：未同意授权、核验特征超长拒绝', () => {
  for (const overrides of [
    { agree: false },
    { verificationTraits: '密'.repeat(201) },
  ]) {
    const result = validate.validatePost(postInput(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('validatePost：公开描述里出现手机号/微信号拒绝（防联系方式泄露）', () => {
  for (const description of [
    '捡到校园卡，联系 13800138000',
    '联系我微信 wx_abc12345',
    '加 QQ 123456789',
  ]) {
    const result = validate.validatePost(postInput({ description }));
    assert.equal(result.ok, false, `应拒绝：${description}`);
  }
});

test('validateClaim：核验回答必填且限长，关系字段必填', () => {
  assert.equal(validate.validateClaim({ relation: '', evidence: '白色耳机' }).ok, false);
  assert.equal(validate.validateClaim({ relation: '本人遗失', evidence: '' }).ok, false);
  assert.equal(validate.validateClaim({ relation: '本人遗失', evidence: '密'.repeat(501) }).ok, false);
  assert.equal(validate.validateClaim({ relation: '本人遗失', evidence: '充电仓有贴纸' }).ok, true);
});

test('validateList：分页上限 20', () => {
  assert.equal(validate.validateList({ page: 0, pageSize: 21 }).ok, false);
  assert.equal(validate.validateList({ page: 0, pageSize: 20 }).ok, true);
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

test('state：帖子合法迁移', () => {
  for (const [from, to] of [
    ['draft', 'open'], ['draft', 'closed'],
    ['open', 'matching'], ['open', 'verifying'], ['open', 'closed'], ['open', 'suspended'],
    ['matching', 'open'], ['matching', 'verifying'], ['matching', 'closed'], ['matching', 'suspended'],
    ['verifying', 'open'], ['verifying', 'resolved'], ['verifying', 'closed'], ['verifying', 'suspended'],
    ['resolved', 'closed'],
    ['suspended', 'open'], ['suspended', 'closed'],
  ]) {
    assert.equal(state.canTransitionPost(from, to), true, `应允许：${from} → ${to}`);
  }
});

test('state：帖子非法迁移拒绝（跳过状态、从终态出发、回退）', () => {
  for (const [from, to] of [
    ['draft', 'resolved'], ['draft', 'verifying'],
    ['open', 'draft'],
    ['closed', 'open'], ['resolved', 'open'], ['resolved', 'verifying'],
    ['suspended', 'resolved'],
    ['open', 'unknown-state'], ['unknown-state', 'open'],
  ]) {
    assert.equal(state.canTransitionPost(from, to), false, `应拒绝：${from} → ${to}`);
  }
});

test('state：认领合法迁移', () => {
  for (const [from, to] of [
    ['pending', 'needs_more_info'], ['pending', 'accepted'], ['pending', 'rejected'], ['pending', 'cancelled'],
    ['needs_more_info', 'pending'], ['needs_more_info', 'rejected'], ['needs_more_info', 'cancelled'],
    ['accepted', 'completed'], ['accepted', 'cancelled'], ['accepted', 'disputed'],
    ['disputed', 'completed'], ['disputed', 'cancelled'],
  ]) {
    assert.equal(state.canTransitionClaim(from, to), true, `应允许：${from} → ${to}`);
  }
});

test('state：认领非法迁移拒绝（终态不可再动）', () => {
  for (const [from, to] of [
    ['rejected', 'pending'], ['cancelled', 'pending'], ['completed', 'disputed'],
    ['pending', 'completed'], ['accepted', 'rejected'], ['pending', 'unknown'],
  ]) {
    assert.equal(state.canTransitionClaim(from, to), false, `应拒绝：${from} → ${to}`);
  }
});

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------

test('security：联系方式记号检测（手机/微信/QQ）', () => {
  assert.equal(security.hasContactToken('捡到校园卡 联系 13800138000'), true);
  assert.equal(security.hasContactToken('微信 wx_abc12345'), true);
  assert.equal(security.hasContactToken('QQ 123456789'), true);
  assert.equal(security.hasContactToken('在图书馆二楼捡到校园卡'), false);
});

test('security：图片 fileID 必须属于本人前缀（防引用他人上传）', () => {
  assert.equal(security.isOwnImage('cloud://env.bucket/lost-found/ab12cd/x.png', 'ab12cd'), true);
  assert.equal(security.isOwnImage('cloud://env.bucket/lost-found/ab12cd/x.png', 'ef34gh'), false);
  assert.equal(security.isOwnImage('cloud://env.bucket/other/ab12cd/x.png', 'ab12cd'), false);
});

test('security：核验特征不得出现在候选解释里（解释包含私密原文即泄漏）', () => {
  const traits = '卡套背面有蓝色贴纸';
  const explanations = [
    { similarities: ['类别一致'], conflicts: [], uncertainties: [] },
    { similarities: ['卡套背面有蓝色贴纸'], conflicts: [], uncertainties: [] },
  ];
  assert.equal(security.explanationsLeakPrivate(explanations[0], traits), false);
  assert.equal(security.explanationsLeakPrivate(explanations[1], traits), true);
});
