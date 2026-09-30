import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 事实卡允许的正文长度上限（不含标题、引用块与「边界」之后的小节）。 */
export const MAX_BODY_CHARS = 1200;

const NONE_LIKE = new Set(['无', 'none', 'n/a', 'na', '']);

/** 条目 id：事实用 F1/D3，不变量用 INV-1 / INV-A。必须含数字，避免匹配表头「id」。 */
const ENTRY_ID = '(?:INV-[A-Z0-9]+|[A-Z]\\d+)';
const ENTRY_ID_AT_START = new RegExp('^(' + ENTRY_ID + ')', 'i');
const ENTRY_ID_ROW = new RegExp('^\\|\\s*(' + ENTRY_ID + ')\\s*\\|(.+)$', 'i');

const entryIdOf = (value) => String(value).match(ENTRY_ID_AT_START)?.[1];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** 规范化空白后用于重复检测，避免缩进或换行差异造成漏判。 */
export const normalizeText = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * 正文长度口径：只数可见正文字符。
 * 去掉空白、Markdown 表格分隔符（| -）与强调/代码标记（* ` # >），
 * 否则表格排版本身会被当成内容计入，与「<=1200 字」的本意不符。
 */
export function countBodyChars(text) {
  return [...text.replace(/\s/g, '').replace(/[|*`#>~-]/g, '')].length;
}

/**
 * 取事实卡正文并统计长度。
 * 正文 = 首个二级标题到 `## 边界` / `## 声明`（或文件末尾）之间的内容。
 */
export function extractBody(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+\S/.test(line));
  if (start === -1) return { text: '', chars: 0, rawChars: 0, counted: false };
  let end = lines.findIndex((line, index) => index > start && /^##\s*(边界|声明)/.test(line));
  if (end === -1) end = lines.length;
  const text = lines.slice(start, end).join('\n');
  return {
    text,
    chars: countBodyChars(text),
    rawChars: [...text.replace(/\s/g, '')].length,
    counted: true,
  };
}

/**
 * 从事实卡的表格行提取条目：`| id | 说明 | 状态 | … |`。
 * 「不变量」小节下的 id（如 INV-1）标记为 invariant，供样例引用材料性质。
 */
export function extractFacts(markdown, cardId) {
  const facts = [];
  let inInvariant = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^#{2,3}\s/.test(line)) inInvariant = /不变量/.test(line);
    const row = line.match(ENTRY_ID_ROW);
    if (!row) continue;
    const cells = row[2].split('|').map((cell) => cell.trim()).filter(Boolean);
    const id = row[1];
    const body = cells.join(' ').trim();
    if (body) facts.push({ cardId, id, body, invariant: inInvariant || id.startsWith('INV') });
  }
  return facts;
}

export function loadCards(directory, errors) {
  const cards = [];
  const files = readdirSync(directory).filter((name) => /^fact-card-.*\.md$/.test(name)).sort();
  for (const file of files) {
    const id = `FC-${Number(file.match(/^fact-card-(\d+)/)?.[1])}`;
    const markdown = readFileSync(path.join(directory, file), 'utf8');
    const body = extractBody(markdown);
    if (!body.counted) errors.push(`${file}: 未找到正文起始的二级标题，无法统计长度`);
    if (body.chars > MAX_BODY_CHARS) {
      errors.push(`${file}: 正文 ${body.chars} 字，超过上限 ${MAX_BODY_CHARS} 字`);
    }
    const facts = extractFacts(markdown, id);
    if (facts.length === 0) errors.push(`${file}: 未解析出任何条目（期望表格行「| F1 | … |」）`);
    cards.push({ id, file, bodyChars: body.chars, facts });
  }
  return cards;
}

export function loadSamples(directory, expectedSet, errors) {
  const file = path.join(directory, `samples-${expectedSet}.json`);
  if (!existsSync(file)) {
    errors.push(`缺少样例文件 samples-${expectedSet}.json`);
    return null;
  }
  const data = readJson(file);
  if (data.set !== expectedSet) errors.push(`samples-${expectedSet}.json: set 字段为 ${data.set}，期望 ${expectedSet}`);
  if (!Array.isArray(data.samples)) errors.push(`samples-${expectedSet}.json: samples 不是数组`);
  return data;
}

/**
 * 校验素材包的 id / 引用 / 长度 / 重复项与冻结条件。
 * 返回错误与警告；警告不阻断，但必须在报告中如实说明。
 */
export function checkPackage(directory) {
  const errors = [];
  const warnings = [];
  const sourcesFile = path.join(directory, 'sources.json');
  if (!existsSync(sourcesFile)) return { errors: ['缺少 sources.json'], warnings, stats: {} };
  const sources = readJson(sourcesFile);
  const frozenAt = sources.frozenAt;
  if (!frozenAt) errors.push('sources.json: 缺少 frozenAt');

  const cards = loadCards(directory, errors);
  cards.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  const declared = new Map((sources.materials ?? []).map((item) => [item.id, item]));
  for (const card of cards) {
    if (!declared.has(card.id)) errors.push(`sources.json 未登记事实卡 ${card.id}`);
    else if (declared.get(card.id).bodyFile !== card.file) {
      errors.push(`sources.json 中 ${card.id} 的 bodyFile 为 ${declared.get(card.id).bodyFile}，实际为 ${card.file}`);
    }
  }
  for (const id of declared.keys()) {
    if (!cards.some((card) => card.id === id)) errors.push(`sources.json 登记了不存在的事实卡 ${id}`);
  }

  const seenCard = new Set();
  const factIds = new Map();
  for (const card of cards) {
    if (seenCard.has(card.id)) errors.push(`事实卡 id 重复：${card.id}`);
    seenCard.add(card.id);
    const seenFact = new Set();
    for (const fact of card.facts) {
      if (seenFact.has(fact.id)) errors.push(`${card.file}: 条目 id 重复：${fact.id}`);
      seenFact.add(fact.id);
      if (factIds.has(fact.id)) errors.push(`条目 id ${fact.id} 在 ${factIds.get(fact.id)} 与 ${card.file} 之间重复`);
      factIds.set(fact.id, card.file);
    }
  }

  const sets = {};
  const answers = new Map();
  const counts = {};
  for (const set of ['development', 'heldout']) {
    const data = loadSamples(directory, set, errors);
    sets[set] = data;
    if (!data?.samples) continue;
    counts[set] = data.samples.length;
    if (data.tuningAllowed !== (set === 'development')) {
      errors.push(`samples-${set}.json: tuningAllowed 应为 ${set === 'development'}（留出样例不得用于调整）`);
    }
    if (data.frozenAt !== frozenAt) errors.push(`samples-${set}.json: frozenAt 与 sources.json 不一致`);
    const seenSample = new Set();
    for (const sample of data.samples) {
      if (seenSample.has(sample.id)) errors.push(`样例 id 重复：${sample.id}`);
      seenSample.add(sample.id);
      const card = cards.find((item) => item.id === sample.cardId);
      if (!card) errors.push(`${sample.id}: cardId ${sample.cardId} 不对应任何事实卡`);
      if (sample.frozenAt !== frozenAt) errors.push(`${sample.id}: frozenAt 与 sources.json 不一致`);

      const spans = sample.citableSpans;
      if (!Array.isArray(spans) || spans.length === 0) errors.push(`${sample.id}: 缺少可引用原句`);
      else {
        for (const span of spans) {
          const id = entryIdOf(span);
          if (!id) errors.push(`${sample.id}: 可引用原句未以条目 id 开头（${String(span).slice(0, 24)}…）`);
          else if (!factIds.has(id)) errors.push(`${sample.id}: 引用了不存在的条目 id ${id}`);
          else if (card && !card.facts.some((fact) => fact.id === id)) {
            errors.push(`${sample.id}: 引用 ${id} 不属于它自己的事实卡 ${sample.cardId}`);
          }
        }
      }

      const preserve = sample.mustPreserveUnverified;
      if (!Array.isArray(preserve) || preserve.length === 0) {
        errors.push(`${sample.id}: 必须保留的「待验证」为空`);
      } else if (preserve.every((item) => NONE_LIKE.has(normalizeText(String(item)).toLowerCase()))) {
        errors.push(`${sample.id}: 必须保留的「待验证」等于「无」占位`);
      }

      const key = normalizeText(String(sample.answer ?? ''));
      if (!key) errors.push(`${sample.id}: 缺少回答正文`);
      else if (answers.has(key)) errors.push(`${sample.id} 与 ${answers.get(key)} 的回答正文重复`);
      else answers.set(key, sample.id);
    }
  }

  if (counts.development !== 6) errors.push(`开发样例应为 6 个，实际 ${counts.development ?? 0} 个`);
  if (counts.heldout !== 2) errors.push(`留出样例应为 2 个，实际 ${counts.heldout ?? 0} 个`);

  for (const card of cards) {
    const used = new Set();
    for (const set of ['development', 'heldout']) {
      for (const sample of sets[set]?.samples ?? []) {
        if (sample.cardId !== card.id) continue;
        for (const span of sample.citableSpans ?? []) {
          const id = entryIdOf(span);
          if (id) used.add(id);
        }
      }
    }
    for (const fact of card.facts) {
      if (!used.has(fact.id)) warnings.push(`${card.file}: 条目 ${fact.id} 未被任何样例引用`);
    }
  }

  const rubricFile = path.join(directory, 'rubric.md');
  if (!existsSync(rubricFile)) errors.push('缺少 rubric.md');
  else {
    const rubric = readFileSync(rubricFile, 'utf8');
    for (const required of ['职业', '录用', '教师认可', '100%', '至少 5 个', '不得', '润色']) {
      if (!rubric.includes(required)) errors.push(`rubric.md 缺少必要条件：${required}`);
    }
  }

  const budgetFile = path.join(directory, 'budget.md');
  if (!existsSync(budgetFile)) errors.push('缺少 budget.md');
  else {
    const budget = readFileSync(budgetFile, 'utf8');
    for (const required of ['4 次', '1 次', '12 次', '50 元']) {
      if (!budget.includes(required)) errors.push(`budget.md 缺少预算口径：${required}`);
    }
    if (!/不(运行|执行)真实/.test(budget)) warnings.push('budget.md 未写明 G0 不执行真实调用');
  }

  return {
    errors,
    warnings,
    stats: {
      cards: cards.length,
      entries: factIds.size,
      development: counts.development ?? 0,
      heldout: counts.heldout ?? 0,
      bodyChars: Object.fromEntries(cards.map((card) => [card.id, card.bodyChars])),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
    ? path.resolve(process.argv[2])
    : fileURLToPath(new URL('../docs/evidence/project-defense-g0/', import.meta.url));
  try {
    const { errors, warnings, stats } = checkPackage(directory);
    for (const warning of warnings) console.warn(`警告：${warning}`);
    for (const error of errors) console.error(`错误：${error}`);
    console.log(
      `G0 素材包检查：${stats.cards} 份事实卡、${stats.entries} 条事实/不变量、`
      + `${stats.development} 个开发样例、${stats.heldout} 个留出样例；`
      + `正文长度 ${JSON.stringify(stats.bodyChars)}；${errors.length} 个错误、${warnings.length} 个警告。`,
    );
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`G0 素材包检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
