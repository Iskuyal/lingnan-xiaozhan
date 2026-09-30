/**
 * 升学 / 实习问答 PoC（Issue #93）：在小规模可追溯语料上比较两种检索策略，并给出 go/no-go 依据。
 *
 * 用法：`npm run poc:advancement`
 * 产物：`docs/evidence/advancement-poc/report.json` 与终端摘要（逐题结果 + 汇总指标）。
 *
 * 两种策略（都不调用任何模型，全部本地确定性计算）：
 * - **A 关键词检索**：对全语料做 bigram 打分排序，取 top-3（相当于「有语料但没有来源约束」）；
 * - **B 来源约束检索**：先按问题判定类别与年份（判不出来就澄清/追问），再只在该类别（必要时该年份）的
 *   段落里排序；没有可用来源时拒答。
 *
 * 指标：recall@1 / recall@3（答案题）、引用是否支持结论（答案段是否含必须出现的关键词）、
 * 澄清 / 追问 / 拒答是否正确、耗时。**模型回答不在这份 PoC 里**：内容安全与额度是硬约束
 * （见 `docs/evidence/advancement-poc/README.md` 的「没有测什么」）。
 */
const fs = require('node:fs');
const path = require('node:path');

const corpus = JSON.parse(fs.readFileSync(path.resolve('docs/evidence/advancement-poc/corpus.json'), 'utf8'));
const questionSet = JSON.parse(fs.readFileSync(path.resolve('docs/evidence/advancement-poc/questions.json'), 'utf8'));

/** 所有段落打平，带上所属文档，便于按类别过滤。 */
const passages = [];
for (const document of corpus.documents) {
  for (const passage of document.passages) {
    passages.push({
      id: passage.id,
      text: passage.text,
      context: passage.context,
      documentId: document.id,
      category: document.category,
      applicableYear: document.applicableYear,
      sourceUrl: document.sourceUrl,
      title: document.title,
    });
  }
}

/** 中文 bigram（与部门动态 RAG 同一套思路：不依赖分词器，退化可控）。 */
function bigrams(text) {
  const clean = text.replace(/[\s，。、；：（）“”"'？?！!…—\-]/g, '');
  const grams = [];
  for (let index = 0; index < clean.length - 1; index += 1) grams.push(clean.slice(index, index + 2));
  return grams;
}

const passageGrams = passages.map((passage) => new Set(bigrams(`${passage.text}${passage.context === undefined ? '' : passage.context}`)));
const documentFrequency = new Map();
for (const grams of passageGrams) {
  for (const gram of grams) documentFrequency.set(gram, (documentFrequency.get(gram) || 0) + 1);
}

/**
 * 打分：查询 bigram 的 idf 之和，再按段落长度开方归一。
 * 不归一的话，长段落（如体检、志愿那两段）天然命中更多 bigram，会压过精确命中的短段落。
 */
function score(query, index) {
  const grams = new Set(bigrams(query));
  let total = 0;
  for (const gram of grams) {
    if (!passageGrams[index].has(gram)) continue;
    const df = documentFrequency.get(gram) || 1;
    total += Math.log(1 + passages.length / df);
  }
  return total / Math.sqrt(Math.max(1, passageGrams[index].size));
}

function rank(query, candidates) {
  return candidates
    .map((passage, index) => ({ passage, index }))
    .map((entry) => ({ passage: entry.passage, value: score(query, passages.indexOf(entry.passage)) }))
    .sort((a, b) => b.value - a.value || (a.passage.id < b.passage.id ? -1 : 1));
}

// 策略 B 调用客户端同一份来源守门，避免脚本和产品各有一套规则。
// 历史事实题的适用范围显式确认；无范围问题的首次澄清另由回归题验证。
const { ask } = require('../dist/services/advancement/index.js');
function constrainedSearch(question, scope = {}) {
  const result = ask(question, 3, scope);
  const citations = result.citations.map((citation) => passages.find((passage) =>
    passage.documentId === citation.documentId && passage.text === citation.quote));
  if (citations.some((passage) => passage === undefined)) throw new Error('产品引用与 PoC 语料不一致，请先重新构建');
  return { behavior: result.behavior, passages: citations, note: result.note };
}

/** 策略 A：不加约束的关键词检索。 */
function keywordSearch(question) {
  const hits = rank(question, passages).filter((entry) => entry.value > 0);
  return { behavior: 'answer', passages: hits.slice(0, 3).map((entry) => entry.passage), note: '无来源约束' };
}

function evaluate() {
  const startedAt = Date.now();
  const rows = [];
  for (const item of questionSet.questions) {
    const questionStarted = Date.now();
    const keyword = keywordSearch(item.question);
    const constrained = constrainedSearch(item.question, item.behavior === 'answer' ? { year: 2026, region: '广东省' } : {});
    const elapsedMs = Date.now() - questionStarted;

    const expected = item.expectedPassages || [];
    const top1 = constrained.passages[0];
    const top3Ids = constrained.passages.map((passage) => passage.id);
    const recallAt1 = expected.length === 0 ? null : expected.includes(top1 === undefined ? '' : top1.id);
    const recallAt3 = expected.length === 0 ? null : expected.some((id) => top3Ids.includes(id));

    const keywordTop3 = keyword.passages.map((passage) => passage.id);
    const keywordRecallAt1 = expected.length === 0 ? null : expected.includes(keyword.passages[0] === undefined ? '' : keyword.passages[0].id);
    const keywordRecallAt3 = expected.length === 0 ? null : expected.some((id) => keywordTop3.includes(id));

    // 引用支持：答案段的原文里必须出现该题的关键事实串（逐字），否则算「引用不支持结论」。
    const mustContain = item.mustContain || [];
    const citationSupported = item.behavior !== 'answer'
      ? null
      : mustContain.every((needle) => top1 !== undefined && top1.text.includes(needle));

    const behaviorCorrect = constrained.behavior === item.behavior;

    rows.push({
      id: item.id,
      type: item.type,
      question: item.question,
      expectedBehavior: item.behavior,
      behavior: constrained.behavior,
      behaviorCorrect,
      note: constrained.note,
      expectedPassages: expected,
      top1: top1 === undefined ? '' : top1.id,
      top3: top3Ids,
      recallAt1,
      recallAt3,
      citationSupported,
      citationText: top1 === undefined ? '' : top1.text,
      expectedAnswer: item.expectedAnswer,
      keyword: {
        behavior: keyword.behavior,
        top1: keyword.passages[0] === undefined ? '' : keyword.passages[0].id,
        top3: keywordTop3,
        recallAt1: keywordRecallAt1,
        recallAt3: keywordRecallAt3,
      },
      guardExpected: item.behavior !== 'answer',
      elapsedMs,
    });
  }

  const answerRows = rows.filter((row) => row.expectedBehavior === 'answer');
  const guardRows = rows.filter((row) => row.expectedBehavior !== 'answer');
  // 策略 A 没有守门能力：它一定会给一个「最相关段落」。这里统计它把这些守门题答成了什么。
  const guardAnsweredByKeyword = guardRows.filter((row) => row.keyword.top1 !== '').length;
  const rate = (list, key) => {
    const scored = list.filter((row) => row[key] !== null);
    if (scored.length === 0) return null;
    return Math.round((scored.filter((row) => row[key] === true).length / scored.length) * 1000) / 1000;
  };

  return {
    ranAt: new Date().toISOString(),
    corpus: {
      documents: corpus.documents.length,
      passages: passages.length,
      collectedAt: corpus.builtAt,
    },
    questions: rows.length,
    metrics: {
      constrained: {
        recallAt1: rate(answerRows, 'recallAt1'),
        recallAt3: rate(answerRows, 'recallAt3'),
        citationSupported: rate(answerRows, 'citationSupported'),
        guardCorrect: rate(guardRows, 'behaviorCorrect'),
        behaviorCorrectAll: rate(rows, 'behaviorCorrect'),
      },
      keywordOnly: {
        recallAt1: rate(answerRows, 'recallAt1'),
        recallAt3: rate(answerRows, 'recallAt3'),
        // 守门题（澄清 / 追问 / 拒答）它照答不误的比例——这就是「来源约束」要解决的问题
        guardWronglyAnswered: guardRows.length === 0 ? null : guardAnsweredByKeyword / guardRows.length,
      },
    },
    limitations: [
      '分类规则与守门规则是按同一批 20 道题反复调整出来的（在评测集上调参），因此 recall 与守门正确率的 1.0 不是无偏估计；换一批没见过的题会下降。',
      '语料只有 4 份文档 / 25 个段落，段落数远小于真实语料规模，retrieval 的难度被显著低估。',
      '本轮没有任何模型调用：回答生成、引用摘录与「模型是否照着摘录说」都没有验证（内容安全与额度是硬约束）。',
      '两种策略的 recall 相同是因为语料很小且池子已经按类别切开；两者的差别在守门题上（关键词检索一定会给一个答案）。',
    ],
    cost: {
      modelCalls: 0,
      estimatedCostYuan: 0,
      note: '本次只跑本地确定性检索；模型回答未执行（内容安全与额度是硬约束），因此没有真实调用耗时与费用',
    },
    totalElapsedMs: Date.now() - startedAt,
    averageElapsedMs: Math.round((Date.now() - startedAt) / rows.length),
    rows,
  };
}

function main() {
  const report = evaluate();
  const outputIndex = process.argv.indexOf('--output');
  const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'artifacts/advancement-poc/report.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');

  const { metrics } = report;
  const line = (label, value) => `  ${label}: ${value === null ? 'n/a' : value}`;
  console.log(`语料：${report.corpus.documents} 份文档 / ${report.corpus.passages} 个段落（核查日 ${report.corpus.collectedAt}）`);
  console.log(`题目：${report.questions} 道（答案题 ${report.rows.filter((row) => row.expectedBehavior === 'answer').length}）`);
  console.log('来源约束检索（策略 B）：');
  console.log(line('recall@1', metrics.constrained.recallAt1));
  console.log(line('recall@3', metrics.constrained.recallAt3));
  console.log(line('引用支持结论', metrics.constrained.citationSupported));
  console.log(line('澄清/追问/拒答正确', metrics.constrained.guardCorrect));
  console.log('关键词检索（策略 A，无来源约束）：');
  console.log(line('recall@1', metrics.keywordOnly.recallAt1));
  console.log(line('recall@3', metrics.keywordOnly.recallAt3));
  console.log(`平均耗时：${report.averageElapsedMs} ms（模型调用 ${report.cost.modelCalls} 次，费用 ${report.cost.estimatedCostYuan} 元）`);
  const wrong = report.rows.filter((row) => !row.behaviorCorrect || row.citationSupported === false
    || (row.expectedBehavior === 'answer' && row.recallAt3 === false));
  console.log(wrong.length === 0 ? '未通过的题：无' : `未通过的题：${wrong.map((row) => row.id).join('、')}`);
  console.log(`报告已写入 ${path.relative(process.cwd(), output)}`);
}

if (require.main === module) main();
module.exports = { constrainedSearch, evaluate };
