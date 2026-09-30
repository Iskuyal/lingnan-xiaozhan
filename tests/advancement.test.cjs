const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 升学 / 实习问答（Issue #94，本地演示形态）：服务层与 20 道 PoC 固定题对齐。
// 题目与期望答案在 docs/evidence/advancement-poc/questions.json——测试直接读它，
// 这样「PoC 报告」与「小程序里的回答」用的是同一批题与同一个标准，不会各写一套。
const advancement = require('../dist/services/advancement/index.js');
const questionSet = JSON.parse(fs.readFileSync('docs/evidence/advancement-poc/questions.json', 'utf8'));
const corpus = JSON.parse(fs.readFileSync('docs/evidence/advancement-poc/corpus.json', 'utf8'));

const PASSAGE_TEXTS = new Set(
  corpus.documents.flatMap((document) => document.passages.map((passage) => passage.text)),
);

test('语料自检：四份文档、段落齐全、每条都有 https 出处与核查日', () => {
  assert.equal(advancement.ADVANCEMENT_DOCUMENTS.length, 4);
  const passages = advancement.ADVANCEMENT_DOCUMENTS.flatMap((document) => document.passages);
  assert.equal(passages.length, 25);
  for (const document of advancement.ADVANCEMENT_DOCUMENTS) {
    assert.match(document.sourceUrl, /^https?:\/\//, `${document.id} 缺少官方链接`);
    assert.equal(document.collectedAt, '2026-09-29');
    assert.ok(document.title !== '' && document.issuer !== '');
  }
  for (const passage of passages) {
    assert.ok(passage.text.trim() !== '', `${passage.id} 段落为空`);
    assert.ok(passage.context.trim() !== '', `${passage.id} 缺检索用 context`);
    assert.equal(PASSAGE_TEXTS.has(passage.text), true, `${passage.id} 的原文与 PoC 语料不一致`);
  }
  // 语料里不许出现岗位/薪资这类实时数据（票面要求：不宣称实时岗位全集）
  for (const document of advancement.ADVANCEMENT_DOCUMENTS) {
    for (const passage of document.passages) {
      assert.ok(!/月薪|薪资|时薪/.test(passage.text), `${passage.id} 疑似含薪资信息`);
    }
  }
});

test('20 道固定题：行为与引用都与 PoC 预登记的一致', () => {
  for (const item of questionSet.questions) {
    // 历史事实题的已知范围须显式确认，不能再靠服务默认为广东 2026。
    const result = advancement.ask(item.question, 2, item.behavior === 'answer' ? { year: 2026, region: '广东省' } : {});
    assert.equal(result.behavior, item.behavior, `${item.id}（${item.question}）行为不对：${result.behavior}`);

    if (item.behavior === 'answer') {
      // 引用必须是语料里的逐字原文，且含该题预登记的关键事实串
      assert.ok(result.citations.length > 0, `${item.id} 没有给出出处`);
      for (const citation of result.citations) {
        assert.equal(PASSAGE_TEXTS.has(citation.quote), true, `${item.id} 的引用不是语料原文：${citation.quote}`);
        assert.match(citation.sourceUrl, /^https?:\/\//);
        assert.ok(citation.publishedAt !== '' || citation.documentId === 'gd-employment-portal');
      }
      const quoted = result.citations.map((citation) => citation.quote).join('\n');
      for (const needle of item.mustContain) {
        assert.ok(quoted.includes(needle), `${item.id} 的引用里没有「${needle}」：${quoted}`);
      }
      // 回答 = 原文摘录（不改写）：回答文本必须能由引用拼出来
      assert.equal(result.answer, result.citations.map((citation) => citation.quote).join('\n'));
      assert.equal(result.choices.length, 0);
      assert.equal(result.links.length, 0);
    }

    if (item.behavior === 'clarify') {
      assert.ok(result.choices.length > 0, `${item.id} 澄清时应当给可选项`);
      assert.equal(result.citations.length, 0);
    }

    if (item.behavior === 'refuse') {
      assert.match(result.answer, /无法核实/, `${item.id} 拒答文案不对：${result.answer}`);
      assert.equal(result.citations.length, 0, `${item.id} 拒答时不该给引用`);
      assert.ok(result.links.length > 0, `${item.id} 拒答时应当给官方入口`);
    }
  }
});

test('跨类型与类别不明：先说清两种「三二分段」，不混答', () => {
  const loose = advancement.ask('三二分段报名是1月12日开始，对吗？');
  assert.equal(loose.behavior, 'clarify');
  assert.deepEqual(loose.choices, ['中高职贯通三二分段（中职升高职）', '三二分段专升本转段（高职升本科）']);

  const compare = advancement.ask('专升本和三二分段转段有什么区别？');
  assert.equal(compare.behavior, 'clarify');
  assert.equal(compare.choices.length, 2);

  const vague = advancement.ask('报名时间是什么时候？');
  assert.equal(vague.behavior, 'clarify');
  assert.equal(vague.choices.length, 3);
});

test('年份未收录与语料不含的数据：拒答并给官方入口，不沿用旧年份', () => {
  const nextYear = advancement.ask('2027年的专升本政策出来了吗？');
  assert.equal(nextYear.behavior, 'refuse');
  assert.match(nextYear.answer, /只收录 2026 年/);
  assert.match(nextYear.answer, /不会把 2026 年的日期当成 2027 年/);

  const line = advancement.ask('今年录取分数线是多少？');
  assert.equal(line.behavior, 'refuse');
  assert.match(line.answer, /没有录取分数线/);

  const jobs = advancement.ask('现在有哪些实习岗位？薪资多少？');
  assert.equal(jobs.behavior, 'refuse');
  assert.match(jobs.answer, /不提供实时信息/);
  assert.ok(jobs.links.some((link) => link.url.includes('edu.gd.gov.cn')));
});

test('空问题与无关问题：不硬答', () => {
  assert.equal(advancement.ask('').behavior, 'clarify');
  assert.equal(advancement.ask('   ').behavior, 'clarify');
  assert.equal(advancement.ask('校园卡在哪里补办？').behavior, 'refuse');
});

test('适用范围：年份简写、缺失范围、异省与冲突年份都不能用广东 2026 年资料硬答', () => {
  for (const q of ['2027专升本什么时候报名？', '2025普通专升本什么时候报名？', '2026年湖南普通专升本什么时候报名？', '2026广东和湖南普通专升本报名时间一样吗？']) {
    const result = advancement.ask(q);
    assert.equal(result.behavior, 'refuse', q);
    assert.equal(result.citations.length, 0);
  }
  for (const q of ['普通专升本什么时候报名？', '2026专升本什么时候报名？', '广东普通专升本什么时候报名？', '2026和2027年广东普通专升本什么时候报名？']) {
    const result = advancement.ask(q);
    assert.equal(result.behavior, 'clarify', q);
    assert.equal(result.citations.length, 0);
  }
  assert.equal(advancement.ask('2026广东普通专升本什么时候报名？').behavior, 'answer');
});

test('澄清类别有明确状态：比较题选择后不循环，中职升高职不混答', () => {
  const question = '2026年广东专升本和三二分段转段有什么区别？';
  const initial = advancement.ask(question);
  assert.equal(initial.behavior, 'clarify');
  for (const choice of initial.choices) {
    const scope = advancement.selectScope(initial, choice);
    assert.ok(scope, '澄清选项必须携带类别，而不是拼接问题文字');
    assert.equal(advancement.ask(question, 2, scope).behavior, 'answer');
  }
  const looseQuestion = '2026年广东三二分段报名是1月12日开始吗？';
  const loose = advancement.ask(looseQuestion);
  const scope = advancement.selectScope(loose, '中高职贯通三二分段（中职升高职）');
  assert.ok(scope);
  assert.equal(advancement.ask(looseQuestion, 2, scope).behavior, 'refuse');
  assert.equal(advancement.ask('2026年广东中高职贯通三二分段什么时候报名？').behavior, 'refuse');
  assert.equal(advancement.selectScope(initial, '不是本轮的选项'), null);
});

test('类别守门：中职简写不混答，明确普通专升本不被免考词或矛盾 scope 覆盖', () => {
  assert.equal(advancement.ask('2026年广东普通专升本和三二分段报名日期是什么？').behavior, 'clarify', '同时问两类考试不依赖“区别”等比较词');
  for (const q of ['2026年广东中职三二分段怎么报名？', '2026年广东中职生三二分段什么时候报名？', '2026年广东中职学校应届毕业生想报三二分段，报名时间是什么时候？']) {
    assert.equal(advancement.ask(q).behavior, 'refuse', q);
  }
  const ordinary = advancement.ask('2026年广东普通专升本免考英语条件是什么？');
  assert.ok(ordinary.citations.every((citation) => citation.documentId === 'gd-zsb-2026'));
  const mismatch = advancement.ask('2026年广东普通专升本什么时候预报名？', 2, { category: 'segmented_三二分段专升本转段', year: 2026, region: '广东省' });
  assert.equal(mismatch.behavior, 'refuse');
  assert.equal(mismatch.citations.length, 0);
});

test('不接模型：服务与页面都不调用云函数或 AI', () => {
  const service = fs.readFileSync('dist/services/advancement/index.js', 'utf8');
  const page = fs.readFileSync('dist/pages/advancement/index.js', 'utf8');
  for (const source of [service, page]) {
    assert.ok(!source.includes('callFunction'), '不该调用云函数');
    assert.ok(!source.includes('wx.cloud'), '不该使用云开发');
  }
  // 出处必须是真实链接（点开可核对），不是占位
  const result = advancement.ask('2026年广东普通专升本什么时候网上预报名？');
  assert.equal(result.citations[0].sourceUrl.startsWith('https://eea.gd.gov.cn/'), true);
});

test('问答页：澄清保留原问题，新题清空旧选择，并可复制出处', () => {
  const store = new Map();
  const calls = { clipboard: [], toast: [], navigate: [] };
  const wx = {
    setClipboardData: (options) => { calls.clipboard.push(options.data); if (options.success) options.success(); },
    showToast: (options) => calls.toast.push(options.title),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (options) => calls.navigate.push(options.url),
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
  };
  globalThis.wx = wx;
  const filename = path.resolve('dist/pages/advancement/index.js');
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => {
      page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
      page.setData = (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          if (key.includes('.')) {
            const parts = key.split('.');
            let target = page.data;
            for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
            target[parts[parts.length - 1]] = value;
            continue;
          }
          page.data[key] = value;
        }
      };
    },
    wx,
    getCurrentPages: () => [{}, {}],
    require: createRequire(filename),
    exports: {},
    console,
  }, { filename });

  page.onLoad();
  assert.equal(page.data.hasResult, true);
  assert.equal(page.data.result.behavior, 'answer');
  assert.equal(page.data.asked, '2026年广东普通专升本什么时候网上预报名？');

  page.onExample({ currentTarget: { dataset: { value: '转段考核包括哪几个部分？' } } });
  assert.equal(page.data.result.behavior, 'clarify');
  page.onChoice({ currentTarget: { dataset: { value: '2026 年广东省' } } });
  assert.equal(page.data.result.behavior, 'answer');
  assert.match(page.data.result.answer, /三个部分/);

  page.onExample({ currentTarget: { dataset: { value: '三二分段报名是1月12日开始吗？' } } });
  assert.equal(page.data.result.behavior, 'clarify');
  page.onChoice({ currentTarget: { dataset: { value: '三二分段专升本转段（高职升本科）' } } });
  assert.equal(page.data.question, '三二分段报名是1月12日开始吗？');
  assert.equal(page.data.result.behavior, 'clarify', '类别确定后仍需确认年份地区');
  page.onChoice({ currentTarget: { dataset: { value: '2026 年广东省' } } });
  assert.equal(page.data.result.behavior, 'answer', '澄清后重问应当给出原文摘录');

  page.onCopySource({ currentTarget: { dataset: { url: page.data.result.citations[0].sourceUrl } } });
  assert.equal(calls.clipboard.length, 1);
  assert.deepEqual(calls.toast, ['原文链接已复制']);

  // 新问题清空上一题范围；比较题选择后不再循环分类。
  page.onExample({ currentTarget: { dataset: { value: '专升本和三二分段转段有什么区别？' } } });
  page.onChoice({ currentTarget: { dataset: { value: '普通专升本（专科毕业生统考）' } } });
  assert.equal(page.data.result.behavior, 'clarify', '新题不沿用上一题年份地区');
  page.onChoice({ currentTarget: { dataset: { value: '2026 年广东省' } } });
  assert.equal(page.data.result.behavior, 'answer');
  assert.equal(page.data.asked, '专升本和三二分段转段有什么区别？');
  page.onExample({ currentTarget: { dataset: { value: '三二分段报名是1月12日开始吗？' } } });
  page.onChoice({ currentTarget: { dataset: { value: '中高职贯通三二分段（中职升高职）' } } });
  assert.equal(page.data.result.behavior, 'refuse');
  assert.deepEqual(Array.from(store.keys()), [], '问答页不该往本机存储写东西');

  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  assert.ok(app.pages.includes('pages/advancement/index'));
});
