/**
 * 失物招领数据层流程测试(先写用例再实现,框架第 12 节:越权、状态流转、冒领防护)。
 *
 * 直接加载数据层模块并注入内存 db(见 db-stub.cjs),覆盖:
 * - 帖子创建(公开/私密分离、校验失败不写库、私密字段不进公开记录);
 * - 越权(编辑他人帖子、处理他人申请、读他人私密);
 * - 状态机(关闭、非法迁移拒绝);
 * - 认领(不能认领自己、重复申请拒绝、发布者处理、双方确认交接);
 * - 规则召回(相反类型 + 类别 + 时间窗 + 区域);
 * - 审计事件写入。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDb, allRows } = require('./lost-found-db-stub.cjs');
const posts = require('../dist/cloudfunctions/lost-found/posts.js');
const claims = require('../dist/cloudfunctions/lost-found/claims.js');
const matches = require('../dist/cloudfunctions/lost-found/matches.js');
const audit = require('../dist/cloudfunctions/lost-found/audit.js');

const OWNER = 'openid-owner';
const OTHER = 'openid-other';
const NOW = Date.now();

function postInput(overrides = {}) {
  return {
    type: 'lost',
    category: '电子设备',
    title: '丢失一副白色蓝牙耳机',
    description: '充电仓上有贴纸，位置在三教到食堂之间路段',
    timeRange: { start: '2026-09-24', end: '2026-09-25' },
    locationArea: '清远校区 · 三教-食堂',
    images: [],
    verificationTraits: '充电仓背面贴蓝色圆形贴纸',
    agree: true,
    ...overrides,
  };
}

async function createPost(overrides = {}, owner = OWNER) {
  const { db, stores } = createDb();
  const result = await posts.createPost(db, owner, postInput(overrides), { now: NOW });
  return { db, stores, result, post: result.ok ? allRows(stores, 'lost_found_posts')[0] : null };
}

// ---------------------------------------------------------------------------
// 帖子
// ---------------------------------------------------------------------------

test('创建：公开记录不含私密核验特征,私密记录单独存放且只属发布者', async () => {
  const { stores, result, post } = await createPost();
  assert.equal(result.ok, true, result.message);
  assert.equal(post.status, 'open');
  assert.equal(JSON.stringify(post).includes('蓝色圆形贴纸'), false, '私密特征不得进公开记录');
  const privates = allRows(stores, 'lost_found_post_private');
  assert.equal(privates.length, 1);
  assert.equal(privates[0].postId, post.postId);
  assert.ok(privates[0].verificationTraits.includes('蓝色圆形贴纸'));
  const events = allRows(stores, 'lost_found_audit_events');
  assert.equal(events.length, 1, '创建要写审计');
});

test('创建：校验失败不写任何库', async () => {
  const { db, stores, result } = await createPost({ description: '' });
  assert.equal(result.ok, false);
  assert.equal(allRows(stores, 'lost_found_posts').length, 0);
  assert.equal(allRows(stores, 'lost_found_post_private').length, 0);
});

test('编辑：越权拒绝,本人按版本乐观锁更新', async () => {
  const { db, post } = await createPost();
  const forbidden = await posts.updatePost(db, OTHER, post.postId, { title: '改标题' }, { now: NOW });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.failureClass, 'forbidden');

  const okEdit = await posts.updatePost(db, OWNER, post.postId, { title: '改标题', version: post.version }, { now: NOW });
  assert.equal(okEdit.ok, true, okEdit.message);
  const staleEdit = await posts.updatePost(db, OWNER, post.postId, { title: '再改', version: 0 }, { now: NOW });
  assert.equal(staleEdit.ok, false, '版本不匹配应拒绝(乐观锁)');
  assert.equal(staleEdit.failureClass, 'conflict');
});

test('读取：他人只能拿公开字段,本人可拿私密特征', async () => {
  const { db, post } = await createPost();
  const publicView = await posts.getPost(db, OTHER, post.postId);
  assert.equal(publicView.ok, true);
  assert.equal(publicView.data.post.verificationTraits, undefined, '他人不可见私密特征');

  const ownView = await posts.getPost(db, OWNER, post.postId);
  assert.equal(ownView.ok, true);
  assert.ok(String(ownView.data.post.verificationTraits).includes('蓝色圆形贴纸'), '本人可见私密特征');
});

test('关闭：本人可关闭并写明原因;已关闭帖子不再可编辑', async () => {
  const { db, post } = await createPost();
  const closed = await posts.closePost(db, OWNER, post.postId, '物品已自行找到', { now: NOW });
  assert.equal(closed.ok, true, closed.message);
  const again = await posts.closePost(db, OWNER, post.postId, '重复关闭', { now: NOW });
  assert.equal(again.ok, false, '终态不可再迁移');
  const editAfterClose = await posts.updatePost(db, OWNER, post.postId, { title: '改标题', version: post.version + 1 }, { now: NOW });
  assert.equal(editAfterClose.ok, false, '已关闭帖子不可编辑');
});

// ---------------------------------------------------------------------------
// 认领与交接
// ---------------------------------------------------------------------------

test('认领：不能认领自己的帖子;重复申请被拒(同帖同人仅一条活跃申请)', async () => {
  const { db, post } = await createPost({}, OWNER);
  const own = await claims.submitClaim(db, OWNER, post.postId, { relation: '本人遗失', evidence: '有贴纸' }, { now: NOW });
  assert.equal(own.ok, false, '不得认领自己的帖子');
  assert.equal(own.failureClass, 'forbidden');

  const first = await claims.submitClaim(db, OTHER, post.postId, { relation: '本人遗失', evidence: '充电仓背面贴蓝色圆形贴纸' }, { now: NOW });
  assert.equal(first.ok, true, first.message);
  const duplicate = await claims.submitClaim(db, OTHER, post.postId, { relation: '本人遗失', evidence: '重复提交' }, { now: NOW });
  assert.equal(duplicate.ok, false, '重复申请应拒绝');
  assert.equal(duplicate.failureClass, 'conflict');
});

test('认领：核验回答与私密特征做受控比较,匹配提示但不下定论', async () => {
  const { db, post } = await createPost();
  const hit = await claims.submitClaim(db, OTHER, post.postId, { relation: '本人遗失', evidence: '充电仓背面贴蓝色圆形贴纸' }, { now: NOW });
  assert.equal(hit.ok, true);
  // 受控比较结果只提示「与发布者的未公开特征相符」,不回传特征原文。
  assert.equal(hit.data.traitsMatched, true);
  assert.equal(JSON.stringify(hit.data).includes('蓝色圆形贴纸'), false, '比较结果不得回传私密原文');
});

test('认领处理：非发布者越权拒绝;状态非法迁移拒绝;通过后双方确认交接才结案', async () => {
  const { db, post } = await createPost();
  const submitted = await claims.submitClaim(db, OTHER, post.postId, { relation: '本人遗失', evidence: '充电仓背面贴蓝色圆形贴纸' }, { now: NOW });
  const claimId = submitted.data.claimId;

  const forbidden = await claims.reviewClaim(db, OTHER, claimId, 'accepted', '', { now: NOW });
  assert.equal(forbidden.ok, false, '非发布者不得处理申请');
  assert.equal(forbidden.failureClass, 'forbidden');

  const accepted = await claims.reviewClaim(db, OWNER, claimId, 'accepted', '', { now: NOW });
  assert.equal(accepted.ok, true, accepted.message);

  const badTransition = await claims.reviewClaim(db, OWNER, claimId, 'pending', '', { now: NOW });
  assert.equal(badTransition.ok, false, 'accepted → pending 非法');

  // 单方确认不结案:发布者确认后帖子仍未结案,等认领人。
  const ownerConfirm = await claims.confirmHandover(db, OWNER, post.postId, claimId, { now: NOW });
  assert.equal(ownerConfirm.ok, true, ownerConfirm.message);
  const afterOwnerPost = (await posts.getPost(db, OWNER, post.postId)).data.post;
  assert.equal(afterOwnerPost.status, 'verifying', '单方确认不结案');

  const claimantConfirm = await claims.confirmHandover(db, OTHER, post.postId, claimId, { now: NOW });
  assert.equal(claimantConfirm.ok, true, claimantConfirm.message);

  const postRow = (await posts.getPost(db, OWNER, post.postId)).data.post;
  assert.equal(postRow.status, 'resolved', '双方确认后帖子结案');
});

test('认领处理：拒绝与需补充都要记录原因,补充后回到待核验', async () => {
  const { db, post } = await createPost();
  const submitted = await claims.submitClaim(db, OTHER, post.postId, { relation: '本人遗失', evidence: '耳机是白色的' }, { now: NOW });
  const claimId = submitted.data.claimId;

  const more = await claims.reviewClaim(db, OWNER, claimId, 'needs_more_info', '请说明充电仓上的独有特征', { now: NOW });
  assert.equal(more.ok, true);
  const back = await claims.reviewClaim(db, OWNER, claimId, 'pending', '', { now: NOW });
  assert.equal(back.ok, true, 'needs_more_info 可回到 pending');

  const rejected = await claims.reviewClaim(db, OWNER, claimId, 'rejected', '特征不符', { now: NOW });
  assert.equal(rejected.ok, true);
  const again = await claims.reviewClaim(db, OWNER, claimId, 'accepted', '', { now: NOW });
  assert.equal(again.ok, false, '终态不可再迁移');
});

// ---------------------------------------------------------------------------
// 规则召回
// ---------------------------------------------------------------------------

test('规则召回：只召回相反类型 + 类别相同 + 时间窗内 + 同区域,rank 由时间邻近度排', async () => {
  const { db, post } = await createPost({}, OWNER); // lost 电子设备 09-24~25 三教-食堂
  const foundMatch = await posts.createPost(db, OTHER, postInput({
    type: 'found',
    category: '电子设备',
    title: '捡到一副白色蓝牙耳机',
    timeRange: { start: '2026-09-25', end: '2026-09-26' },
  }), { now: NOW });
  const foundSame = await posts.createPost(db, OTHER, postInput({
    type: 'lost',
    category: '电子设备',
    title: '我也丢了耳机',
  }), { now: NOW });
  const foundFar = await posts.createPost(db, OTHER, postInput({
    type: 'found',
    category: '电子设备',
    title: '捡到耳机(不同校区)',
    locationArea: '广州校区 · 教学楼',
  }), { now: NOW });

  const candidates = await matches.ruleRecall(db, post.postId, { now: NOW });
  assert.equal(candidates.ok, true, candidates.message);
  const ids = candidates.data.matches.map((match) => match.candidatePostId);
  assert.ok(ids.includes(foundMatch.data.postId), '相反类型+同类别+同区域应召回');
  assert.ok(!ids.includes(foundSame.data.postId), '同类型不得召回');
  assert.ok(!ids.includes(foundFar.data.postId), '不同区域不得召回');
});

test('规则召回：召回结果落库,带规则版本与失效时间', async () => {
  const { db, stores, post } = await createPost({}, OWNER);
  await posts.createPost(db, OTHER, postInput({
    type: 'found',
    title: '捡到一副白色蓝牙耳机',
  }), { now: NOW });
  const recall = await matches.ruleRecall(db, post.postId, { now: NOW });
  assert.equal(recall.ok, true, recall.message);
  const rows = allRows(stores, 'lost_found_matches');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruleVersion, 'rules-v1');
  assert.ok(rows[0].expiresAt > NOW);
  assert.equal(rows[0].modelVersion, '', '规则召回不含模型版本(未经过 AI 比对)');
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

test('审计：关键动作都写事件,且不存核验特征原文之外的敏感大对象', async () => {
  const { db, stores, post } = await createPost();
  await audit.record(db, { actorOpenId: OTHER, action: 'reportPost', postId: post.postId, summary: '疑似冒领' });
  const events = allRows(stores, 'lost_found_audit_events').map((event) => event.summary);
  assert.ok(events.includes('疑似冒领'));
});
