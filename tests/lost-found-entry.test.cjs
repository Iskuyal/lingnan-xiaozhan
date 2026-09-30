const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDb, allRows } = require('./lost-found-db-stub.cjs');

function loadEntry(db, openid) {
  const filename = path.resolve('dist/cloudfunctions/lost-found/index.js');
  const moduleExports = {};
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: moduleExports, console,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: openid }) };
      return localRequire(name);
    },
  }, { filename });
  return moduleExports.main;
}

test('候选反馈云函数入口：拒绝其他账号，使用可信帖主身份写审计', async () => {
  const { db, stores } = createDb();
  await db.collection('lost_found_posts').add({ data: { _id: 'post-test', postId: 'post-test', ownerOpenId: 'owner-test' } });
  await db.collection('lost_found_matches').add({ data: { _id: 'match-test', matchId: 'match-test', sourcePostId: 'post-test', feedback: '' } });
  const input = { action: 'feedbackMatch', matchId: 'match-test', feedback: 'helpful', openid: 'owner-test' };
  const forbidden = await loadEntry(db, 'other-test')(input);
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.failureClass, 'forbidden');
  assert.equal(allRows(stores, 'lost_found_matches')[0].feedback, '');
  assert.equal(allRows(stores, 'lost_found_audit_events').length, 0);

  const accepted = await loadEntry(db, 'owner-test')({ ...input, openid: 'other-test' });
  assert.equal(accepted.ok, true);
  assert.equal(allRows(stores, 'lost_found_matches')[0].feedback, 'helpful');
  assert.equal(allRows(stores, 'lost_found_audit_events')[0].actorOpenId, 'owner-test');
});
