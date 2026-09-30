/**
 * 体测估算：按《国家学生体质健康标准（2014年修订）》大学组评分表算单项分与总分。
 *
 * 三条纪律（对应 Issue #92 的验收标准）：
 * 1. **只算不算猜**：分数来自标准原表；BMI 的低体重与超重共用 80 分合并单元格。
 *    缺项或非法输入不给分，并说明原因，不替学生填一个数。
 * 2. **不冒充结果**：输出是「按所选标准的估算分」，不是学校正式成绩，也不给是否合格的结论；
 *    学校实际采用规则未核实时在说明里写明。
 * 3. **不落盘、不联网**：本模块是纯函数，输入只在内存里参与计算，调用方不得持久化或上传。
 *
 * 计分口径（可复核）：
 * - 单项得分：高优项取「成绩 ≥ 档位阈值」里分数最高的一档；低优项取「成绩 ≤ 档位阈值」里最高的一档；
 *   低于表中最低档（10 分档）按 0 分计——表外没有更低档，这是本估算器的口径，门店已在文档里标注。
 * - 标准分 = Σ(单项得分 × 权重) / 100（权重之和为 100，所以标准分是 0~100 的加权平均）。
 * - 附加分 = 引体向上/仰卧起坐超过 100 分标准的次数、长跑比 100 分标准快的秒数对应的分数，
 *   单项上限 10 分、合计上限 20 分。
 * - 总分 = 标准分 + 附加分；**只有 7 个单项都拿到分数时**才给总分与等级，否则只给已填项。
 */
import {
  BONUS,
  GradeBand,
  GRADE_BANDS,
  ItemTable,
  MAX_BONUS,
  MAX_BONUS_PER_ITEM,
  ScoreBreakpoint,
  Sex,
  WEIGHTS,
  itemsFor,
} from './standard';

export * from './standard';

/** 七个计分项的键（不含 BMI）：与 `standard.ts` 的 `itemsFor()` 一一对应。 */
export type ItemKey = 'vitalCapacity' | 'sprint50' | 'sitAndReach' | 'standingLongJump' | 'pullUp' | 'sitUp' | 'distanceRun';

export interface FitnessInput {
  sex: Sex;
  band: GradeBand;
  /** 身高（厘米）与体重（千克）：只有两个都填了才算 BMI。 */
  height?: number;
  weight?: number;
  /** 肺活量（毫升）。 */
  vitalCapacity?: number;
  /** 50 米跑（秒）。 */
  sprint50?: number;
  /** 坐位体前屈（厘米）。 */
  sitAndReach?: number;
  /** 立定跳远（厘米）。 */
  standingLongJump?: number;
  /** 引体向上（男）/ 1 分钟仰卧起坐（女），次数。 */
  strength?: number;
  /** 1000 米（男）/ 800 米（女），秒。 */
  distanceRunSeconds?: number;
}

export interface ItemScore {
  key: 'bmi' | ItemKey;
  label: string;
  /** 成绩文本，如「4300 毫升」「3′17″」；未填时为空。 */
  valueText: string;
  /** 该单项得分；表外或输入不可用时为 null。 */
  score: number | null;
  /** 给用户看的说明：为什么没有分数，或这一档的边界。 */
  note: string;
}

export interface FitnessResult {
  items: ItemScore[];
  /** 已计分项的加权标准分（0~100）；一项都没算出来时为 null。 */
  standardScore: number | null;
  /** 附加分合计（0~20）。 */
  bonus: number;
  /** 附加分明细，逐项说明加了多少分、依据什么。 */
  bonusDetail: string[];
  /** 总分（标准分 + 附加分）；只有 7 项全部计分时才有。 */
  total: number | null;
  /** 等级评定（优秀/良好/及格/不及格）；只有总分明细完整时才有。 */
  grade: string | null;
  /** 没有计入的项与原因，页面据此提示「这不是学年总分」。 */
  missing: string[];
  /** 口径与边界说明，页面原样展示。 */
  notes: string[];
}

/** 输入范围：只挡住明显不合法的值（如负数、厘米写成米）。表外的成绩照常按最低档处理。 */
const RANGES: Record<string, { min: number; max: number; unit: string }> = {
  height: { min: 100, max: 250, unit: '厘米' },
  weight: { min: 20, max: 200, unit: '千克' },
  vitalCapacity: { min: 500, max: 9000, unit: '毫升' },
  sprint50: { min: 5, max: 30, unit: '秒' },
  sitAndReach: { min: -30, max: 50, unit: '厘米' },
  standingLongJump: { min: 50, max: 400, unit: '厘米' },
  strength: { min: 0, max: 100, unit: '次' },
  distanceRunSeconds: { min: 120, max: 900, unit: '秒' },
};

const BAND_LABEL: Record<GradeBand, string> = { freshman: '大学一、二年级', senior: '大学三、四年级' };

function inRange(key: string, value: number): string {
  const range = RANGES[key];
  if (!Number.isFinite(value)) return '请填一个数字';
  if (value < range.min || value > range.max) {
    return `超出可核对范围：${key === 'distanceRunSeconds' ? '长跑' : '该项'}应在 ${range.min}~${range.max} ${range.unit} 之间`;
  }
  return '';
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}′${String(rest).padStart(2, '0')}″`;
}

/** 表里取出的档位阈值：高优项看 `>=`，低优项看 `<=`。 */
function thresholdOf(row: ScoreBreakpoint, band: GradeBand): number {
  return band === 'freshman' ? row.freshman : row.senior;
}

/**
 * 单项得分；低于最低档按 0 分的估算口径在结果中说明。
 */
function scoreFromTable(table: ItemTable, value: number, band: GradeBand): number | null {
  for (const row of table.rows) {
    const threshold = thresholdOf(row, band);
    if (table.lowerIsBetter ? value <= threshold : value >= threshold) return row.score;
  }
  // 表里最低档是 10 分；成绩更差时表外没有更低档，按 0 分计（口径写在模块注释与说明里）。
  return 0;
}

/** BMI 原表：正常 100，低体重/超重共用 80 分合并单元格，肥胖 60。 */
function bmiScore(bmi: number, sex: Sex): { score: number; label: string; note: string } {
  const normalLow = sex === 'male' ? 17.9 : 17.2;
  const normalHigh = 23.9;
  if (bmi >= normalLow && bmi <= normalHigh) return { score: 100, label: '正常', note: '' };
  if (bmi < normalLow) return { score: 80, label: '低体重', note: '' };
  if (bmi >= 28.0) return { score: 60, label: '肥胖', note: '' };
  return {
    score: 80,
    label: '超重',
    note: '',
  };
}

/** 引体向上/仰卧起坐与长跑的附加分：按 100 分标准的超出量查附加分表。 */
function bonusOf(
  rows: readonly { score: number; excess?: number; seconds?: number }[],
  amount: number,
  kind: 'excess' | 'seconds',
): number {
  let best = 0;
  for (const row of rows) {
    const threshold = kind === 'excess' ? row.excess : row.seconds;
    if (threshold === undefined) continue;
    if (amount >= threshold && row.score > best) best = row.score;
  }
  return Math.min(best, MAX_BONUS_PER_ITEM);
}

/**
 * 附加分：两项各自算、各自上限 10 分，合计上限 20 分。
 * **两项独立**：只填了引体向上（没填长跑）也能拿到引体向上的加分。
 */
function bonusFor(sex: Sex, band: GradeBand, strength?: number, distanceRunSeconds?: number): { bonus: number; detail: string[]; } {
  const items = itemsFor(sex);
  const detail: string[] = [];
  let bonus = 0;

  if (strength !== undefined && inRange('strength', strength) === '') {
    const strengthTable = sex === 'male' ? items.pullUp : items.sitUp;
    const excess = strength - thresholdOf(strengthTable.rows[0], band);
    if (excess > 0) {
      const add = bonusOf(sex === 'male' ? BONUS.malePullUp : BONUS.femaleSitUp, excess, 'excess');
      if (add > 0) {
        bonus += add;
        detail.push(`${sex === 'male' ? '引体向上' : '仰卧起坐'}超过 100 分标准 ${excess} 次，加 ${add} 分`);
      }
    }
  }

  if (distanceRunSeconds !== undefined && inRange('distanceRunSeconds', distanceRunSeconds) === '') {
    const runTable = items.distanceRun;
    const faster = thresholdOf(runTable.rows[0], band) - distanceRunSeconds;
    if (faster > 0) {
      const add = bonusOf(sex === 'male' ? BONUS.maleDistanceRun : BONUS.femaleDistanceRun, faster, 'seconds');
      if (add > 0) {
        bonus += add;
        detail.push(`长跑比 100 分标准快 ${faster} 秒，加 ${add} 分`);
      }
    }
  }

  if (bonus > MAX_BONUS) {
    detail.push(`附加分合计上限 ${MAX_BONUS} 分，已按上限计`);
    bonus = MAX_BONUS;
  }
  return { bonus, detail };
}

/**
 * 估算。调用方只传学生自己填的项；缺项不计入，也不猜。
 * 输入不合法（非数字、明显越界）时该项记为不计分并给出原因，不影响其他项。
 */
export function estimate(input: FitnessInput): FitnessResult {
  const band = input.band;
  const items: ItemScore[] = [];
  const missing: string[] = [];
  const notes: string[] = [
    '结果为「按所选国家标准的估算分」，不是学校体测的正式成绩，也不代表体检或医学建议。',
    '学校实际采用的测试与计分规则尚未核实，最终成绩以学校公布的测试结果为准。',
  ];

  // 1) BMI：身高体重都填了才算。
  const heightProblem = input.height === undefined ? '请填身高' : inRange('height', input.height);
  const weightProblem = input.weight === undefined ? '请填体重' : inRange('weight', input.weight);
  if (input.height !== undefined && input.weight !== undefined && heightProblem === '' && weightProblem === '') {
    const meters = (input.height as number) / 100;
    const bmi = (input.weight as number) / (meters * meters);
    const rounded = Math.round(bmi * 10) / 10;
    const result = bmiScore(rounded, input.sex);
    items.push({
      key: 'bmi',
      label: '体重指数（BMI）',
      valueText: `${rounded}（${input.height} 厘米 / ${input.weight} 千克）`,
      score: result.score,
      note: result.score === null ? result.note : `等级：${result.label}`,
    });
    if (result.score === null) missing.push(`BMI（${result.label}）`);
  } else {
    items.push({ key: 'bmi', label: '体重指数（BMI）', valueText: '', score: null, note: heightProblem || weightProblem });
    missing.push('BMI');
  }

  // 2) 其余六项：填了就算，没填记为缺项。键直接用标准里的项目名，页面按同一套键渲染。
  const table = itemsFor(input.sex);
  const strengthKey: ItemKey = input.sex === 'male' ? 'pullUp' : 'sitUp';
  const plan: Array<{ key: ItemKey; value?: number; inputKey: string; format: (value: number) => string }> = [
    { key: 'vitalCapacity', value: input.vitalCapacity, inputKey: 'vitalCapacity', format: (value) => `${value} 毫升` },
    { key: 'sprint50', value: input.sprint50, inputKey: 'sprint50', format: (value) => `${value} 秒` },
    { key: 'sitAndReach', value: input.sitAndReach, inputKey: 'sitAndReach', format: (value) => `${value} 厘米` },
    { key: 'standingLongJump', value: input.standingLongJump, inputKey: 'standingLongJump', format: (value) => `${value} 厘米` },
    { key: strengthKey, value: input.strength, inputKey: 'strength', format: (value) => `${value} 次` },
    { key: 'distanceRun', value: input.distanceRunSeconds, inputKey: 'distanceRunSeconds', format: (value) => formatSeconds(value) },
  ];

  for (const entry of plan) {
    const itemTable = table[entry.key];
    if (itemTable === undefined) continue;
    if (entry.value === undefined) {
      items.push({ key: entry.key, label: itemTable.label, valueText: '', score: null, note: '没填，不计入' });
      missing.push(itemTable.label);
      continue;
    }
    const problem = inRange(entry.inputKey, entry.value);
    if (problem !== '') {
      items.push({ key: entry.key, label: itemTable.label, valueText: entry.format(entry.value), score: null, note: problem });
      missing.push(itemTable.label);
      continue;
    }
    const score = scoreFromTable(itemTable, entry.value, band);
    const lowest = itemTable.rows[itemTable.rows.length - 1];
    const note = score === 0 ? `低于表中最低档（${lowest.score} 分档），按 0 分计` : '';
    items.push({ key: entry.key, label: itemTable.label, valueText: entry.format(entry.value), score, note });
  }

  // 3) 标准分与附加分。
  const weightOf: Record<string, number> = {
    bmi: WEIGHTS.bmi,
    vitalCapacity: WEIGHTS.vitalCapacity,
    sprint50: WEIGHTS.sprint50,
    sitAndReach: WEIGHTS.sitAndReach,
    standingLongJump: WEIGHTS.standingLongJump,
    pullUp: WEIGHTS.strength,
    sitUp: WEIGHTS.strength,
    distanceRun: WEIGHTS.distanceRun,
  };
  let weighted = 0;
  let counted = 0;
  for (const item of items) {
    if (item.score === null) continue;
    const weight = weightOf[item.key];
    if (weight === undefined) continue;
    weighted += item.score * weight;
    counted += weight;
  }
  const standardScore = counted === 0 ? null : Math.round((weighted / 100) * 10) / 10;

  const strengthValue = input.strength;
  const runValue = input.distanceRunSeconds;
  const { bonus, detail } = bonusFor(input.sex, band, strengthValue, runValue);

  const complete = missing.length === 0 && standardScore !== null;
  const total = complete ? Math.round((standardScore + bonus) * 10) / 10 : null;
  const grade = total === null ? null : (GRADE_BANDS.find((entry) => total >= entry.min)?.label ?? '不及格');

  if (counted > 0 && counted < 100) {
    notes.push(`已计分项目权重合计 ${counted}%，标准分是按已填项折算的，**不是学年总分**。`);
  }
  notes.push('低于表中最低档（10 分档）的成绩按 0 分计，这是本估算器的口径，标准原文未给出更低档。');

  return {
    items,
    standardScore,
    bonus,
    bonusDetail: detail,
    total,
    grade,
    missing,
    notes,
  };
}
