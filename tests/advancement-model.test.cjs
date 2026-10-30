/**
 * 升学 / 实习问答的模型版（Issue #94）：客户端行为测试。
 *
 * 这一层要证明的三件事：
 * 1. **只有检索到原文才调用模型**——澄清/拒答这一路不发请求（不花额度，也不给模型无依据作答的机会）；
 * 2. **模型文字不是「返回了就上屏」**：服务端的出处校验结论（`advancement.verified`）才是上屏依据；
 * 3. **过期回答不上屏**：换问题或点取消之后，在途的模型回答落到别的题目下面是不允许的。
 *
 * 页面部分用 vm 加载编译产物、桩掉 `callAi`（真实请求形状由 ai-advancement.test.cjs 在服务端侧覆盖）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const model = require('../dist/services/advancement/model.js');
const ai = require('../dist/services/ai.js');
const advancement = require('../dist/services/advancement/index.js');

const PAGE_FILE = path.resolve('dist/pages/advancement/index.js');

/** 一次成功的服务端返回（`advancement` 里带校验结论，形状与云函数一致）。 */
function callResult(overrides = {}) {
  const sources = advancement.ask('2026年广东普通专升本什么时候网上预报名？').citations.map((citation) => ({
    id: citation.passageId,
    documentId: citation.documentId,
    title: citation.title,
    documentNumber: citation.documentNumber,
    issuer: citation.issuer,
    publishedAt: citation.publishedAt,
    applicableYear: citation.applicableYear,
    applicableRegion: citation.applicableRegion,
    collectedAt: citation.collectedAt,
    sourceUrl: citation.sourceUrl,
    quote: citation.quote,
  }));
  return {
    ok: true,
    failureClass: '',
    message: '',
    text: '网上预报名时间为2026年1月12日09:00至19日18:00[S1]。',
    capWarning: '',
    safety: { provider: 'wechat', api: 'msgSecCheck', passed: true, checked: true, detail: '' },
    warnings: [],
    citations: [],
    advancement: { corpusVersion: 'adv-corpus-34e8bcf7a71c', verified: true, refused: false, violations: [], sources },
    ...overrides,
  };
}

/** 装载页面：桩掉 wx 与 callAi，返回页面对象、请求记录与一个可控的 Promise。 */
function loadPage() {
  const calls = { ai: [], toast: [], clipboard: [], navigate: [] };
  /** 未决请求：每次 startModel 造一个，测试自己决定何时 resolve/reject。 */
  const pending = [];
  ai.callAi = (event) => {
    calls.ai.push(event);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pending.push({ event, resolve, reject, promise });
    return promise;
  };
  const originalTransport = ai.transportMessage;
  ai.transportMessage = (error) => `传输失败：${error && error.message ? error.message : String(error)}`;

  const wx = {
    setClipboardData: (options) => { calls.clipboard.push(options.data); if (options.success) options.success(); },
    showToast: (options) => calls.toast.push(options.title),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (options) => calls.navigate.push(options.url),
  };
  let page;
  vm.runInNewContext(fs.readFileSync(PAGE_FILE, 'utf8'), {
    Page: (options) => {
      page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
      page.setData = (patch) => {
        for (const [key, value] of Object.entries(patch)) page.data[key] = value;
      };
    },
    wx,
    getCurrentPages: () => [{}, {}],
    require: createRequire(PAGE_FILE),
    exports: {},
    console,
  }, { filename: PAGE_FILE });
  return { page, calls, pending, restore: () => { ai.transportMessage = originalTransport; } };
}

/** 等一次微任务链跑完（页面里的 promise then 都是同一条链）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------- 服务层：提示词与事件 ----------

test('提示词与事件形状：只给段落 id，正文由服务端注入，客户端不夹带「官方原文」', () => {
  const question = '2026年广东普通专升本什么时候网上预报名？';
  const result = advancement.ask(question);
  const event = model.advancementChatEvent(question, result.resolvedScope, result.citations);
  assert.equal(event.action, 'chat');
  assert.equal(event.feature, 'advancement-qa');
  assert.equal(event.messages.length, 1);
  assert.equal(event.messages[0].role, 'user');
  assert.equal(event.messages[0].text, question);
  assert.deepEqual(JSON.parse(JSON.stringify(event.scope)), { category: 'ordinary_专升本', year: 2026, region: '广东省' });
  assert.deepEqual(JSON.parse(JSON.stringify(event.passageIds)), result.citations.map((citation) => citation.passageId));
  assert.equal(event.maxTokens, 1200, '按负责人确认的上限为推理与完整原句留出余量');
  // 提示词是纪律，不含资料正文（资料由服务端按 passageIds 注入）。
  for (const citation of result.citations) {
    assert.equal(event.system.includes(citation.quote), false);
  }
  assert.match(event.system, /\[S1\]/);
  assert.match(event.system, /无法核实/);
});

test('canAskModel：只有「答案 + 有出处的段落」才发模型请求', () => {
  const answer = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  assert.equal(model.canAskModel(answer), true);
  const clarify = advancement.ask('报名时间是什么时候？');
  assert.equal(clarify.behavior, 'clarify');
  assert.equal(model.canAskModel(clarify), false);
  const refuse = advancement.ask('2026年广东普通专升本录取分数线是多少？');
  assert.equal(refuse.behavior, 'refuse');
  assert.equal(model.canAskModel(refuse), false);
  assert.equal(model.canAskModel(null), false);
  // 防御：答案缺 authoritative 范围时也不发（服务端会拒，别浪费一次调用）。
  assert.equal(model.canAskModel({ ...answer, resolvedScope: undefined }), false);
});

// ---------- 服务层：上屏判定 ----------

test('modelOutcome：服务端校验通过才上屏模型解释', () => {
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  const outcome = model.modelOutcome({ call: callResult(), transportNote: '', result });
  assert.equal(outcome.kind, 'model');
  assert.match(outcome.text, /2026年1月12日/);
  assert.equal(outcome.sources.length, result.citations.length);
  assert.match(outcome.note, /内容安全已检测/);
});

test('modelOutcome：没有校验结论、校验不通过、调用失败一律降级为原文摘录', () => {
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  const cases = [
    { label: '调用未到达云端', input: { call: null, transportNote: '传输失败：未部署', result } },
    { label: '模型不可用', input: { call: callResult({ ok: false, failureClass: 'model_unavailable', message: '模型暂时不可用', text: '' }), transportNote: '', result } },
    {
      label: '出处校验未过',
      input: {
        call: callResult({
          ok: false,
          failureClass: 'citation_unverified',
          message: '这条回答没能核对上官方原文的出处，已改为展示检索到的原文摘录。',
          text: '',
          advancement: { corpusVersion: 'adv-corpus-34e8bcf7a71c', verified: false, refused: false, violations: ['s1:unsupported_number'], sources: callResult().advancement.sources },
        }),
        transportNote: '',
        result,
      },
    },
    { label: '服务端没给校验结论', input: { call: callResult({ advancement: null }), transportNote: '', result } },
    {
      label: '声称 ok 但没核过',
      input: { call: callResult({ advancement: { corpusVersion: 'adv-corpus-34e8bcf7a71c', verified: false, refused: false, violations: [], sources: [] } }), transportNote: '', result },
    },
  ];
  for (const item of cases) {
    const outcome = model.modelOutcome(item.input);
    assert.equal(outcome.kind, 'fallback', item.label);
    assert.equal(outcome.text, result.answer, `${item.label}：降级后展示的是本地原文摘录`);
    assert.ok(outcome.note.length > 0, `${item.label}：要说明为什么降级`);
    if (item.label === '出处校验未过') {
      assert.match(outcome.note, /s1:unsupported_number/);
      assert.match(outcome.note, /没能核对上官方原文的出处/);
    }
  }
  // 降级时绝不显示模型文字。
  const failed = model.modelOutcome({
    call: callResult({ ok: false, failureClass: 'citation_unverified', text: '网上缴费截止时间为1月30日17:00[S1]。', advancement: { corpusVersion: 'v', verified: false, refused: false, violations: ['s1:unsupported_number'], sources: [] } }),
    transportNote: '',
    result,
  });
  assert.equal(failed.text.includes('1月30日'), false);
});

test('modelOutcome：模型自己说无法核实 → 拒答形态，并把原文列出来', () => {
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  const outcome = model.modelOutcome({
    call: callResult({
      text: '无法核实',
      advancement: { corpusVersion: 'adv-corpus-34e8bcf7a71c', verified: true, refused: true, violations: [], sources: [] },
    }),
    transportNote: '',
    result,
  });
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.text, '无法核实');
  assert.match(outcome.note, /无法核实/);
});

test('modelOutcome：降级时不说「本轮回答未经内容安全检测」（上屏的是官方原文，不是 AI 内容）', () => {
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  const outcome = model.modelOutcome({
    call: callResult({
      ok: false,
      failureClass: 'quota_exhausted',
      message: '今日 AI 调用次数已达上限，请稍后再试。',
      text: '',
      // 额度在模型之前就被拦下：safety 为空只是因为这次请求根本没到检测那一步。
      safety: null,
      advancement: null,
    }),
    transportNote: '',
    result,
  });
  assert.equal(outcome.kind, 'fallback');
  assert.match(outcome.note, /今日 AI 调用次数已达上限/);
  assert.equal(outcome.note.includes('没有经过内容安全检测'), false);
});

test('modelOutcome：内容安全没有真正执行时，说明里点出来', () => {
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  const outcome = model.modelOutcome({
    call: callResult({ safety: { provider: 'off', api: '', passed: false, checked: false, detail: '未检测' } }),
    transportNote: '',
    result,
  });
  assert.equal(outcome.kind, 'model');
  assert.match(outcome.note, /未检测/);
});

test('服务端返回解析：advancement 只有 verified === true 才算通过，坏条目丢弃', () => {
  // 字符串 'true' 不是 true：宁可当作没核过。
  const loose = ai.advancementOf({ corpusVersion: 'v', verified: 'true', refused: false, violations: [], sources: [] });
  assert.equal(loose.verified, false);
  const good = ai.advancementOf({
    corpusVersion: 'v',
    verified: true,
    refused: false,
    violations: ['s1:uncited_claim'],
    sources: [
      { id: 'a', documentId: 'd', title: 't', documentNumber: '', issuer: 'i', publishedAt: 'p', applicableYear: 2026, applicableRegion: '广东省', collectedAt: 'c', sourceUrl: 'u', quote: 'q' },
      { id: 'bad' },
    ],
  });
  assert.equal(good.verified, true);
  assert.deepEqual(JSON.parse(JSON.stringify(good.violations)), ['s1:uncited_claim']);
  assert.equal(good.sources.length, 1);
  assert.equal(ai.advancementOf(null), null);
});

// ---------- 页面：三态与过期请求 ----------

test('页面：提问 → 等待 → 模型解释上屏（引用编号与出处卡片对应）', async () => {
  const { page, calls, pending, restore } = loadPage();
  try {
    page.onLoad();
    assert.equal(page.data.hasResult, true);
    assert.equal(page.data.result.behavior, 'answer');
    assert.equal(page.data.modelPhase, 'loading');
    assert.equal(calls.ai.length, 1, '有原文依据才发模型请求');
    const event = calls.ai[0];
    assert.equal(event.feature, 'advancement-qa');
    assert.equal(event.messages[0].text, '2026年广东普通专升本什么时候网上预报名？');
    assert.deepEqual(JSON.parse(JSON.stringify(event.passageIds)), page.data.result.citations.map((citation) => citation.passageId));

    pending[0].resolve(callResult());
    await flush();
    assert.equal(page.data.modelPhase, 'ready');
    assert.equal(page.data.modelLabel, 'AI 解释 · 依据官方原文');
    assert.match(page.data.modelText, /2026年1月12日/);
    assert.equal(page.data.modelRefused, false);
  } finally {
    restore();
  }
});

test('页面：换问题后，上一个问题的模型回答不上屏', async () => {
  const { page, calls, pending, restore } = loadPage();
  try {
    page.onLoad();
    // 第二个问题：换成一个会先澄清的题（不发模型请求），第一题的答案随后才回来。
    page.ask('转段考核包括哪几个部分？');
    assert.equal(page.data.modelPhase, 'idle');
    assert.equal(calls.ai.length, 1, '澄清路径不再发模型请求');

    pending[0].resolve(callResult());
    await flush();
    assert.equal(page.data.modelPhase, 'idle', '第一题的回答不能落到第二题下面');
    assert.equal(page.data.modelText, '');
    assert.equal(page.data.asked, '转段考核包括哪几个部分？');
  } finally {
    restore();
  }
});

test('页面：取消等待后立刻显示原文摘录，在途回答作废', async () => {
  const { page, pending, restore } = loadPage();
  try {
    page.onLoad();
    assert.equal(page.data.modelPhase, 'loading');
    const localAnswer = page.data.result.answer;
    page.onCancelModel();
    assert.equal(page.data.modelPhase, 'fallback');
    assert.equal(page.data.modelText, localAnswer);
    assert.match(page.data.modelNote, /已取消/);

    pending[0].resolve(callResult());
    await flush();
    assert.equal(page.data.modelPhase, 'fallback');
    assert.equal(page.data.modelText, localAnswer, '取消之后回来的回答也不许上屏');
  } finally {
    restore();
  }
});

test('页面：模型失败时降级显示原文摘录，并可重试', async () => {
  const { page, calls, pending, restore } = loadPage();
  try {
    page.onLoad();
    pending[0].reject(new Error('云端未部署'));
    await flush();
    assert.equal(page.data.modelPhase, 'fallback');
    assert.equal(page.data.modelLabel, '原文摘录');
    assert.equal(page.data.modelText, page.data.result.answer);
    assert.match(page.data.modelNote, /传输失败/);

    page.onRetryModel();
    assert.equal(page.data.modelPhase, 'loading');
    assert.equal(calls.ai.length, 2);
    pending[1].resolve(callResult({ text: '重试后的解释[S1]。' }));
    await flush();
    assert.equal(page.data.modelPhase, 'ready');
    assert.equal(page.data.modelText, '重试后的解释[S1]。');
  } finally {
    restore();
  }
});

test('页面：澄清与拒答都不调用模型，也不显示模型块', async () => {
  const { page, calls, restore } = loadPage();
  try {
    page.onLoad();
    page.ask('报名时间是什么时候？');
    assert.equal(page.data.result.behavior, 'clarify');
    assert.equal(page.data.modelPhase, 'idle');
    page.ask('2026年广东普通专升本录取分数线是多少？');
    assert.equal(page.data.result.behavior, 'refuse');
    assert.equal(page.data.modelPhase, 'idle');
    assert.equal(page.data.modelText, '');
    assert.equal(calls.ai.length, 1, '两次守门提问都不发模型请求（只有 onLoad 那次答案题发过）');
  } finally {
    restore();
  }
});

test('页面：澄清选项把问题变成答案后，也会走模型解释', async () => {
  const { page, calls, pending, restore } = loadPage();
  try {
    page.onLoad();
    page.ask('普通专升本的加分政策是什么？');
    assert.equal(page.data.result.behavior, 'clarify');
    assert.equal(calls.ai.length, 1);
    page.onChoice({ currentTarget: { dataset: { value: '2026 年广东省' } } });
    assert.equal(page.data.result.behavior, 'answer');
    assert.equal(page.data.asked, '普通专升本的加分政策是什么？', '保留原问题');
    assert.equal(page.data.modelPhase, 'loading');
    assert.equal(calls.ai.length, 2);
    pending[1].resolve(callResult());
    await flush();
    assert.equal(page.data.modelPhase, 'ready');
  } finally {
    restore();
  }
});

test('页面源码不再自称「没有接模型」，也不再直接调用 wx.cloud', () => {
  const pageSource = fs.readFileSync(PAGE_FILE, 'utf8');
  const wxml = fs.readFileSync('miniprogram/pages/advancement/index.wxml', 'utf8');
  assert.equal(pageSource.includes('wx.cloud'), false, '页面只能经 services/ai 调用');
  assert.equal(wxml.includes('没有接模型'), false);
  assert.match(wxml, /AI 依据原文解释/);
  // 检索服务本身仍然完全不碰网络与云函数（本地确定性守门）。
  const serviceSource = fs.readFileSync('dist/services/advancement/index.js', 'utf8');
  assert.equal(serviceSource.includes('callFunction'), false);
  assert.equal(serviceSource.includes('wx.cloud'), false);
});
