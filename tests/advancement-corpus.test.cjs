const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// 升学 / 实习 PoC 的语料与题库不变量（Issue #93）。
// 这两份文件是人工维护的，谁改错了都会让 PoC 报告与小程序里的回答一起失真，所以在这里钉住：
// 段落必须有出处、题库必须有 20 道且预期的段落 id 真实存在、答案题的 mustContain 必须真在原文里出现。
const corpus = JSON.parse(fs.readFileSync('docs/evidence/advancement-poc/corpus.json', 'utf8'));
const questionSet = JSON.parse(fs.readFileSync('docs/evidence/advancement-poc/questions.json', 'utf8'));

const documents = corpus.documents;
const passages = documents.flatMap((document) => document.passages);
const passageById = new Map(passages.map((passage) => [passage.id, passage]));

test('语料：四份官方材料，每条段落都带出处、核查日与检索用 context', () => {
  assert.equal(documents.length, 4);
  assert.equal(passages.length, 25);
  for (const document of documents) {
    assert.match(document.sourceUrl, /^https?:\/\//, `${document.id} 缺少官方链接`);
    assert.ok(document.title.trim() !== '', `${document.id} 缺少标题`);
    assert.ok(document.issuer.trim() !== '', `${document.id} 缺少发布主体`);
    assert.equal(document.collectedAt, '2026-09-29', `${document.id} 核查日不对`);
    assert.ok([
      'ordinary_专升本',
      'segmented_三二分段专升本转段',
      'internship_实习招聘',
    ].includes(document.category), `${document.id} 的类别不在三类里`);
  }
  for (const passage of passages) {
    assert.ok(passage.text.trim() !== '', `${passage.id} 原文为空`);
    assert.ok(passage.context.trim() !== '', `${passage.id} 缺 context（检索要用）`);
  }
  // 语料里不许出现岗位/薪资这类实时数据
  for (const passage of passages) {
    assert.ok(!/月薪|薪资|时薪|到手工资/.test(passage.text), `${passage.id} 疑似含薪资信息`);
  }
});

test('题库：正好 20 道，预期的段落 id 都存在，答案题的关键串真在原文里', () => {
  const questions = questionSet.questions;
  assert.equal(questions.length, 20);
  const ids = new Set(questions.map((item) => item.id));
  assert.equal(ids.size, 20, '题目 id 不能重复');

  const behaviors = questions.reduce((acc, item) => {
    acc[item.behavior] = (acc[item.behavior] ?? 0) + 1;
    return acc;
  }, {});
  // 票面要求：至少 3 道「无来源/无资料时应拒答」，并覆盖跨类型与年份不明
  assert.equal(behaviors.answer, 13);
  assert.ok(behaviors.clarify >= 3, `澄清题太少：${behaviors.clarify}`);
  assert.ok(behaviors.refuse >= 3, `拒答题太少：${behaviors.refuse}`);
  assert.equal(behaviors.answer + behaviors.clarify + behaviors.refuse, 20);

  for (const item of questions) {
    assert.ok(item.question.trim() !== '', `${item.id} 缺问题`);
    assert.ok(item.expectedAnswer.trim() !== '', `${item.id} 缺标准答案`);
    assert.ok(item.basis.length > 0 || item.behavior !== 'fact' && !item.id.startsWith('q0'), `${item.id} 事实题必须写明依据文档`);

    for (const id of item.expectedPassages) {
      const passage = passageById.get(id);
      assert.ok(passage, `${item.id} 预期的段落 ${id} 不在语料里`);
    }
    if (item.behavior === 'answer') {
      assert.ok(item.expectedPassages.length > 0, `${item.id} 答案题必须给预期段落`);
      assert.ok(item.mustContain.length > 0, `${item.id} 答案题必须给关键串`);
      const texts = item.expectedPassages.map((id) => passageById.get(id).text).join('\n');
      for (const needle of item.mustContain) {
        assert.ok(texts.includes(needle), `${item.id} 的关键串「${needle}」不在预期原文里`);
      }
    } else {
      assert.equal(item.expectedPassages.length, 0, `${item.id} 非答案题不该有预期段落`);
      assert.equal(item.citationRequired, false, `${item.id} 非答案题不该要求引用`);
    }
  }
});

test('题库覆盖三类考试与四类边界情形', () => {
  const types = new Set(questionSet.questions.map((item) => item.type));
  for (const type of ['fact_专升本', 'fact_转段', 'fact_就业', 'cross_跨类型', 'unknown_year_年份不明', 'no_source_无来源', 'stale_过期年份']) {
    assert.ok(types.has(type), `缺少类型：${type}`);
  }
  // 普通专升本与三二分段转段的题必须分开（票面要求：不把不同考试类型混答）
  assert.ok([...types].some((type) => type === 'fact_专升本'));
  assert.ok([...types].some((type) => type === 'fact_转段'));
});
