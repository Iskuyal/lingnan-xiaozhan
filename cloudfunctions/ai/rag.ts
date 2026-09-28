/**
 * 部门动态检索：大字符二元组（bigram）倒排 + idf 加权（Ticket 10 先行落地）。
 *
 * 为什么不用分词与向量：项目没有分词依赖，`ai` 云函数也没有 embeddings 端点
 * （Ticket 10 技术约束，见 docs/tasks/tickets/10-campus-rag-qa.md）；中文 bigram
 * 无需词典即可工作，语料规模小（每部门 3~5 条动态），预建索引的开销可忽略。
 *
 * 索引文本 = 部门名 + 活动标题：这样「校学生会最近有什么动态」这类开放问题
 * 也能靠部门名的 bigram 重合命中该部门的动态，而不是只认标题字面。
 *
 * 语料由构建脚本生成（dist/cloudfunctions/ai/department-corpus.js，见 scripts/build.mjs），
 * 本模块只依赖它的形状，不依赖文件位置——纯函数，便于 node:test 直接验证。
 */
import type { DepartmentActivityCitation } from './types';

/** 一条活动动态（字段与 miniprogram/services/departments.ts 的 DepartmentActivity 对齐）。 */
export interface ActivityDoc {
  departmentId: string;
  departmentName: string;
  title: string;
  /** 官网文章发布日期，格式 YYYY-MM-DD。 */
  publishedAt: string;
  sourceUrl: string;
}

/** 构建产物 department-corpus.js 的形状（本模块只用其中一部分）。 */
export interface DepartmentActivityCorpus {
  source: {
    label?: string;
    sourceUrl?: string;
    verifiedAt?: string;
  };
  departments: {
    id: string;
    name: string;
    activities: {
      title: string;
      publishedAt: string;
      sourceUrl: string;
    }[];
  }[];
}

/** 构建产物即使能 require，也必须有完整的检索字段；坏数据按无语料降级。 */
export function isDepartmentActivityCorpus(value: unknown): value is DepartmentActivityCorpus {
  if (value === null || typeof value !== 'object') return false;
  const corpus = value as Record<string, unknown>;
  if (!Array.isArray(corpus.departments)) return false;
  return corpus.departments.every((department: unknown) => {
    if (department === null || typeof department !== 'object') return false;
    const item = department as Record<string, unknown>;
    return typeof item.id === 'string'
      && typeof item.name === 'string'
      && Array.isArray(item.activities)
      && item.activities.every((activity: unknown) => {
        if (activity === null || typeof activity !== 'object') return false;
        const row = activity as Record<string, unknown>;
        return typeof row.title === 'string'
          && typeof row.publishedAt === 'string'
          && typeof row.sourceUrl === 'string';
      });
  });
}

/**
 * 一条检索命中：引用条目 + 打分（score > 0 才算命中，0 分不硬塞）。
 * 形状直接复用 types.ts 的 DepartmentActivityCitation（返回值契约的唯一声明处）。
 */
export interface ActivityHit extends DepartmentActivityCitation {}

export interface RagIndex {
  docGrams: Set<string>[];
  idf: Map<string, number>;
}

const indexCache = new WeakMap<DepartmentActivityCorpus, { docs: ActivityDoc[]; index: RagIndex }>();

function indexedCorpus(corpus: DepartmentActivityCorpus): { docs: ActivityDoc[]; index: RagIndex } {
  const cached = indexCache.get(corpus);
  if (cached !== undefined) return cached;
  const result = { docs: documentsOf(corpus), index: buildIndex(corpus) };
  indexCache.set(corpus, result);
  return result;
}

export interface ActivityContext {
  /** 命中时拼进 system 的注入文本；无命中时为空串。 */
  injectedText: string;
  /** 注入文本引用的动态条目（与 citations 一一对应）。 */
  hits: ActivityHit[];
  /** 返回给调用方展示的来源清单（按分数降序）。 */
  citations: ActivityHit[];
}

/** 去空白与标点后取中文大字符二元组。 */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s\p{P}]+/gu, '');
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2));
  return grams;
}

/** 语料里的检索单元：每活动一篇，索引文本带部门名（开放问题也能命中）。 */
export function documentsOf(corpus: DepartmentActivityCorpus): ActivityDoc[] {
  const docs: ActivityDoc[] = [];
  for (const department of corpus.departments) {
    for (const activity of department.activities) {
      docs.push({
        departmentId: department.id,
        departmentName: department.name,
        title: activity.title,
        publishedAt: activity.publishedAt,
        sourceUrl: activity.sourceUrl,
      });
    }
  }
  return docs;
}

/** 预建倒排与 idf；语料不变时只建一次（模块加载时由调用方缓存）。 */
export function buildIndex(corpus: DepartmentActivityCorpus): RagIndex {
  const docs = documentsOf(corpus);
  const docGrams = docs.map((doc) => bigrams(`${doc.departmentName} ${doc.title}`));
  const df = new Map<string, number>();
  for (const grams of docGrams) {
    for (const gram of grams) df.set(gram, (df.get(gram) ?? 0) + 1);
  }
  const total = docs.length;
  const idf = new Map<string, number>();
  for (const [gram, count] of df) idf.set(gram, Math.log(1 + total / count));
  return { docGrams, idf };
}

/** 按查询打分：返回全部文档的 { index, score }，按分数降序（0 分也保留，由调用方截断）。 */
export function score(index: RagIndex, question: string): { index: number; score: number }[] {
  const query = bigrams(question);
  const scored = index.docGrams.map((grams, docIndex) => {
    let sum = 0;
    for (const gram of query) {
      if (grams.has(gram)) sum += index.idf.get(gram) ?? 0;
    }
    return { index: docIndex, score: sum };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/** 检索 top-k 条动态；无 bigram 重合（分数为 0）的条目不算命中，返回空数组而不是硬塞。 */
export function retrieveActivities(
  corpus: DepartmentActivityCorpus,
  query: string,
  k: number,
): ActivityHit[] {
  const trimmed = query.trim();
  if (trimmed === '' || corpus.departments.length === 0) return [];
  const { index, docs } = indexedCorpus(corpus);
  const ranking = score(index, trimmed);
  const hits: ActivityHit[] = [];
  for (const row of ranking) {
    if (row.score <= 0) break;
    hits.push({ ...docs[row.index], score: Number(row.score.toFixed(2)) });
    if (hits.length >= k) break;
  }
  return hits;
}

/** 注入文本：检索结果的提示词段，命中才有内容。 */
export function injectedTextFor(hits: ActivityHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((hit, index) => {
    const source = hit.sourceUrl;
    return `${index + 1}. ${hit.departmentName} · ${hit.title}（${hit.publishedAt}）来源：${source}`;
  });
  return [
    '【部门动态检索结果】',
    '以下是从官网已核实资料中检索到的部门动态，回答动态类问题只能依据这些条目；',
    '这里没有的一律回答「官网未公布」，不要推测或补全活动细节。',
    ...lines,
  ].join('\n');
}

/**
 * 动态类问题的意图词表：问题含其中任一词才做动态检索。
 *
 * 为什么加这道闸门：bigram 索引文本含部门名，基础问题（「联系方式」「校区」「成立年份」）
 * 也会因部门名重合命中动态条目——「问联系方式却挂一列动态来源」是噪声（code-review 实测）。
 * 词表只挡「明显不是动态意图」的提问，漏检的代价是动态类问题不注入、模型按纪律回答
 * 「官网未公布」（安全侧失败，不编造）；误检的代价只是多注入几条动态，还有无命中闸门兜底。
 */
export const ACTIVITY_QUESTION_TERMS = [
  '动态', '活动', '最近', '近期', '新闻', '资讯', '通知', '公告', '公示',
  '招募', '招新', '报名', '举办', '举行', '开展', '参加', '召开', '落幕', '结束',
  '大会', '大赛', '比赛', '晚会', '培训', '述职', '总结', '复盘',
  // 「志愿」不在词表里：它是组织名（青年志愿者联合会）的一部分，会把校区类基础题误判成动态类。
  // 志愿服务类动态题靠「马拉松」「活动」「招募」等词命中，漏判时按纪律回答官网未公布（安全侧）。
  '社区', '马拉松', '提案', '表彰', '评选', '名单',
  '第几期', '什么时候', '时间', '安排', '发布',
];

/** 问题是否动态类：只按意图词表判定（词表见上，测试用题集锁定）。 */
export function isActivityQuestion(query: string): boolean {
  return ACTIVITY_QUESTION_TERMS.some((term) => query.includes(term));
}

/** 组装一次检索：注入文本 + 命中清单（两者同源，便于页面展示与测试断言一致）。 */
export function buildActivityContext(
  corpus: DepartmentActivityCorpus,
  query: string,
  k: number,
): ActivityContext {
  const hits = retrieveActivities(corpus, query, k);
  return { injectedText: injectedTextFor(hits), hits, citations: hits };
}
