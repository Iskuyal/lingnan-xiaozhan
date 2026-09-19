#!/usr/bin/env node
/**
 * 官网栏目普查（只读）。
 *
 * 用途：Ticket 10「校园通知与政策 RAG 问答」的前置工作包第 1 步——找出官网上哪些栏目
 * 的条目指向**官网自己的详情页**（即正文可入库），哪些只是公众号或外部站的外链。
 *
 * 为什么需要它：教务处的「通知公告」108 条全部指向 mp.weixin.qq.com，一条正文都没有；
 * 只看页脚「共 108 条信息」会误判成可用语料。本脚本把「条目落点」当作判据。
 *
 * 限速：官网 WAF 明写「每秒不能多于 1 个页面请求」，超限返回 403 并冻结 IP，
 * 因此所有请求之间固定间隔 THROTTLE_MS。**不要调小。**
 *
 * 用法：
 *   node scripts/probe-columns.cjs sitemap [sitemap 路径或 URL]
 *       解析 sitemap，按栏目分组统计官网详情页（content_NNNNN）数量。
 *       **注意 sitemap 不完整**（实测 1083 条里 977 条属于 /xyxw/*，连团委 155 条都没收录），
 *       只能当弱信号；判定栏目是否可用要以 columns 模式为准。
 *   node scripts/probe-columns.cjs discover [站点清单 JSON 路径]
 *       从各站点首页抽出候选栏目链接，产出可交给 columns 模式的清单。
 *   node scripts/probe-columns.cjs columns [候选清单 JSON 路径]
 *       抓候选栏目的列表页，分类条目落点，并抽样一篇正文判断容器与字数。
 *       清单格式：[{ "name": "栏目名", "url": "https://…" }, …]
 *
 * 输出：控制台表格 + artifacts/corpus-survey/<mode>.json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const THROTTLE_MS = 1400;
const USER_AGENT = 'Mozilla/5.0 (compatible; wx-match-corpus-survey/0.1)';
const OUT_DIR = path.join(__dirname, '..', 'artifacts', 'corpus-survey');
const DEFAULT_SITEMAP = path.join(OUT_DIR, 'sitemap.xml');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function writeJson(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`\n已写出 ${file}`);
}

/** 把 content_12345 这类详情页归到它的栏目路径。 */
function columnOf(url) {
  const match = /^(https?:\/\/[^/]+)(\/.*?)\/content_\d+$/.exec(url);
  if (match === null) return null;
  return match[2];
}

/** sitemap 模式：按栏目统计官网详情页数量。 */
async function sitemapMode(source) {
  const xml = /^https?:/.test(source) ? await fetchText(source) : fs.readFileSync(source, 'utf8');
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const byColumn = new Map();
  let own = 0;
  let external = 0;
  for (const loc of locs) {
    if (!loc.startsWith('https://lnc.edu.cn')) {
      external += 1;
      continue;
    }
    if (!/content_\d+/.test(loc)) continue;
    own += 1;
    const column = columnOf(loc);
    if (column === null) continue;
    byColumn.set(column, (byColumn.get(column) ?? 0) + 1);
  }
  const rows = [...byColumn.entries()]
    .map(([column, count]) => ({ column, count }))
    .sort((a, b) => b.count - a.count);

  console.log(`sitemap 中共 ${locs.length} 条 URL：本站详情页 ${own} 条，外部站 ${external} 条\n`);
  console.log('栏目路径'.padEnd(34) + '详情页数');
  console.log('-'.repeat(46));
  for (const row of rows) console.log(row.column.padEnd(34) + String(row.count));

  writeJson('sitemap-columns', { source, totalUrls: locs.length, ownDetailPages: own, externalUrls: external, columns: rows });
}

/** 从列表页 HTML 里抠出条目，判断每条落点。 */
function classifyItems(html) {
  const container = /<ul[^>]*class="[^"]*newsList[^"]*"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  const scope = container === null ? html : container[1];
  const items = [...scope.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => m[0]);
  const result = { container: container === null ? '(无 ul.newsList)' : 'ul.newsList', items: [], detail: 0, weixin: 0, other: 0 };
  for (const item of items) {
    const href = /href="([^"]+)"/.exec(item);
    if (href === null) continue;
    const url = href[1];
    const title = /title="([^"]*)"/.exec(item);
    const date = /class="date"[^>]*>([^<]*)</.exec(item);
    let kind = 'other';
    if (/^\/.*content_\d+$/.test(url) || /^https?:\/\/lnc\.edu\.cn\/.*content_\d+$/.test(url)) kind = 'detail';
    else if (/mp\.weixin\.qq\.com/.test(url)) kind = 'weixin';
    else kind = 'other';
    result[kind] += 1;
    result.items.push({
      kind,
      url,
      // title 形如「标题：… 点击数：… 发表时间：…」，取「标题：」之后、「点击数：」之前
      title: title === null ? '' : title[1].replace(/&#xD;&#xA;/g, ' ').replace(/^标题：/, '').split('点击数：')[0].trim(),
      date: date === null ? '' : date[1].trim(),
    });
  }
  return result;
}

/**
 * 抽样一篇官网详情页，判断正文容器与字数。
 *
 * 正文提取不能假设「容器后紧跟边界标记」：通知公告模板的正文里混着整段脚本、
 * `div.property` 与 `h2.title`（见 docs/news-sources.md），所以先按多种右边界取最早的一个截断，
 * 再删掉脚本、property 与标题块，最后剥标签。
 */
function analyzeArticle(html) {
  const title = /<h[12][^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/.exec(html);
  const hasPrintArea = /class="[^"]*printArea[^"]*"/.test(html);
  const hasArticleContent = /class="[^"]*article-content[^"]*"/.test(html);
  const printIndex = html.search(/<div[^>]*class="[^"]*printArea[^"]*"[^>]*>/);
  const contentIndex = html.search(/<div[^>]*class="[^"]*article-content[^"]*"[^>]*>/);
  const start = printIndex >= 0 ? printIndex : contentIndex;
  let text = '';
  if (start >= 0) {
    let slice = html.slice(start);
    const boundaries = [
      /<div[^>]*class="[^"]*userControl/,
      /<div[^>]*id="relativeInfo/,
      /<\/article>/,
      /<div[^>]*class="[^"]*article-fd/,
    ];
    let cut = slice.length;
    for (const boundary of boundaries) {
      const index = slice.search(boundary);
      if (index >= 0 && index < cut) cut = index;
    }
    text = slice
      .slice(0, cut)
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<div[^>]*class="[^"]*property[^"]*"[\s\S]*?<\/div>/g, ' ')
      .replace(/<h[12][^>]*class="[^"]*title[^"]*"[\s\S]*?<\/h[12]>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return {
    title: title === null ? '' : title[1].replace(/<[^>]*>/g, '').trim(),
    containers: { printArea: hasPrintArea, articleContent: hasArticleContent },
    textLength: text.length,
    excerpt: text.slice(0, 120),
  };
}

/** articles 模式：逐篇抽查给定 URL 的正文。 */
async function articlesMode(listFile) {
  const targets = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  const results = [];
  for (const target of targets) {
    try {
      const article = analyzeArticle(await fetchText(target.url));
      console.log(`${target.name}：${article.textLength} 字 | 容器 printArea=${article.containers.printArea} article-content=${article.containers.articleContent}`);
      console.log(`   标题：${article.title}`);
      console.log(`   正文：${article.excerpt}`);
      results.push({ ...target, ...article });
    } catch (error) {
      console.log(`${target.name}：失败 ${String(error.message ?? error)}`);
      results.push({ ...target, error: String(error.message ?? error) });
    }
    await sleep(THROTTLE_MS);
  }
  writeJson('articles', results);
}

/** columns 模式：抓候选栏目列表页并分类。 */
async function columnsMode(listFile) {
  const candidates = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  const results = [];
  for (const candidate of candidates) {
    const row = { name: candidate.name, url: candidate.url };
    try {
      const html = await fetchText(candidate.url);
      const footer = /共\s*(\d+)\s*条信息[^<]*共\s*(\d+)\s*页/.exec(html);
      row.footer = footer === null ? null : { count: Number(footer[1]), pages: Number(footer[2]) };
      Object.assign(row, classifyItems(html));
      const firstDetail = row.items.find((item) => item.kind === 'detail');
      if (firstDetail !== undefined) {
        await sleep(THROTTLE_MS);
        const articleUrl = firstDetail.url.startsWith('http') ? firstDetail.url : `https://lnc.edu.cn${firstDetail.url}`;
        row.article = analyzeArticle(await fetchText(articleUrl));
        row.article.url = articleUrl;
      }
    } catch (error) {
      row.error = String(error.message ?? error);
    }
    console.log(
      `${row.name}：详情页 ${row.detail ?? '-'} / 公众号 ${row.weixin ?? '-'} / 其他 ${row.other ?? '-'}` +
        (row.footer === null || row.footer === undefined ? '' : ` （页脚 共${row.footer.count}条/${row.footer.pages}页）`) +
        (row.article === undefined ? '' : ` | 抽样正文 ${row.article.textLength} 字`) +
        (row.error === undefined ? '' : ` | 失败：${row.error}`),
    );
    results.push(row);
    await sleep(THROTTLE_MS);
  }
  writeJson('columns', results);
}

/** 站点首页里可能是「栏目列表页」的链接（路径深度 ≤ 3，排除详情页与锚点）。 */
function discoverColumns(html, siteRoot) {
  const prefix = new URL(siteRoot).pathname.replace(/\/$/, '');
  const found = new Map();
  for (const match of html.matchAll(/<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = match[1];
    const text = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 14) continue;
    if (!href.startsWith('/')) continue;
    if (/content_\d+/.test(href)) continue;
    if (href.split('/').filter((s) => s !== '').length > 3) continue;
    if (!href.startsWith(prefix === '' ? '/' : prefix)) continue;
    if (found.has(href)) continue;
    found.set(href, text);
  }
  return [...found.entries()].map(([href, text]) => ({ name: text, url: `https://lnc.edu.cn${href}` }));
}

/** discover 模式：从各站点首页抽候选栏目。 */
async function discoverMode(sitesFile) {
  const sites = JSON.parse(fs.readFileSync(sitesFile, 'utf8'));
  const all = [];
  for (const site of sites) {
    try {
      const columns = discoverColumns(await fetchText(site.url), site.url);
      console.log(`${site.name}（${site.url}）：发现 ${columns.length} 个候选栏目`);
      for (const column of columns) all.push({ site: site.name, ...column });
    } catch (error) {
      console.log(`${site.name}：失败 ${String(error.message ?? error)}`);
    }
    await sleep(THROTTLE_MS);
  }
  // 同一路径可能被多个站点页重复发现，按 URL 去重（保留首个名称）
  const unique = new Map();
  for (const column of all) if (!unique.has(column.url)) unique.set(column.url, column);
  writeJson('discover', [...unique.values()]);
}

async function main() {
  const mode = process.argv[2] ?? 'sitemap';
  if (mode === 'sitemap') {
    await sitemapMode(process.argv[3] ?? DEFAULT_SITEMAP);
    return;
  }
  if (mode === 'discover') {
    if (process.argv[3] === undefined) throw new Error('discover 模式需要站点清单 JSON 路径');
    await discoverMode(process.argv[3]);
    return;
  }
  if (mode === 'columns') {
    if (process.argv[3] === undefined) throw new Error('columns 模式需要候选清单 JSON 路径');
    await columnsMode(process.argv[3]);
    return;
  }
  if (mode === 'articles') {
    if (process.argv[3] === undefined) throw new Error('articles 模式需要 URL 清单 JSON 路径');
    await articlesMode(process.argv[3]);
    return;
  }
  throw new Error(`未知模式：${mode}（可用：sitemap / discover / columns / articles）`);
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
