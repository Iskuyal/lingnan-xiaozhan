/**
 * C 分支三页（校历 / 体测 / 升学）的界面契约测试（岭南红 UI 第二轮）。
 *
 * 只测「三页各自的诚实性红线」，服务层算法与既有页面行为仍由既有测试守：
 * 1. **校历**：没有官方日期的事项不显示日期、不给倒计时，也必须写明原因（待公布 / 以本校为准 /
 *    暂无官方日期）；显示出来的日期逐条来自 `CALENDAR_EVENTS`，页面不新造。
 * 2. **体测**：缺项时不显示学年总分与等级，且「已填项目的加权标准分」不会被摆成总分；
 *    单项分逐项等于 `estimate()` 的输出（页面不重算、不写死）；长跑三种写法都换算成秒。
 * 3. **升学**：`canAskModel` 为 false 时**不发模型请求**，直接给原文/固定话术；模型失败退回
 *    「原文摘录」；正文里的 `[S1]` 与「对应原文」区块互相引用；适用年份与人群上屏。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const pageFile = (route) => path.resolve(ROOT, 'dist', 'pages', route, 'index.js');
const wxmlOf = (route) => fs.readFileSync(path.resolve(ROOT, 'miniprogram', 'pages', route, 'index.wxml'), 'utf8');
/** 直接 require 构建产物里的服务模块（页面与测试看到的是同一份实现）。 */
const serviceOf = (name) => require(path.resolve(ROOT, 'dist', 'services', name));

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!key.includes('.')) {
        page.data[key] = value;
        continue;
      }
      const parts = key.split('.');
      let target = page.data;
      for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
      target[parts[parts.length - 1]] = value;
    }
  };
  return page;
}

/** 装载一页编译产物：返回页面对象与页面模块自己的导出（纯函数）。 */
function loadPage(route, wx, stack = [{}, {}]) {
  const filename = pageFile(route);
  const sandbox = {
    Page: (options) => {
      sandbox.page = instantiate(options);
    },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return { page: sandbox.page, api: sandbox.exports };
}

function wxBase() {
  const calls = { toast: [], navigate: [], clipboard: [], scroll: [] };
  const store = new Map();
  return {
    calls,
    store,
    wx: {
      navigateTo: (options) => calls.navigate.push(options.url),
      navigateBack: () => calls.navigate.push('back'),
      reLaunch: (options) => calls.navigate.push(options.url),
      switchTab: (options) => {
        calls.navigate.push(options.url);
        if (options.success) options.success();
      },
      setClipboardData: (options) => {
        calls.clipboard.push(options.data);
        if (options.success) options.success();
      },
      showToast: (options) => calls.toast.push(options.title),
      pageScrollTo: (options) => calls.scroll.push(options.scrollTop),
      getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
      setStorageSync: (key, value) => store.set(key, value),
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------- 校历 ----------

test('校历：没有官方日期的事项不显示日期、不给倒计时，但每一类都写明原因', () => {
  const stub = wxBase();
  const { page } = loadPage('calendar', stub.wx);
  page.onLoad({ today: '2026-09-29' });

  const rows = page.data.groups.flatMap((group) => group.rows);
  const undated = rows.filter((row) => row.date === '');
  assert.ok(undated.length >= 4, `未公布日期的事项应当在页面上如实出现：${undated.length}`);

  for (const row of undated) {
    assert.equal(row.dateText, '', `${row.id} 不该有日期文案`);
    assert.equal(row.days, null, `${row.id} 不该有倒计时`);
    assert.equal(/还有 \d+ 天|就是今天/.test(row.stateLabel), false, `${row.id} 的标签不能是倒计时`);
    // 「为什么没有日期」必须上屏（文字，不只靠颜色）
    assert.notEqual(row.dateHint, '', `${row.id} 需要一句日期状态说明`);
    assert.notEqual(row.guard, '', `${row.id} 需要写明原因`);
  }

  const pending = undated.find((row) => row.id === 'ncre-next');
  assert.equal(pending.dateHint, '日期待公布');
  assert.equal(pending.tone, 'warn');
  assert.match(pending.guard, /不沿用往年/);

  const perSchool = undated.find((row) => row.id === 'cet-2026h2-register');
  assert.equal(perSchool.dateHint, '日期以本校为准');
  assert.match(perSchool.guard, /不给全国统一截止日期/);

  const linkOnly = undated.find((row) => row.id === 'school-calendar');
  assert.equal(linkOnly.dateHint, '暂无官方日期');
  assert.equal(linkOnly.tone, 'plain');
});

test('校历：页面显示的日期逐条来自已有条目，不新造日期', () => {
  const stub = wxBase();
  const { page } = loadPage('calendar', stub.wx);
  page.onLoad({ today: '2026-09-29' });

  const calendar = serviceOf('calendar/index.js');
  const known = new Map(calendar.CALENDAR_EVENTS.map((event) => [event.id, event]));
  const rows = page.data.groups.flatMap((group) => group.rows);
  assert.equal(rows.length, calendar.CALENDAR_EVENTS.length);

  for (const row of rows) {
    const source = known.get(row.id);
    assert.ok(source !== undefined, `${row.id} 必须来自 services/calendar/events.ts`);
    assert.equal(row.date, source.date, `${row.id} 的日期不能与条目不同`);
    assert.match(row.sourceUrl, /^https:\/\//, `${row.id} 必须有可核对的原文链接`);
    assert.equal(row.verifiedAt, '2026-09-29');
  }

  const cet4 = rows.find((row) => row.id === 'cet-2026h2-cet4');
  assert.equal(cet4.dateText, '2026-12-12 09:00–11:20');
  assert.equal(cet4.stateLabel, '还有 74 天');
});

// ---------- 体测 ----------

const FULL_FORM = {
  height: '175',
  weight: '61.3',
  vitalCapacity: '4300',
  sprint50: '7.0',
  sitAndReach: '17.7',
  standingLongJump: '248',
  strength: '15',
};

function fillAll(page, form) {
  for (const [field, value] of Object.entries(form)) {
    page.onInput({ currentTarget: { dataset: { value: field } }, detail: { value } });
  }
}

test('体测：缺一项时不显示学年总分与等级，已填项的加权标准分不冒充总分', () => {
  const stub = wxBase();
  const { page } = loadPage('fitness', stub.wx);
  page.onLoad();
  fillAll(page, FULL_FORM);
  page.calculate();

  assert.equal(page.data.result.total, null, '缺项就没有学年总分');
  assert.equal(page.data.result.grade, null, '缺项就没有等级');
  assert.equal(page.data.totalText, '—');
  assert.ok(page.data.result.standardScore > 0, '已填项仍有加权标准分（服务层给出）');
  assert.equal(page.data.filledCount, 6);

  // 缺项列在「缺少的项目」里，并且名称旁就能补填
  assert.equal(page.data.missingRows.length, 1);
  const missing = page.data.missingRows[0];
  assert.match(missing.label, /跑/);
  assert.equal(missing.fields[0].field, 'distanceRun');

  // 单项明细仍在：7 行都渲染，只有缺的那项没有分数
  assert.equal(page.data.result.items.length, 7);
  const run = page.data.result.items.find((item) => item.key === 'distanceRun');
  assert.equal(run.score, null);
  assert.equal(run.valueText, '');

  // 总分卡只在 total 非空时渲染：缺项时页面上根本没有大分数
  const wxml = wxmlOf('fitness');
  assert.match(wxml, /wx:if="\{\{result\.total !== null\}\}"/);
  assert.match(wxml, /不给学年总分、也不给等级/);
  assert.match(wxml, /单项明细|已填项目的单项结果/);
});

test('体测：单项分逐项等于服务层 estimate 的结果，页面不重算', () => {
  const stub = wxBase();
  const { page } = loadPage('fitness', stub.wx);
  page.onLoad();
  fillAll(page, FULL_FORM);
  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '3′42″' } });
  page.calculate();

  const service = serviceOf('fitness/index.js');
  const expected = service.estimate({
    sex: 'male',
    band: 'freshman',
    height: 175,
    weight: 61.3,
    vitalCapacity: 4300,
    sprint50: 7.0,
    sitAndReach: 17.7,
    standingLongJump: 248,
    strength: 15,
    distanceRunSeconds: 222,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.result)), JSON.parse(JSON.stringify(expected)));
  assert.equal(page.data.missingRows.length, 0);
  assert.equal(page.data.filledCount, 7);
});

test('体测：长跑三种写法都换算成秒，非法写法不会被当成数字', () => {
  const stub = wxBase();
  const { page, api } = loadPage('fitness', stub.wx);
  page.onLoad();

  for (const written of ['3′42″', "3'42\"", '3:42', '222']) {
    page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: written } });
    assert.equal(page.data.runHint, '按 3 分 42 秒（222 秒）计算', `${written} 应当换算成 222 秒`);
  }

  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '三分四十二' } });
  assert.match(page.data.runHint, /可以写/);
  assert.equal(Number.isNaN(api.parseRunInput('三分四十二')), true);
  assert.equal(api.parseRunInput(''), undefined);
  assert.equal(api.parseNumberInput('  '), undefined);
  assert.equal(api.parseNumberInput('61.3'), 61.3);
});

test('体测：缺项就地补填后重新估算，才出现总分与等级', () => {
  const stub = wxBase();
  const { page } = loadPage('fitness', stub.wx);
  page.onLoad();
  fillAll(page, FULL_FORM);
  page.calculate();
  assert.equal(page.data.result.total, null);

  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '222' } });
  page.onRecalculate();
  assert.notEqual(page.data.result.total, null);
  assert.notEqual(page.data.result.grade, null);
  assert.equal(page.data.missingRows.length, 0);
  // 输入不落本机存储：身高体重等个人数据不留痕
  assert.deepEqual(Array.from(stub.store.keys()), []);
});

// ---------- 升学 ----------

/** 一次「服务端已核过出处」的模型调用结果，形状与云函数返回一致。 */
function verifiedCall(citations) {
  const sources = citations.map((citation) => ({
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
    text: '网上预报名时间为2026年1月12日09:00至19日18:00[S1]，缴费截止时间为1月23日17:00[S2]。',
    capWarning: '',
    safety: { provider: 'wechat', api: 'msgSecCheck', passed: true, checked: true, detail: '' },
    warnings: [],
    citations: [],
    advancement: { corpusVersion: 'test', verified: true, refused: false, violations: [], sources },
  };
}

test('升学：没有可核对出处时不发模型请求，直接给固定话术或原文', () => {
  const stub = wxBase();
  const ai = serviceOf('ai.js');
  const requested = [];
  const original = ai.callAi;
  ai.callAi = (event) => {
    requested.push(event);
    return new Promise(() => {});
  };
  try {
    const { page } = loadPage('advancement', stub.wx);
    page.onLoad();
    assert.equal(requested.length, 1, '首题有出处，才发了一次模型请求');

    // 类别不明 → clarify：不发请求，页面上是固定话术
    page.ask('报名时间是什么时候？');
    assert.equal(page.data.result.behavior, 'clarify');
    assert.equal(requested.length, 1, 'clarify 不花额度');
    assert.equal(page.data.modelPhase, 'idle');
    assert.equal(page.data.modelText, '');
    assert.equal(page.data.segments.length, 0);

    // 问分数线 → refuse：仍然不发请求，并给官方入口
    page.ask('2026年广东普通专升本录取分数线是多少？');
    assert.equal(page.data.result.behavior, 'refuse');
    assert.equal(requested.length, 1, 'refuse 不花额度');
    assert.ok(page.data.result.links.length > 0);

    // 澄清后变成可答：这时才发第二次请求
    page.ask('普通专升本的加分政策是什么？');
    assert.equal(page.data.result.behavior, 'clarify');
    assert.equal(requested.length, 1);
    page.onChoice({ currentTarget: { dataset: { value: '2026 年广东省' } } });
    assert.equal(page.data.result.behavior, 'answer');
    assert.equal(requested.length, 2);

    // 发给服务端的只有段落 id 与范围，不带原文正文
    const event = requested[1];
    assert.deepEqual(
      JSON.parse(JSON.stringify(event.passageIds)),
      page.data.result.citations.map((citation) => citation.passageId),
    );
    assert.equal(JSON.stringify(event).includes(page.data.result.citations[0].quote), false);
  } finally {
    ai.callAi = original;
  }
});

test('升学：模型失败时退回「原文摘录」，正文与出处编号仍能互相引用', async () => {
  const stub = wxBase();
  const ai = serviceOf('ai.js');
  const originalCall = ai.callAi;
  const originalTransport = ai.transportMessage;
  ai.callAi = () => Promise.reject(new Error('云端未部署'));
  ai.transportMessage = (error) => `传输失败：${error.message}`;
  try {
    const { page } = loadPage('advancement', stub.wx);
    page.onLoad();
    await flush();

    assert.equal(page.data.modelPhase, 'fallback');
    assert.equal(page.data.modelLabel, '原文摘录');
    assert.equal(page.data.modelText, page.data.result.answer, '降级时上屏的是本地原文，不是模型文字');
    assert.match(page.data.modelNote, /传输失败/);

    // 降级正文按引用顺序拼出编号，且每个编号都能在「对应原文」里找到
    const refs = page.data.segments.filter((segment) => segment.kind === 'ref').map((segment) => segment.ref);
    // 页面模块在 vm 沙箱里跑，数组原型与测试不同；比较前统一成本域的普通数组。
    assert.deepEqual(Array.from(refs), Array.from(page.data.sources, (source) => source.ref));
    assert.equal(refs[0], '[S1]');

    // 引用区块带适用年份与人群（不只给标题）
    const first = page.data.sources[0];
    assert.ok(page.data.sources.length > 0);
    assert.match(first.applicableText, /2026 年/);
    assert.notEqual(first.applicableAudience, '');
  } finally {
    ai.callAi = originalCall;
    ai.transportMessage = originalTransport;
  }
});

test('升学：模型解释上屏时，正文引用编号与「对应原文」区块一一对应', async () => {
  const stub = wxBase();
  const ai = serviceOf('ai.js');
  const originalCall = ai.callAi;
  try {
    const { page } = loadPage('advancement', stub.wx);
    // 首题请求先挂住不管；换成按页面当前结果构造的「已核过出处」返回再重试。
    ai.callAi = () => new Promise(() => {});
    page.onLoad();
    const citations = page.data.result.citations;
    ai.callAi = (event) => {
      assert.deepEqual(JSON.parse(JSON.stringify(event.passageIds)), citations.map((citation) => citation.passageId));
      return Promise.resolve(verifiedCall(citations));
    };
    page.onRetryModel();
    await flush();

    assert.equal(page.data.modelPhase, 'ready');
    assert.equal(page.data.modelLabel, 'AI 解释 · 依据官方原文');
    const textRefs = page.data.segments.filter((segment) => segment.kind === 'ref').map((segment) => segment.ref);
    assert.deepEqual(Array.from(textRefs), ['[S1]', '[S2]']);
    assert.deepEqual(Array.from(page.data.sources, (source) => source.ref), ['[S1]', '[S2]']);
    for (const ref of textRefs) {
      assert.ok(page.data.sources.some((source) => source.ref === ref), `${ref} 必须能在对应原文里找到`);
    }

    // 点正文编号 → 对应原文卡高亮；再点一次取消
    page.onJumpRef({ currentTarget: { dataset: { ref: '[S2]' } } });
    assert.equal(page.data.activeRef, '[S2]');
    page.onJumpRef({ currentTarget: { dataset: { ref: '[S2]' } } });
    assert.equal(page.data.activeRef, '');
  } finally {
    ai.callAi = originalCall;
  }
});

test('升学：适用范围（通道 / 年份 / 地区）与「非新年度报考依据」上屏', () => {
  const stub = wxBase();
  const ai = serviceOf('ai.js');
  const originalCall = ai.callAi;
  ai.callAi = () => new Promise(() => {});
  try {
    const { page, api } = loadPage('advancement', stub.wx);
    page.onLoad();
    assert.equal(page.data.scopeLabel, '2026 年已存政策 · 非新年度报考依据');
    assert.deepEqual(
      JSON.parse(JSON.stringify(page.data.scopeRows)),
      [
        { key: '通道', value: '普通专升本' },
        { key: '适用年份', value: '2026 年' },
        { key: '适用地区', value: '广东省' },
      ],
    );
    // 只有 answer 才给范围；澄清时不给（省得把范围按到错的题上）
    page.ask('报名时间是什么时候？');
    assert.equal(page.data.scopeLabel, '');
    assert.equal(page.data.scopeRows.length, 0);
    // 纯函数：没有正文时不硬造编号
    assert.deepEqual(JSON.parse(JSON.stringify(api.answerSegments('', []))), []);
  } finally {
    ai.callAi = originalCall;
  }
});
