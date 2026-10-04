/**
 * 生成答辩练习的材料数据模块（构建产物：`dist/cloudfunctions/ai/defense-materials.js`）。
 *
 * 单一来源是 **G0 冻结的两份事实卡**：本脚本只做「读原文 + 打成模块」，**不改写正文**，
 * 因此云函数侧看到的材料与冻结件逐字一致；冻结件一旦被改动，构建产物跟着变，
 * `tests/defense-g3.test.cjs` 会比对两者，改冻结件而不改这里不会静默通过。
 *
 * 为什么材料在**服务端**：客户端只发 `materialId`。答辩练习的判定是「回答能不能回核到当前材料」，
 * 如果材料正文由客户端提供，客户端就能自带一份「方便自己」的材料；放服务端后，
 * 引用核对是对服务端那份冻结原文做的。这也与升学问答的语料同一套路数。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 冻结素材包目录（相对仓库根）。 */
const PACKAGE_DIR = 'docs/evidence/project-defense-g0';

/** 两份材料的登记表：id / 展示名 / 性质 / 冻结文件名。 */
const MATERIAL_SOURCES = Object.freeze([
  Object.freeze({
    id: 'FC-1',
    name: '课表导入与校对',
    kind: 'owned',
    kindLabel: '本项目自有材料',
    file: 'fact-card-1-timetable.md',
  }),
  Object.freeze({
    id: 'FC-2',
    name: '打字练习小游戏',
    kind: 'design',
    kindLabel: '维护者原创设计情景（不是小程序已有功能）',
    file: 'fact-card-2-typing-game.md',
  }),
]);

/** 读一份冻结事实卡的正文（统一换行、去掉首尾空白，正文本身不改）。 */
function readMaterial(root, source) {
  const file = path.join(root, PACKAGE_DIR, source.file);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').trim();
  if (text === '') throw new Error(`${source.file} 正文为空`);
  return { id: source.id, name: source.name, kind: source.kind, kindLabel: source.kindLabel, file: source.file, text };
}

/** 装配两份材料；任何一份读不到都抛错（调用方决定 fail-open 还是 fail-closed）。 */
function buildDefenseMaterials(root) {
  return MATERIAL_SOURCES.map((source) => readMaterial(root, source));
}

/** 渲染成 CJS 模块：只导出 `DEFENSE_MATERIALS`，正文用 JSON 转义，逐字保真。 */
function renderDefenseMaterialsModule(materials) {
  return [
    '// 由 scripts/build.mjs 从 docs/evidence/project-defense-g0/ 的冻结件生成，请勿手改。',
    `module.exports = ${JSON.stringify({ DEFENSE_MATERIALS: materials }, null, 2)};`,
    '',
  ].join('\n');
}

module.exports = { PACKAGE_DIR, MATERIAL_SOURCES, buildDefenseMaterials, renderDefenseMaterialsModule };
