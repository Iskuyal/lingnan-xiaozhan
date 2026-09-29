/**
 * 课表截图识别的**分带并行**：预算、分带计划、提示词与结果合并（Ticket 05 的模型环）。
 *
 * 为什么需要它：一次 `vision` 调用就是一次模型调用，而当前中转模型的实测画像是
 * **固定约 11 秒 + 约 86 token/秒 + 每门课约 300 个完成 token**。据此外推，一份 45 门课的
 * 完整课表要 170 秒以上——**超过云函数 60 秒上限，一次调用识别整张表不成立**
 * （测量过程见 docs/evidence/p5-b/README.md「第三轮」）。
 *
 * 做法是按**节次**把「整张表」切成若干带、并行发多次模型调用，每次只索要一小段课程：
 * 墙钟时间从「所有课程求和」变成「最大的一带」。带数不写死，由可用预算与上面的画像算出
 * （`bandsForBudget`），环境变量一变，分带自动跟着变。
 *
 * 三条不能破的约束：
 * 1. **图片与输入文字只过一次内容安全**：每带各检一次会把微信内容安检的每日配额按带数烧掉
 *    （配额用尽即 fail-closed，当天三处 AI 全不可用，见 docs/development/cloud/ai.md 的 45009 记录）；
 * 2. **每带只保留 startSection 落在本带的课程**：模型若没遵守「只输出本带」的指令，
 *    这条过滤保证总输出不会退化成带数倍；
 * 3. **会丢数据的地方都要写进 `problems`**：任一带失败时成功带的课程照常返回、失败带写进告警；
 *    「节次读不出、又轮不到保留的那一带」的课程单独计数上报——它是唯一一类真的会丢、且不看提示就发现不了的。
 */
/**
 * 节次范围：与客户端 `services/timetable/photo.ts` 的 `VISION_SYSTEM` 里
 * 「startSection 1到12的整数」同一口径，分带据此切分。改提示词的范围要同步这里。
 */
export const SECTION_MIN = 1;
export const SECTION_MAX = 12;

/** 一带的节次区间（含两端）。 */
export interface Band {
  from: number;
  to: number;
}

/**
 * 模型画像：2026-09-19 用真实课表截图在 `qwen/qwen3.8-flash` 上量到的三点拟合
 * （固定开销、吞吐、每门课的完成 token），用于**算预算**，不是对外承诺的性能指标。
 * 换模型或关掉思考模式后这个画像会变，改这里一处即可。
 */
export const VISION_PROFILE = {
  /** 与图片大小、输出长度都无关的固定开销。 */
  fixedSeconds: 11,
  tokensPerSecond: 86,
  tokensPerCourse: 300,
  /** 一份完整课表的最坏课程数，分带按它算。 */
  worstCaseCourses: 45,
} as const;

/** 分带数上限：再多也不会更准，只会把并发请求数放大（中继的并发与限流都未实测）。 */
export const MAX_BANDS = 6;

/** 一次识别预计耗时（秒）：按画像拟合，仅供分带决策与日志。 */
export function predictSeconds(courses: number): number {
  const safe = Math.max(0, courses);
  return VISION_PROFILE.fixedSeconds + (safe * VISION_PROFILE.tokensPerCourse) / VISION_PROFILE.tokensPerSecond;
}

/** 按节次把 1..12 等分成 `count` 带（余数优先给前面几带），返回至少一带。 */
export function splitSections(count: number): Band[] {
  const total = SECTION_MAX - SECTION_MIN + 1;
  const bands = Math.max(1, Math.min(Math.floor(count) || 1, MAX_BANDS));
  const base = Math.floor(total / bands);
  const extra = total % bands;
  const result: Band[] = [];
  let from = SECTION_MIN;
  for (let index = 0; index < bands; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    result.push({ from, to: from + size - 1 });
    from += size;
  }
  return result;
}

/**
 * 按一次模型调用的可用预算决定分几带：预算里装得下多少门课，就按最坏情况（45 门）切几带。
 *
 * **预算连一次调用的固定开销都装不下时退回单带**（不是切到上限）：实测画像的 11 秒固定开销
 * 是**每次调用**都要付的，装不下的预算切 6 带仍然是 6 次全超时，只是多花 6 倍的调用与并发
 * （默认 `AI_TIMEOUT_MS` 8 秒正好落在这一档，客户端又固定下发 `bands: 'auto'`，
 * 忘了配环境变量的部署会精确命中）。这里退成单带不是「放弃」，而是同样的失败用 1/6 的代价换。
 */
export function bandsForBudget(budgetMs: number): Band[] {
  const usableSeconds = budgetMs / 1000 - VISION_PROFILE.fixedSeconds;
  if (!(usableSeconds > 0)) return [{ from: SECTION_MIN, to: SECTION_MAX }];
  const perBand = Math.floor((usableSeconds * VISION_PROFILE.tokensPerSecond) / VISION_PROFILE.tokensPerCourse);
  if (perBand < 1) return [{ from: SECTION_MIN, to: SECTION_MAX }];
  return splitSections(Math.ceil(VISION_PROFILE.worstCaseCourses / perBand));
}

/**
 * 每一带要准备多大的输出上限。
 *
 * `vision` 一次调用的输出上限由调用方给（客户端是 `VISION_MAX_TOKENS = 2048`，为**整张表**设的），
 * 但分带后每一带仍要按「本带课程数 × 每门课完成 token」出结果：8 门课的中位成本约 2400 token，
 * **超过 2048 会被截断**，截断的 JSON 解析不出来，该带就变成「没有可用结果」——看起来像模型失败，
 * 实际是上限不够。所以分带时按本带课程数把上限抬上去（留 1.5 倍余量与 256 token 的结构开销），
 * 同时不超过接口上限 8192；调用方要的上限更高时以调用方为准；单带时原样返回调用方的上限
 * （不分带就不该改动调用方的意图）。
 */
export function bandMaxTokens(bandCount: number, askedMaxTokens: number): number {
  if (bandCount <= 1) return askedMaxTokens;
  const perBand = Math.ceil(VISION_PROFILE.worstCaseCourses / bandCount);
  const wanted = Math.ceil(perBand * VISION_PROFILE.tokensPerCourse * 1.5) + 256;
  return Math.min(8192, Math.max(askedMaxTokens, wanted));
}

/**
 * `bands` 事件字段 → 分带计划。
 * - `'auto'`：按预算算（推荐，客户端 `VISION_BANDS` 用的就是它）；
 * - 数字 ≥2：按该数量等分节次；
 * - 缺省、1 或非法值：**单带**，即 Ticket 01 验收时那条一次调用的原路径。
 */
export function planBands(raw: unknown, budgetMs: number): Band[] {
  if (raw === 'auto') return bandsForBudget(budgetMs);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 2) return splitSections(Math.floor(raw));
  return [{ from: SECTION_MIN, to: SECTION_MAX }];
}

/** 本带的范围指令，追加到 system 上：客户端传的提示词保持原样，分带是服务端的事。 */
export function bandInstruction(band: Band): string {
  return `本次只识别并输出 startSection 在 ${band.from} 到 ${band.to} 之间的课程（含两端）；`
    + 'startSection 不在这个范围的课程一律不要放进 courses 数组。其余字段与格式要求不变。';
}

/** 按带改写系统提示词；调用方没给 system 时只留范围指令。 */
export function bandedSystem(system: string, band: Band): string {
  return system.trim() === '' ? bandInstruction(band) : `${system}\n${bandInstruction(band)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从模型输出里取 JSON 对象：先整体解析，失败时截取第一个 `{` 到最后一个 `}` 再试。
 * 与客户端 `services/ai.ts` 的 `extractJson` 同一套容错——服务端不能 import 小程序代码，
 * 因此这份实现是**有意重复**的；两边行为不一致时以客户端的解析为准（那边还要展示 problems）。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const tryParse = (source: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(source);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParse(trimmed.slice(start, end + 1));
}

/** 一带的调用结果：`ok: false` 表示这一带的模型调用失败（超时、限流等）。 */
export interface BandCallResult {
  band: Band;
  ok: boolean;
  text: string;
}

/** 一门课的收录判定。 */
type CourseVerdict = 'keep' | 'out-of-band' | 'unreadable';

/**
 * 本带要不要收录这门课。
 *
 * - `keep`：`startSection` 落在本带内；**节次没识别出来的课程只在「第一个成功的带」保留**
 *   （`keepUnsectioned`）——它落不进任何一带，每带都丢会让草稿静默少课，每带都留又会让条数随带数翻倍。
 *   留一份交给客户端按「节次未识别」标成待核对，与「识别不出的只标记不猜」同一条纪律。
 * - `out-of-band`：节次读得出、但不属于本带。丢掉是**设计**（模型没遵守范围指令时靠它防止总输出翻倍），
 *   这门课会出现在它自己那一带的结果里；它那一带失败时，失败范围已经写进 problems，不重复报。
 * - `unreadable`：节次读不出、又轮不到保留的那一带——**这是真的会丢数据**，调用方要计数上报。
 */
function classifyCourse(row: Record<string, unknown>, band: Band, keepUnsectioned: boolean): CourseVerdict {
  const raw = row.startSection;
  const section = typeof raw === 'number' && Number.isInteger(raw) ? raw : 0;
  const readable = section >= SECTION_MIN && section <= SECTION_MAX;
  if (!readable) return keepUnsectioned ? 'keep' : 'unreadable';
  return section >= band.from && section <= band.to ? 'keep' : 'out-of-band';
}

export interface MergedBands {
  /** 合并后的 JSON 文本，形状与单次识别一致——客户端的解析逻辑不用改。 */
  text: string;
  /** 成功拿到可用结果的带数。 */
  succeeded: number;
  /** 没有任何可用结果的带（供告警写明是哪几节没识别到）。 */
  failed: Band[];
  /** 合并后的整图/整带问题，写进 JSON 的 `problems` 交给校对页展示。 */
  problems: string[];
}

function bandLabel(band: Band): string {
  return `第 ${band.from}-${band.to} 节`;
}

/**
 * 把各带的结果并回**一个** JSON 对象：`courses` 按带序拼接，`problems` 去重合并，
 * 学校/学期取第一个非空值。返回的 `text` 与单次识别的输出同形状。
 */
export function mergeBands(results: BandCallResult[]): MergedBands {
  const courses: unknown[] = [];
  const problems: string[] = [];
  const failed: Band[] = [];
  let succeeded = 0;
  let semester = '';
  let school = '';
  // 第一个**成功**的带才保留「节次未识别」的课程：第一带失败时那个位置不该空着，
  // 否则节次读不出的课会被前面的失败连带丢掉（复核发现的行为与承诺不一致）。
  let keepUnsectioned = true;
  let unreadable = 0;
  const emptyBands: Band[] = [];
  const addProblem = (value: string): void => {
    const text = value.trim().slice(0, 200);
    if (text !== '' && !problems.includes(text) && problems.length < 20) problems.push(text);
  };

  for (const result of results) {
    const parsed = result.ok ? extractJsonObject(result.text) : null;
    const rawCourses = parsed === null ? null : parsed.courses;
    // 缺 `courses` 字段按失败处理（它可能只是没返回完整 JSON），空数组是合法结果（这一段确实没课），
    // 两者分开：前者要学生重试，后者只要核对。
    if (parsed === null || !Array.isArray(rawCourses)) {
      failed.push(result.band);
      addProblem(`${bandLabel(result.band)}这一段没有拿到可用的识别结果，这几节的课程可能缺失，请重试或手工补录。`);
      continue;
    }
    succeeded += 1;
    const firstSuccess = keepUnsectioned;
    keepUnsectioned = false;
    if (school === '' && typeof parsed.school === 'string') school = parsed.school;
    if (semester === '' && typeof parsed.semester === 'string') semester = parsed.semester;
    if (Array.isArray(parsed.problems)) {
      for (const item of parsed.problems) {
        if (typeof item === 'string') addProblem(item);
      }
    }
    let kept = 0;
    for (const course of rawCourses) {
      if (!isRecord(course)) continue;
      const verdict = classifyCourse(course, result.band, firstSuccess);
      if (verdict === 'unreadable') {
        unreadable += 1;
        continue;
      }
      if (verdict === 'out-of-band') continue;
      courses.push(course);
      kept += 1;
    }
    if (kept === 0) {
      emptyBands.push(result.band);
    }
  }
  // 「这一段没有识别出课程」合并成一条：一节没课是常态（低年级课少、11-12 节常空），
  // 每带各写一条会让确认页冒出好几行同样的提示，真正要看的问题反而被淹掉。
  if (emptyBands.length > 0) {
    addProblem(
      `${emptyBands.map(bandLabel).join('、')}没有识别出课程，请核对这几节是否确实没有课。`,
    );
  }
  // 真的会丢数据的那一类单独报：节次读不出的课轮不到保留的那一带时，学生既看不到课也看不到提示。
  if (unreadable > 0) {
    addProblem(`有 ${unreadable} 门课的节次没有识别出来、也不是保留的那一段，未能收录；请对照截图手工补录。`);
  }

  return {
    text: JSON.stringify({ semester, school, problems, courses }),
    succeeded,
    failed,
    problems,
  };
}
