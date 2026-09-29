/**
 * 校历与考试日期：**版本化的人工核准数据**（不抓取、不推断）。
 *
 * 数据只从官方公告抄写，每条都带发布主体、原文 URL、公告发布日期与最后核查日；
 * 没有官方日期的事项不写日期（宁可写「以本校通知为准」「待公布」），**绝不沿用上一年的日期**。
 *
 * 来源核验记录见 `docs/product/sources/exam-calendar.md`（2026-09-29 核查）。改数据必须同时改那份文档。
 */
export type CalendarCategory = 'cet' | 'ncre' | 'mandarin' | 'school';

/**
 * 事件状态：
 * - `published`：官方公告给了确定日期（只有这种才显示「还有 N 天」）；
 * - `pending`：还没公布；
 * - `ended`：本批次已结束（明确标注，不当作未来的事）；
 * - `per-school`：日期由各考点/学校自行规定（写「以本校通知为准」）；
 * - `link-only`：没有可维护的官方日期来源，只给官方入口。
 */
export type CalendarEventStatus = 'published' | 'pending' | 'ended' | 'per-school' | 'link-only';

export interface CalendarEvent {
  id: string;
  category: CalendarCategory;
  title: string;
  /** 'YYYY-MM-DD'；没有确定日期时为 ''。 */
  date: string;
  /** 当日时间说明，如「09:00–11:20」；没有就空着，不写「全天」。 */
  timeText: string;
  /** 报名信息：有官方日期就写日期，没有就写清楚归谁定；不留在空字符串上含糊。 */
  registerText: string;
  scope: string;
  status: CalendarEventStatus;
  /** 发布主体（页面上与原文链接一起展示）。 */
  sourceLabel: string;
  sourceUrl: string;
  /** 官方公告的发布日期，'YYYY-MM-DD'。 */
  publishedAt: string;
  /** 最后人工核查日，'YYYY-MM-DD'。 */
  verifiedAt: string;
  note: string;
}

const CET_ANNOUNCEMENT_URL = 'https://cet.neea.edu.cn/html1/report/2609/1-1.htm';
const CET_ANNOUNCEMENT_LABEL = '中国教育考试网 · 2026年下半年四六级报名工作启动';
const NCRE_ANNOUNCEMENT_URL = 'https://ncre.neea.edu.cn/html1/report/2606/16-1.htm';
const NCRE_ANNOUNCEMENT_LABEL = '中国教育考试网 · 2026年9月NCRE报名工作启动';
/** 本批数据的核查日：所有 verifiedAt 都用它，改数据时一起改。 */
export const VERIFIED_AT = '2026-09-29';

export const CALENDAR_EVENTS: CalendarEvent[] = [
  {
    id: 'cet-2026h2-set4',
    category: 'cet',
    title: '大学英语四级口语考试（CET-SET4）',
    date: '2026-11-21',
    timeText: '',
    registerText: '各考点报名时间不同，以本校教务处通知为准',
    scope: '2026 年下半年 · 全国',
    status: 'published',
    sourceLabel: CET_ANNOUNCEMENT_LABEL,
    sourceUrl: CET_ANNOUNCEMENT_URL,
    publishedAt: '2026-09-02',
    verifiedAt: VERIFIED_AT,
    note: '口试准考证自 11 月 17 日 9 时起可打印',
  },
  {
    id: 'cet-2026h2-set6',
    category: 'cet',
    title: '大学英语六级口语考试（CET-SET6）',
    date: '2026-11-22',
    timeText: '',
    registerText: '各考点报名时间不同，以本校教务处通知为准',
    scope: '2026 年下半年 · 全国',
    status: 'published',
    sourceLabel: CET_ANNOUNCEMENT_LABEL,
    sourceUrl: CET_ANNOUNCEMENT_URL,
    publishedAt: '2026-09-02',
    verifiedAt: VERIFIED_AT,
    note: '口试准考证自 11 月 17 日 9 时起可打印',
  },
  {
    id: 'cet-2026h2-cet4',
    category: 'cet',
    title: '大学英语四级笔试（CET4）',
    date: '2026-12-12',
    timeText: '09:00–11:20',
    registerText: '各考点报名时间不同，以本校教务处通知为准',
    scope: '2026 年下半年 · 全国',
    status: 'published',
    sourceLabel: CET_ANNOUNCEMENT_LABEL,
    sourceUrl: CET_ANNOUNCEMENT_URL,
    publishedAt: '2026-09-02',
    verifiedAt: VERIFIED_AT,
    note: '笔试准考证自 12 月 1 日 9 时起可打印',
  },
  {
    id: 'cet-2026h2-cet6',
    category: 'cet',
    title: '大学英语六级笔试（CET6）',
    date: '2026-12-12',
    timeText: '15:00–17:25',
    registerText: '各考点报名时间不同，以本校教务处通知为准',
    scope: '2026 年下半年 · 全国',
    status: 'published',
    sourceLabel: CET_ANNOUNCEMENT_LABEL,
    sourceUrl: CET_ANNOUNCEMENT_URL,
    publishedAt: '2026-09-02',
    verifiedAt: VERIFIED_AT,
    note: '笔试准考证自 12 月 1 日 9 时起可打印',
  },
  {
    id: 'cet-2026h2-register',
    category: 'cet',
    title: '四六级报名',
    date: '',
    timeText: '',
    registerText: '公告只写「各地报名工作陆续启动」，没有全国统一截止时间',
    scope: '2026 年下半年 · 全国',
    status: 'per-school',
    sourceLabel: CET_ANNOUNCEMENT_LABEL,
    sourceUrl: CET_ANNOUNCEMENT_URL,
    publishedAt: '2026-09-02',
    verifiedAt: VERIFIED_AT,
    note: '报名入口：cet-bm.neea.edu.cn；请以本校教务处的报名通知为准，本卡不给出报名截止日期',
  },
  {
    id: 'ncre-2026-09',
    category: 'ncre',
    title: '全国计算机等级考试（2026 年 9 月批次）',
    date: '2026-09-19',
    timeText: '',
    registerText: '广东省报名：2026-06-25 10:00 至 2026-07-03 16:00（报名已结束）',
    scope: '2026 年 9 月批次 · 广东',
    status: 'ended',
    sourceLabel: NCRE_ANNOUNCEMENT_LABEL,
    sourceUrl: NCRE_ANNOUNCEMENT_URL,
    publishedAt: '2026-06-24',
    verifiedAt: VERIFIED_AT,
    note: '考试时间 9 月 19 日至 21 日；本批次已结束，不显示倒计时',
  },
  {
    id: 'ncre-next',
    category: 'ncre',
    title: '全国计算机等级考试（下一批）',
    date: '',
    timeText: '',
    registerText: '以省教育考试院与 NCRE 报名网站公告为准',
    scope: '待公布 · 广东',
    status: 'pending',
    sourceLabel: '中国教育考试网 · 全国计算机等级考试栏目',
    sourceUrl: 'https://ncre.neea.edu.cn/',
    publishedAt: '2026-06-24',
    verifiedAt: VERIFIED_AT,
    note: '截至核查日尚未公布下一批的报名与考试时间；不沿用上一批日期',
  },
  {
    id: 'mandarin',
    category: 'mandarin',
    title: '普通话水平测试',
    date: '',
    timeText: '',
    registerText: '广东没有全省统一公告，各测试站按批次在网上报名系统发布',
    scope: '广东省 · 各测试站',
    status: 'link-only',
    sourceLabel: '国家普通话水平测试在线报名系统',
    sourceUrl: 'https://bm.cltt.org',
    publishedAt: '',
    verifiedAt: VERIFIED_AT,
    note: '本卡只提供官方报名入口，不显示日期，也不承诺名额',
  },
  {
    id: 'school-calendar',
    category: 'school',
    title: '学校校历',
    date: '',
    timeText: '',
    registerText: '官网未公开可解析的校历页面',
    scope: '广东岭南职业技术学院',
    status: 'link-only',
    sourceLabel: '学校官网 · 教务处',
    sourceUrl: 'https://lnc.edu.cn/jwc',
    publishedAt: '',
    verifiedAt: VERIFIED_AT,
    note: '2026-09-29 核查：官网首页与教务处首页都没有校历栏目；找到官方页面后再补日期',
  },
];

export const CATEGORY_LABEL: Record<CalendarCategory, string> = {
  cet: '四六级',
  ncre: '计算机等级',
  mandarin: '普通话',
  school: '学校校历',
};

/** 页面上的分组顺序：学校 → 四六级 → 计算机等级 → 普通话。 */
export const CATEGORY_ORDER: CalendarCategory[] = ['school', 'cet', 'ncre', 'mandarin'];
