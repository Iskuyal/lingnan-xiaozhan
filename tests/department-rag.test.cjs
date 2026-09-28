/**
 * 部门动态检索模块（cloudfunctions/ai/rag.ts）的纯逻辑测试。
 *
 * rag.ts 是无依赖纯函数（bigram 倒排 + idf 打分），直接加载编译产物验证行为；
 * 语料注入进 ai 云函数入口的集成断言在 tests/ai-flow.test.cjs（真实入口 + 桩边界）。
 *
 * 语料形状与 build.mjs 生成到 dist/cloudfunctions/ai/department-corpus.js 的契约一致，
 * 生成侧的可测逻辑在 scripts/lib/generate-department-corpus.cjs（tests/build-corpus.test.cjs 覆盖）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const rag = require('../dist/cloudfunctions/ai/rag.js');

/** 三部门、各两条动态的最小语料（字段形状与 departments.ts 对齐）。 */
function sampleCorpus() {
  return {
    source: { label: '测试来源', sourceUrl: 'https://example.edu/source', verifiedAt: '2026-09-26' },
    departments: [
      {
        id: 'student-union',
        name: '校学生会',
        activities: [
          { title: '校学生会举办迎新晚会', publishedAt: '2026-09-20', sourceUrl: 'https://example.edu/su/welcome' },
          { title: '校学生会志愿者招募通知', publishedAt: '2026-09-18', sourceUrl: 'https://example.edu/su/volunteer' },
        ],
      },
      {
        id: 'volunteer',
        name: '青年志愿者协会',
        activities: [
          { title: '青年志愿者协会开展社区义诊', publishedAt: '2026-09-15', sourceUrl: 'https://example.edu/vol/clinic' },
          { title: '青年志愿者协会地铁引导服务报名', publishedAt: '2026-09-10', sourceUrl: 'https://example.edu/vol/metro' },
        ],
      },
      {
        id: 'radio',
        name: '广播台',
        activities: [],
      },
    ],
  };
}

test('损坏的构建语料会被识别，动态检索可安全降级', () => {
  assert.equal(rag.isDepartmentActivityCorpus(sampleCorpus()), true);
  assert.equal(rag.isDepartmentActivityCorpus({ departments: [{ id: 'broken', name: '坏数据' }] }), false);
  assert.equal(rag.isDepartmentActivityCorpus({ departments: null }), false);
});

test('bigram 索引：查询与某部门动态词面重合时，该部门动态排在最前', () => {
  const corpus = sampleCorpus();
  const index = rag.buildIndex(corpus);
  const ranking = rag.score(index, '校学生会最近有什么动态');
  const top = ranking[0];
  const doc = rag.documentsOf(corpus)[top.index];
  assert.equal(doc.departmentId, 'student-union');
  assert.match(doc.title, /迎新晚会|志愿者招募/);
});

test('retrieveActivities：命中时返回带来源的动态条目，score 为正', () => {
  const corpus = sampleCorpus();
  const hits = rag.retrieveActivities(corpus, '青年志愿者协会有什么义诊活动', 3);
  assert.ok(hits.length >= 1);
  const first = hits[0];
  assert.equal(first.departmentId, 'volunteer');
  assert.ok(first.title.includes('义诊'));
  assert.ok(first.score > 0);
  assert.equal(first.sourceUrl, 'https://example.edu/vol/clinic');
});

test('retrieveActivities：k 截断生效，且每个命中都带部门名与日期', () => {
  const corpus = sampleCorpus();
  const hits = rag.retrieveActivities(corpus, '学生会', 1);
  assert.equal(hits.length, 1);
  for (const hit of hits) {
    assert.ok(hit.departmentName !== '');
    assert.match(hit.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(hit.sourceUrl.startsWith('https://'));
  }
});

test('不相关查询：无 bigram 重合时不返回任何命中（不硬塞，防止噪声进提示词）', () => {
  const corpus = sampleCorpus();
  const hits = rag.retrieveActivities(corpus, '课表第三节有没有课', 3);
  assert.equal(hits.length, 0);
});

test('空语料与空查询：安全返回空数组', () => {
  assert.deepEqual(rag.retrieveActivities({ source: {}, departments: [] }, '校学生会动态', 3), []);
  assert.deepEqual(rag.retrieveActivities(sampleCorpus(), '  ', 3), []);
});

test('buildActivityContext：命中时给出注入文本与引用清单，两者一致', () => {
  const corpus = sampleCorpus();
  const context = rag.buildActivityContext(corpus, '校学生会迎新晚会是什么时候', 3);
  assert.ok(context.injectedText.includes('【部门动态检索结果】'));
  assert.ok(context.injectedText.includes('迎新晚会'));
  assert.ok(context.injectedText.includes('https://example.edu/su/welcome'));
  assert.equal(context.citations.length, context.hits.length);
  assert.deepEqual(context.citations[0], context.hits[0]);
});

test('buildActivityContext：无命中时注入文本为空串，引用为空', () => {
  const context = rag.buildActivityContext(sampleCorpus(), '与部门动态完全无关的问题', 3);
  assert.equal(context.injectedText, '');
  assert.deepEqual(context.citations, []);
});

test('评分可解释：两部门都命中时按重合度排序（不靠任何魔法顺序）', () => {
  const corpus = sampleCorpus();
  const hits = rag.retrieveActivities(corpus, '校学生会的迎新晚会', 5);
  // 两条校学生会动态应排在青年志愿者协会之前。
  const firstDepartment = hits[0].departmentId;
  assert.equal(firstDepartment, 'student-union');
});

test('动态意图词表：题集 5 道动态题全部判为动态类，5 道基础题全部判为基础类', () => {
  const bank = JSON.parse(fs.readFileSync('docs/evidence/department-rag/questions.json', 'utf8'));
  const activityQuestions = bank.questions.filter((question) => question.kind === 'activity');
  const baseQuestions = bank.questions.filter((question) => question.kind === 'base');
  assert.equal(activityQuestions.length, 5, '题集应有 5 道动态题');
  assert.equal(baseQuestions.length, 5, '题集应有 5 道基础题');
  for (const question of activityQuestions) {
    assert.equal(rag.isActivityQuestion(question.q), true, `动态题应判为动态类：${question.q}`);
  }
  for (const question of baseQuestions) {
    assert.equal(rag.isActivityQuestion(question.q), false, `基础题不应判为动态类：${question.q}`);
  }
});

test('动态意图词表：典型问法不误判（校区/联系方式/下设/成立都不触发）', () => {
  for (const question of [
    '校学生团委的联系方式是什么？',
    '青年志愿者联合会属于哪个校区？',
    '校学生会下设哪些部门？',
    '退役军人事务服务部成立于哪一年？',
    '校学生社团管理部的简介是什么？',
  ]) {
    assert.equal(rag.isActivityQuestion(question), false, `不应判为动态类：${question}`);
  }
});
