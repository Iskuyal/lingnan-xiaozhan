#!/usr/bin/env node
/**
 * RAG 可行性 PoC 工具（Ticket 10）。
 *
 * 三个子命令，第一轮不需要模型密钥：
 *
 *   node scripts/rag-poc.cjs crawl   抓语料快照到 artifacts/rag-poc/corpus.json
 *                                    用**项目自己的解析器**（dist/cloudfunctions/newsSync/parse.js）
 *                                    处理页面，保证 PoC 语料与云端入库结果同源。
 *                                    只读、遵守官网 ≤1 请求/秒（间隔 1.4 秒），支持断点续抓。
 *   node scripts/rag-poc.cjs recall  纯本地检索评估：用大字符二元组召回打分，
 *                                    对照题库的 expectedUrl 量 recall@1/3/5 —— 不调模型。
 *   node scripts/rag-poc.cjs answer  模型阶段：检索 → 把候选段落送模型 → 记录
 *                                    逐题答案、耗时与成本（需要 AI_BASE_URL / AI_API_KEY / AI_MODEL）。
 *
 * 题库：docs/evidence/p6-rag/questions.json（含每题预期的原文 URL 与陷阱题标记）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'rag-poc');
const CORPUS_FILE = path.join(OUT_DIR, 'corpus.json');
const QUESTIONS_FILE = path.join(ROOT, 'docs', 'evidence', 'p6-rag', 'questions.json');
const THROTTLE_MS = 1400;
const USER_AGENT = 'Mozilla/5.0 (compatible; wx-match-rag-poc/0.1)';

/** 语料来源：Ticket 10 选定入库的 A 类「通知 / 办事指引」栏目（见 cloudfunctions/newsSync/columns.ts）。 */
const COLUMNS = [
  { id: 'tw-tqsd', label: '团委通知公告', listUrl: 'https://lnc.edu.cn/tw/djxf/tqsd', pages: 16 },
  { id: 'bw-tqsd', label: '保卫工作部通知公告', listUrl: 'https://lnc.edu.cn/bw/tqsd', pages: 2 },
  { id: 'bw-xywt', label: '保卫工作部服务指南', listUrl: 'https://lnc.edu.cn/bw/xywt', pages: 1 },
  { id: 'bw-aqglzd', label: '保卫工作部安全管理制度', listUrl: 'https://lnc.edu.cn/bw/djxf/aqglzd', pages: 1 },
  { id: 'zl-tzgg', label: '质量监控中心通知公告', listUrl: 'https://lnc.edu.cn/zl/tzgg', pages: 7 },
  { id: 'jwc-jxyh', label: '教务处教学运行', listUrl: 'https://lnc.edu.cn/jwc/jxyh', pages: 1 },
  { id: 'zxsy-lnpp', label: '知行书院通知公告', listUrl: 'https://lnc.edu.cn/zxsy/lnpp', pages: 1 },
  { id: 'ln-ggtz', label: '砺能书院公告通知', listUrl: 'https://lnc.edu.cn/ln/xssw/ggtz', pages: 1 },
  { id: 'cl-zzyr', label: '崇礼书院资助育人', listUrl: 'https://lnc.edu.cn/cl/jyjx/zzyr', pages: 1 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function loadParser() {
  const file = path.join(ROOT, 'dist', 'cloudfunctions', 'newsSync', 'parse.js');
  if (!fs.existsSync(file)) throw new Error('缺少解析器产物：先运行 npm run build');
  return require(file);
}

function readCorpus() {
  if (!fs.existsSync(CORPUS_FILE)) throw new Error(`缺少语料快照：先运行 crawl（${CORPUS_FILE}）`);
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
}

// ---------------------------------------------------------------- crawl

async function crawl() {
  const parse = loadParser();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpus = fs.existsSync(CORPUS_FILE) ? readCorpus() : { capturedAt: '', documents: [] };
  corpus.skipped = corpus.skipped ?? { offsite: 0, imageOnly: 0, empty: 0 };
  const known = new Set(corpus.documents.map((doc) => doc.url));
  let fetched = 0;

  for (const column of COLUMNS) {
    for (let page = 1; page <= column.pages; page += 1) {
      const pageUrl = page === 1 ? column.listUrl : `${column.listUrl}_${page}`;
      let items = [];
      try {
        items = parse.parseAnnouncementList(await fetchText(pageUrl), column.listUrl);
      } catch (error) {
        console.log(`  列表失败 ${pageUrl}：${error.message}`);
        await sleep(THROTTLE_MS);
        continue;
      }
      console.log(`${column.label} 第 ${page} 页：${items.length} 条`);
      await sleep(THROTTLE_MS);
      for (const item of items) {
        if (!item.url.startsWith('https://lnc.edu.cn/')) {
          corpus.skipped.offsite += 1;
          continue; // 站外（公众号）条目：项目已定不入库正文
        }
        if (known.has(item.url)) continue;
        try {
          const html = await fetchText(item.url);
          const article = parse.parseAnnouncementArticle(html, item.url);
          if (article.paragraphs.length === 0) {
            // 实测有一批通知的正文是**海报扫描图**（div.conTxt 里只有 <img>），
            // 不是解析失败 —— 这类条目对文本 RAG 不可用，单独计数以便量化。
            const body = /<div[^>]*class="[^"]*conTxt[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*class="[^"]*auditRecord|<div[^>]*class="[^"]*printFd|<\/div>)/i.exec(html);
            const looksImage = body !== null && /<img/i.test(body[1]) && body[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim().length < 20;
            corpus.skipped = corpus.skipped ?? { offsite: 0, imageOnly: 0, empty: 0 };
            if (looksImage) {
              corpus.skipped.imageOnly += 1;
              console.log(`    图片正文（无文字）：${item.title.slice(0, 26)}`);
            } else {
              corpus.skipped.empty += 1;
              console.log(`    无正文：${item.title.slice(0, 26)}`);
            }
          } else {
            corpus.documents.push({
              url: item.url,
              column: column.label,
              title: article.title === '' ? item.title : article.title,
              date: article.date === '' ? item.date : article.date,
              paragraphs: article.paragraphs,
            });
            known.add(item.url);
            fetched += 1;
          }
        } catch (error) {
          console.log(`    正文失败 ${item.url}：${error.message}`);
        }
        await sleep(THROTTLE_MS);
        // 边抓边落盘：中断后重跑会自动跳过已有 URL
        if (fetched % 10 === 0) {
          corpus.capturedAt = new Date().toISOString().slice(0, 10);
          writeCorpus(corpus);
        }
      }
    }
  }
  corpus.capturedAt = new Date().toISOString().slice(0, 10);
  writeCorpus(corpus);
  const skipped = corpus.skipped ?? { offsite: 0, imageOnly: 0, empty: 0 };
  console.log(`\n语料快照：${corpus.documents.length} 篇有正文（本次新增 ${fetched}）→ ${CORPUS_FILE}`);
  console.log(`不可用条目：图片正文 ${skipped.imageOnly}、无正文 ${skipped.empty}、站外（公众号）${skipped.offsite}`);
}

function writeCorpus(corpus) {
  fs.writeFileSync(CORPUS_FILE, `${JSON.stringify(corpus, null, 1)}\n`, 'utf8');
}

// ---------------------------------------------------------------- images

/**
 * 收集「正文是图片」的通知及其图片 URL（Ticket 11 的输入清单）。
 *
 * 复用同一份栏目清单与解析器：列表页给出条目，已在 corpus.json 里的跳过（那是有正文的），
 * 其余抓文章页，抠出 div.conTxt 里的 <img src>。**不下载图片**——腾讯云 OCR 支持直接传
 * 公网可访问的 ImageUrl，省掉数百 MB 的本地存储。
 */
async function collectImages() {
  const parse = loadParser();
  const corpus = readCorpus();
  const known = new Set(corpus.documents.map((doc) => doc.url));
  const notices = [];

  for (const column of COLUMNS) {
    for (let page = 1; page <= column.pages; page += 1) {
      const pageUrl = page === 1 ? column.listUrl : `${column.listUrl}_${page}`;
      let items = [];
      try {
        items = parse.parseAnnouncementList(await fetchText(pageUrl), column.listUrl);
      } catch (error) {
        console.log(`  列表失败 ${pageUrl}：${error.message}`);
        await sleep(THROTTLE_MS);
        continue;
      }
      await sleep(THROTTLE_MS);
      for (const item of items) {
        if (known.has(item.url) || !item.url.startsWith('https://lnc.edu.cn/')) continue;
        try {
          const html = await fetchText(item.url);
          const article = parse.parseAnnouncementArticle(html, item.url);
          if (article.paragraphs.length > 0) continue; // 已有正文，不属本清单
          const body = /<div[^>]*class="[^"]*conTxt[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*auditRecord/i.exec(html);
          const scope = body === null ? html : body[1];
          const images = [...scope.matchAll(/<img[^>]+src="([^"]+)"/gi)]
            .map((m) => m[1])
            .filter((src) => src.startsWith('/') || src.startsWith('http'))
            .map((src) => (src.startsWith('http') ? src : `https://lnc.edu.cn${src}`));
          if (images.length > 0) {
            notices.push({
              column: column.label,
              url: item.url,
              title: item.title,
              date: item.date,
              images,
            });
            console.log(`  ${item.title.slice(0, 28)}：${images.length} 张图`);
          }
        } catch (error) {
          console.log(`    失败 ${item.url}：${error.message}`);
        }
        await sleep(THROTTLE_MS);
      }
    }
  }

  const out = path.join(OUT_DIR, 'image-notices.json');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), notices }, null, 1)}\n`, 'utf8');
  const total = notices.reduce((sum, notice) => sum + notice.images.length, 0);
  console.log(`\n图片正文通知 ${notices.length} 篇，共 ${total} 张图 → ${out}`);
  console.log('下一步：node scripts/ocr-backfill.cjs plan（用密钥前先看清单与调用量）');
}

// ---------------------------------------------------------------- recall

/**
 * 检索打分：大字符二元组（bigram）倒排 + idf 加权。
 *
 * 为什么不用分词与向量：项目没有分词依赖，`ai` 云函数也没有 embeddings 端点（见票内技术约束）。
 * 中文 bigram 无需词典即可工作，且能在云函数里预建索引。
 */
function bigrams(text) {
  const clean = text.replace(/[\s\p{P}]+/gu, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2));
  return grams;
}

function buildIndex(documents) {
  const docGrams = documents.map((doc) => bigrams(`${doc.title} ${doc.paragraphs.join(' ')}`));
  const df = new Map();
  for (const grams of docGrams) for (const gram of grams) df.set(gram, (df.get(gram) ?? 0) + 1);
  const total = documents.length;
  const idf = new Map();
  for (const [gram, count] of df) idf.set(gram, Math.log(1 + total / count));
  return { docGrams, idf };
}

function score(index, question) {
  const query = bigrams(question);
  const scored = index.docGrams.map((grams, index_) => {
    let sum = 0;
    for (const gram of query) if (grams.has(gram)) sum += index.idf.get(gram) ?? 0;
    return { index: index_, score: sum };
  });
  return scored.sort((a, b) => b.score - a.score);
}

function recallAt(ranking, documents, expectedUrl, k) {
  return ranking.slice(0, k).some((row) => documents[row.index].url === expectedUrl);
}

function runRecall() {
  const corpus = readCorpus();
  const { documents } = corpus;
  const bank = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const index = buildIndex(documents);
  console.log(`语料 ${documents.length} 篇，题库 ${bank.questions.length} 题\n`);

  const rows = [];
  for (const question of bank.questions) {
    const ranking = score(index, question.q);
    const top = ranking.slice(0, 5).map((row) => ({ score: Number(row.score.toFixed(1)), doc: documents[row.index] }));
    const row = {
      id: question.id,
      kind: question.kind,
      q: question.q,
      expectedUrl: question.expectedUrl ?? null,
      expectedTitle: question.expectedTitle ?? null,
      top,
    };
    if (question.expectedUrl !== undefined && question.expectedUrl !== null) {
      row.recall = {
        at1: recallAt(ranking, documents, question.expectedUrl, 1),
        at3: recallAt(ranking, documents, question.expectedUrl, 3),
        at5: recallAt(ranking, documents, question.expectedUrl, 5),
        rank: ranking.findIndex((r) => documents[r.index].url === question.expectedUrl) + 1,
      };
    }
    rows.push(row);
    const mark = row.recall === undefined
      ? (top[0].score > 0 ? `最高分 ${top[0].score}` : '零命中')
      : `rank=${row.recall.rank} ${row.recall.at5 ? '✅' : '❌'}`;
    console.log(`[${question.kind}] ${question.q}`);
    console.log(`    ${mark} | 首条候选：${top[0].doc.title.slice(0, 30)}`);
  }

  const answerable = rows.filter((row) => row.recall !== undefined);
  const hit = (k) => answerable.filter((row) => row.recall[`at${k}`]).length;
  console.log(`\n可答题 ${answerable.length} 题：recall@1 = ${hit(1)}，recall@3 = ${hit(3)}，recall@5 = ${hit(5)}`);
  const traps = rows.filter((row) => row.kind === 'trap');
  console.log(`陷阱题 ${traps.length} 题：最高分 = ${traps.map((row) => row.top[0].score).join('、')}（越低越好；高分说明语料里有似是而非的内容）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'recall.json'), `${JSON.stringify(rows, null, 1)}\n`, 'utf8');
  console.log(`\n明细 → ${path.join(OUT_DIR, 'recall.json')}`);
}

// ---------------------------------------------------------------- answer

/** 模型阶段：检索候选段落 → 送模型作答 → 记录答案、耗时与成本（需要密钥）。 */
async function runAnswer() {
  const baseUrl = (process.env.AI_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = process.env.AI_API_KEY ?? '';
  const model = process.env.AI_MODEL ?? '';
  if (baseUrl === '' || apiKey === '' || model === '') {
    throw new Error('模型阶段需要 AI_BASE_URL / AI_API_KEY / AI_MODEL 三个环境变量（与云函数同一套配置）');
  }
  const corpus = readCorpus();
  const bank = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const index = buildIndex(corpus.documents);
  const results = [];

  for (const question of bank.questions) {
    const ranking = score(index, question.q);
    const candidates = ranking.slice(0, 5).map((row) => corpus.documents[row.index]);
    const context = candidates
      .map((doc, i) => `【资料${i + 1}】${doc.title}（${doc.date}，${doc.url}）\n${doc.paragraphs.join('\n').slice(0, 1200)}`)
      .join('\n\n');
    const prompt = [
      '你是校园事务助手。只能依据下面的资料回答，资料里没有的必须回答「没查到」，不得编造。',
      '回答时给出依据的资料编号与原文链接。',
      '',
      `问题：${question.q}`,
      '',
      context,
    ].join('\n');

    const startedAt = Date.now();
    let answer = '';
    let usage = null;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 800 }),
      });
      const body = await res.json();
      answer = body?.choices?.[0]?.message?.content ?? '';
      usage = body?.usage ?? null;
      if (!res.ok) answer = `HTTP ${res.status}：${JSON.stringify(body).slice(0, 200)}`;
    } catch (error) {
      answer = `调用失败：${error.message}`;
    }
    const elapsedMs = Date.now() - startedAt;
    results.push({ id: question.id, kind: question.kind, q: question.q, expectedUrl: question.expectedUrl ?? null, candidates: candidates.map((doc) => doc.url), answer, usage, elapsedMs });
    console.log(`\n[${question.kind}] ${question.q}\n  ${answer.slice(0, 200).replace(/\n/g, ' ')}\n  ${elapsedMs}ms${usage ? ` | ${usage.prompt_tokens}+${usage.completion_tokens} tok` : ''}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'answers.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
  const avg = Math.round(results.reduce((sum, row) => sum + row.elapsedMs, 0) / results.length);
  console.log(`\n平均耗时 ${avg}ms；明细 → ${path.join(OUT_DIR, 'answers.json')}`);
  console.log('判定（有据/没查到/编造）与引用是否支持答案需要人工逐题核对，脚本不替你打分。');
}

const mode = process.argv[2] ?? '';
const modes = { crawl, images: collectImages, recall: runRecall, answer: runAnswer };
if (modes[mode] === undefined) {
  console.error('用法：node scripts/rag-poc.cjs <crawl|images|recall|answer>');
  process.exitCode = 1;
} else {
  modes[mode]().catch((error) => {
    console.error(`失败：${error.message}`);
    process.exitCode = 1;
  });
}
