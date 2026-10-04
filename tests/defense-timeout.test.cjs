/**
 * A3：客户端云调用超时的兜底（2026-10-02，设计契约 5.1）。
 *
 * 契约：超过阈值未返回，按 `model_unavailable` 结束本次并**保留输入**。原写 30 秒——那写在实测
 * 12–23 秒的年代；G4 实测正常时延已到 20–45 秒，照 30 秒实现会砍掉正常请求。本文件锁四件事：
 * ① 阈值高于实测上界（不许改回 30 秒）；
 * ② 挂住的调用在超时后返回 `model_unavailable` 且**不抛错**；
 * ③ 阈值内返回照旧成功（正常路径行为不变）；
 * ④ 超时后失败态可重试、草稿与轮次不变，页面把失败卡上屏且不显示半截内容。
 *
 * 仓库约定：测试 require **构建产物**（`npm test` 会先 `npm run build`）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../dist/services/ai.js');
const defense = require('../dist/services/defense/index.js');

/** 装一个只有 `cloud.callFunction` 的 `wx` 桩；返回清理函数。 */
function stubCloud(callFunction) {
  const previous = global.wx;
  global.wx = { cloud: { callFunction } };
  return () => {
    if (previous === undefined) delete global.wx;
    else global.wx = previous;
  };
}

/** 永不 settle 的云调用：模拟「平台既没成功也没失败」。 */
const HANGING = () => new Promise(() => {});

const ANSWER = '课表是学生自己从教务系统下载后导入的，不用拿教务账号密码。';

test('超时阈值高于实测上界（不许改回 30 秒）', () => {
  assert.ok(
    ai.AI_CALL_TIMEOUT_MS >= 75000,
    `客户端超时阈值应 ≥75 秒，实际 ${ai.AI_CALL_TIMEOUT_MS}；30 秒会砍掉 20–45 秒的正常请求`,
  );
  assert.ok(ai.AI_CALL_TIMEOUT_MS > 45000, '必须高于 G4 真机实测上界 45 秒');
});

test('云调用挂住：超时返回 model_unavailable（不抛错），并在 warnings 里留标记', async () => {
  const restore = stubCloud(HANGING);
  try {
    const result = await ai.callAi({ action: 'chat' }, 20);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'model_unavailable');
    assert.equal(result.text, '');
    assert.equal(result.safety, null);
    assert.ok(result.warnings.includes(ai.CLIENT_TIMEOUT_WARNING), '超时要在 warnings 里留一条可排查的标记');
  } finally {
    restore();
  }
});

test('阈值内返回照旧成功（正常路径行为不变）', async () => {
  const restore = stubCloud(() => Promise.resolve({
    result: { ok: true, text: '【引用核对】F1', safety: { provider: 'x', api: 'y', passed: true, checked: true, detail: '' } },
  }));
  try {
    // 不传阈值 = 生产默认值；快速返回必须照旧成功。
    const result = await ai.callAi({ action: 'chat' });
    assert.equal(result.ok, true);
    assert.equal(result.text, '【引用核对】F1');
    assert.equal(ai.safetyChecked(result.safety), true);
  } finally {
    restore();
  }
});

test('答辩练习：超时进 model_unavailable，草稿与轮次不变、可重试', async () => {
  const restore = stubCloud(HANGING);
  try {
    const session = defense.submitAnswer(defense.createSession('FC-1'), ANSWER);
    const { call, transportNote } = await defense.requestFeedback(session, '这个功能是给谁、解决什么问题的？', 20);
    assert.notEqual(call, null, '超时不得退化成传输层异常（那是「没能发出去」文案）');
    assert.equal(call.failureClass, 'model_unavailable');
    const copy = defense.defenseFailureCopy(call, transportNote);
    assert.equal(copy.retryable, true);
    assert.match(copy.body, /你的回答/u);
    const failed = defense.recordFailure(session, copy);
    assert.equal(failed.phase, 'failure');
    assert.equal(failed.round, session.round, '失败不得推进轮次');
    assert.equal(failed.draft, ANSWER, '失败必须保留草稿');
    assert.deepEqual(failed.feedbacks, [], '失败不得产生反馈');
  } finally {
    restore();
  }
});

test('页面：model_unavailable（客户端超时也走这条）上屏失败卡、保留回答、可重试', async () => {
  let captured = null;
  const previousPage = global.Page;
  global.Page = (options) => { captured = options; };
  const restore = stubCloud(() => Promise.resolve({
    result: {
      ok: false, failureClass: 'model_unavailable', message: '', text: '', capWarning: '',
      safety: null, warnings: [ai.CLIENT_TIMEOUT_WARNING], citations: [], advancement: null,
    },
  }));
  try {
    delete require.cache[require.resolve('../dist/pages/defense/index.js')];
    require('../dist/pages/defense/index.js');
    const instance = Object.assign({}, captured, {
      data: JSON.parse(JSON.stringify(captured.data)),
      setData(patch) { Object.assign(this.data, patch); },
    });
    instance.onLoad();
    instance.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
    instance.onAnswerInput({ detail: { value: ANSWER } });
    instance.onSubmit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.data.phase, 'failure');
    assert.equal(instance.data.failureRetryable, true);
    assert.match(instance.data.failureBody, /重试/u);
    assert.ok(instance.data.answer.includes('教务系统'), '失败必须保留已写内容');
    assert.deepEqual(instance.data.sections, [], '失败不得显示半截反馈');
    instance.onUnload();
  } finally {
    restore();
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
  }
});
