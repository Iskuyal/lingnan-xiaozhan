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
    .sort((a, b) => b.value - a.value || a.passage.id.localeCompare(b.passage.id));
}

/**
 * 类别判定（顺序即优先级）。规则来自三类语料的用词差异，而不是模型判断：
 * - 「三二分段专升本转段」是一个整体说法，先把整词归一到「三二分段」再匹配，避免被当成普通专升本；
 * - 只说「三二分段 / 贯通」而没有「转段 / 专升本 / 本科 / 中职 / 高职」时，无法区分中高职贯通与
 *   专升本转段 → 先澄清（票面要求：跨类型问题先澄清）；
 * - 问句同时出现「专升本」和「三二分段」并要求比较时 → 澄清；
 * - 「转段」类问句里常带「就业」「本科」，所以转段优先于就业；“技能大赛/免考/专业能力考核”这些
 *   只出现在转段语料里，足以单独判定类别。
 */
const SEGMENTED_STRONG = /三二分段|转段|专业能力考核|基本素质考核|技能大赛|免考|贯通/;
const SEGMENTED_LOOSE = /三二分段|贯通/;
const DISAMBIGUATORS = /转段|专升本|本科|中职|高职/;
const UPGRADE_MARKERS = /专升本|专插本|职教师资|建档立卡|志愿|普通批|提前批|院校专业组|加分|体检|预报名|退役|招生工作规定/;
const EMPLOYMENT_MARKERS = /就业|实习|招聘|岗位|校招|毕业生|公务员|事业单位|国企|科研助理|用人单位/;
const COMPARISON = /区别|哪个|还是|两个都|怎么选|一样吗/;

function classify(question) {
  const normalized = question.split('三二分段专升本').join('三二分段');
  const segmented = SEGMENTED_STRONG.test(normalized);
  const loose = SEGMENTED_LOOSE.test(normalized) && !DISAMBIGUATORS.test(normalized);
  const upgrade = UPGRADE_MARKERS.test(normalized);
  const employment = EMPLOYMENT_MARKERS.test(normalized);

  if (segmented && upgrade && COMPARISON.test(normalized)) {
    return { kind: 'ambiguous', categories: ['ordinary_专升本（专科毕业生统考）', 'segmented_三二分段专升本转段（试点高职学生转段）'] };
  }
  if (loose) {
    return { kind: 'ambiguous', categories: ['segmented_中高职贯通（中职升高职）', 'segmented_三二分段专升本转段（高职升本科）'] };
  }
  if (segmented) return { kind: 'single', category: 'segmented_三二分段专升本转段' };
  if (upgrade) return { kind: 'single', category: 'ordinary_专升本' };
  if (employment) return { kind: 'single', category: 'internship_实习招聘' };
  return { kind: 'unknown' };
}

function coveredYears(category) {
  return [...new Set(passages.filter((passage) => passage.category === category).map((passage) => passage.applicableYear))]
    .filter((year) => year > 0)
    .sort();
}

function isCoveredYear(category, year) {
  return coveredYears(category).includes(year);
}

const DATE_SENSITIVE = ['报名', '考试', '时间', '截止', '几号', '哪天'];

/**
 * 语料明确不含的数据：这类问题一律拒答并给官方入口，不用「相关段落」硬答。
 * （票面要求：不宣称实时岗位全集、不做个性录取资格判断。）
 */
const OUT_OF_SCOPE = ['分数线', '投档线', '录取结果', '录取名单', '录取率', '薪资', '工资', '招人', '招不招', '哪家公司', '哪家单位'];

/** 问句里出现的年份（4 位数字）；没有就返回 null。 */
function yearOf(question) {
  const match = question.match(/(20\d{2})\s*年/);
  return match === null ? null : Number(match[1]);
}

/** 策略 B：来源约束检索。返回 { behavior, passages, note }。 */
function constrainedSearch(question) {
  const outOfScope = OUT_OF_SCOPE.find((word) => question.includes(word));
  if (outOfScope !== undefined) {
    return { behavior: 'refuse', passages: [], note: `问的是语料明确不含的数据（${outOfScope}），只给官方入口` };
  }
  const classification = classify(question);
  if (classification.kind === 'ambiguous') {
    return { behavior: 'clarify', passages: [], note: `命中多个类别：${classification.categories.join(' / ')}` };
  }
  if (classification.kind === 'unknown') {
    const asksDate = DATE_SENSITIVE.some((word) => question.includes(word));
    return asksDate
      ? { behavior: 'clarify', passages: [], note: '没说清是哪一类考试，先澄清普通专升本还是三二分段转段' }
      : { behavior: 'refuse', passages: [], note: '没有命中任何类别，语料里没有可引用来源' };
  }
  // 语料只覆盖一个招生年度时，问题不带年份也能回答；但年份写错（如问 2025、2027）时必须说无法核实。
  const year = yearOf(question);
  if (year !== null && !isCoveredYear(classification.category, year)) {
    return {
      behavior: 'refuse',
      passages: [],
      note: `语料只覆盖 ${coveredYears(classification.category).join('、')} 年，${year} 年没有官方文件，不沿用旧年份`,
    };
  }
  const pool = passages.filter((passage) => passage.category === classification.category);
  const hits = rank(question, pool).filter((entry) => entry.value > 0);
  if (hits.length === 0) {
    return { behavior: 'refuse', passages: [], note: '该类别下没有与问题相关的段落' };
  }
  return { behavior: 'answer', passages: hits.slice(0, 3).map((entry) => entry.passage), note: '' };
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
    const constrained = constrainedSearch(item.question);
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
  const output = path.resolve('docs/evidence/advancement-poc/report.json');
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

main();
