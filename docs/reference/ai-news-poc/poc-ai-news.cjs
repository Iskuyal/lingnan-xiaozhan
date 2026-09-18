/**
 * AI 资讯小样 · 第 2 步：用真实文章测 5 种 AI 能力
 *
 * 目的：回答一个问题——AI 在"校园资讯"这件事上，能不能做出「不用 AI 就做不到」的事？
 *
 * 用法：
 *   1. 在 key.txt 里粘贴你的 API Key（或设环境变量 POC_API_KEY）
 *   2. node poc-ai-news.cjs
 *   3. 看 data/results.json 与终端汇总
 *
 * 兼容任何 OpenAI 格式的接口（智谱 / OpenRouter / Groq / Gemini 兼容层 都行），
 * 改 config.json 里的 baseUrl 与 model 即可。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'news.json');
const CFG_FILE = path.join(ROOT, 'config.json');
const KEY_FILE = path.join(ROOT, 'key.txt');
const OUT_FILE = path.join(ROOT, 'data', 'results.json');

const DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.7-flash',
  delayMs: 1500, // 免费层有限速，慢点跑
  maxArticles: 8,
};

function loadConfig() {
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(CFG_FILE)) {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  }
  return cfg;
}

function loadKey() {
  if (process.env.POC_API_KEY) return process.env.POC_API_KEY.trim();
  if (fs.existsSync(KEY_FILE)) {
    // 允许文件里写 # 开头的说明行，只取真正的 Key 那一行
    const k = fs
      .readFileSync(KEY_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .join('');
    if (k) return k;
  }
  console.error('缺少 API Key：请把 Key 粘贴到 ' + KEY_FILE + '（只放一行），或设环境变量 POC_API_KEY');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次模型调用，返回 { text, usage, ms } */
async function callModel(cfg, key, system, user) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
  };
  const t0 = Date.now();
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('返回不是 JSON: ' + raw.slice(0, 200));
  }
  const text = json.choices?.[0]?.message?.content ?? '';
  return { text, usage: json.usage || {}, ms };
}

/** 从模型输出里抠出 JSON（允许它包 ```json 围栏） */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 五个测试

const TESTS = [
  {
    id: 'summary',
    name: '摘要（通用做法，团队判定为"贡献弱"）',
    system: '你是校园资讯编辑。用中文写不超过 3 句话的摘要。只输出摘要正文，不要任何前缀。',
    user: (a) => `标题：${a.title}\n\n正文：\n${a.text}`,
  },
  {
    id: 'extract',
    name: '结构化抽取（时间/地点/主办/事件类型）',
    system:
      '你是信息抽取工具。只输出 JSON，不要解释。字段：{"date": "文中的日期或空串", "place": "地点或空串", "organizer": "主办/参与单位，数组", "eventType": "从 党建|教学|荣誉|活动|合作|志愿服务|招生就业|其他 中选一个"}。资料里没有的字段必须留空，禁止推测。',
    user: (a) => `标题：${a.title}\n\n正文：\n${a.text}`,
  },
  {
    id: 'classify',
    name: '分类打标（多标签）',
    system:
      '你是校园资讯分类器。只输出 JSON 数组，元素只能来自这些标签：["党建思政","教学科研","荣誉成果","校园活动","校企合作","志愿服务","招生就业","国际交流"]。可选多个，按相关度排序，最多 3 个。',
    user: (a) => `标题：${a.title}\n\n正文前 800 字：\n${a.text.slice(0, 800)}`,
  },
  {
    id: 'actions',
    name: '学生行动项抽取（有截止/要报名的事）',
    system:
      '你是学生助手。判断这篇资讯里有没有"学生需要去做的事"（报名、申请、参加、截止日期、领取等）。只输出 JSON：{"hasAction": true/false, "items": [{"what": "要做什么", "deadline": "截止日期或空串", "evidence": "原文依据的一句话"}]}。没有就 hasAction=false 且 items 为空数组。严禁编造原文没有的事。',
    user: (a) => `标题：${a.title}\n\n正文：\n${a.text}`,
  },
  {
    id: 'targeted',
    name: '定点问答（AI 能否只依据原文回答、不知道就说不知道）',
    system:
      '你只能依据用户提供的资料回答。资料里没有的信息，必须回答"资料未提及"，绝对不许推测或补充常识。回答控制在 2 句话内。',
    user: (a) => `资料：\n${a.text}\n\n问题：这篇报道发生在哪个校区？`,
  },
];

// 跨全库的检索问答（RAG）：注意第 3 题是"防幻觉陷阱"，资料里根本没有答案
const RAG_QUESTIONS = [
  { q: '我校棒球队取得了什么成绩？', expect: '2026中国大学生棒垒球联赛总决赛乙组全国冠军' },
  { q: '2026级新生入学教育是什么时候开展的？', expect: '2026-09-12' },
  { q: '学校图书馆的开放时间是几点？', expect: '（资料未提及——正确答案是承认不知道）' },
];

async function main() {
  const cfg = loadConfig();
  const key = loadKey();
  if (!fs.existsSync(DATA_FILE)) {
    console.error('缺少数据文件，请先运行 node fetch-news.cjs');
    process.exit(1);
  }
  const news = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const articles = news.articles.filter((a) => !a.error).slice(0, cfg.maxArticles);
  for (const a of articles) a.text = (a.paragraphs || []).join('\n');

  console.log(`模型: ${cfg.model}  @ ${cfg.baseUrl}`);
  console.log(`文章: ${articles.length} 篇，测试项: ${TESTS.length} 项 → 共 ${articles.length * TESTS.length} 次调用\n`);

  const results = { model: cfg.model, baseUrl: cfg.baseUrl, startedAt: new Date().toISOString(), calls: [], perArticle: [] };
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalMs = 0;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const row = { id: a.id, title: a.title, date: a.date, charCount: a.charCount, outputs: {} };
    console.log(`—— [${i + 1}/${articles.length}] ${a.title.slice(0, 34)}…`);
    for (const t of TESTS) {
      try {
        const r = await callModel(cfg, key, t.system, t.user(a));
        const pt = r.usage.prompt_tokens || 0;
        const ct = r.usage.completion_tokens || 0;
        totalPrompt += pt;
        totalCompletion += ct;
        totalMs += r.ms;
        results.calls.push({ articleId: a.id, test: t.id, promptTokens: pt, completionTokens: ct, ms: r.ms });
        row.outputs[t.id] = t.id === 'extract' || t.id === 'classify' || t.id === 'actions'
          ? { raw: r.text, parsed: extractJson(r.text) }
          : r.text.trim();
        const shown = t.id === 'summary' ? r.text.trim().slice(0, 60) + '…' : r.text.trim().replace(/\s+/g, ' ').slice(0, 70);
        console.log(`   ${t.id.padEnd(9)} ${String(r.ms).padStart(5)}ms  ${pt}+${ct}tok  ${shown}`);
      } catch (err) {
        row.outputs[t.id] = { error: err.message };
        console.log(`   ${t.id.padEnd(9)} 失败: ${err.message.slice(0, 120)}`);
      }
      await sleep(cfg.delayMs);
    }
    results.perArticle.push(row);
  }

  // ---------------- RAG 跨全库问答 ----------------
  console.log('\n—— RAG 跨全库问答（8 篇全文一起给模型）');
  const corpus = articles.map((a, i) => `【${i + 1}】${a.title}（${a.date}）\n${a.text}`).join('\n\n---\n\n');
  results.rag = [];
  for (const item of RAG_QUESTIONS) {
    try {
      const r = await callModel(
        cfg,
        key,
        '你只能依据用户提供的资料回答。资料里没有的信息，必须明确回答"资料未提及"，绝对不许推测。回答控制在 3 句话内，并指出依据的是第几篇。',
        `资料：\n${corpus}\n\n问题：${item.q}`
      );
      totalPrompt += r.usage.prompt_tokens || 0;
      totalCompletion += r.usage.completion_tokens || 0;
      totalMs += r.ms;
      results.calls.push({ articleId: 'RAG', test: 'rag:' + item.q, promptTokens: r.usage.prompt_tokens || 0, completionTokens: r.usage.completion_tokens || 0, ms: r.ms });
      results.rag.push({ question: item.q, expect: item.expect, answer: r.text.trim(), ms: r.ms });
      console.log(`   问: ${item.q}`);
      console.log(`   答: ${r.text.trim().replace(/\s+/g, ' ')}`);
      console.log(`   ${String(r.ms).padStart(5)}ms  ${r.usage.prompt_tokens || 0}+${r.usage.completion_tokens || 0}tok\n`);
    } catch (err) {
      results.rag.push({ question: item.q, error: err.message });
      console.log(`   问: ${item.q}  失败: ${err.message.slice(0, 120)}\n`);
    }
    await sleep(cfg.delayMs);
  }

  results.summary = {
    finishedAt: new Date().toISOString(),
    callCount: results.calls.length,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    totalTokens: totalPrompt + totalCompletion,
    totalMs,
    avgMs: results.calls.length ? Math.round(totalMs / results.calls.length) : 0,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');

  console.log('===== 汇总 =====');
  console.log(`调用次数   ${results.summary.callCount}`);
  console.log(`输入 token ${totalPrompt}`);
  console.log(`输出 token ${totalCompletion}`);
  console.log(`合计 token ${results.summary.totalTokens}`);
  console.log(`总耗时     ${(totalMs / 1000).toFixed(1)} 秒，平均每次 ${results.summary.avgMs} ms`);
  console.log(`每篇平均   ${Math.round(results.summary.totalTokens / articles.length)} token`);
  console.log(`\n明细已存 ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
