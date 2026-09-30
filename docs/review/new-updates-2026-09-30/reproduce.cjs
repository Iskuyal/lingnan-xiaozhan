// 本地审查复现；全部数据为内存合成值，不调用云端或微信 API。
// 先在仓库根目录 npm run build；存在审查缺陷时 exit 1。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const load = (p) => require(path.join(root, p));
const results = [];
function check(id, expected, actual) {
  let passed = true;
  try { assert.deepStrictEqual(actual, expected); } catch { passed = false; }
  results.push({ id, passed, expected, actual });
}
function pageFrom(relativePath, extra = {}) {
  let page;
  const filename = path.join(root, relativePath);
  const context = {
    require: (p) => require(path.resolve(path.dirname(filename), p)),
    exports: {}, console, wx: global.wx,
    Page: (definition) => { page = definition; },
    getCurrentPages: () => [{}, {}], ...extra,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.');
      let target = this.data;
      for (const segment of parts.slice(0, -1)) target = target[segment];
      target[parts.at(-1)] = value;
    }
  };
  return page;
}
async function main() {
  const ask = load('dist/services/advancement/index.js').ask;
  const cases = ['2027专升本什么时候报名？', '2026年湖南普通专升本什么时候报名？', '普通专升本什么时候报名？'];
  check('S1 适用范围不应直接回答', [false, false, false], cases.map((q) => ask(q).behavior === 'answer'));

  const ambiguous = '专升本和三二分段转段有什么区别？';
  const initial = ask(ambiguous);
  // 点真实澄清选项并确认缺失范围，原问题保持原样。
  const advancement = load('dist/services/advancement/index.js');
  const followups = initial.choices.map((choice) => {
    let scope = advancement.selectScope(initial, choice);
    let result = ask(ambiguous, 2, scope);
    for (let step = 0; step < 3 && result.behavior === 'clarify'; step += 1) {
      const selected = advancement.selectScope(result, result.choices[0]);
      if (selected === null) break;
      scope = { ...scope, ...selected };
      result = ask(ambiguous, 2, scope);
    }
    return result.behavior;
  });
  const wrongCategory = ask('中高职贯通三二分段（中职升高职） 三二分段报名是1月12日开始吗？');
  check('S2 澄清应消除歧义，未收录类别应拒答', { stillClarifying: false, uncollected: 'refuse' }, {
    stillClarifying: followups.some((behavior) => behavior === 'clarify'), uncollected: wrongCategory.behavior,
  });

  const fit = load('dist/services/fitness/index.js').estimate({ sex: 'male', band: 'freshman', height: 175,
    weight: 80, vitalCapacity: 4300, sprint50: 7, sitAndReach: 17.7, standingLongJump: 248, strength: 15, distanceRunSeconds: 222 });
  check('R1 BMI 超重应为 80 分', { bmiScore: 80, total: 81 }, { bmiScore: fit.items[0].score, total: fit.total });

  const { createDb, allRows } = load('tests/lost-found-db-stub.cjs');
  const { db, stores } = createDb();
  await db.collection('lost_found_claims').add({ data: { _id: 'claim-test', claimId: 'claim-test', postId: 'post-test',
    claimantOpenId: 'claimant-test', status: 'completed', evidence: '合成私密核验回答', relation: '本人遗失',
    version: 1, createdAt: 1, updatedAt: 1, ownerConfirmedAt: 1, claimantConfirmedAt: 1 } });
  await db.collection('lost_found_posts').add({ data: { _id: 'post-test', postId: 'post-test', ownerOpenId: 'owner-test', status: 'resolved' } });
  const leaked = await load('dist/cloudfunctions/lost-found/claims.js').confirmHandover(db, 'unrelated-test', 'post-test', 'claim-test', { now: 2 });
  check('R2 无关账号不得读取已完成申请', { ok: false, leaked: false }, { ok: leaked.ok, leaked: Boolean(leaked.data.claim?.evidence) });

  await db.collection('lost_found_matches').add({ data: { _id: 'match-test', matchId: 'match-test', sourcePostId: 'post-test', feedback: '' } });
  const filename = path.join(root, 'dist/cloudfunctions/lost-found/index.js');
  const moduleExports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: moduleExports, console,
    require(p) {
      if (p === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: 'unrelated-test' }) };
      return require(path.resolve(path.dirname(filename), p));
    },
  }, { filename });
  const feedback = await moduleExports.main({ action: 'feedbackMatch', matchId: 'match-test', feedback: 'misleading' });
  check('R3 入口须拒绝他人候选反馈', { ok: false, feedback: '' }, { ok: feedback.ok, feedback: allRows(stores, 'lost_found_matches')[0].feedback });

  const goals = load('dist/services/goals/index.js');
  let raw = JSON.stringify([{ id: 'old-test', name: '原有目标', date: '2026-12-01', countToday: false, createdAt: 1, updatedAt: 1 }]);
  let failRead = true;
  global.wx = { getStorageSync() { if (failRead) { failRead = false; throw Error('合成读取异常'); } return raw; }, setStorageSync(_key, value) { raw = value; } };
  try { goals.addGoal({ name: '新增目标', date: '2026-12-02', countToday: false }); } catch {}
  check('R4 读取异常不得覆盖旧记录', true, JSON.parse(raw).some((goal) => goal.id === 'old-test'));

  raw = '';
  let timers = 0;
  global.wx = { getStorageSync: () => raw, setStorageSync(_key, value) { raw = value; }, showToast() {}, showModal() {} };
  const editPage = pageFrom('dist/pages/goals/edit/index.js', { setTimeout() { timers += 1; } });
  editPage.onLoad({});
  editPage.onNameInput({ detail: { value: '合成目标' } });
  editPage.save(); editPage.save();
  check('R5 连续保存只应生成一条记录和一次返回', { records: 1, timers: 1 }, { records: JSON.parse(raw).length, timers });

  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.some((result) => !result.passed) ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 2; });
