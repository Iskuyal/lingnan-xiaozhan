/**
 * 同步栏目清单与批次参数。
 *
 * 范围依据：
 * - 2026-09-18 负责人确定（见 docs/tasks/p3-2-news-updates.md「已确定的范围」表）：首批栏目为
 *   校园动态 + 团委通知公告，增量回看最近 3 页；请求间隔 1.3 秒、单批不超过 10 次页面请求；
 *   定时同步每日 06:00（Asia/Shanghai）。
 * - 2026-09-19 Ticket 10 追加（见 docs/tasks/tickets/10-campus-rag-qa.md）：为「校园通知与办事
 *   指引问答」的语料入库 8 个栏目。它们与团委通知公告同属站群的 `newsList` 模板，**不需要新的
 *   解析分支**，实测依据见 docs/product/sources/news.md 与 tests/fixtures/news/*-list-page-1.html。
 * - 同日决定校园动态 126 页全量暂缓（只保每日增量），故 `xyxw-xydt` 仍在清单里但不再跑全量。
 *
 * 页数、分页格式与模板差异均来自 docs/product/sources/news.md 与 tests/fixtures/news/ 的真实页面实测。
 */
import { NewsColumn } from './types';

/** 栏目清单。顺序即定时同步的处理顺序；每个栏目的状态文档 `_id` 就是这里的 id。 */
export const COLUMNS: NewsColumn[] = [
  {
    id: 'xyxw-xydt',
    label: '学校官网 · 校园动态',
    listUrl: 'https://lnc.edu.cn/xyxw/xydt',
    template: 'xyxw',
    // 实测第 1 页页脚「共1252条信息/共126页」，第 1-125 页各 10 条、第 126 页 2 条。
    // 2026-09-19：全量导入暂缓（事后报道性质），保留栏目以维持每日增量。
    totalPages: 126,
  },
  {
    id: 'tw-tqsd',
    label: '学校官网 · 团委通知公告',
    listUrl: 'https://lnc.edu.cn/tw/djxf/tqsd',
    template: 'newsList',
    // 实测第 1 页页脚「共155条信息/共16页」。
    totalPages: 16,
  },
  // —— 以下 8 个栏目为 2026-09-19 Ticket 10 追加，全部实测为 `newsList` 模板（见文件头说明）——
  {
    id: 'bw-tqsd',
    label: '学校官网 · 保卫工作部通知公告',
    listUrl: 'https://lnc.edu.cn/bw/tqsd',
    template: 'newsList',
    // 实测第 1 页页脚「共11条信息/共2页」，10 条全部指向官网详情页。
    totalPages: 2,
  },
  {
    id: 'bw-xywt',
    label: '学校官网 · 保卫工作部服务指南',
    listUrl: 'https://lnc.edu.cn/bw/xywt',
    template: 'newsList',
    // 实测「共7条信息/共1页」；办事流程类正文（如「学生户口迁移办理流程」），是问答的高价值语料。
    totalPages: 1,
  },
  {
    id: 'bw-aqglzd',
    label: '学校官网 · 保卫工作部安全管理制度',
    listUrl: 'https://lnc.edu.cn/bw/djxf/aqglzd',
    template: 'newsList',
    // 实测「共1条信息/共1页」（清远校区交通与车辆管理规定，正文 3300 余字）。
    totalPages: 1,
  },
  {
    id: 'zl-tzgg',
    label: '学校官网 · 质量监控中心通知公告',
    listUrl: 'https://lnc.edu.cn/zl/tzgg',
    template: 'newsList',
    // 实测「共70条信息/共7页」；含期末评价、评教等学生相关通知。
    totalPages: 7,
  },
  {
    id: 'jwc-jxyh',
    label: '学校官网 · 教务处教学运行',
    listUrl: 'https://lnc.edu.cn/jwc/jxyh',
    template: 'newsList',
    // 实测「共9条信息/共1页」，其中 1 条指向公众号（由 isOffsiteUrl 按外链处理，只存标题与链接）。
    totalPages: 1,
  },
  {
    id: 'zxsy-lnpp',
    label: '学校官网 · 知行书院通知公告',
    listUrl: 'https://lnc.edu.cn/zxsy/lnpp',
    template: 'newsList',
    // 实测「共5条信息/共1页」；内容偏学院新闻，作为覆盖度补充。
    totalPages: 1,
  },
  {
    id: 'ln-ggtz',
    label: '学校官网 · 砺能书院公告通知',
    listUrl: 'https://lnc.edu.cn/ln/xssw/ggtz',
    template: 'newsList',
    // 实测「共1条信息/共1页」。
    totalPages: 1,
  },
  {
    id: 'cl-zzyr',
    label: '学校官网 · 崇礼书院资助育人',
    listUrl: 'https://lnc.edu.cn/cl/jyjx/zzyr',
    template: 'newsList',
    // 实测「共3条信息/共1页」。
    totalPages: 1,
  },
];

/**
 * 相邻两次页面请求的最小间隔。
 * 官网 WAF 明写「每秒不能多于 1 个页面请求」，超限返回 403 并冻结 IP，故取 1.3 秒留余量。
 */
export const REQUEST_INTERVAL_MS = 1300;

/**
 * 单次调用最多发起的页面请求数（列表页、正文与同站跳转都算一次）。
 * 10 次请求里第 1 次到第 10 次相隔 9 × 1.3 = 11.7 秒，加上最后一次请求自身约 0.3 秒，
 * 整批约 12 秒，落在 WORK_DEADLINE_MS（12.5 秒）与 20 秒云函数超时之内。
 *
 * 全量导入的实际批数（供排期参考，2026-09-19 按 Ticket 10 重算）：
 *   校园动态 126 页 + 1252 篇正文 = 1378 次请求（**已暂缓，见文件头：只保每日增量**）
 *   团委通知公告 16 页 + 155 篇正文 = 171 次请求
 *   Ticket 10 追加的 8 个栏目 15 页 + 107 篇正文 = 122 次请求
 * 即**当前要跑的全量 = 171 + 122 = 293 次请求 ÷ 每批 10 次 ≈ 30 批**（连续跑约 15 分钟）。
 * 票面「首次全量约 15 批」按每批 10 个列表页估算，未计入正文请求；在 1.3 秒间隔与 20 秒
 * 超时下，正文请求必须与列表页共享同一份配额，否则单批必然超时。
 * 分批进度落在状态文档里，中断后可接着跑；维护者可用 `column` 参数只跑一个栏目。
 */
export const MAX_REQUESTS_PER_CALL = 10;

/** 增量同步回看最近 N 页。 */
export const INCREMENTAL_PAGES = 3;

/**
 * 单次调用的请求截止点（相对调用开始）：此后不再发起新请求，避免撞上 20 秒超时。
 *
 * 推导（2026-09-18 两轴审查后重算）：
 *   20 秒（云函数超时）
 *   − 6 秒（单次请求最坏耗时，即 REQUEST_TIMEOUT_MS；跳转在发下一次之前还会再判一次截止点，
 *          所以「最后一次已发出的请求」最多只有一个）
 *   − 1 秒（每批约 30 次数据库往返里，落在 1.3 秒节流间隙之外的部分：查重、写文章、落盘状态）
 *   − 0.5 秒（收尾：最后一次状态落盘与返回值的序列化）
 *   = 12.5 秒
 *
 * 10 次请求按 1.3 秒间隔在第 11.7 秒发完，仍在 12.5 秒之内；判定顺序是
 * 「先等够 1.3 秒、再判截止点、最后才发请求」（见 index.ts 的 fetchWithGate），
 * 因此不会出现「检查时还没到点、发出去时已经超时」。
 */
export const WORK_DEADLINE_MS = 12500;

/** 单次页面请求的超时时间。官网正常响应约 0.3 秒，6 秒足够，同时给函数总时长留余量。 */
export const REQUEST_TIMEOUT_MS = 6000;

/**
 * 触发限速 403 后的冷却时间：冷却期内后续调用直接跳过，不发起任何请求。
 * 实测继续重试会延长官网的冻结时间，因此宁可空跑一次也不再请求。
 */
export const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 单次调用的运行锁时长。微信文档说明定时消息可能被重复推送，两次并发调用会把
 * 请求间隔压到 1 秒以内、触发官网限速，因此调用开始时加锁，结束时释放；
 * 调用被超时强杀时锁最多残留这么久（大于 20 秒超时，小于正常的调用间隔）。
 */
export const RUN_LOCK_MS = 25000;

/** 列表第 N 页 URL：第 1 页无后缀，第 N（N ≥ 2）页为 `${listUrl}_${N}`（实测格式）。 */
export function listPageUrl(column: NewsColumn, page: number): string {
  return page <= 1 ? column.listUrl : `${column.listUrl}_${page}`;
}
