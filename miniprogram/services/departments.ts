/**
 * 学生组织内容服务。
 *
 * 数据随包提供，不依赖云环境。所有内容取自学校官网已核实页面，
 * 逐条来源、核查日期与缺失字段记录见 docs/departments-sources.md。
 * 官网没有公布的信息一律留空并在界面显示缺失文案，不做推测。
 */

export interface DepartmentContact {
  label: string;
  value: string;
}

export interface DepartmentActivity {
  title: string;
  /** 官网文章发布日期，格式 YYYY-MM-DD。 */
  publishedAt: string;
  sourceUrl: string;
}

export interface Department {
  id: string;
  name: string;
  /** 官网未标注所属校区时为 null。 */
  campus: string | null;
  /** 校区结论的来源文章；无依据时为 null。 */
  campusSourceUrl: string | null;
  /** 校区依据说明，仅在有校区依据时给出。 */
  campusNote: string;
  introduction: string;
  /** 下设部门的原文说明。 */
  unitNote: string;
  units: string[];
  /** 官网未公布联系方式时为空数组。 */
  contacts: DepartmentContact[];
  activities: DepartmentActivity[];
  sourceUrl: string;
  verifiedAt: string;
}

export interface DepartmentsSource {
  label: string;
  sourceUrl: string;
  verifiedAt: string;
  note: string;
}

export interface DepartmentListItem {
  id: string;
  name: string;
  campusLabel: string;
  campusMissing: boolean;
}

export interface DepartmentListView {
  items: DepartmentListItem[];
  total: number;
  isEmpty: boolean;
  emptyTitle: string;
  emptyCopy: string;
  source: DepartmentsSource;
}

export interface DepartmentDetailView {
  id: string;
  name: string;
  campusLabel: string;
  campusMissing: boolean;
  campusNote: string;
  campusSourceUrl: string | null;
  introduction: string;
  unitNote: string;
  units: string[];
  contactItems: DepartmentContact[];
  contactMissing: boolean;
  contactMissingText: string;
  activities: DepartmentActivity[];
  activityMissing: boolean;
  activityMissingText: string;
  sourceLabel: string;
  sourceUrl: string;
  verifiedAt: string;
}

export const MISSING_CAMPUS_TEXT = '官网未标注所属校区';
export const MISSING_CONTACT_TEXT = '暂无公开联系方式';
export const MISSING_ACTIVITY_TEXT = '官网暂未收录该组织的活动动态';
export const EMPTY_LIST_TITLE = '暂无可查看的学生组织';
export const EMPTY_LIST_COPY = '官网暂未提供可核实的学生组织名录，核实后会在这里展示。';
export const NOT_FOUND_TITLE = '未找到该部门';
export const NOT_FOUND_COPY = '这个部门不在已核实名录中，可以返回列表重新选择。';

export const departmentsSource: DepartmentsSource = {
  label: '学校官网 · 团委 · 学生组织',
  sourceUrl: 'https://lnc.edu.cn/tw/sygk/xszz',
  verifiedAt: '2026-09-18',
  note: '组织名称与介绍转录自该页面的「学生组织机构简介」表格；组织动态取自团委各栏目 2025-2026 年文章，日期为官网「发布时间」；官网未公布组织联系方式。',
};

export const departments: Department[] = [
  {
    id: 'student-youth-league',
    name: '校学生团委',
    campus: null,
    campusSourceUrl: null,
    campusNote: '',
    introduction: '共青团广东岭南职业技术学院委员会是团组织联系广大团员青年的桥梁和窗口，负责规划、统筹全校各级学生组织的基层团建及团员青年思想政治教育工作，指导全校各级学生组织开展工作和活动。目前校学生团委直属部门包括秘书处、组织部、宣传部、广播台 4 个部门。',
    unitNote: '直属部门包括秘书处、组织部、宣传部、广播台 4 个部门。',
    units: ['秘书处', '组织部', '宣传部', '广播台'],
    contacts: [],
    activities: [
      {
        title: '对话榜样｜笃行团务，砺己争先',
        publishedAt: '2026-06-30',
        sourceUrl: 'https://lnc.edu.cn/tw/kjcx/qcby/content_30203',
      },
      {
        title: '关于2026年广东大学生“青马工程” 培训班学员推荐名单的公示',
        publishedAt: '2026-06-18',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/tqsd/content_29791',
      },
      {
        title: '我校组织参加2026年全省高校无偿献血工作动员视频会议',
        publishedAt: '2026-04-30',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_28456',
      },
      {
        title: '述职收官，逐光前行 2025-2026学年第一学期学生干部述职大会圆满落幕',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27039',
      },
      {
        title: '规范团务强本领 挺膺担当启新程——我校举办2025年共青团“岁末年初”专题工作培训',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27016',
      },
    ],
    sourceUrl: departmentsSource.sourceUrl,
    verifiedAt: departmentsSource.verifiedAt,
  },
  {
    id: 'student-union',
    name: '校学生会',
    campus: null,
    campusSourceUrl: null,
    campusNote: '',
    introduction: '校学生会是在校党委正确领导和校团委具体指导下的全校性学生组织（以下简称学生会）。学生会组织架构为“主席团+工作部门”模式，设权益部、文娱部、器材部、体育部、学创部 5 大部门。学生会围绕以加强对同学的思想引领为根本，以全心全意为同学服务为宗旨，发挥联系广大同学的主要桥梁和纽带作用。',
    unitNote: '组织架构为“主席团+工作部门”模式，设 5 大部门。',
    units: ['权益部', '文娱部', '器材部', '体育部', '学创部'],
    contacts: [],
    activities: [
      {
        title: '广东岭南职业技术学院第十四次学生代表大会顺利召开',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27001',
      },
      {
        title: '青春向党悟思想 挺膺担当启新程——我校学生会主席团参加广东学联2025-2026学年第一次集体学习',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27018',
      },
      {
        title: '第四届校园提案大赛圆满结束',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27004',
      },
      {
        title: '校长接待日｜校长面对面，这些后勤诉求全回应！',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27006',
      },
      {
        title: '我为同学做实事 校学生会助力2025年大学生体质健康测试工作',
        publishedAt: '2026-03-06',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_26964',
      },
      {
        title: '我为同学做实事|校园摆起 "权益小摊"，校学生会为校园消费撑起 "保护伞"',
        publishedAt: '2025-03-31',
        sourceUrl: 'https://lnc.edu.cn/tw/lndt/wwtxzss/content_22115',
      },
    ],
    sourceUrl: departmentsSource.sourceUrl,
    verifiedAt: departmentsSource.verifiedAt,
  },
  {
    id: 'student-club-management',
    name: '校学生社团管理部',
    campus: null,
    campusSourceUrl: null,
    campusNote: '',
    introduction: '校学生社团管理部阳光外向，理智独立，是学生社团健康发展的引航员，统筹全校学生社团建设管理，负责社团的注册登记、备案年审、组织建设、活动管理、工作保障等工作。校学生社团管理部下设策划部、秘书部、宣传部 3 个职能部门。',
    unitNote: '下设策划部、秘书部、宣传部 3 个职能部门。',
    units: ['策划部', '秘书部', '宣传部'],
    contacts: [],
    activities: [
      {
        title: '学生社团进社区｜第二期圆满落幕，下期敬请期待！',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_26999',
      },
      {
        title: '学生社团进社区 第三期圆满落幕，下期未完待续！',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27005',
      },
      {
        title: '学生社团进社区｜第一期圆满落幕，下期精彩待续！',
        publishedAt: '2026-03-06',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_26965',
      },
      {
        title: '学生社团招新 2025“社“聚新能量，青春燃校园',
        publishedAt: '2025-10-27',
        sourceUrl: 'https://lnc.edu.cn/tw/xywt/stfc/content_24789',
      },
    ],
    sourceUrl: departmentsSource.sourceUrl,
    verifiedAt: departmentsSource.verifiedAt,
  },
  {
    id: 'young-volunteers',
    name: '青年志愿者联合会',
    campus: '广州校区、清远校区',
    campusSourceUrl: 'https://lnc.edu.cn/tw/lnpp/zyhd/content_27022',
    campusNote: '官网组织表格未标注校区；此处依据 2026-03-10 志愿活动报道中的“广清两校区的青年志愿者联合会”。',
    introduction: '青年志愿者联合会隶属校团委，依“奉献、友爱、互助、进步”的志愿者精神为行动纲领，以“立足校园、发挥优势、奉献爱心、服务社会”为服务宗旨，通过组织全校青年志愿者向全校和社会提供志愿服务，培养学生成为具有高度社会责任感的时代新人，是大学生社会实践中重要的实践平台。青年志愿者联合会设主席团及职能部门 4 个：青枢部、青创部、青拓部，青宣部，建有“红小荔”志愿服务队。',
    unitNote: '设主席团及职能部门 4 个，建有“红小荔”志愿服务队。',
    units: ['青枢部', '青创部', '青拓部', '青宣部', '“红小荔”志愿服务队'],
    contacts: [],
    activities: [
      {
        title: '2026清远马拉松赛志愿服务复盘总结大会在我校顺利举行',
        publishedAt: '2026-04-15',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27865',
      },
      {
        title: '“青”志愿｜共建文明新校园，红荔聚力志愿行',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/lnpp/zyhd/content_27017',
      },
      {
        title: '“青”志愿｜岭南热血 双城同心',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/lnpp/zyhd/content_27022',
      },
      {
        title: '“青”young行 绘彩童心专项行（三十一）',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/lnpp/zyhd/content_27027',
      },
      {
        title: '“青”志愿 稻香伴“星“影，田垄齐漫步',
        publishedAt: '2026-03-09',
        sourceUrl: 'https://lnc.edu.cn/tw/lnpp/zyhd/content_26998',
      },
    ],
    sourceUrl: departmentsSource.sourceUrl,
    verifiedAt: departmentsSource.verifiedAt,
  },
  {
    id: 'veteran-affairs-service',
    name: '退役军人事务服务部',
    campus: null,
    campusSourceUrl: null,
    campusNote: '',
    introduction: '退役军人事务服务部隶属校团委，成立于 2022 年 5 月，是一个由退役大学生组成的组织。服务站是退役军人学子回归校园、适应校园、融入校园的重要平台，也是服务帮扶同学、维护同学权益、维护校规校纪的重要平台。服务站下设 2 个职能部门：宣秘团、督勤部。',
    unitNote: '服务站下设 2 个职能部门。',
    units: ['宣秘团', '督勤部'],
    contacts: [],
    activities: [
      {
        title: '述职收官，逐光前行 2025-2026学年第一学期学生干部述职大会圆满落幕',
        publishedAt: '2026-03-10',
        sourceUrl: 'https://lnc.edu.cn/tw/djxf/djhd/content_27039',
      },
    ],
    sourceUrl: departmentsSource.sourceUrl,
    verifiedAt: departmentsSource.verifiedAt,
  },
];

export function listDepartments(): Department[] {
  return departments;
}

export function findDepartmentById(id: unknown, source: Department[] = departments): Department | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  const found = source.find((item) => item.id === id);
  return found ?? null;
}

/** 组装列表页数据；传入空数组时返回空态视图。 */
export function buildDepartmentList(source: Department[] = departments): DepartmentListView {
  const items = source.map((item) => ({
    id: item.id,
    name: item.name,
    campusLabel: item.campus ?? MISSING_CAMPUS_TEXT,
    campusMissing: item.campus === null,
  }));
  return {
    items,
    total: items.length,
    isEmpty: items.length === 0,
    emptyTitle: EMPTY_LIST_TITLE,
    emptyCopy: EMPTY_LIST_COPY,
    source: departmentsSource,
  };
}

/** 组装详情页数据；未知 id 返回 null，由页面显示未找到状态。 */
export function buildDepartmentDetail(id: unknown, source: Department[] = departments): DepartmentDetailView | null {
  const department = findDepartmentById(id, source);
  if (!department) return null;
  return {
    id: department.id,
    name: department.name,
    campusLabel: department.campus ?? MISSING_CAMPUS_TEXT,
    campusMissing: department.campus === null,
    campusNote: department.campusNote,
    campusSourceUrl: department.campusSourceUrl,
    introduction: department.introduction,
    unitNote: department.unitNote,
    units: department.units,
    contactItems: department.contacts,
    contactMissing: department.contacts.length === 0,
    contactMissingText: MISSING_CONTACT_TEXT,
    activities: department.activities,
    activityMissing: department.activities.length === 0,
    activityMissingText: MISSING_ACTIVITY_TEXT,
    sourceLabel: departmentsSource.label,
    sourceUrl: department.sourceUrl,
    verifiedAt: department.verifiedAt,
  };
}
