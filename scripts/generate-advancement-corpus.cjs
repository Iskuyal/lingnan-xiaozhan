/**
 * 把 PoC 语料（`docs/evidence/advancement-poc/corpus.json`）生成小程序里的 TS 模块。
 *
 * 为什么要有这一步：语料必须只有一份来源——PoC 报告、来源目录与小程序用的都是同一批逐字段落。
 * 手抄第二份一定会漂移，所以小程序里的 `services/advancement/corpus.ts` 由本脚本生成。
 *
 * 用法：`node scripts/generate-advancement-corpus.cjs`
 * 改语料时改 `corpus.json`，再跑这个脚本与 `npm run poc:advancement`，两处结果必须一致。
 */
const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve('docs/evidence/advancement-poc/corpus.json');
const target = path.resolve('miniprogram/services/advancement/corpus.ts');
const corpus = JSON.parse(fs.readFileSync(source, 'utf8'));

const header = `/**
 * 升学 / 实习问答语料（数据，不含逻辑）。
 *
 * **本文件由 \`docs/evidence/advancement-poc/corpus.json\` 生成，不要手改**：
 * 语料的唯一来源是那份 PoC 语料文件（4 份官方材料、逐字段落、每段带出处与核查日）。
 * 重新生成：\`node scripts/generate-advancement-corpus.cjs\`。
 *
 * 纪律：\`text\` 一律是官方原文的逐字摘录，回答与引用只能用它；\`context\` 只为检索打分添加，
 * 不得出现在界面上当作原文。
 */
export interface AdvancementPassage {
  id: string;
  text: string;
  /** 只用于检索打分的关键词标签，不是原文。 */
  context: string;
}

export interface AdvancementDocument {
  id: string;
  category: 'ordinary_专升本' | 'segmented_三二分段专升本转段' | 'internship_实习招聘';
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  applicableYear: number;
  applicableRegion: string;
  applicableAudience: string;
  sourceUrl: string;
  collectedAt: string;
  passages: AdvancementPassage[];
}

export const CORPUS_COLLECTED_AT = ${JSON.stringify(corpus.builtAt)};

export const ADVANCEMENT_DOCUMENTS: AdvancementDocument[] = `;

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
  passages: document.passages.map((passage) => ({ id: passage.id, text: passage.text, context: passage.context })),
}));

fs.writeFileSync(target, header + JSON.stringify(documents, null, 2) + ';\n');
console.log(`已生成 ${path.relative(process.cwd(), target)}：文档 ${documents.length} 份、段落 ${documents.reduce((sum, item) => sum + item.passages.length, 0)} 个`);
