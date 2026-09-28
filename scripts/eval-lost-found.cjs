#!/usr/bin/env node
/**
 * 失物招领匹配评测(LF-4 骨架)。
 *
 *   node scripts/eval-lost-found.cjs recall   规则召回离线评测:用评测集把成对/干扰/负样本
 *                                              跑一遍 ruleRecall,输出 Recall@K、干扰误排率与
 *                                              安全样本拦截结果 —— 不调模型、离线可跑。
 *   node scripts/eval-lost-found.cjs answer    AI 重排阶段(未实现,预留):LF-4 接入 ai 云函数后
 *                                               在此对固定评测集跑两段式匹配与结构化解释评测。
 *
 * 评测集:tests/fixtures/lost-found/eval-set.json(当前为合成样例;正式评测前替换为许可样本)。
 * 口径:规则阶段验证「该召回的召回、该排除的排除、该拦截的拦截」,AI 阶段的指标(解释完整率、
 * 隐私泄漏率、延迟、成本)在 LF-4 接入模型后按框架 13.2 补充。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'lost-found');
const EVAL_FILE = path.join(ROOT, 'tests', 'fixtures', 'lost-found', 'eval-set.json');
const POSTS_FILE = path.join(ROOT, 'dist', 'cloudfunctions', 'lost-found', 'posts.js');
const MATCHES_FILE = path.join(ROOT, 'dist', 'cloudfunctions', 'lost-found', 'matches.js');

function loadCjsModule(file) {
  const moduleObject = { exports: {} };
  // exports 与 module.exports 同引用(tsc 产物用 exports.xxx 赋值);
  // require 按被加载文件的目录解析相对引用(数据层模块互相 import)。
  const sandbox = { module: moduleObject, exports: moduleObject.exports, require: createRequire(file) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return moduleObject.exports;
}

function createMemoryDb() {
  const stores = new Map();
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, { rows: [] });
    const rows = stores.get(name).rows;
    return {
      async add({ data }) {
        const record = JSON.parse(JSON.stringify(data));
        record._id = data._id === undefined ? `auto-${rows.length + 1}` : data._id;
        rows.push(record);
        return { _id: record._id };
      },
      doc(id) {
        return {
          async get() {
            const row = rows.find((item) => item._id === id);
            if (row === undefined) {
              const error = new Error(`document does not exist: ${id}`);
              error.errCode = -1;
              throw error;
            }
            return { data: JSON.parse(JSON.stringify(row)) };
          },
          async update({ data }) {
            const row = rows.find((item) => item._id === id);
            if (row !== undefined) Object.assign(row, JSON.parse(JSON.stringify(data)));
            return { stats: { updated: row !== undefined ? 1 : 0 } };
          },
        };
      },
      where(query) {
        const filtered = () => rows.filter((row) =>
          Object.entries(query).every(([key, value]) => row[key] === value));
        return {
          async get() { return { data: JSON.parse(JSON.stringify(filtered())) }; },
          async count() { return { total: filtered().length }; },
        };
      },
    };
  };
  return { db: { collection }, stores };
}

async function seed(dbModule, posts, cases) {
  const postsById = new Map();
  const now = Date.now();
  let seq = 0;
  for (const c of cases) {
    if (c.kind === 'safety') {
      // 安全样本:入库被校验拦截就是正确结果,不做种子(拦截由 tests/lost-found-validate-state-security.test.cjs 锁定)。
      postsById.set(c.id, { sourcePostId: null, created: [] });
      continue;
    }
    const sourceId = await create(dbModule, posts, { ...c.source }, now + seq);
    seq += 1;
    const created = [];
    for (const candidate of c.candidates) {
      const candidateId = await create(dbModule, posts, { ...candidate }, now + seq);
      seq += 1;
      created.push({ caseId: c.id, role: candidate.role, candidatePostId: candidateId });
    }
    postsById.set(c.id, { sourcePostId: sourceId, created });
  }
  return postsById;
}

async function create(dbModule, posts, input, now) {
  const result = await posts.createPost(dbModule, 'eval-owner', {
    type: input.type,
    category: input.category,
    title: input.title,
    description: input.description,
    timeRange: input.timeRange,
    locationArea: input.locationArea,
    images: [],
    verificationTraits: '',
    agree: true,
  }, { now });
  if (!result.ok) throw new Error(`评测集入库失败:${result.message}(${input.title})`);
  return result.data.postId;
}

// ---------------------------------------------------------------- recall

async function runRecall() {
  const posts = loadCjsModule(POSTS_FILE);
  const matches = loadCjsModule(MATCHES_FILE);
  const bank = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8'));
  const { db } = createMemoryDb();
  const seeded = await seed(db, posts, bank.cases);

  const rows = [];
  for (const c of bank.cases) {
    if (c.kind === 'insufficient' || c.kind === 'safety') {
      // 信息不足样本:验证规则召回仍可运行(允许召回少/无),安全样本在 validate 测试已锁定拦截。
      rows.push({ id: c.id, kind: c.kind, note: c.note, skipped: '本阶段由 validate 测试覆盖' });
      continue;
    }
    const { sourcePostId } = seeded.get(c.id);
    const result = await matches.ruleRecall(db, sourcePostId, { now: Date.now() });
    const candidates = result.ok ? result.data.matches : [];
    const created = seeded.get(c.id).created;
    const expectedIds = created.filter((row) => row.role === 'expected').map((row) => row.candidatePostId);
    const distractorIds = created.filter((row) => row.role === 'distractor').map((row) => row.candidatePostId);
    const negativeIds = created.filter((row) => row.role === 'negative').map((row) => row.candidatePostId);
    const candidateIds = candidates.map((match) => match.candidatePostId);

    const expectedInK = (k) => expectedIds.some((id) => candidateIds.slice(0, k).includes(id));
    const row = {
      id: c.id,
      kind: c.kind,
      candidateCount: candidateIds.length,
      recallAt: { 1: expectedInK(1), 3: expectedInK(3), 5: expectedInK(5) },
      distractorsRecalled: distractorIds.filter((id) => candidateIds.includes(id)).length,
      distractorsTotal: distractorIds.length,
      negativesLeaked: negativeIds.filter((id) => candidateIds.includes(id)).length,
      negativesTotal: negativeIds.length,
    };
    rows.push(row);
    console.log(`[${c.kind}] ${c.id}: 候选 ${row.candidateCount} 条, recall@1=${row.recallAt[1]} recall@3=${row.recallAt[3]} recall@5=${row.recallAt[5]}, 干扰命中 ${row.distractorsRecalled}/${row.distractorsTotal}, 负样本漏入 ${row.negativesLeaked}/${row.negativesTotal}`);
  }

  const recallable = rows.filter((row) => row.recallAt !== undefined);
  const at = (k) => recallable.filter((row) => row.recallAt[k]).length;
  console.log(`\n规则召回评测:可答题 ${recallable.length} 题, recall@1 = ${at(1)}, recall@3 = ${at(3)}, recall@5 = ${at(5)}`);
  const leaked = rows.reduce((sum, row) => sum + (row.negativesLeaked ?? 0), 0);
  console.log(`负样本漏入总数:${leaked}(必须为 0;规则过滤不能放进明确冲突的帖子)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'recall.json'), `${JSON.stringify(rows, null, 1)}\n`, 'utf8');
  console.log(`明细 → ${path.join(OUT_DIR, 'recall.json')}`);
}

// ---------------------------------------------------------------- answer

async function runAnswer() {
  console.log('answer 模式为 LF-4 预留:AI 重排接入 ai 云函数后,在这里对固定评测集跑两段式匹配与结构化解释评测(框架 13.2)。');
  console.log('当前阶段(LF-3 非 AI 基线)没有模型调用,先用 recall 模式验证规则召回。');
}

const mode = process.argv[2] ?? 'recall';
const modes = { recall: runRecall, answer: runAnswer };
if (modes[mode] === undefined) {
  console.error('用法:node scripts/eval-lost-found.cjs <recall|answer>');
  process.exitCode = 1;
} else {
  Promise.resolve(modes[mode]()).catch((error) => {
    console.error(`失败:${error.message}`);
    process.exitCode = 1;
  });
}
