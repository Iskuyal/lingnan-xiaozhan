#!/usr/bin/env node
/**
 * 部门动态 RAG 评测（feat/department-activity-rag，Ticket 10 先行落地）。
 *
 *   node scripts/eval-department-rag.cjs recall   检索命中评测：对动态题跑与云函数同一套
 *                                                 检索（top-5），对照题库 expectedUrl 量
 *                                                 recall@1/3/5 —— 不调模型、离线可跑。
 *   node scripts/eval-department-rag.cjs answer   达标线重测：检索注入 → 拼产品同款系统提示词
 *                                                 → 送模型作答，记录逐题答案、命中来源与耗时。
 *                                                 需要 AI_BASE_URL / AI_API_KEY / AI_MODEL
 *                                                 （与 ai 云函数同一套环境变量）。
 *                                                 脚本不自动打分：有据 / 没查到 / 编造由人工
 *                                                 逐题判定（与 rag-poc.cjs 同一口径）。
 *
 * 题库：docs/evidence/department-rag/questions.json（基础题不评测检索：随包全量语料保证）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'department-rag');
const QUESTIONS_FILE = path.join(ROOT, 'docs', 'evidence', 'department-rag', 'questions.json');
const CORPUS_FILE = path.join(ROOT, 'dist', 'cloudfunctions', 'ai', 'department-corpus.js');
const RAG_FILE = path.join(ROOT, 'dist', 'cloudfunctions', 'ai', 'rag.js');
const QA_FILE = path.join(ROOT, 'dist', 'pages', 'departments', 'qa.js');
const RECALL_K = 5;
const INJECT_K = 3;

function loadCjsModule(file) {
  if (!fs.existsSync(file)) throw new Error(`缺少产物：${file}（先运行 npm run build）`);
  const moduleObject = { exports: {} };
  // exports 必须与 module.exports 同引用：tsc 产物用 exports.xxx 赋值，各指一个对象会丢导出。
  // require 按被加载文件的目录解析相对引用：qa.js 依赖 services/ai 与 services/departments。
  const sandbox = { module: moduleObject, exports: moduleObject.exports, require: createRequire(file) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return moduleObject.exports;
}

function readQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) throw new Error(`缺少题库：${QUESTIONS_FILE}`);
  return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
}

// ---------------------------------------------------------------- recall

function runRecall() {
  const corpus = loadCjsModule(CORPUS_FILE);
  const rag = loadCjsModule(RAG_FILE);
  const bank = readQuestions();
  const rows = [];
  const activityRows = [];

  for (const question of bank.questions) {
    if (question.kind !== 'activity') continue;
    const hits = rag.retrieveActivities(corpus, question.q, RECALL_K);
    const rank = hits.findIndex((hit) => hit.sourceUrl === question.expectedUrl) + 1;
    const row = {
      id: question.id,
      q: question.q,
      expectedUrl: question.expectedUrl,
      expectedTitle: question.expectedTitle,
      top: hits.map((hit) => ({ score: hit.score, department: hit.departmentName, title: hit.title })),
      rank,
      recall: { at1: rank === 1, at3: rank >= 1 && rank <= 3, at5: rank >= 1 && rank <= RECALL_K },
    };
    rows.push(row);
    activityRows.push(row);
    console.log(`[${question.id}] ${question.q}`);
    console.log(`    rank=${rank} ${row.recall.at5 ? '✅' : '❌'} | 首条候选：${hits.length > 0 ? hits[0].title.slice(0, 30) : '（无命中）'}`);
  }

  const hit = (k) => activityRows.filter((row) => row.recall[`at${k}`]).length;
  console.log(`\n动态题 ${activityRows.length} 题：recall@1 = ${hit(1)}，recall@3 = ${hit(3)}，recall@5 = ${hit(5)}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'recall.json'), `${JSON.stringify(rows, null, 1)}\n`, 'utf8');
  console.log(`明细 → ${path.join(OUT_DIR, 'recall.json')}`);
}

// ---------------------------------------------------------------- answer

async function runAnswer() {
  const baseUrl = (process.env.AI_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = process.env.AI_API_KEY ?? '';
  const model = process.env.AI_MODEL ?? '';
  if (baseUrl === '' || apiKey === '' || model === '') {
    throw new Error('达标线重测需要 AI_BASE_URL / AI_API_KEY / AI_MODEL 三个环境变量（与 ai 云函数同一套配置）');
  }
  const corpus = loadCjsModule(CORPUS_FILE);
  const rag = loadCjsModule(RAG_FILE);
  const qa = loadCjsModule(QA_FILE);
  const bank = readQuestions();
  const results = [];

  for (const question of bank.questions) {
    // 与云函数同一道意图闸门：基础题不检索注入（citations 为空），动态题才检索。
    const hits = rag.isActivityQuestion(question.q)
      ? rag.retrieveActivities(corpus, question.q, INJECT_K)
      : [];
    const injected = rag.injectedTextFor(hits);
    const system = `${qa.buildSystemPrompt()}${injected === '' ? '' : `\n\n${injected}`}`;
    const startedAt = Date.now();
    let answer = '';
    let usage = null;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: question.q },
          ],
          temperature: 0.2,
          max_tokens: 800,
        }),
      });
      const body = await res.json();
      answer = body?.choices?.[0]?.message?.content ?? '';
      usage = body?.usage ?? null;
      if (!res.ok) answer = `HTTP ${res.status}：${JSON.stringify(body).slice(0, 200)}`;
    } catch (error) {
      answer = `调用失败：${error.message}`;
    }
    results.push({
      id: question.id,
      kind: question.kind,
      q: question.q,
      expectedUrl: question.expectedUrl ?? null,
      citations: hits.map((hit) => hit.sourceUrl),
      answer,
      usage,
      elapsedMs: Date.now() - startedAt,
    });
    console.log(`\n[${question.kind}] ${question.q}\n  ${answer.slice(0, 200).replace(/\n/g, ' ')}\n  ${Date.now() - startedAt}ms${usage ? ` | ${usage.prompt_tokens}+${usage.completion_tokens} tok` : ''}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'answers.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
  console.log(`\n明细 → ${path.join(OUT_DIR, 'answers.json')}`);
  console.log('判定（有据 / 没查到 / 编造）与引用是否支持答案需要人工逐题核对，脚本不替你打分。');
}

const mode = process.argv[2] ?? 'recall';
const modes = { recall: runRecall, answer: runAnswer };
if (modes[mode] === undefined) {
  console.error('用法：node scripts/eval-department-rag.cjs <recall|answer>');
  process.exitCode = 1;
} else {
  Promise.resolve(modes[mode]()).catch((error) => {
    console.error(`失败：${error.message}`);
    process.exitCode = 1;
  });
}
