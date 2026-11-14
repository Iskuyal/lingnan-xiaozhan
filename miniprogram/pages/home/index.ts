import { loadGoals } from '../../services/goals/index';
import { loadPlan } from '../../services/goals/plan';
import { shanghaiToday } from '../../services/dates/index';
import { Course } from '../../services/timetable/types';
import { TimetableSettings, emptySettings, loadSettings } from '../../services/timetable/settings';
import { listCourses } from '../../services/timetable/index';
import { TodayBrief, TimelineRow, buildTodayBrief } from '../../services/timetable/brief';
import { openTimetable, openUiTab } from '../../ui/navigation';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string; route?: string } };
}

type LoadState = 'loading' | 'ready' | 'error';

/**
 * 首屏红色卡片（设计图 01「下一节课」）。
 *
 * 四种状态各自成立，不互相顶替：
 * - class：有课且有作息，给时刻、地点与教师；
 * - unknown-times：有课但没填作息（设计图 53），只按节次看，不说「正在上」；
 * - empty：今天真没有课（或无课表），给导入与手工添加（设计图 36）；
 * - error：课表读取失败，既不说「没课」也不说「上完了」。
 */
interface HeroView {
  mode: 'class' | 'unknown-times' | 'empty' | 'error' | 'loading';
  /** 课程行 key（`课程id:起始节`）；非课程状态为空串。点卡片时用它打开课程详情。 */
  key: string;
  label: string;
  timeRange: string;
  title: string;
  meta: string;
  sectionText: string;
  footNote: string;
}

interface PlanStrip {
  hasPlan: boolean;
  title: string;
  meta: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * 课表读不到时的简报：不给假的「今天没课」，说清是没读到。
 * 与 services/timetable/brief 的约定一致——读取失败不等于无课。
 */
function emptyBrief(settings: TimetableSettings, today: string, clockMinutes: number): TodayBrief {
  return {
    ...buildTodayBrief({ courses: [], settings, today, clockMinutes, goals: [] }),
    headline: '正在读取今日课表',
    sentences: ['读取完成后显示今天的课程与空闲时段。'],
    emptyMessage: '正在读取，请稍候。',
  };
}

/** 现在几点几分（设备本地时间，与课表页 localMinutes 同口径）。 */
function localClockMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** 从行的 key（`课程id:起始节`）找出这节课的实际结束节次，用来算下课时刻。 */
function endSectionOf(row: TimelineRow, courses: Course[]): number | null {
  const [id, startText] = row.key.split(':');
  const start = Number(startText);
  const course = courses.find((item) => item.id === id);
  if (course === undefined) return null;
  const ranges = course.sectionRanges.length > 0
    ? course.sectionRanges
    : [{ start: course.startSection, end: course.endSection }];
  const range = ranges.find((item) => item.start === start);
  return range === undefined ? null : range.end;
}

/** 卡片上的「10:10 — 11:45」：任一端缺失就整段不显示，不给半截时刻。 */
function heroTimeRange(row: TimelineRow, courses: Course[], settings: TimetableSettings): string {
  const end = endSectionOf(row, courses);
  if (row.timeText === '' || end === null) return '';
  const raw = settings.sectionTimes[end - 1];
  if (raw === undefined || typeof raw.end !== 'string' || raw.end === '') return '';
  return `${row.timeText} — ${raw.end}`;
}

/** 今日卡片：先取「正在上」，再取「下一节」，都没有就按有无作息落到另外两种状态。 */
function buildHero(options: {
  state: LoadState; brief: TodayBrief; courses: Course[]; settings: TimetableSettings; hasTimes: boolean;
}): HeroView {
  const { state, brief, courses, settings, hasTimes } = options;
  if (state === 'loading') {
    return { mode: 'loading', key: '', label: '下一节课', timeRange: '', title: '正在读取今天的安排', meta: '', sectionText: '', footNote: '' };
  }
  if (state === 'error') {
    return {
      mode: 'error', key: '', label: '今日课表', timeRange: '', title: '今天的课表暂时没读到',
      meta: '读取失败不等于今天没课，稍后返回首页会重新读取。', sectionText: '', footNote: '',
    };
  }
  const classes = brief.rows.filter((row) => row.kind === 'course');
  const current = classes.find((row) => row.isNow);
  const next = classes.find((row) => row.isNext);
  if (courses.length === 0) {
    return {
      mode: 'empty', key: '', label: '新的一天', timeRange: '', title: '这里还没有课表',
      meta: '导入后，就能按周看课程、查询和核对自己的安排。', sectionText: '', footNote: '',
    };
  }
  if (!brief.hasCourses) {
    return {
      mode: 'class', key: '', label: '今天的安排', timeRange: '', title: '今天没有课',
      meta: '已导入的课程仍在周课表里，可以查看其他日期。', sectionText: '', footNote: '',
    };
  }
  if (!hasTimes) {
    return {
      mode: 'unknown-times', key: '', label: '今天的安排', timeRange: '', title: '先按节次看',
      meta: '先展示今天的课程，不判断哪节正在上；填好作息后这里会显示几点上课。', sectionText: '', footNote: '',
    };
  }
  const row = current ?? next;
  if (row === undefined) {
    return {
      mode: 'class', key: '', label: '今天的课', timeRange: '', title: '今天的课已经上完',
      meta: '剩下的时间自己安排；明天的课照常在课表里。', sectionText: '', footNote: '',
    };
  }
  return {
    mode: 'class',
    key: row.key,
    label: current === undefined ? '下一节课' : '正在上课',
    timeRange: heroTimeRange(row, courses, settings),
    title: row.title,
    meta: row.detail,
    sectionText: row.sectionText,
    footNote: '时刻来自已填写的作息',
  };
}

Page({
  data: {
    brief: emptyBrief(emptySettings(), '2026-01-01', 0),
    state: 'loading' as LoadState,
    hero: buildHero({ state: 'loading', brief: emptyBrief(emptySettings(), '2026-01-01', 0), courses: [], settings: emptySettings(), hasTimes: false }),
    dateTile: { month: 'JAN', day: '1' },
    greetLine: '把今天安排好。',
    planStrip: { hasPlan: false, title: '', meta: '' } as PlanStrip,
  },
  /** 测试可注入固定时刻，避免「今天」随真实时钟漂移。 */
  fixedToday: '',
  fixedClock: -1,
  onLoad(query: { today?: string; clock?: string } = {}) {
    this.fixedToday = typeof query.today === 'string' ? query.today : '';
    const clock = Number(query.clock);
    this.fixedClock = typeof query.clock === 'string' && Number.isFinite(clock) ? clock : -1;
    this.setData({ dateTile: dateTileOf(this.todayText()) });
    return this.loadToday();
  },
  /**
   * 目标日与课表都存在本机/云端、随时会变，所以每次显示都重算简报：
   * 从目标日页返回就能看到倒计时更新，不用手动刷新。
   */
  onShow() {
    this.setData({ dateTile: dateTileOf(this.todayText()) });
    this.loadPlanStrip();
    return this.loadToday();
  },
  todayText(): string {
    return this.fixedToday !== '' ? this.fixedToday : shanghaiToday();
  },
  clockMinutes(): number {
    return this.fixedClock >= 0 ? this.fixedClock : localClockMinutes();
  },
  /**
   * 今日简报：课表读不到时降级成「只有目标日与日期」的版本，
   * 不把失败说成「今天没课」——没读到和没有是两件事。
   */
  loadToday() {
    const today = this.todayText();
    const clock = this.clockMinutes();
    return loadSettings()
      .then((settings) => listCourses().then((feed) => ({ settings, courses: feed.courses })))
      .then(({ settings, courses }) => {
        const brief = buildTodayBrief({ courses, settings, today, clockMinutes: clock, goals: loadGoals() });
        this.setData({
          brief,
          state: 'ready',
          hero: buildHero({ state: 'ready', brief, courses, settings, hasTimes: brief.hasTimes }),
          greetLine: brief.hasCourses && brief.hasTimes ? '把今天安排好。' : brief.hasCourses ? '先按节次看。' : '从自己的课表开始。',
        });
      })
      .catch(() => {
        const settings = emptySettings();
        const brief = buildTodayBrief({ courses: [], settings, today, clockMinutes: clock, goals: loadGoals() });
        this.setData({
          brief: {
            ...brief,
            headline: '今日课表暂时没读到',
            sentences: ['暂时无法确认今天有哪些课，稍后返回首页会重新读取。', ...brief.sentences.filter((line) => line.includes('距「') || line.includes('今天就是「'))],
            emptyMessage: '请检查网络，或进入我的课表重新读取。',
          },
          state: 'error',
          hero: buildHero({ state: 'error', brief, courses: [], settings, hasTimes: false }),
          greetLine: '稍后再看今天的安排。',
        });
      });
  },
  loadPlanStrip() {
    const plan = loadPlan();
    if (plan === null) {
      this.setData({ planStrip: { hasPlan: false, title: '', meta: '' } });
      return;
    }
    this.setData({
      planStrip: {
        hasPlan: true,
        title: plan.goalName,
        meta: `${plan.blocks.length} 段 · 共 ${plan.totalMinutes} 分钟 · 本机保存`,
      },
    });
  },
  retryToday() {
    return this.loadToday();
  },
  /** 问课表：只打开课表页的助手并结束在这一步，不自动发问题、不调模型。 */
  askTimetable() {
    return openTimetable({ kind: 'assistant' }).catch(() => {
      wx.showToast({ title: '课表页暂时打不开，稍后再试', icon: 'none' });
    });
  },
  openTimetable() {
    return openUiTab('timetable').catch(() => {
      wx.showToast({ title: '课表页暂时打不开，稍后再试', icon: 'none' });
    });
  },
  openImport() {
    wx.navigateTo({ url: '/pages/timetable/import/index' });
  },
  /** 手工添加走课表编辑页既有的新增模式（不带 id 即新增）。 */
  openManualCourse() {
    wx.navigateTo({ url: '/pages/timetable/edit/index' });
  },
  openTimetableSettings() {
    wx.navigateTo({ url: '/pages/timetable/settings/index' });
  },
  openGoals() {
    wx.navigateTo({ url: '/pages/goals/index' });
  },
  openPlan() {
    wx.navigateTo({ url: '/pages/goals/plan/index' });
  },
  openNews() {
    wx.navigateTo({ url: '/pages/news/index' });
  },
  /** 时间线里点课程：打开该课程的详情编辑页（与课表页同一入口，不复制逻辑）。 */
  openCourse(event: TapEvent) {
    const key = event.currentTarget.dataset.id;
    if (typeof key !== 'string' || key === '' || key.startsWith('free:')) return;
    const id = key.split(':')[0];
    if (id === '') return;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=saved&id=${encodeURIComponent(id)}` });
  },
});

/** 日期角标：月份用大写英文缩写（设计图 01 的 NOV / 11），日取两位内数字。 */
function dateTileOf(today: string): { month: string; day: string } {
  const parts = today.split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) {
    return { month: '—', day: '—' };
  }
  return { month: MONTHS[month - 1], day: String(day) };
}
