/**
 * 分析小样结果：解析成功率、各测试项的 token 分布、分类标签分布等。
 */
const fs = require('fs');
const path = require('path');

const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'results.json'), 'utf8'));

console.log('===== 1. 结构化输出解析成功率 =====');
const structTests = ['extract', 'classify', 'actions'];
for (const t of structTests) {
  let ok = 0, bad = 0, missing = 0;
  for (const a of r.perArticle) {
    const o = a.outputs[t];
    if (!o || o.error) { missing++; continue; }
    if (o.parsed) ok++; else bad++;
  }
  console.log(`${t.padEnd(9)} 解析成功 ${ok}/${r.perArticle.length}  解析失败 ${bad}  调用出错 ${missing}`);
}

console.log('\n===== 2. 各测试项的 token 消耗（40 次逐篇调用）=====');
const byTest = {};
for (const c of r.calls) {
  if (c.articleId === 'RAG') continue;
  byTest[c.test] = byTest[c.test] || { p: 0, c: 0, ms: 0, n: 0 };
  byTest[c.test].p += c.promptTokens;
  byTest[c.test].c += c.completionTokens;
  byTest[c.test].ms += c.ms;
  byTest[c.test].n++;
}
console.log('测试项      调用  输入tok  输出tok   合计   占比   平均耗时');
let grand = 0;
for (const c of r.calls) if (c.articleId !== 'RAG') grand += c.promptTokens + c.completionTokens;
const rows = Object.entries(byTest).sort((a, b) => (b[1].p + b[1].c) - (a[1].p + a[1].c));
for (const [k, v] of rows) {
  const tot = v.p + v.c;
  console.log(
    `${k.padEnd(10)} ${String(v.n).padStart(4)}  ${String(v.p).padStart(7)}  ${String(v.c).padStart(7)}  ${String(tot).padStart(6)}  ${((tot / grand) * 100).toFixed(1).padStart(5)}%  ${Math.round(v.ms / v.n)}ms`
  );
}

console.log('\n===== 3. actions（学生行动项）结果 =====');
for (const a of r.perArticle) {
  const o = a.outputs.actions;
  const p = o && o.parsed;
  console.log(`  ${p ? (p.hasAction ? '有行动项' : '无行动项') : '解析失败'}  ${a.title.slice(0, 30)}`);
}

console.log('\n===== 4. classify 标签分布 =====');
const tagCount = {};
for (const a of r.perArticle) {
  const p = a.outputs.classify && a.outputs.classify.parsed;
  if (!Array.isArray(p)) continue;
  for (const t of p) tagCount[t] = (tagCount[t] || 0) + 1;
}
for (const [k, v] of Object.entries(tagCount).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v} 次`);

console.log('\n===== 5. 抽取字段完整度 =====');
let dateOk = 0, placeOk = 0, orgOk = 0, typeOk = 0, total = 0;
for (const a of r.perArticle) {
  const p = a.outputs.extract && a.outputs.extract.parsed;
  if (!p) continue;
  total++;
  if (p.date) dateOk++;
  if (p.place) placeOk++;
  if (Array.isArray(p.organizer) ? p.organizer.length : p.organizer) orgOk++;
  if (p.eventType) typeOk++;
}
console.log(`  可解析样本 ${total}`);
console.log(`  date 有值      ${dateOk}/${total}`);
console.log(`  place 有值     ${placeOk}/${total}`);
console.log(`  organizer 有值 ${orgOk}/${total}`);
console.log(`  eventType 有值 ${typeOk}/${total}`);

console.log('\n===== 6. 规模换算 =====');
const perArticle = grand / r.perArticle.length;
console.log(`  单篇文章跑全部 5 项: ${Math.round(perArticle)} token`);
const ragTok = r.calls.filter((c) => c.articleId === 'RAG').reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
console.log(`  单次跨全库问答: 约 ${Math.round(ragTok / 3)} token`);
console.log(`  若对全站 1252 篇都跑: 约 ${(perArticle * 1252 / 1e6).toFixed(1)}M token`);
console.log(`  若只跑「结构化抽取」一项: 约 ${Math.round((byTest.extract.p + byTest.extract.c) / r.perArticle.length * 1252 / 1e6 * 10) / 10}M token`);
