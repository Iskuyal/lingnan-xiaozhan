# P3 官网资讯（含云端同步）

对应 [开发阶段](../../development-phases.md) 的 **P3-1**（已完成）与 **P3-2**（未开始），规格见 [开发规格](../../development-spec.md) 的「校园资讯」行与「内容与边界」。云端实施的完整依据见 [云开发环境与 P3 云端实施](../../cloud-development.md)。

## 状态

| 阶段条目 | 状态 |
| --- | --- |
| P3-1 验证 AppID 与云环境关联、数据库权限和云函数调用 | 已完成（云函数已部署并实测） |
| P3-1 实现维护者导入/同步一篇真实文章、服务端读取、小程序列表与详情、来源信息 | 已完成 |
| P3-1 验证标题日期正文对应原文、无登录可看公开资讯、普通客户端不能写公开内容 | 已完成（实测见 [verification.md](verification.md)） |
| P3-2 栏目同步与更新（定时、去重、分页、失败保留） | **未开始** |
| P3-2 首页增加最近资讯入口与条目 | **未开始** |

## 数据流

```
官网「校园动态」列表页
   │  ① 云函数抓取（https，浏览器请求头）
   ▼
parseNewsList()  ──►  条目（id / title / url / date），按原文 URL 去重
   │  ② 逐篇抓正文
   ▼
parseNewsArticle()  ──►  标题、日期、清理后的正文段落（剥离编辑署名行）
   │  ③ toArticleRecord() 补来源与时间字段
   ▼
云数据库 news_articles  ──按 url upsert──►  同时更新 sync_state
   │  ④ 客户端只读（安全规则 read:true / write:false）
   ▼
小程序列表页 / 详情页（异步加载，区分加载中 / 有数据 / 空 / 读取失败可重试）
```

## 交付物

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `cloudfunctions/newsSync/parse.ts` | 238 | 列表与正文解析纯函数（**从 `miniprogram/services/news/` 迁入**） |
| `cloudfunctions/newsSync/index.ts` | 187 | 同步云函数主流程 |
| `cloudfunctions/newsSync/record.ts` | 54 | 入库记录字段契约（纯函数，可在本地测试） |
| `cloudfunctions/newsSync/types.ts` | 24 | 云函数侧类型 |
| `cloudfunctions/newsSync/package.json` | 10 | 声明 `wx-server-sdk 4.0.2` |
| `cloudfunctions/tsconfig.json` | 16 | 云函数独立编译配置（Node 环境） |
| `miniprogram/services/news/index.ts` | 117 | 客户端服务：读云数据库、错误文案、时间格式化 |
| `miniprogram/services/news/types.ts` | 34 | 客户端侧类型 |
| `miniprogram/pages/news/index.{ts,wxml,wxss}` | 52 / 47 / 20 | 资讯列表页 |
| `miniprogram/pages/news/detail/index.{ts,wxml,wxss,json}` | 90 / 43 / 11 / 1 | 资讯详情页 |
| `miniprogram/app.ts` | 18 | `wx.cloud.init`（环境 ID 写死在代码里，不是密钥） |
| `scripts/build.mjs` | +23 | 编译云函数到 `dist/cloudfunctions/` 并复制非 TS 文件 |
| `project.config.json` | — | 增加 `cloudfunctionRoot: "cloudfunctions/"` |
| `tests/news.test.cjs`、`tests/newsSync.test.cjs` | 308 / 56 | 解析、服务、页面、字段契约测试 |
| `tests/fixtures/news/*.html` | 4 个文件 | 真实页面片段（抓取日期 2026-09-17） |
| `docs/news-sources.md` | — | 栏目结构、分页格式、真实样本、未验证清单 |

**已删除**：`miniprogram/services/news/snapshot.ts`（随包内容快照，42KB）。正文现在只来自云端。

## 解析链路（`parse.ts`）

- 只接收 HTML 字符串、返回普通对象：不调用 `wx.*`、不访问网络，因此可在 Node 测试中执行、也能在云函数里复用。
- 正文容器右边界用 `article-fd`；标题用 `h1.title`，缺失时回退 `<title>`；日期取列表页与文章页的发布时间（实测两者日期一致，抽查 2014 / 2023 / 2026 年样本）。
- **编辑署名行剥离**：官网正文末尾固定 4 行（供稿 / 初审 / 复审 / 终审），实测 4 篇文章 100% 命中，其中一篇用全角分号（`复审；黄雅晴`）。只剥离**尾部连续**的署名行；署名行之后仍有正文时不剥离；正文只由署名行组成时返回空数组。
- **去重键是原文绝对 URL**（`id` 取 URL 末段，用于页面传参）。
- 容错：缺日期 → 空字符串；缺正文 / 缺列表容器 / 空输入 → 空数组，都不抛异常。
- 只覆盖已实测的页面特征；选择器依据与脆弱点记录在 [资讯栏目来源](../../news-sources.md)。

## 云函数 `newsSync`

- 职责：抓列表 → 逐篇抓正文 → 解析 → 按 URL upsert → 更新 `sync_state`。
- **手动触发**：维护者通过云开发控制台「测试」或管理端调用（参数可传 `{"limit": N}`，默认 10、上限 30）。小程序调用仅为历史验收方式；本轮准备的函数权限规则将禁止客户端调用，待控制台应用。
- **定时触发**：**未配置**（刻意留到 P3-2；首次同步范围与失败处理先验证）。
- 请求：使用 Node 内置 `https`（不依赖运行时是否有全局 `fetch`），带浏览器请求头。
- 失败处理：单篇失败不中断整批，失败列表写入 `sync_state.lastError` 并由调用结果返回；标题或正文为空不覆盖旧文章，缺日期仍可保存。整批成功才推进 `lastSuccessAt`，部分成功为 `partial`，零成功为 `failed`。本轮修复已在本地测试，待重新部署。
- 返回值自带自检信息：`{ok, parsed, inserted, updated, failed, elapsedMs, sample}`，调用方无需另查库即可判断本次同步结果。

### 官网对云函数环境返回 403

首次调用时抓取官网返回 **403**（同一地址在本机 `curl` 返回 200）。给请求加上常见浏览器请求头（`User-Agent`/`Accept`/`Accept-Language`）后恢复正常，判断为官网拦截缺少浏览器特征的请求。云函数不携带 Cookie、不涉及身份伪装，只读取公开页面。

错误信息现在会带上响应片段（前 200 字符），便于下次直接判断原因。

## 数据库（云环境 `cloudbase-d2gjtbbwu3575cd7b`）

| 集合 | 字段 | 索引 | 客户端权限 |
| --- | --- | --- | --- |
| `news_articles` | `id`、`url`、`title`、`date`、`paragraphs[]`、`sourceLabel`、`capturedAt`、`updatedAt` | `url` **唯一索引**（`url_1`），去重的数据库层兜底 | 自定义安全规则 `{"read": true, "write": false}` |
| `sync_state` | `column`、`lastSuccessAt`、`lastAttemptAt`、`lastOutcome`、`lastError`、`elapsedMs`、`inserted`、`updated` | 用固定 `_id`（如 `xyxw-xydt`）标识，无需索引 | 「所有用户不可读写」 |

- 唯一索引防的是**并发写入**：应用层「先查后写」在云函数并发执行时仍可能插入重复条目。
- 安全规则用**自定义规则而非控制台预设**：控制台提示预设权限不支持无登录态用户访问（单页模式等场景 `auth` 为空），`{"read": true, "write": false}` 不引用 `auth`，两种情况都能读。
- 云函数与控制台属管理端，不受安全规则限制，因此写入只发生在云函数内。
- **「更新时间」的取法**：客户端展示的「数据同步于 …」取自当前读取记录中最新的 `updatedAt`，表示文章最近成功写入时间；部分成功也可能推进。整批成功时间单独记录在私有 `sync_state.lastSuccessAt`，不对客户端开放。

## 客户端改造

- 列表页与详情页改为**异步加载**，状态机为 `loading / ready / empty / missing / error`；读取失败显示可重试的错误状态，**不静默降级**为旧内容。
- 列表查询只投影 `id/title/url/date/updatedAt`（不拉正文，避免列表页传输大字段）。
- 错误文案不依赖 `instanceof Error`：云调用失败常抛带 `errMsg` 的普通对象，改为按 `message` / `errMsg` 取文案（否则页面会显示 `[object Object]`）。
- 详情页显示来源与同步时间，保留「复制原文链接」，未使用 web-view。

## 测试

- **解析**：真实片段驱动的 12 项（条目解析、导航链接不入条目、署名行剥离三种情形、去重、缺日期、缺正文、标题回退、空输入）。
- **字段契约**：`tests/newsSync.test.cjs` 检查入库字段，并将真实解析/入库输出交给真实客户端服务，验证列表、详情和时间；不再仅对照手写清单。
- **构建**：云函数产物齐全、`cloudfunctionRoot` 指向存在、`tsconfig.json` 不进部署目录、解析逻辑不进小程序包。
- **服务**：用假 `wx.cloud` 验证字段映射、`orderBy:date:desc`、`limit` 参数、空 id 不发请求、云开发不可用时抛可读错误。
- **页面**：列表展示与跳转、空数据与失败区分、重试、详情渲染、未知 id、复制链接反馈、返回行为。
