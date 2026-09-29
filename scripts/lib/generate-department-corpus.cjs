/**
 * 部门动态语料的构建侧生成逻辑（scripts/build.mjs 注入 ai 云函数用）。
 *
 * 单一数据源：语料从 miniprogram/services/departments.ts 的编译产物导出，
 * 渲染成 CJS 模块写进 dist/cloudfunctions/ai/department-corpus.js，
 * 云函数运行时 require 后交给 rag.ts 预建索引。
 * 这里拆成纯函数（CJS 便于 build.mjs 与 node:test 两边直接加载）。
 */

/** 生成语料载荷：只取检索需要的最小字段，来源信息一并带上（供注入文本与展示用）。 */
function buildCorpusPayload(departmentsModule) {
  const departments = departmentsModule.departments;
  const source = departmentsModule.departmentsSource;
  return {
    generatedFrom: 'miniprogram/services/departments.ts',
    source: {
      label: typeof source?.label === 'string' ? source.label : '',
      sourceUrl: typeof source?.sourceUrl === 'string' ? source.sourceUrl : '',
      verifiedAt: typeof source?.verifiedAt === 'string' ? source.verifiedAt : '',
    },
    departments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      activities: department.activities.map((activity) => ({
        title: activity.title,
        publishedAt: activity.publishedAt,
        sourceUrl: activity.sourceUrl,
      })),
    })),
  };
}

/** 渲染成云函数可 require 的 CJS 模块文本（带来源注释，防止被当成手写文件修改）。 */
function renderCorpusModule(payload) {
  return [
    '// 本文件由 scripts/build.mjs 生成（scripts/lib/generate-department-corpus.cjs），勿手工编辑。',
    `// 语料数据源：${payload.generatedFrom}，核查日期 ${payload.source.verifiedAt}。`,
    `module.exports = ${JSON.stringify(payload, null, 1)};`,
    '',
  ].join('\n');
}

module.exports = { buildCorpusPayload, renderCorpusModule };
