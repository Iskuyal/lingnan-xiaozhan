/**
 * 升学 / 实习问答（本地演示，Issue #94）。
 *
 * **这一版不调用任何模型**：回答就是把检索到的官方原文段落原样给出，配出处卡片与「适用年份」；
 * 类别不明、年份未收录、问岗位或分数线时，用固定话术澄清或拒答。因此：
 * - 不存在「模型编造」的风险，但**也不是智能问答**——检索不到就答不了；
 * - 界面必须写明「未接模型」，不得宣称实时 AI 服务（见 `docs/evidence/advancement-poc/README.md` 的 go/no-go）。
 *
 * 检索与守门规则与 PoC 脚本一致（`scripts/advancement-poc.cjs`）：
 * bigram + idf 打分、按段落长度开方归一；类别判定与越界数据的规则见下。
 */
import { ADVANCEMENT_DOCUMENTS, CORPUS_COLLECTED_AT, AdvancementDocument, AdvancementPassage } from './corpus';

export * from './corpus';

export type AskBehavior = 'answer' | 'clarify' | 'refuse';

/** 一条出处：文档级元信息 + 被引用的那一段原文。 */
export interface Citation {
  documentId: string;
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  applicableYear: number;
  applicableRegion: string;
  collectedAt: string;
  sourceUrl: string;
  /** 逐字原文段落；界面只展示它，不展示检索用的 context。 */
  quote: string;
}

export interface AskResult {
  behavior: AskBehavior;
  /** 回答 = 检索到的原文摘录（原样拼接，不改写）。clarify/refuse 时为固定话术。 */
  answer: string;
  /** 固定话术的说明（为什么澄清/拒答）。 */
  note: string;
  citations: Citation[];
  /** 可点的澄清选项；只有 clarify 且有明确二选一时才给。 */
  choices: string[];
  /** 拒答时给的官方入口。 */
  links: Array<{ label: string; url: string }>;
}

const SEGMENTED_STRONG = /三二分段|转段|专业能力考核|基本素质考核|技能大赛|免考|贯通/;
const SEGMENTED_LOOSE = /三二分段|贯通/;
const DISAMBIGUATORS = /转段|专升本|本科|中职|高职/;
const UPGRADE_MARKERS = /专升本|专插本|职教师资|建档立卡|志愿|普通批|提前批|院校专业组|加分|体检|预报名|退役|招生工作规定/;
const EMPLOYMENT_MARKERS = /就业|实习|招聘|岗位|校招|毕业生|公务员|事业单位|国企|科研助理|用人单位/;
const COMPARISON = /区别|哪个|还是|两个都|怎么选|一样吗/;
const DATE_SENSITIVE = /报名|考试|时间|截止|几号|哪天/;
/** 语料明确不含的数据：一律拒答并给官方入口，不用「相关段落」硬答。 */
const OUT_OF_SCOPE: Array<{ word: string; kind: string }> = [
  { word: '分数线', kind: '录取分数线' },
  { word: '投档线', kind: '投档线' },
  { word: '录取结果', kind: '录取结果' },
  { word: '录取名单', kind: '录取名单' },
  { word: '录取率', kind: '录取率' },
  { word: '薪资', kind: '薪资' },
  { word: '工资', kind: '薪资' },
  { word: '招人', kind: '实时岗位' },
  { word: '招不招', kind: '实时岗位' },
  { word: '哪家公司', kind: '实时岗位' },
  { word: '哪家单位', kind: '实时岗位' },
];

/** 官方入口：拒答时给出，让用户自己去查。 */
const OFFICIAL_LINKS = [
  { label: '广东省教育考试院', url: 'https://eea.gd.gov.cn/' },
  { label: '广东学生就业创业网（省教育厅）', url: 'http://edu.gd.gov.cn/ztzlnew/jycy/' },
];

interface FlatPassage extends AdvancementPassage {
  document: AdvancementDocument;
}

/** 段落打平，供检索使用。 */
function flatPassages(): FlatPassage[] {
  const list: FlatPassage[] = [];
  for (const document of ADVANCEMENT_DOCUMENTS) {
    for (const passage of document.passages) list.push({ ...passage, document });
  }
  return list;
}

const PASSAGES = flatPassages();

/** 中文 bigram（与部门动态 RAG 同一套思路：不依赖分词器）。 */
function bigrams(text: string): string[] {
  const clean = text.replace(/[\s，。、；：（）“”"'？?！!…—\-]/g, '');
  const grams: string[] = [];
  for (let index = 0; index < clean.length - 1; index += 1) grams.push(clean.slice(index, index + 2));
  return grams;
}

const PASSAGE_GRAMS = PASSAGES.map((passage) => new Set(bigrams(`${passage.text}${passage.context}`)));
const DOCUMENT_FREQUENCY = new Map<string, number>();
for (const grams of PASSAGE_GRAMS) {
  for (const gram of grams) DOCUMENT_FREQUENCY.set(gram, (DOCUMENT_FREQUENCY.get(gram) ?? 0) + 1);
}

/** idf 之和，按段落长度开方归一（不归一的话长段落会压过精确命中的短段落）。 */
function score(query: string, index: number): number {
  let total = 0;
  for (const gram of new Set(bigrams(query))) {
    if (!PASSAGE_GRAMS[index].has(gram)) continue;
    const df = DOCUMENT_FREQUENCY.get(gram) ?? 1;
    total += Math.log(1 + PASSAGES.length / df);
  }
  return total / Math.sqrt(Math.max(1, PASSAGE_GRAMS[index].size));
}

function yearOf(question: string): number | null {
  const match = question.match(/(20\d{2})\s*年/);
  return match === null ? null : Number(match[1]);
}

type Classification =
  | { kind: 'single'; category: AdvancementDocument['category'] }
  | { kind: 'ambiguous'; categories: string[] }
  | { kind: 'unknown' };

/** 类别判定：规则来自三类语料的用词差异，不用模型。 */
export function classify(question: string): Classification {
  const normalized = question.split('三二分段专升本').join('三二分段');
  const segmented = SEGMENTED_STRONG.test(normalized);
  const loose = SEGMENTED_LOOSE.test(normalized) && !DISAMBIGUATORS.test(normalized);
  const upgrade = UPGRADE_MARKERS.test(normalized);
  const employment = EMPLOYMENT_MARKERS.test(normalized);

  if (segmented && upgrade && COMPARISON.test(normalized)) {
    return {
      kind: 'ambiguous',
      categories: ['普通专升本（专科毕业生统考）', '三二分段专升本转段（试点高职学生转段）'],
    };
  }
  if (loose) {
    return {
      kind: 'ambiguous',
      categories: ['中高职贯通三二分段（中职升高职）', '三二分段专升本转段（高职升本科）'],
    };
  }
  if (segmented) return { kind: 'single', category: 'segmented_三二分段专升本转段' };
  if (upgrade) return { kind: 'single', category: 'ordinary_专升本' };
  if (employment) return { kind: 'single', category: 'internship_实习招聘' };
  return { kind: 'unknown' };
}

/** 该类别收录了哪些年份（从文档元信息读，不猜）。 */
export function coveredYears(category: AdvancementDocument['category']): number[] {
  const years = new Set<number>();
  for (const document of ADVANCEMENT_DOCUMENTS) {
    if (document.category === category && document.applicableYear > 0) years.add(document.applicableYear);
  }
  return [...years].sort();
}

function citationOf(passage: FlatPassage): Citation {
  const document = passage.document;
  return {
    documentId: document.id,
    title: document.title,
    documentNumber: document.documentNumber,
    issuer: document.issuer,
    publishedAt: document.publishedAt,
    applicableYear: document.applicableYear,
    applicableRegion: document.applicableRegion,
    collectedAt: document.collectedAt,
    sourceUrl: document.sourceUrl,
    quote: passage.text,
  };
}

/** 提问。`topN` 决定最多给几条出处（默认 2 条，界面一屏能读完）。 */
export function ask(question: string, topN: number = 2): AskResult {
  const trimmed = typeof question === 'string' ? question.trim() : '';
  if (trimmed === '') {
    return {
      behavior: 'clarify',
      answer: '先写一个具体问题吧，例如「2026 年普通专升本什么时候网上预报名？」',
      note: '空问题不检索',
      citations: [],
      choices: [],
      links: [],
    };
  }

  const outOfScope = OUT_OF_SCOPE.find((entry) => trimmed.includes(entry.word));
  if (outOfScope !== undefined) {
    return {
      behavior: 'refuse',
      answer: `无法核实：我的语料里没有${outOfScope.kind}这类数据，也不提供实时信息。请从官方入口查看。`,
      note: `问的是语料明确不含的数据（${outOfScope.kind}）`,
      citations: [],
      choices: [],
      links: OFFICIAL_LINKS,
    };
  }

  const classification = classify(trimmed);
  if (classification.kind === 'ambiguous') {
    return {
      behavior: 'clarify',
      answer: '先确认一下你问的是哪一类，两类的报名与考试安排不同。',
      note: `命中多个类别：${classification.categories.join(' / ')}`,
      citations: [],
      choices: classification.categories,
      links: [],
    };
  }
  if (classification.kind === 'unknown') {
    const asksDate = DATE_SENSITIVE.test(trimmed);
    return asksDate
      ? {
        behavior: 'clarify',
        answer: '先确认一下你问的是哪一类考试：普通专升本、三二分段专升本转段，还是实习/就业？',
        note: '没说清是哪一类，先澄清',
        citations: [],
        choices: ['普通专升本', '三二分段专升本转段', '实习 / 就业'],
        links: [],
      }
      : {
        behavior: 'refuse',
        answer: '无法核实：这句话里没有我能对应到官方材料的主题，请说得更具体一些。',
        note: '没有命中任何类别',
        citations: [],
        choices: [],
        links: OFFICIAL_LINKS,
      };
  }

  const year = yearOf(trimmed);
  const years = coveredYears(classification.category);
  if (year !== null && !years.includes(year)) {
    return {
      behavior: 'refuse',
      answer: `无法核实：语料只收录 ${years.join('、')} 年的官方文件，${year} 年还没有收录。我不会把 ${years[years.length - 1]} 年的日期当成 ${year} 年的答案。`,
      note: `年份未收录（已收录 ${years.join('、')}）`,
      citations: [],
      choices: [],
      links: OFFICIAL_LINKS,
    };
  }

  const pool = PASSAGES.filter((passage) => passage.document.category === classification.category);
  const ranked = pool
    .map((passage) => ({ passage, value: score(trimmed, PASSAGES.indexOf(passage)) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.passage.id.localeCompare(b.passage.id));
  if (ranked.length === 0) {
    return {
      behavior: 'refuse',
      answer: '无法核实：这一类语料里没有与问题相关的原文段落。',
      note: '该类别下没有相关段落',
      citations: [],
      choices: [],
      links: OFFICIAL_LINKS,
    };
  }

  const top = ranked.slice(0, topN).map((entry) => entry.passage);
  return {
    behavior: 'answer',
    answer: top.map((passage) => passage.text).join('\n'),
    note: `原文摘录 · 未改写 · 语料核查于 ${CORPUS_COLLECTED_AT}`,
    citations: top.map(citationOf),
    choices: [],
    links: [],
  };
}
