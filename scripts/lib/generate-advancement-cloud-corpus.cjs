/**
 * 升学语料的构建侧生成逻辑（scripts/build.mjs 注入 ai 云函数用）。
 *
 * 单一数据源：`docs/evidence/advancement-poc/corpus.json`——PoC 报告、来源目录、
 * 小程序 `services/advancement/corpus.ts` 与本文件生成的云函数语料都来自它，
 * 手抄第二份一定会漂移。
 *
 * 与部门动态语料的差别：部门语料是**增强**（缺失时 fail-open，检索禁用即可），
 * 升学语料是**前提**——模型回答只能建立在这些可信段落上，所以云函数侧缺失时
 * 按 `internal` 拒绝（fail-closed），不能退化成「凭模型常识回答」。
 *
 * 这里拆成纯函数（CJS 便于 build.mjs 与 node:test 两边直接加载）。
 */
const crypto = require('node:crypto');

/** 语料唯一来源（相对仓库根）。 */
const ADVANCEMENT_CORPUS_SOURCE = 'docs/evidence/advancement-poc/corpus.json';

/**
 * 生成语料载荷：只带回答与引用需要的字段（语料里的 `context` 是检索用关键词，
 * 不是原文，**不进云函数**——进了就有被当成原文引用的风险）。
 *
 * `version` 由文档内容的 SHA-256 前 12 位得出：语料一改版本就变，
 * 评测报告里的「来源版本」可以直接对上。
 */
function buildAdvancementPayload(corpus) {
  const documents = corpus.documents.map((document) => ({
    id: document.id,
    category: document.category,
    title: document.title,
    documentNumber: document.documentNumber,
    issuer: document.issuer,
    publishedAt: document.publishedAt,
    applicableYear: document.applicableYear,
    applicableRegion: document.applicableRegion,
    applicableAudience: document.applicableAudience,
    sourceUrl: document.sourceUrl,
    collectedAt: document.collectedAt,
    passages: document.passages.map((passage) => ({ id: passage.id, text: passage.text })),
  }));
  const version = `adv-corpus-${crypto.createHash('sha256').update(JSON.stringify(documents)).digest('hex').slice(0, 12)}`;
  return {
    generatedFrom: ADVANCEMENT_CORPUS_SOURCE,
    version,
    collectedAt: corpus.builtAt,
    documents,
  };
}

/** 渲染成云函数可 require 的 CJS 模块文本（带来源注释，防止被当成手写文件修改）。 */
function renderAdvancementCorpusModule(payload) {
  return [
    '// 本文件由 scripts/build.mjs 生成（scripts/lib/generate-advancement-cloud-corpus.cjs），勿手工编辑。',
    `// 语料数据源：${payload.generatedFrom}，版本 ${payload.version}，核查日期 ${payload.collectedAt}。`,
    `module.exports = ${JSON.stringify(payload, null, 1)};`,
    '',
  ].join('\n');
}

module.exports = { ADVANCEMENT_CORPUS_SOURCE, buildAdvancementPayload, renderAdvancementCorpusModule };
