/**
 * AI 资讯小样 · 第 1 步：抓取真实资讯
 *
 * 目的：拿学校官网的真实文章做后续 AI 抽取测试的输入。
 * 关键点：解析逻辑直接复用项目自己的编译产物（dist/cloudfunctions/newsSync/parse.js），
 *         不另写一套，保证小样跑的是"生产同款"解析。
 *
 * 输出：data/news.json
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PARSE_PATH = path.join(PROJECT_ROOT, 'dist/cloudfunctions/newsSync/parse.js');
if (!fs.existsSync(PARSE_PATH)) {
  console.error('请先在仓库根目录运行 npm run build，再重试。');
  process.exit(1);
}
const parse = require(PARSE_PATH);

const LIST_URL = 'https://lnc.edu.cn/xyxw/xydt';
const BASE_URL = 'https://lnc.edu.cn/xyxw/xydt/';
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'news.json');
const ARTICLE_COUNT = 8;
const DELAY_MS = 1300; // 官网限速约 1 请求/秒

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} for ${url} :: ${body}`);
  }
  return await res.text();
}

async function main() {
  console.log('== 抓取列表页 ==', LIST_URL);
  const listHtml = await fetchHtml(LIST_URL);
  const list = parse.parseNewsList(listHtml, BASE_URL);
  console.log(`解析出 ${list.length} 条条目`);
  if (list.length === 0) throw new Error('列表解析为空，站点结构可能变了');

  const picked = list.slice(0, ARTICLE_COUNT);
  const articles = [];

  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    process.stdout.write(`[${i + 1}/${picked.length}] 抓正文: ${item.title.slice(0, 30)}… `);
    try {
      const html = await fetchHtml(item.url);
      const parsed = parse.parseNewsArticle(html, item.url);
      const text = (parsed.paragraphs || []).join('\n');
      articles.push({
        id: parse.newsIdFromUrl(item.url),
        url: item.url,
        title: parsed.title || item.title,
        date: parsed.date || item.date || '',
        paragraphs: parsed.paragraphs || [],
        charCount: text.length,
      });
      console.log(`ok  ${parsed.paragraphs.length} 段 / ${text.length} 字`);
    } catch (err) {
      console.log(`失败: ${err.message}`);
      articles.push({ id: parse.newsIdFromUrl(item.url), url: item.url, error: err.message });
    }
    if (i < picked.length - 1) await sleep(DELAY_MS);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ fetchedAt: new Date().toISOString(), listUrl: LIST_URL, list, articles }, null, 2),
    'utf8'
  );

  const ok = articles.filter((a) => !a.error);
  const totalChars = ok.reduce((s, a) => s + a.charCount, 0);
  console.log('\n===== 汇总 =====');
  console.log(`成功 ${ok.length} / ${articles.length} 篇`);
  console.log(`正文总字数 ${totalChars}，平均 ${ok.length ? Math.round(totalChars / ok.length) : 0} 字/篇`);
  console.log(`保存到 ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
