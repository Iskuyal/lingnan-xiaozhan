/**
 * 部门动态语料生成逻辑（scripts/lib/generate-department-corpus.cjs）的测试。
 *
 * 断言三件事：
 * - 生成载荷只含检索需要的最小字段（不把整个 departments 模块泄漏进云函数）；
 * - 渲染结果是可加载的 CJS 模块，形状与 cloudfunctions/ai/rag.ts 的语料契约一致；
 * - 真实构建后 dist/cloudfunctions/ai/department-corpus.js 存在且内容可被 rag.ts 消费
 *   （本测试文件由 npm test 在 build 之后运行，产物已在）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildCorpusPayload, renderCorpusModule } = require('../scripts/lib/generate-department-corpus.cjs');

/** 与 departments.ts 同形状的最小样例（只含生成器要读的字段）。 */
function sampleModule() {
  return {
    departmentsSource: {
      label: '学校官网 · 团委 · 学生组织',
      sourceUrl: 'https://lnc.edu.cn/tw/sygk/xszz',
      verifiedAt: '2026-09-18',
      note: '无关字段不应进入载荷',
    },
    departments: [
      {
        id: 'student-union',
        name: '校学生会',
        campus: '广州校区',
        introduction: '简介不应进入载荷',
        units: [],
        contacts: [],
        activities: [
          { title: '校学生会举办迎新晚会', publishedAt: '2026-09-20', sourceUrl: 'https://lnc.edu.cn/a' },
        ],
        sourceUrl: 'https://lnc.edu.cn/su',
        verifiedAt: '2026-09-18',
      },
    ],
  };
}

test('载荷只含检索需要的字段：简介、联系方式、校区等不进入云函数语料', () => {
  const payload = buildCorpusPayload(sampleModule());
  assert.equal(payload.generatedFrom, 'miniprogram/services/departments.ts');
  assert.equal(payload.source.verifiedAt, '2026-09-18');
  assert.equal(payload.departments.length, 1);
  const department = payload.departments[0];
  assert.deepEqual(Object.keys(department).sort(), ['activities', 'id', 'name']);
  assert.deepEqual(Object.keys(department.activities[0]).sort(), ['publishedAt', 'sourceUrl', 'title']);
});

test('渲染结果是可加载的 CJS 模块，且载荷往返一致', () => {
  const payload = buildCorpusPayload(sampleModule());
  const source = renderCorpusModule(payload);
  assert.ok(source.includes('勿手工编辑'), '生成文件要带来源注释');
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(source, sandbox);
  // vm 跨 realm 的对象原型不同，deepStrictEqual 会误报；按 JSON 往返比较内容。
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.module.exports)), JSON.parse(JSON.stringify(payload)));
});

test('真实构建产物存在，且 rag.ts 能消费（部门与动态字段齐全）', () => {
  const file = path.resolve('dist/cloudfunctions/ai/department-corpus.js');
  assert.ok(fs.existsSync(file), '构建产物缺失：先运行 npm run build');
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const corpus = sandbox.module.exports;
  const rag = require('../dist/cloudfunctions/ai/rag.js');
  const docs = rag.documentsOf(corpus);
  assert.ok(docs.length > 0, '语料里要有动态条目');
  for (const doc of docs) {
    assert.ok(doc.departmentName !== '');
    assert.ok(doc.sourceUrl.startsWith('https://'));
  }
  // 语料与源码同源：条目标题能查回 departments.ts 的原文（防止生成器悄悄改内容）。
  const departmentsSource = fs.readFileSync('miniprogram/services/departments.ts', 'utf8');
  const first = docs[0];
  assert.ok(departmentsSource.includes(first.title), `动态标题「${first.title}」不在 departments.ts 原文里`);
});
