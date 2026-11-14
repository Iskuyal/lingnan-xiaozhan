/**
 * 体测估算（Issue #92；岭南红 UI 第二轮 C 分支按设计稿 26 / 27 / 63 重做）。
 *
 * 页面只负责收集输入、调用 `services/fitness` 的纯函数、把结果渲染出来。三条纪律落在页面上：
 * 1. **输入不保存**：表单值只存在页面内存里，退出即丢，不写本机存储、不进 AI 请求；
 * 2. **缺项不猜、也不冒充**：7 项没有全部计分时**不显示学年总分、不显示等级**，
 *    也不把「已填项折算出的加权标准分」摆成大分数——那正是最容易被误读成总分的地方；
 *    缺项在结果区单独列出来，名称旁直接给输入框，填完点「重新估算」即可；
 * 3. **单项分只来自 `estimate()`**：页面不重算、不写死任何分数，只做展示与计数。
 *
 * 长跑输入接受 `3′42″`、`3:42` 或纯秒数（`222`），换算成秒后交给服务。
 */
import {
  FitnessInput,
  FitnessResult,
  ItemScore,
  Sex,
  GradeBand,
  estimate,
} from '../../services/fitness/index';
import { openUiTab } from '../../ui/navigation';

interface InputEvent {
  currentTarget: { dataset: { value?: string } };
  detail: { value: string };
}

interface TapEvent {
  currentTarget: { dataset: { value?: string } };
}

interface FormState {
  height: string;
  weight: string;
  vitalCapacity: string;
  sprint50: string;
  sitAndReach: string;
  standingLongJump: string;
  strength: string;
  distanceRun: string;
}

/** 缺项行里的一个可直接补填的输入框；`field` 与 `form` 的键一致。 */
export interface ToolsFillField {
  field: keyof FormState;
  placeholder: string;
  type: 'digit' | 'number' | 'text';
  /** 当前输入值：与 `form` 同步，避免补填框在别处输入后显示旧值。 */
  value: string;
}

/** 结果区「缺少的项目」一行：项目名 + 服务给的原因 + 可就地补填的输入框。 */
export interface ToolsMissingRow {
  key: ItemScore['key'];
  label: string;
  note: string;
  fields: ToolsFillField[];
}

type FieldSpec = Omit<ToolsFillField, 'value'>;

/** 单项 key → 表单字段。BMI 由身高体重两个字段合成，因此是两条。 */
const FILL_FIELDS: Record<string, FieldSpec[]> = {
  bmi: [
    { field: 'height', placeholder: '身高（厘米）', type: 'digit' },
    { field: 'weight', placeholder: '体重（千克）', type: 'digit' },
  ],
  vitalCapacity: [{ field: 'vitalCapacity', placeholder: '肺活量（毫升）', type: 'number' }],
  sprint50: [{ field: 'sprint50', placeholder: '50 米跑（秒）', type: 'digit' }],
  sitAndReach: [{ field: 'sitAndReach', placeholder: '坐位体前屈（厘米）', type: 'digit' }],
  standingLongJump: [{ field: 'standingLongJump', placeholder: '立定跳远（厘米）', type: 'number' }],
  pullUp: [{ field: 'strength', placeholder: '引体向上（次）', type: 'number' }],
  sitUp: [{ field: 'strength', placeholder: '1 分钟仰卧起坐（次）', type: 'number' }],
  distanceRun: [{ field: 'distanceRun', placeholder: '3′42″ 或 222', type: 'text' }],
};

/** 数字框：空字符串当没填；不是数字时给 NaN，由服务给出「请填一个数字」。 */
export function parseNumberInput(text: string): number | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return undefined;
  return Number(trimmed);
}

/**
 * 长跑输入：`3′42″` / `3'42"` / `3:42` 都按「分:秒」换算成秒；纯数字按秒。
 * 其他写法返回 NaN，由服务提示格式问题。
 */
export function parseRunInput(text: string): number | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return undefined;
  const clock = trimmed.match(/^(\d+)\s*[′':：]\s*(\d{1,2})\s*[″"]?$/);
  if (clock !== null) return Number(clock[1]) * 60 + Number(clock[2]);
  return Number(trimmed);
}

/** 没有分数的单项就是缺项；原因原样用服务给的 note，页面不另编理由。 */
function missingRowsOf(result: FitnessResult, form: FormState): ToolsMissingRow[] {
  return result.items
    .filter((item) => item.score === null)
    .map((item) => ({
      key: item.key,
      label: item.label,
      note: item.note,
      fields: (FILL_FIELDS[item.key] ?? []).map((spec) => ({ ...spec, value: form[spec.field] })),
    }));
}

/** 数字统一留一位小数：服务层已经四舍五入到 0.1，这里只补显示位，不改数值。 */
function fixed1(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function emptyForm(): FormState {
  return { height: '', weight: '', vitalCapacity: '', sprint50: '', sitAndReach: '', standingLongJump: '', strength: '', distanceRun: '' };
}

Page({
  data: {
    sex: 'male' as Sex,
    band: 'freshman' as GradeBand,
    bandLabel: '大学一、二年级',
    sexLabel: '男',
    form: emptyForm(),
    result: null as FitnessResult | null,
    hasResult: false,
    /** 结果区「缺少的项目」：缺项才非空，每行带可就地补填的输入框。 */
    missingRows: [] as ToolsMissingRow[],
    /** 有分数的单项数（0~7）：只用于说明「几项有输入」，不参与任何计分。 */
    filledCount: 0,
    /** 结果抬头，如「估算结果 · 大一 / 大二 · 男」。 */
    resultEyebrow: '',
    /** 三位小数统一留一位，避免 84 与 84.0 两种写法在同一屏里混着出现。 */
    totalText: '',
    standardText: '',
    bonusText: '',
    /** 长跑输入换算结果，显示在输入框下方，避免学生以为自己填错了。 */
    runHint: '',
  },
  onLoad() {
    this.refreshLabels();
  },
  refreshLabels() {
    this.setData({
      sexLabel: this.data.sex === 'male' ? '男' : '女',
      bandLabel: this.data.band === 'freshman' ? '大学一、二年级' : '大学三、四年级',
    });
  },
  onSexTap(event: TapEvent) {
    const value = event.currentTarget.dataset.value;
    if (value !== 'male' && value !== 'female') return;
    this.setData({ sex: value });
    this.refreshLabels();
    if (this.data.hasResult) this.calculate();
  },
  onBandTap(event: TapEvent) {
    const value = event.currentTarget.dataset.value;
    if (value !== 'freshman' && value !== 'senior') return;
    this.setData({ band: value });
    this.refreshLabels();
    if (this.data.hasResult) this.calculate();
  },
  onInput(event: InputEvent) {
    const field = event.currentTarget.dataset.value;
    if (field === undefined || !(field in this.data.form)) return;
    this.setData({ [`form.${field}`]: event.detail.value });
    this.syncRefillValue(field as keyof FormState, event.detail.value);
    if (field === 'distanceRun') this.refreshRunHint(event.detail.value);
  },
  /** 补填框与顶部表单是同一份输入：一处改动，另一处同步显示。 */
  syncRefillValue(field: keyof FormState, value: string) {
    const rows = this.data.missingRows;
    if (rows.length === 0) return;
    let changed = false;
    const next = rows.map((row) => ({
      ...row,
      fields: row.fields.map((entry) => {
        if (entry.field !== field || entry.value === value) return entry;
        changed = true;
        return { ...entry, value };
      }),
    }));
    if (changed) this.setData({ missingRows: next });
  },
  refreshRunHint(text: string) {
    const seconds = parseRunInput(text);
    if (seconds === undefined) {
      this.setData({ runHint: '' });
      return;
    }
    if (!Number.isFinite(seconds)) {
      this.setData({ runHint: '长跑可以写 3′42″、3:42 或直接写秒数' });
      return;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - minutes * 60);
    this.setData({ runHint: `按 ${minutes} 分 ${String(rest).padStart(2, '0')} 秒（${seconds} 秒）计算` });
  },
  calculate() {
    const form = this.data.form;
    const input: FitnessInput = {
      sex: this.data.sex,
      band: this.data.band,
      height: parseNumberInput(form.height),
      weight: parseNumberInput(form.weight),
      vitalCapacity: parseNumberInput(form.vitalCapacity),
      sprint50: parseNumberInput(form.sprint50),
      sitAndReach: parseNumberInput(form.sitAndReach),
      standingLongJump: parseNumberInput(form.standingLongJump),
      strength: parseNumberInput(form.strength),
      distanceRunSeconds: parseRunInput(form.distanceRun),
    };
    const result = estimate(input);
    this.setData({
      result,
      hasResult: true,
      missingRows: missingRowsOf(result, form),
      filledCount: result.items.filter((item) => item.score !== null).length,
      resultEyebrow: `估算结果 · ${this.data.band === 'freshman' ? '大一 / 大二' : '大三 / 大四'} · ${this.data.sexLabel}`,
      totalText: fixed1(result.total),
      standardText: fixed1(result.standardScore),
      bonusText: fixed1(result.bonus),
    });
  },
  /** 缺项就地补填后重新估算：不清空别的输入，也不假装已经算完。 */
  onRecalculate() {
    this.calculate();
  },
  /** 「改一个数字重算」：回到输入区继续改，结果保留到下次点估算为止。 */
  focusForm() {
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  /**
   * 回「今天」主入口。栈里还有上一页就直接返回（保留已填项与估算结果）；
   * 只剩本页时走公共导航切「今天」tab，让底栏高亮跟着变。宿主没有 switchTab 时退回 reLaunch。
   */
  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openUiTab('today').catch(() => {
      wx.reLaunch({ url: '/pages/home/index' });
    });
  },
  /** 回学习工具：普通页跳 tab 页用 switchTab，环境不支持时退回 reLaunch。 */
  goStudy() {
    openUiTab('study').catch(() => {
      wx.reLaunch({ url: '/pages/study/index' });
    });
  },
});
