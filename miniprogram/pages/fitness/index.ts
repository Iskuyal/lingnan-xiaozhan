/**
 * 体测估算页（Issue #92）。
 *
 * 页面只负责收集输入、调用 `services/fitness` 的纯函数、把结果渲染出来。
 * 三条纪律落在页面上：
 * 1. **输入不保存**：表单值只存在页面内存里，退出即丢，不写本机存储、不进 AI 请求；
 * 2. **缺项不猜**：没填的项目不算 0 分，也不参与折算；结果里逐项说明为什么没有分数；
 * 3. **不冒充学校结果**：标准名称、版本、年级组、估算说明固定出现在结果区。
 *
 * 长跑输入接受 `3′42″`、`3:42` 或纯秒数（`222`），换算成秒后交给服务。
 */
import { FitnessInput, FitnessResult, Sex, GradeBand, estimate } from '../../services/fitness/index';

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
    if (field === 'distanceRun') this.refreshRunHint(event.detail.value);
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
    this.setData({ result: estimate(input), hasResult: true });
  },
  /** 「改一个数字重算」：回到输入区继续改，结果保留到下次点估算为止。 */
  focusForm() {
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
