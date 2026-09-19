# 云开发环境与 P3 云端实施

状态（2026-09-18 收尾记录）：P3-1 修复版云函数已部署，超时已调整为 20 秒，`newsSync.invoke: false` 已应用并通过客户端复核。证据见 [审查验证记录](review/p2-p3/verification.md) 及本文权限复核表。普通真机渲染与未登录单页模式尚未实测，分别由 P6 真机回归与 Ticket 08 跟踪。

## 环境信息

| 项 | 值 | 说明 |
| --- | --- | --- |
| 环境 ID | `cloudbase-d2gjtbbwu3575cd7b` | 环境标识，不是密钥，可写入代码与文档 |
| AppID | 见根目录 `project.config.json` | 环境与该 AppID 关联 |
| 开通日期 | 2026-09-18 | 由项目负责人在微信开发者工具「云开发」中开通 |
| 归属 | 项目团队 | 团队账号下的环境，非个人测试环境 |
| 接入形态 | 云函数 + 文档数据库 | 见 [ADR-0001](adr/0001-native-wechat-typescript.md) |
| 计费 | 按量计费 | 额度与预算以云开发控制台实际显示为准，开通后核实并补记于此 |

## 为什么是云开发而不是云托管

ADR-0001 已选定**微信云开发**（云函数 + 文档数据库），小程序通过 `wx.cloud.callFunction` 调用。P3 资讯的需求是「定时抓取官网 → 写入数据库 → 小程序读取」，无状态、低频、数据量小，云函数是最省事的一条路。

**云托管**（容器方案）适用于长连接、WebSocket、固定出口 IP 或需要完整 Web 框架的场景，本项目当前没有这类需求。课表已改为导入制，P4-A 教务账号接入研究取消。导入解析与 AI 调用计划继续使用云函数，需在 Ticket 01、03、05 中验证；`newsSync` 的 256MB / 20 秒配置不代表 AI 链路已验证可用。

## 前端接入

`miniprogram/app.ts` 已加入云能力初始化：

```ts
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请确认基础库版本满足云开发要求');
      return;
    }
    wx.cloud.init({
      env: 'cloudbase-d2gjtbbwu3575cd7b',
      traceUser: true,
    });
  },
});
```

要点：

- 环境 ID 直接写在代码里，不用环境变量；它不是凭据。
- `traceUser` 用于在控制台按用户查看调用记录，便于排查。是否保留由实施者决定，不涉及数据正确性。
- 初始化失败时不要静默：资讯页需要能显示「云能力不可用」，不能白屏。

## 构建与目录接入（已完成）

- `scripts/build.mjs` 清理并重建 `dist`，编译小程序并复制页面资源。
- 云函数使用 `cloudfunctions/tsconfig.json` 独立编译至 `dist/cloudfunctions/`，并复制函数的 `package.json`。
- 根目录 `project.config.json` 配置 `cloudfunctionRoot: "cloudfunctions/"`，构建时复制至 `dist`；开发者工具导入 `dist`。
- `npm run typecheck` 检查两份配置；`npm test` 构建后运行测试。云函数依赖在部署时安装。

## 数据模型

### 集合 `news_articles`（公开资讯）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 云数据库自动生成 |
| `url` | string | 原文绝对 URL，**去重键**，需唯一索引 |
| `id` | string | 原文 URL 末段，用于页面传参 |
| `title` | string | 文章标题，取自原文 |
| `date` | string | 发布日期 `YYYY-MM-DD`，取自原文；缺失时为空字符串 |
| `paragraphs` | string[] | 已清理的正文段落（客户端读取此字段，不再提供随包快照） |
| `sourceLabel` | string | 来源栏目，如「学校官网 · 校园动态」 |
| `capturedAt` | string | 本条文抓取日期 |
| `updatedAt` | string | 本条记录最后写入时间 |

去重与更新：按 `url` upsert。同一 URL 再次同步时更新内容与 `updatedAt`，不新增条目；这正是规格里「重复同步不重复」的落点。

`url` 需要唯一索引，作为去重的**数据库层兜底**：应用层「先查后写」在云函数并发执行时仍可能插入重复条目，唯一索引会让并发写入中的一次失败，从根上避免重复。

列表查询：按 `date` 倒序、同日期补 `id` 倒序（`skip` + `limit`）逐页读取，每页 20 条；首页「最近资讯」入口与列表逐页加载由 Ticket 02 于 2026-09-18 完成。数据规模参考：官网「校园动态」历史记录为 1252 条 / 126 页；扩大抓取属 P3-2 的 Ticket 04，真实多页场景待其完成后补验。

### 集合 `sync_state`（每栏目一条状态文档 + 一条站点文档）

Ticket 04 起同步两个栏目（校园动态 `xyxw-xydt`、团委通知公告 `tw-tqsd`），每个栏目一条状态文档，`_id` 即栏目标识。分批续跑的进度就存在这里，字段比 P3-1 多：

| 字段 | 说明 |
| --- | --- |
| `column` | 栏目标识，与文档 `_id` 相同 |
| `backfillDone` | 全量导入是否已完成；**只有整轮零失败才算完成**（有没取到的条目时为 `false`）。未完成而游标已在末页之后时不再重复请求，按 `missing` 提示用 `reset` 补齐 |
| `backfillPage` | 全量导入的下一个列表页（1-based）；校园动态读到第 126 页后收尾 |
| `pending` | 已读列表页、还没抓正文的条目（最多一页 10 条）；调用被中断时从这里续跑 |
| `pendingKind` | `pending` 属于哪一轮（`backfill` / `incremental`），只用于统计口径 |
| `round` | 当前一轮的累计计数与游标：`active`、`phase`、`page`、`pages`、`requests`、`inserted`、`updated`、`skipped`、`offsite`、`failed`、`failures`、`retried`（本轮已重试用过的条目 URL，同一轮内每篇至多重试一次） |
| `lockUntil` | 调用开始加锁、结束释放；未过期时新的调用直接跳过（定时消息可能被重复推送） |
| `lastAttemptAt` | 最后一次尝试时间（ISO 8601） |
| `lastRunAtLocal` | 最后一次运行时间（东八区可读文本，如 `2026-09-18 06:00:12 +08:00`） |
| `lastTrigger` / `lastTriggerName` | 最近一次调用来自 `timer` 还是 `manual`；定时触发记录触发器名 |
| `lastSuccessAt` | 最后一次**整批成功**同步时间；部分成功、全部失败、限速中断都不推进 |
| `lastOutcome` | `ok` / `partial` / `failed` / `running`（本轮没跑完）/ `rate-limited` |
| `lastError` | 最后一次失败摘要（最多留 10 条）＋缺失条目提示；整批成功时清空 |
| `lastRequestAt` | 最后一次页面请求的开始时间；下一次调用据此继续满足 1.3 秒间隔 |
| `rateLimitedAt` | 本栏目最近一次撞上官网限速 403 的时间；站点级另有一条记录（见下） |
| `missing` | 已知没取到的条目 URL（重试后仍失败，最多 200 条）；该条目成功写入后自动摘除，是「还差几条」的唯一来源 |
| `elapsedMs` | 最近一次调用自报耗时 |

**站点文档 `_id: "site"`**（字段 `rateLimitedAt`）：官网 WAF 冻结的是出口 IP，不区分栏目，所以冷却记在站点级。任一栏目撞上 403 时，主循环立即结束本轮、后续栏目的请求全部跳过，并写下这条记录；此后 30 分钟内**任何栏目**的调用都不发起请求。读取时取「站点记录 + 栏目记录」里更晚的一个，升级前写下的栏目级 `rateLimitedAt` 仍然生效。

写入方式：**每完成一次页面请求就整份覆盖写回**（`set`，显式列出上表字段，避免旧字段残留），因此调用被超时强杀时最多丢最后一次请求的进度，不会留下「条目已读、正文丢失」这类不一致状态；队列里缺 URL 的脏条目在读取时被丢弃，不会把整次同步卡在同一个坏条目上。

标识方式：每个栏目一条状态文档，用固定的 `_id`（`xyxw-xydt`、`tw-tqsd`）写入，另有站点文档 `site`。**该集合没有 `url` 字段，不需要 `url` 索引**；当前按 `_id` 直接读取，也不需要为 `column` 建索引。

失败保留旧数据：HTTP 失败、标题为空或正文为空均作为单篇失败，不覆盖该篇旧记录。日期缺失仍可入库；**文章页解析出的日期为空时保留记录里的旧日期**，否则旧记录会被空值覆盖、之后每次增量回看都因日期不一致而重抓同一篇。部分成功时只更新有效文章，`lastOutcome` 为 `partial`；全部失败为 `failed`；**仅整批成功才更新 `lastSuccessAt`**，分批导入没跑完时为 `running`。页面显示所展示文章中最新的 `updatedAt`，它表示文章写入时间，不保证整批同步成功（页面文案已按此改写为「本页条目最近一次写入」）。纯图片正文暂不入库，需按失败记录核查原文。

失败条目的重试与补齐：同一轮内每篇至多重试一次（失败后放回队尾），避免首次全量 1500 多次请求里偶发的 HTTP 抖动在库里留下永久空洞；重试仍失败就记进 `missing` 并不再重试。`failed` 计的是**失败次数**（一篇持续失败的条目在同一轮内最多计 2 次），失败摘要（URL + 原因，最多 10 条）留在 `sync_state.round.failures`。**全量列表读完但 `missing` 不为空时不算完成**：这些条目不会被自动重访，`resumeHint` 与收尾文案都会说明「还差 N 条」，用 `{"reset":true}` 重跑补齐（按原文 URL 幂等）。限速 403 不重试：条目留在队列里，本轮与冷却期内的后续调用都不再请求官网。

正文不在官网的条目（外链）：列表条目 URL 的域名不是 `lnc.edu.cn` 时**不抓正文**，只存标题、日期与原文链接（`paragraphs: []`）；官网页面 302 跳到域外（如 `mp.weixin.qq.com`）时同样不跟随跳转、不抓外链内容，计入本轮的 `offsite` 而不是失败。实测依据见 [官网资讯栏目与提取记录](news-sources.md) 的「通知公告类栏目」（教务处通知公告首条直接链到微信公众号）。

增量回看的取舍：增量轮里若已有记录的标题与日期与列表页一致且正文非空，就跳过正文抓取（省一次请求，让每日一次调用能覆盖最近 3 页的列表）。代价是**「官网只改正文、标题与日期都不变」的修改不会被发现**；标题或日期变化会重新抓取并按原文 URL 更新同一条记录。

## 同步云函数

已实现云函数 `newsSync`，职责：按栏目抓取官网列表 → 逐篇抓正文 → 解析 → 按 URL upsert → 把进度与结果写进 `sync_state`。

调用参数（控制台「测试」页传 JSON）：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `column` | `xyxw-xydt` / `tw-tqsd` | 只跑一个栏目；不传则按顺序跑两个栏目 |
| `mode` | `auto`（默认）/ `backfill` / `incremental` | `auto`：全量没完成就跑全量，完成后退化为回看最近 3 页 |
| `maxRequests` | 1–10，默认 10 | 本次调用允许的**页面请求数**（列表页与正文都算一次）；`limit` 是 P3-1 的旧参数名，含义已从「文章数」改为「请求数」，仍可用 |
| `reset` | `true` / 省略 | 显式要求重跑全量：把全量游标清回第 1 页、丢掉当前队列（写入仍按原文 URL 幂等，不会新增重复条目）。用于失败留下的空洞或解析规则修正后重跑；定时触发不会传它 |
| `Type` / `TriggerName` | 定时触发器自带 | 只用于记录触发来源，定时与手动走同一条同步路径 |

- **手动触发**：维护者在云开发控制台「测试」运行，或经 CLI 调用；用于首次导入与问题排查。
- **定时触发**：`cloudfunctions/newsSync/config.json` 声明 `newsSyncDaily`，cron `0 0 6 * * * *`，即**每天 06:00:00（触发器时区 UTC+8，见官方文档原文「触发器规则的时区为 UTC+8」）**。一个函数只支持一个触发器。函数权限 `newsSync: {"invoke": false}` 只拦客户端调用，定时触发器与管理端不受影响。
- 返回结果（供排查）：`ok`（**只表示本次调用没有失败**，不代表整批完成）、`batchComplete`、`backfillDone`、`missing`（还差几条）、`requestsUsed`、`totals`、`columns[]`（每栏目的阶段、已读页、计数、失败摘要、`missing`、`message`）、`runAt`、`timeZone`、`resumeHint`（未完成且有条目没取到时写明「还差 N 条、用 reset 补齐」）。
- 请求纪律：串行、相邻请求间隔 ≥1.3 秒（同站跳转也算一次请求、同样走这个间隔）、单次调用 ≤10 次页面请求；判定顺序是**先等够间隔、再判断本次调用的截止点、最后才发请求**，因此不会出现「检查时还没到点、发出去时已超时」。单批耗时上限按 20 秒 − 6 秒（单次请求最坏耗时）− 1 秒（数据库往返溢出）− 0.5 秒（收尾）= **12.5 秒**推导（见 `columns.ts` 的 `WORK_DEADLINE_MS`）；10 次请求按 1.3 秒间隔在第 11.7 秒发完，仍在截止点之内。
- 限速处理（**站点级**）：403/429 立即结束本轮并写下站点级 `rateLimitedAt`，同一轮里后续栏目一个请求都不再发；此后 30 分钟内任何栏目、任何调用都不发起请求，**不重试**（继续重试会延长官网冻结）。

首次全量导入的实际批数：正文请求与列表页共享同一份配额，校园动态 126 页 + 1252 篇正文 = 1378 次请求、团委通知公告 16 页 + 155 篇 = 171 次，合计 1549 次 ÷ 每批 10 次 ≈ **155 批**（票面的「约 15 批」只算了列表页，见「未决问题」）。分批进度落在 `sync_state`，中断后接着跑即可。

## 权限

规格要求：**普通客户端不能写公开内容，且无登录可看公开资讯**。

| 集合 | 客户端权限 | 配置方式 |
| --- | --- | --- |
| `news_articles` | 所有用户可读，任何客户端不可写 | **自定义安全规则** `{"read": true, "write": false}`；不要用预设「所有用户可读」，原因见下 |
| `sync_state` | 不对客户端开放 | 预设「所有用户不可读写」，或自定义规则 `{"read": false, "write": false}`；页面时间取文章 `updatedAt`。Ticket 04 起该集合还含站点文档 `site`（限速冷却），同样不对客户端开放 |

**为什么 `news_articles` 用自定义规则而不是预设**：控制台数据权限页明确提示「除自定义权限外，其他权限均不支持无登录态用户访问」。无登录态即官方文档中的[未登录模式](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/security-rules)（例如小程序被分享到朋友圈后以单页模式打开），此时 `auth` 为空，预设权限会拒绝读取。自定义规则 `{"read": true, "write": false}` 不引用 `auth`，登录与未登录两种情况都能读，符合规格「无登录可看公开资讯」。官方文档也建议用安全规则取代基础权限配置。预设与自定义规则的换算关系：预设「所有用户可读」等价于该 JSON，但缺少对无登录态的覆盖。

`sync_state` 保持私有，因为含 `lastError`。客户端使用文章记录的 `updatedAt`，不读取内部状态。

- 数据库权限分小程序端与管理端：**云函数端与控制台属管理端，拥有全部读写权限，不受安全规则限制**，因此写公开内容只发生在云函数内。依据：[数据库安全规则](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/security-rules)。
- 小程序端只读，绝不出现写公开内容的接口。

已完成的数据库配置（历史记录）：

1. 创建两个集合：`news_articles`、`sync_state`。
2. **只给 `news_articles.url` 建唯一索引**；`sync_state` 用固定 `_id` 标识，不需要索引。
3. 设置安全规则：`news_articles` 选「自定义安全规则」并填 `{"read": true, "write": false}`；`sync_state` 选「所有用户不可读写」。

**列表查询的索引（Ticket 02，2026-09-18）**：分页查询按 `date` 倒序、同日期补 `id` 倒序并带 `skip`。该组合排序已在开发者工具中实跑通过（读的是真实云数据库），但**尚未建组合索引**；数据量小（10 条）时无感知，扩大到官网 1252 条的规模前应补建 `date + id` 组合索引，避免深偏移查询随数据量变慢。建索引属控制台操作，与 Ticket 04 的扩大抓取一并处理。

历史验证位置：`docs/evidence/p2-p3/README.md`。

进度（2026-09-18）：两项配置均已按上表完成——`news_articles` 为自定义安全规则 `{"read": true, "write": false}`（已用客户端直写测试确认返回 `DATABASE_PERMISSION_DENIED`），`sync_state` 为「所有用户不可读写」；`news_articles.url` 唯一索引 `url_1` 已建成（`MgolsUnique: true`）。

## 解析逻辑与测试

解析器已迁至 `cloudfunctions/newsSync/parse.ts`，客户端不再引用；只维护这一份实现。两套模板（校园动态 `xyxw`、团委通知公告 `newsList`）由每条栏目记录选择，解析函数是 `parseList` / `parseArticle`。
`tests/news.test.cjs` 使用真实官网片段验证两套模板的解析（团委片段 2026-09-18 抓取，第 1 页 10 条标题与日期齐全；文章片段解析出 h2 标题、`div.property` 发布时间与 26 段正文），`tests/newsSync-flow.test.cjs` 在网络与数据库桩上运行真实云函数入口，覆盖分批配额与 1.3 秒间隔、跨批续跑、限速 403、增量回看、无效正文、整批失败、部分成功、外链条目与定时/手动触发。
`tests/newsSync.test.cjs` 将真实解析与入库输出交给真实客户端服务，检查列表、详情及时间字段；不是仅对照手写字段清单。

## 凭据

- AI 密钥（P5）等一律放云函数的环境变量，由云开发控制台注入；不进 Git、不进小程序包、不写入数据库。ADR-0001 明确「微信前端不保存模型密钥」。
- 环境 ID 不是密钥，可以入库。

## AI 云函数（Ticket 01：统一调用入口、内容安全、用量与成本上限）

**状态（2026-09-19 更新）**：函数代码、桩测试与构建布局检查已完成并本地通过（`cloudfunctions/ai/`，逐项见 [Ticket 01](tasks/tickets/01-ai-foundation.md)）。**两轴代码复核（Standards + Spec）提出的问题已在本轮修复**：月度累加不再被写失败覆盖、「是否有过检测」用 `checked` 明确标出、内容安全与云存储下载都有硬超时、402 与 429 分开、输入检测覆盖全部消息角色且长文本逐段检。**云端侧（2026-09-19）**：函数已部署、两个用量集合与模型环境变量已配；微信内容安全探测在**小程序端**跑通（两条接口 `errcode 0`，记录见下「微信内容安全探测记录」）；**超时已改到 20 秒且端到端已跑通**——`npm run smoke:ai` 返回 `ok=true`、模型输出「链路已通」、`elapsedMs=4600`，用时超过 3 秒而未被截断，故 20 秒配置确实生效（原始输出见 [Ticket 01 端到端冒烟记录](evidence/p5-foundation/README.md)）。**数据库侧无密钥外泄**：控制台抽查 `ai_usage_records` 真实记录只有用量字段；**云函数内存核实为 256MB**（日志 `Memory: 256MB MemUsage: 37.4MB`）。**2026-09-19 复测更正**：步骤 F（月度上限拦截）已由负责人确认完成；**`vision`（图片路径）真实调用经独立复测未通过**——三张真实课表截图 + 一张 570 字节合成小图全部在 8000ms 处超时（`failureClass=model_unavailable`、`AI_VISION_MODEL=qwen/qwen3.8-flash`），文本 `chat` 同时正常。复测入口 `npm run smoke:ai:vision`，候选修复与判据见本节「Ticket 01 人工步骤」。

这一层是 05（课表截图识别）、06（课表助手）、07（部门问答）的共同前置：三处都只调这一个函数，避免各自重复实现「调模型 + 过内容安全 + 失败降级」。**本票不实现三个 AI 功能本身。**

### 动作与调用契约

云函数名 `ai`。事件与返回的字段就是 05/06/07 要依赖的接口，改动等于改动三处调用方。

| 事件字段 | 取值 | 说明 |
| --- | --- | --- |
| `action` | `chat` / `vision` / `moderateText` / `moderateImage` / `usage` / `probe` | 必填 |
| `feature` | 如 `department-qa`、`timetable-screenshot`、`timetable-assistant` | 只用于记账与统计，未知值不影响调用 |
| `system` | string | 系统提示词（可选）；**同样要过内容安全**（属于调用方送进来的文本） |
| `messages` | `[{"role":"user"｜"assistant"｜"system","text":"..."}]` | 非空数组、最多 20 条；`role` 必填且只接受这三个值（写错返回 `invalid_request`，不会默认当成 `user`）；`content` 可作 `text` 的别名；单条 ≤8000 字 |
| `text` | string | `moderateText` 用；按 2000 字窗口逐段检测（最多 2 万字），超出部分在报告里写明并置 `checked: false` |
| `image` | `{"fileID":"cloud://..."}` 或 `{"base64":"...","mimeType":"image/png"}` | `vision` / `moderateImage` 用；只接受 PNG / JPG，默认上限 1MB。**格式不再靠猜**：fileID 的扩展名认不出、base64 没给 `mimeType` 都返回 `invalid_request`。客户端走 fileID：`wx.cloud.uploadFile` 返回的 `cloud://…` 才叫 fileID，`prepareUpload` 给的裸 cloudPath 不是（传裸路径会被 `downloadFile` 拒绝） |
| `maxTokens` / `timeoutMs` | number | 可选覆盖；`timeoutMs` 仍受环境变量上限约束 |

返回形状所有动作统一，调用方只需要看前三个字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 是否完成。**入口不抛异常**：中转挂掉、超时、参数写错都返回 `false` |
| `failureClass` | `model_unavailable` / `content_rejected` / `quota_exhausted` / `invalid_request` / `internal`；成功为空串 |
| `message` | 用户可见文案；**成功时为空串**（`usage` 的上限告警在 `capWarning`，`probe` 的结论在 `message` 与 `probe.conclusion`） |
| `text` | `chat` / `vision` 成功时的模型输出 |
| `detail` | 维护者排查细节（密钥已剔除） |
| `usage` / `usageSummary` / `capWarning` | 本次用量 / 当月累计 / 接近上限的告警 |
| `safety` / `probe` / `warnings` | 检测结论（含 `checked`）/ 探测记录 / 非致命告警（如记账失败、`checked=false`） |

`usage` 动作只读不拦（已超上限也要能查），其余动作的执行顺序是：

**读当月用量 → 月度上限判定 → 输入内容安全 → 模型调用 → 输出内容安全**。
`vision` 的输入检测**先图后文**（图片先过 `imgSecCheck` 再送模型）；`moderateText` / `moderateImage` 也先判上限再检测。
超上限时一次外部请求都不发（连内容检测都不发）；图片被拒时不会送模型（Ticket 05 的硬要求）。

**超时边界**：模型调用、第三方审核、**微信云调用与云存储下载**都有硬超时（见环境变量表），
任一步超时都在 `AI_TOTAL_DEADLINE_MS` 之内以可识别的失败结束，不会无限挂起。
其中检测类调用超时归入「模型不可用或超时」（可重试），与配置/权限类的 `internal` 区分开。

### 数据模型（两个新集合）

| 集合 | 内容 | 客户端权限 |
| --- | --- | --- |
| `ai_usage_records` | 每次子调用一条：`requestId`、`feature`、`kind`（`model` / `moderation`）、`provider`、`model`、`ok`、`failureClass`、`durationMs`、`promptTokens`、`completionTokens`、`totalTokens`、`estimated`、`usageUnknown`、`costYuan`、`month`、`createdAt` | 不对客户端开放（预设「所有用户不可读写」） |
| `ai_usage_monthly` | 每月一条文档（`_id` 为东八区月份，如 `2026-09`）：`calls`、`failures`、三种 token 合计、`costYuan`、`updatedAt`；用原子自增累加 | 不对客户端开放 |

- `usage` 动作、上限判定都读 `ai_usage_monthly`；读不到用量（数据库故障）时**拒绝调用**而不是当作零——上限判断不能因为读失败而失效。只有「文档不存在」（当月首次调用）才按零处理。
- **月度汇总只允许两种写法**：原子自增，或当月文档不存在时用固定 `_id` 插入初值。写失败（非「文档不存在」）一律**向上抛出并记为可处理的记账失败**（返回值 `warnings` 里能看到），绝不回退成覆盖式写入——那会把当月累计冲成单次调用的数字，使成本上限失效。首次插入用月份作 `_id`：并发下只有一个能插入，另一个回到自增，因此不会各写一份丢计数。
- 服务端不返回 usage 时按字符数估算（中文 1 token/字、英文 4 字符/token，图片按固定常数），并标记 `estimated: true`；不估算等于把成本记成 0。
- **接口根本不返回用量时**（OpenAI `/moderations`）既不算 0 元也不编 token 数：记录里 `usageUnknown: true`、`totalTokens: 0`，金额按 `AI_SAFETY_CALL_PRICE_YUAN`（每次审核固定价，默认 0 表示不计入）计，返回值 `warnings` 写明这一次是怎么记的。
- 两个集合需要人工在控制台创建（见人工步骤 B），索引暂无需要：按 `_id` 直读、记录集合只写不查。

### 环境变量（密钥只在这里）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `openai` | 模型接口格式：`openai`（本项目的中转）/ `anthropic` |
| `AI_BASE_URL` | 无（必填） | OpenAI 兼容接口根地址，**中转的实际地址以服务商为准** |
| `AI_API_KEY` | 无（必填） | 模型密钥；不写进代码、数据库、小程序包与文档 |
| `AI_MODEL` | 无（必填） | 文本模型名；**中转的模型名未实测**（AI 资讯实测用的是官方 `deepseek-flash`），按服务商实际值填 |
| `AI_VISION_MODEL` | 取 `AI_MODEL` | 多模态模型名 |
| `AI_ANTHROPIC_BASE_URL` / `AI_ANTHROPIC_API_KEY` / `AI_ANTHROPIC_VERSION` | `https://api.anthropic.com` / 无 / `2023-06-01` | 走 Anthropic 格式时需要 |
| `AI_TIMEOUT_MS` | `8000` | 单次模型调用超时（毫秒），必须 ≤ `AI_TOTAL_DEADLINE_MS` |
| `AI_TOTAL_DEADLINE_MS` | `15000` | 一次云函数调用的总截止；模型、内容安全、云存储下载都受它约束，**必须小于云函数超时时间**（部署时按 20 秒设置） |
| `AI_DOWNLOAD_TIMEOUT_MS` | `5000` | 云存储下载（`vision` 的 fileID 路径）单次超时；下载同样会一直不返回，超时归入「模型不可用或超时」 |
| `AI_MAX_TOKENS` / `AI_TEMPERATURE` | `1024` / `0.2` | 默认生成参数 |
| `AI_EXTRA_BODY_JSON` | 空 | 追加进请求体的 JSON，如关闭思考模式：`{"chat_template_kwargs":{"thinking":false}}`（AI 资讯实测记录该模型默认开启思考、输出 token 偏高，未测关闭后的降幅） |
| `AI_PRICE_INPUT_PER_MILLION` / `AI_PRICE_OUTPUT_PER_MILLION` | `1` / `4` | 单价（元/百万 token）。默认值是实测的 DeepSeek **官方**空闲时段价（不是中转价）；**中转的实际单价未实测**，请按实际单价配置，否则上限判断偏低 |
| `AI_MONTHLY_CAP_YUAN` | `50` | 月度成本上限（规格定案值）；达到即拒绝调用 |
| `AI_CAP_WARN_RATIO` | `0.8` | 告警线比例：达到 `上限 × 比例` 起在返回值里带 `capWarning`，但不拦 |
| `AI_MODERATE_OUTPUT` | `true` | 是否对模型输出做内容安全检测 |
| `AI_MAX_IMAGE_BYTES` | `1048576` | 图片大小上限；默认与微信 `imgSecCheck` 的 1MB 限制对齐，Ticket 05 的截图需先压缩 |
| `AI_SAFETY_PROVIDER` | `wechat` | 内容安全适配器：`wechat` / `openai` / `anthropic` / `off`。**`off` 是仅开发与排障使用的逃生口，生产不得使用**（规格把「AI 文字与用户图片都要过内容安全」列为硬约束）；用它时报告 `checked:false` 并进 `warnings` |
| `AI_SAFETY_FAIL_MODE` | `closed` | 检测服务不可用时：`closed` 拒绝调用（默认）/ `open` 放行并在报告里写明「未检测」且 `checked:false`。**`open` 同样仅限开发与排障，生产不得使用** |
| `AI_SAFETY_REVIEW_AS` | `reject` | 微信 `suggest=review`（需人工复审）的处置：默认按拒绝 |
| `AI_SAFETY_OPENAI_MODE` | `chat` | 第三方审核的调用方式：`chat`（用审核提示词，任何兼容中转可用）/ `moderations`（走 OpenAI 官方 `/moderations` 接口读 `results[0].flagged`）。**接口格式由 `AI_SAFETY_PROVIDER` 决定**（选 `anthropic` 就用 Anthropic 格式），没有单独的 `AI_SAFETY_FORMAT` 开关 |
| `AI_SAFETY_BASE_URL` / `AI_SAFETY_API_KEY` / `AI_SAFETY_MODEL` | 取模型配置 | 第三方审核的地址、密钥、模型（默认复用模型配置） |
| `AI_SAFETY_TIMEOUT_MS` | `6000` | **访问微信云调用与第三方审核的单次超时**（毫秒）；第三方审核另有一层同值 +1 秒的兜底定时器。超时归入「模型不可用或超时」（可重试） |
| `AI_SAFETY_CALL_PRICE_YUAN` | `0` | 每次审核调用的固定价（元）：接口不返回 token 用量时（`/moderations`）按它记账；`0` 表示不计入金额，但记录会带 `usageUnknown: true` 且返回值有告警 |
| `AI_SAFETY_MAX_TOKENS` / `AI_SAFETY_SCENE` | `256` / `1` | 审核最大输出 token、微信 `msgSecCheck` 的 scene（1 资料 / 2 评论 / 3 论坛 / 4 社交日志） |
| `AI_MSG_MODEL_UNAVAILABLE` / `AI_MSG_CONTENT_REJECTED` / `AI_MSG_CONTENT_REJECTED_IMAGE` / `AI_MSG_QUOTA_EXHAUSTED` / `AI_MSG_INVALID_REQUEST` / `AI_MSG_INTERNAL` | 见下表 | 覆盖用户可见文案，**改措辞不用改代码**；`AI_MSG_CONTENT_REJECTED_IMAGE` 只覆盖「用户上传的图片被拒」这一种输入（05 截图路径），缺省时不回落到图片专属文案而是用 `AI_MSG_CONTENT_REJECTED` |

### 失败分类与默认文案

三类是开发规格要求「可区分、各自独立、不合并成一句」的失败；后两类是调用方与内部错误，同样各自成句。

| `failureClass` | 默认文案（可被上表环境变量覆盖） | 触发条件 |
| --- | --- | --- |
| `model_unavailable` | AI 模型暂时不可用或响应超时，请稍后重试；已保存的课表与部门资料仍可正常查看。 | 连接失败、超时（模型 / 内容安全 / 云存储下载都算）、5xx、鉴权失败、返回非 JSON 或空内容、**429 瞬时限流** |
| `content_rejected` | 文字：内容未通过安全检测，请修改后重试。／图片（`vision` / `moderateImage` 的输入图被拒）：这张图片没有通过内容安全检测，请换一张再试。 | 输入或输出被内容安全适配器判为违规（`risky` / `87014` / `flagged` / `allowed=false`）。**文案按输入类型区分**：文字有「改一改再试」的余地，图片只能换一张；两句话各自独立，可分别用 `AI_MSG_CONTENT_REJECTED` / `AI_MSG_CONTENT_REJECTED_IMAGE` 覆盖 |
| `quota_exhausted` | 本月 AI 使用额度已用尽，暂时无法使用 AI 功能，请下月再试或联系维护者。 | 当月累计成本 ≥ `AI_MONTHLY_CAP_YUAN`，或模型服务返回 **402**（服务商额度/余额不足） |
| `invalid_request` | AI 请求参数不正确，请重试；若反复出现请联系维护者。 | 动作、消息角色、图片参数不合法（含图片超限、格式不支持、格式无法判断） |
| `internal` | AI 服务内部错误，请稍后重试。 | 配置缺失、用量读不到、内容安全检测不可用（fail closed，配置/权限类原因）等 |

**默认文案是可供负责人修改的默认值**，改法见上一节的环境变量；三者不得合并成一句（有测试锁定）。
**429 与 402 必须分开**：429 是瞬时限流（可重试），说成「本月额度已用尽，请下月再试」会让用户白等一个月；只有 402 才归「额度或配额用尽」。

### 内容安全适配层

- **文字与图片是两个独立入口**（`checkText` / `checkImage`）：微信侧本就是 `security.msgSecCheck` 与 `security.imgSecCheck` 两个云调用，第三方侧的请求体也不同。
- **检查范围**：`chat` / `vision` 会检**调用方送进来的全部文字**——事件顶层 `system`、每条消息（user / assistant / **system**）以及 `vision` 的图片，外加模型输出（`AI_MODERATE_OUTPUT`）。长文本按 2000 字窗口逐段送检（最多 10 段 = 2 万字）；仍超出时**只检前 2 万字并在报告里写明范围、置 `checked: false`**，不静默放过。
- **`checked` 与 `passed` 是两件事**：`passed: true` 只表示「检过的范围内没发现问题」，`checked: false` 表示这次**没有真正检测**（`AI_SAFETY_PROVIDER=off`、`AI_SAFETY_FAIL_MODE=open` 放行未检内容、或长文本只检了前一段）。`checked: false` 时返回值同时会带一条 `warnings`，调用方与日志都不得把「跳过」读成「干净」。
- **微信为主**：拿到调用上下文 openid 时用 `msgSecCheck` v2（带 `version: 2`、`scene`、`openid`，判 `result.suggest`）；没有 openid 退回 v1 形态，判 `errcode`。违规可能以 `errcode 87014` 返回或抛出，两者都按违规处理。**2026-09-19 从小程序端实测：v2 形态下两条接口都返回 `errcode 0`**（记录见探测记录表）。
- **云调用必须由小程序端触发（2026-09-19 实测到反例）**：云调用要求调用方带上小程序侧的票据；控制台「测试」页、CLI、HTTP 触发、云函数互调都拿不到它，**必然**返回 `-501001`（CloudBase `INVALID_WX_ACCESS_TOKEN`，官方口径原文「云调用鉴权失败，未从小程序端触发使用云调用的云函数」）。因此**凡是要过内容安全的动作（`probe` / `chat` / `vision` / `moderateText` / `moderateImage`）都不能用控制台「测试」页验证**——那样测出的是触发方式不对，不是接口不可用；`usage` 不碰内容安全，控制台与小程序端都可测。小程序端的执行入口：`npm run probe:wechat`（探测）、`npm run smoke:ai`（文本端到端）、`npm run smoke:ai:vision`（图片路径端到端）。
- **内容安全接口有每日调用配额，未上架期间只有 100 次/天（2026-09-19 查官方口径并实测撞到上限）**：官方文档写「单个 appId 调用上限为 4000 次/分钟、2,000,000 次/天；**若为未上架小程序，调用上限为 100 次/天**」（[security.msgSecCheck](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html)）。**本项目当前未认证、未备案、未发布 ⇒ 日上限是 100 次**，一次 AI 调用至少消耗 1 次文本检测，开启输出检测时还要再加（长文本按 2000 字分片、最多 10 片）；`msgSecCheck` 与 `imgSecCheck` 的配额**各自计算**（实测：文本报 45009 时图片仍 `errcode 0`）。默认 `AI_SAFETY_FAIL_MODE=closed` 下配额用尽会**直接拒绝当天所有 AI 调用**（问答 / 助手 / 识图全挂，次日恢复）——**排障时先看有没有 45009，不要往模型或密钥方向找**。三种应对：① 等次日恢复（默认）；② 官方排错指南提到 `clear_quota` 接口可清空当日次数（需 access_token，**本项目未验证**是否适用于云调用与未上架小程序，谨慎）；③ 排障期临时 `AI_SAFETY_FAIL_MODE=open`（仅开发排障、生产不得使用，测完立刻改回 `closed`）。**不要**为省配额去关 `AI_MODERATE_OUTPUT`——「AI 输出也要过内容安全」是硬约束。发布上线后配额自动放大到 4000/分钟、200 万/天，**所以这条只在上架前影响我们：演示当天要按 100 次倒排脚本**。
- **云调用权限**：函数目录 `config.json` 声明了 `permissions.openapi`（`security.msgSecCheck`、`security.imgSecCheck`），随函数上传；官方文档口径是缺声明会返回 48001。**2026-09-19 间接实测**：小程序端探测拿到 `errcode 0`，说明随函数上传的声明已生效（否则按官方口径会返回 48001）。
- **第三方**：`AI_SAFETY_PROVIDER=openai` / `anthropic` 时，用对应接口格式调一个「审核判定」提示词，读回 `{"allowed":bool,"reason":"..."}`；`AI_SAFETY_OPENAI_MODE=moderations` 时改走 OpenAI 官方 `/moderations` 接口读 `results[0].flagged`。**该做法是 Ticket 01 的实现选择**（见票面「决策」），要换成别的第三方审核服务时只需新增一个适配器分支。
- **不可用 / 超时的处置**：默认 fail closed（拒绝调用），避免未检测内容上屏。原因不同、分类也不同：
  - **超时**（微信云调用、第三方审核、云存储下载）→ `model_unavailable`（可重试，与模型超时同类）；
  - **配置 / 权限 / 协议类不可用**（如 `cloud.openapi.security` 缺失、48001、判定 JSON 解析不了）→ `internal`（要改配置）；
  - **`AI_SAFETY_FAIL_MODE=open`** → 放行，但报告 `checked: false`、`detail` 写明「未检测」，并进 `warnings`。
    该开关与 `AI_SAFETY_PROVIDER=off` 都是**仅限开发与排障的逃生口，生产不得使用**：规格把「AI 生成的文字与用户上传的图片都要过内容安全检测」列为硬约束，发布前必须确认这两项是默认值（`wechat` / `closed`）。
- 违规判定与「检测失败」在返回值里区分：违规是 `content_rejected`，检测服务本身出错是 `internal` / `model_unavailable`（或按 fail-open 放行并注明 `checked: false`）。

<a id="微信内容安全探测记录"></a>

### 微信内容安全探测记录（**已回填 2026-09-19**）

未认证小程序能否调用官方内容安全云调用，是本票要探明的第一件事。探测动作 `{"action":"probe"}` 用**固定良性文本**与一个现场生成的 8×8 PNG 各调一次接口，把 errcode/errmsg 原样记下来；**不发违规文本**（那是刻意不做的事，违规路径由错误码表与桩测试覆盖）。

| 探测时间（UTC+8） | 环境 ID | 是否带 openid | `security.msgSecCheck` | `security.imgSecCheck` | 结论 | 建议适配器 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19 01:26 | `cloudbase-d2gjtbbwu3575cd7b` | 否（控制台「测试」页触发） | `-501001` invalid wx openapi access_token | `-501001` invalid wx openapi access_token | **无效测量**：云调用未从小程序端触发，接口可用性没被测到（`probe.valid: false`） | 不切换（无效测量不改默认） |
| 2026-09-19 01:35 | `cloudbase-d2gjtbbwu3575cd7b` | 是（小程序端，v2 形态） | `errcode 0`（544ms） | `errcode 0`（458ms） | **可调用**：文本与图片两条路径都通 | `wechat`（保持默认） |

第二行（有效测量）粘贴进文档的原始记录：

```json
{"probedAt":"2026-09-18T17:35:47.421Z","timeZone":"Asia/Shanghai（UTC+8）","env":"cloudbase-d2gjtbbwu3575cd7b","openidPresent":true,"declaredOpenApi":["security.msgSecCheck","security.imgSecCheck"],"checks":[{"api":"security.msgSecCheck","form":"v2（带 openid）","errCode":0,"errMsg":"openapi.security.msgSecCheck:ok","verdict":"pass","note":"调用成功","elapsedMs":544},{"api":"security.imgSecCheck","form":"v2（带 openid）","errCode":0,"errMsg":"openapi.security.imgSecCheck:ok","verdict":"pass","note":"调用成功","elapsedMs":458}],"valid":true,"invalidReason":"","conclusion":"微信官方内容安全接口可调用（文本与图片均返回 errcode 0）：保持 AI_SAFETY_PROVIDER=wechat（默认）。","recommendedProvider":"wechat"}
```

**怎么读这两行**：`probe.valid` 与 `ok` 必须分开看。第一行 `ok: false` 且 `valid: false`——它**不是**「接口不可用」的证据，而是「这次调用怎么发起的」不对；只有 `valid: true` 时 `ok: false`（或部分可用）才轮到切换适配器。第一行也说明了为什么探测动作需要一个小程序端入口。

常见错误码的含义：`0` 成功；`87014` 内容违规；`48001` / `48002` 接口未授权或被禁（**未认证小程序是否必然返回它们仍未验证**，本次没碰到）；**`45009` 当日调用配额用尽（2026-09-19 实测：文本接口报它时图片接口仍正常，两个接口配额各自计算，次日恢复；默认 fail-closed 会拒绝当天所有 AI 调用）**——**这条自 2026-09-19 起归 `quota_exhausted`**（文案 `AI_MSG_QUOTA_EXHAUSTED_SAFETY`，与月度成本上限的「下月再试」分开），修复前它被归成 `internal`、页面显示「AI 服务内部错误，请稍后重试」；**该修复需重新部署 `ai` 才生效**；`61010` v2 需要 openid 近期访问过小程序；`40001` access_token 相关问题；**`-501001` / `-501007`（以 `-5` 开头的是云开发平台码，不是微信开放接口码）表示「本次调用没有小程序侧云调用票据」**，即不是从小程序端触发的——控制台、CLI、HTTP 触发、云函数互调都会踩到，属于无效测量。探测会把「是否超时」也记进 `note`（接口不响应时按调用超时记录，不会挂住）。

**切换方式**：探测结论为**有效**且显示不可用或部分可用时，在云函数环境变量里把 `AI_SAFETY_PROVIDER` 改为 `openai` 或 `anthropic`，并按需配置 `AI_SAFETY_BASE_URL` / `AI_SAFETY_API_KEY` / `AI_SAFETY_MODEL`；改完重跑一次探测与一次 `chat`（都在小程序端），确认返回值里 `safety.provider` 变成第三方。**本轮实测微信官方接口可用，默认值 `wechat` 保持不变，暂不需要第三方审核密钥。**

<a id="ticket-01-人工步骤"></a>

### Ticket 01 人工步骤（动作 / 对象 / 判据）

**2026-09-19 进展**：A（部署）、B（集合 + 环境变量）、C（超时改成 20 秒并被 4600ms 的端到端调用证明生效）、D（探测，已回填上表）与 E（端到端 + 密钥外泄检查）均已完成；**内存已核实为 256MB**（控制台日志 `Memory: 256MB MemUsage: 37.4MB`，记录在步骤 C）。**步骤 F（月度上限拦截实测）已由负责人确认完成**。**步骤 G（`vision` 路径真实调用）**分两步：① 负责人加上 `AI_EXTRA_BODY_JSON={"chat_template_kwargs":{"thinking":false}}` 与 `AI_TIMEOUT_MS=13000` 之后，**合成小图的链路冒烟通过**（`npm run smoke:ai:vision`：`ok=true`、`elapsedMs=9978`、模型返回合法 JSON、内容安全 `checked=true`）——**模型确实支持图片输入**，「模型名不支持视觉」的猜测不成立；② **但真实课表截图仍失败**，新的读数是 `detail=模型调用超时：请求超时（11417ms）`。四种输入对照（570 字节小图通过、真实截图只问一列超时、真实截图缩到 1000px 宽同样超时、真实截图两门课约 11 秒通过）说明**卡的是固定时延，与图片大小、输出长度都无关**。
**三个数已由负责人调到 60 / 50000 / 40000（`cli cloud functions info` 读回 `timeout=60`），但真实截图仍然不够**：模型拿到 40000ms 预算仍未返回（`elapsedMs=43336`、`detail=模型调用超时：请求超时（40000ms）`）。单独量的模型画像：**固定开销约 11 秒、吞吐约 86 token/秒、每门课约 300 个完成 token**，据此外推 45 门课的完整课表需要 170 秒以上（压到最紧凑格式也仍有 80–90 秒），**超过 60 秒的云函数上限 ⇒ 一次调用识别整张表在当前模型上不成立**。另外发现压缩输出格式并不降低完成 token（正文约 500 token 而完成 token 2571），符合「模型仍在输出思考内容、且计入 completionTokens」的表现，**说明先前那次「关思考」很可能没生效**（Qwen3 系的标准开关名是 `enable_thinking`，配置里写的是 `thinking`）。注意客户端 `VISION_MAX_TOKENS=2048` 对完整课表偏小，第一次拿到完整结果时要检查是否被截断。

**2026-09-19 第四轮：分带并行识别（`bands: 'auto'`，分支 `feat/vision-banded-recognition`）**。既然一次调用不成立，改成**按节次切带、并行多次调用**：带数不写死，由服务端按画像与自己的超时预算算（当前配置下 6 带 / 每带 2 节 / 每带预计约 39 秒）。**这一步不需要新的环境变量**，但**重新部署 `ai` 是必须的**（代码在云函数里）：

```powershell
npm run build
& "<开发者工具目录>\cli.bat" cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <仓库>/dist
# 或在开发者工具里右键 dist/cloudfunctions/ai →「上传并部署：云端安装依赖」
```

复测按顺序、省着用配额（判据见 [P5-B 验证记录](evidence/p5-b/README.md#2026-09-19-第四轮改为服务端分带并行识别把不可能的一次调用拆成可行的多带)）：

```powershell
npm run smoke:ai:vision                   # ① 单带小图，确认原路径没被改坏
npm run smoke:ai:vision -- --bands=auto    # ② 分带小图，确认并发没被中转拒（告警里会出现「分带识别：按节次分 N 带并行调用」）
```

**图片与输入文字仍各只过一次内容安全**：分带只在服务端调用模型，不放大 `imgSecCheck`/`msgSecCheck` 的次数（配额是硬约束，客户端切块才会按块翻倍）。**仍然建议把 `AI_EXTRA_BODY_JSON` 换成 `{"chat_template_kwargs":{"enable_thinking":false}}`**：关掉思考后每门课的完成 token 大幅下降，`bands: 'auto'` 会自动少切几带——两者互补，不互斥。

**步骤 A：部署 `ai` 云函数**（**已完成**：2026-09-18 首次部署，2026-09-19 本轮把修复版重新部署，11 个文件 / 42.4 KB）

- **动作**：`npm run build` 后在开发者工具里右键 `dist/cloudfunctions/ai` →「上传并部署：云端安装依赖」（或 `cli.bat cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <仓库>/dist`）。
- **对象**：云函数 `ai`（依赖只有 `wx-server-sdk@4.0.2`）。
- **判据**：`cli cloud functions info` 读回 `ai` 为 `Active` / `Nodejs16.13`；函数目录含 `index.js`、`package.json`、`config.json`（`config.json` 里的 `permissions.openapi` 是微信云调用的权限声明，必须随目录上传）。

**步骤 B：建集合、配环境变量**（**已完成**）

- **动作**：控制台「数据库」新建 `ai_usage_records` 与 `ai_usage_monthly`，权限都选「所有用户不可读写」；再到「云函数 → ai → 配置 → 环境变量」逐项填密钥与地址（密钥只在控制台粘贴，不写进仓库或文档）。
- **对象**：两个集合；`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_VISION_MODEL`、`AI_PRICE_*`、`AI_MONTHLY_CAP_YUAN`。
- **判据**：运行 `{"action":"usage"}`（控制台「测试」页即可，它不碰内容安全）返回 `ok: true`，`usageSummary.capYuan` 为 50、`month` 为当前东八区月份、返回里不出现密钥。**只配密钥不够**：单价必须按中转实际价格填，否则成本上限偏低。本轮实测：`capYuan: 50`、告警线 40、`AI_PRICE_*` = 0.25 元/百万 token（不同于代码默认值 1 / 4，说明确实按中转价格配过）。

**步骤 C：确认云函数超时与内存**（**已完成，2026-09-19**）

- **动作**：控制台把 `ai` 的超时时间设为 **20 秒**（`newsSync` 已这么设，照做；默认 3 秒会截断模型调用）。CLI 没有超时参数，只能在控制台做。
- **对象**：云函数 `ai` 的函数配置。
- **判据**：`cli cloud functions info` 读回 `ai` 的 timeout 为 20；随后 `npm run smoke:ai` 端到端成功（`ok: true` 且 `text` 非空），且 `elapsedMs` 明显小于 20000（`AI_TOTAL_DEADLINE_MS` 默认 15 秒必须小于函数超时）。
- **内存判据（2026-09-19 已核实）**：控制台函数日志出现 `Report RequestId: … Duration: 1ms Memory: 256MB MemUsage: 37.4MB`（`timetable` 函数的日志行，同环境函数配置一致）→ 记为 **256MB**。
- **实测证据**：3 秒时 `npm run smoke:ai` 返回 `cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds`；2026-09-19 改成 20 秒后同一条冒烟返回 `ok=true`、`elapsedMs=4600`、模型输出「链路已通」（原始输出见 [Ticket 01 端到端冒烟记录](evidence/p5-foundation/README.md)）。

**步骤 D：跑微信内容安全探测并回填上表**（**已完成**，2026-09-19）

- **动作**：**从小程序端**跑 `npm run probe:wechat`（前置：`cli auto --project <仓库>/dist --auto-port 9420 --trust-project` 已打开项目），把输出里那一行 JSON 粘贴到上表。**不要用控制台「测试」页**——云调用拿不到小程序侧票据，必然返回 `-501001`，那是无效测量。
- **对象**：`probe.checks[]` 两条（`security.msgSecCheck`、`security.imgSecCheck`）与 `probe.valid` / `probe.conclusion` / `probe.recommendedProvider`。
- **判据**：`probe.valid` 为 `true`；两条都带 `errCode` / `errMsg` / `note`；`errcode 0` 表示该接口可调用；出现 `48001` / `48002` 时才按上面的「切换方式」改 `AI_SAFETY_PROVIDER` 后重跑探测与一次 `chat`（原因是不是「未认证」要由这次探测结论确认，不要先当成事实）。**这条结论必须落到本表**，否则 05/06/07 的内容安全路径没有依据。

**步骤 E：端到端验证一次，并检查密钥外泄**（**已完成，2026-09-19**）

- **动作**：**从小程序端**跑 `npm run smoke:ai`（它发一句「只回复四个字：链路已通」）；随后读 `ai_usage_records` / `ai_usage_monthly`，并在开发者工具里检查小程序包（`dist` 下 `cloudfunctions/` 之外的 `.js`）与数据库内容。内容安全适配器为 `wechat` 时不能用控制台「测试」页跑 `chat`（见上文「云调用必须由小程序端触发」）。
- **对象**：一次真实模型调用；两个用量集合；小程序包；数据库。
- **判据**：返回值 `ok: true` 且 `text` 非空；`ai_usage_records` 新增一条 `kind: "model"`、`ok: true` 的记录并带耗时与 token；`ai_usage_monthly` 的 `calls` 与 `costYuan` 增加；小程序包里搜不到密钥字符串；数据库里搜不到密钥字符串。**这是票面「端到端验证：一句测试文本经模型返回结果，全过程无密钥外泄」的唯一证据来源。**
- **2026-09-19 实测**：`npm run smoke:ai` 返回 `ok: true`、模型输出「链路已通」；控制台抽查 `ai_usage_records` 一条真实记录，字段为 `_id / action / completionTokens / costYuan / createdAt / durationMs / estimated / failureClass / feature / kind / model / month / ok / promptTokens`，**没有密钥字段也搜不到密钥值**；小程序包一侧由 `tests/ai-bundle.test.cjs` 断言不含密钥。

**步骤 F：核对月度上限真的会拦**（**仍未执行**）

- **动作**：把 `AI_MONTHLY_CAP_YUAN` 临时改成一个小于当月已花金额的值，再跑一次 `chat`（小程序端），然后把上限改回 50。
- **对象**：上限判定路径。
- **判据**：返回 `failureClass: "quota_exhausted"`，`message` 是额度类文案（与「模型不可用」「内容被拒」不同句），且这一次没有发起模型请求（`ai_usage_records` 不新增 `kind: "model"` 记录）。

### 已知限制与未决问题（Ticket 01）

- **中转的模型名与单价未核实**：AI 资讯实测用的是 DeepSeek **官方** API（`deepseek-flash`），中转（CommandCode）的接口地址、模型名与价格**没有公开依据**，因此 `AI_MODEL` / `AI_PRICE_*` 没有代码默认值，必须由维护者按服务商实际值配置。选型已验证的部分只有「该模型支持多模态、延迟约 164ms、43 次调用约 0.13 元」，**这是官方 API 的实测，不是中转的实测**。
- **中转接口格式已实测（2026-09-19）**：端到端冒烟以 `provider=openai`、`model=deepseek/deepseek-v4.1-flash` 真实调通，OpenAI 兼容形态成立（原始输出见 [Ticket 01 端到端冒烟记录](evidence/p5-foundation/README.md)）。**仍未核实的是单价**：本次 105 token 记为 0.000026 元，说明生效的是环境变量里配置的 0.25 元/百万 token；这个价格是否等于中转的真实计费必须联调核对——**单价填低，50 元上限就形同虚设**。
- **成本量级参考**：按实测的官方单价，50 元约合 1.6 万次调用；走中转的实际价格可能不同，上限按实际单价判断。
- **月度首次写入不再有竞态**：当月文档用固定 `_id`（月份）插入初值，并发下只有一个能插入，另一个回到原子自增；`update` 的其它失败一律抛出并记为可处理的记账失败，**不会**回退成覆盖式写入（否则会把当月累计冲掉，成本上限失效）。
- **图片 token 为估算**：多模态请求里图片按固定常数计入估算（服务端若返回 usage 则以服务端为准）。
- **用量未知的审核调用按固定价或标记计入**：OpenAI `/moderations` 不返回 token 用量，记录带 `usageUnknown: true`；金额按 `AI_SAFETY_CALL_PRICE_YUAN`（默认 0）计，返回值有告警。若长期使用该模式，负责人应把每次固定价配上，否则这部分成本不进上限。
- **`ai_usage_records` 只增不删**：保留策略（滚动窗口/定期清理）未定，等真实调用量出来再决定。
- **探测只能证明「接口可调用」**：不发违规文本是刻意选择，因此「违规内容一定会被拦」由官方错误码表 + 桩测试覆盖，不是探测结论。
- **`invalid_request` / `internal` 两类失败**：规格只要求三类用户可见失败可区分；这两类是本票补的基础设施分类，文案同样独立。

## 待核实并锁定（实施时填写）

ADR-0001 规定这些不在没有工程时编造，实施时核实并回填本节：

- [x] 云函数的 Node.js 运行时版本：**Nodejs16.13**（`cli cloud functions info` 实测读取，2026-09-18）
- [x] 云函数超时时间：**20 秒**（2026-09-18 由负责人在控制台从默认 3 秒调大，`cli cloud functions info` 读回确认）
- [x] `wx-server-sdk` 直接依赖固定为 `4.0.2`；根目录锁文件锁定本地依赖，云函数远端安装的传递依赖尚无函数级锁文件
- [x] 基础库锁定 `3.17.2`，历史开发者工具验收已成功读取云端数据
- [x] 数据库安全规则写法：已核实——`news_articles` 用自定义规则 `{"read": true, "write": false}`（预设「所有用户可读」不支持无登录态访问，故不用预设），`sync_state` 用预设「所有用户不可读写」或 `{"read": false, "write": false}`；云函数端属管理端，不受规则限制
- [x] **云函数定时触发器的配置字段与 cron 格式**（2026-09-18 按官方文档核实，尚未部署验证）：云函数目录下的 `config.json` 声明 `triggers` 数组，**只支持一个触发器**；字段为 `name`（触发周期名，字母开头）、`type`（只支持 `timer`）、`config`（cron 表达式，七个必需字段「秒 分 时 日 月 星期 年」）；**触发器规则的时区为 UTC+8**；同一条定时消息可能被重复推送，需要去重。依据：[定时触发器](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions/triggers.html)。本项目的 `cloudfunctions/newsSync/config.json` 即按此写成（`0 0 6 * * * *` = 每天 06:00），**是否真的按配置触发要等部署后观察，见下「Ticket 04 人工步骤」。**
- [ ] 云开发环境的地域、计费与额度实际值（全量导入的调用量估算见「未决问题」，额度需在控制台核对）
- [x] **AI 云函数的运行时与超时**（2026-09-19 `cli cloud functions info` 实测运行时 **Nodejs16.13**、状态 Active；**超时已由负责人在控制台改成 20 秒并实测生效**——端到端冒烟耗时 4600ms 未被 `-504003` 截断，见「Ticket 01 人工步骤」步骤 C）。**内存已核实为 256MB**（2026-09-19 控制台函数日志出现 `Memory: 256MB MemUsage: 37.4MB`，为 `timetable` 函数的日志行、同环境函数配置一致，见步骤 C）
- [ ] **中转（CommandCode）的接口地址、模型名与实际单价**（Ticket 01 只能提供配置项，无公开依据可核实；已从 `usage` 读到 `AI_PRICE_*` 配的是 0.25 元/百万 token，模型名与单价是否与中转实际一致仍待联调确认）
- [x] **未认证状态下微信内容安全接口是否可用**（**2026-09-19 实测：可用**。小程序端 v2 形态下 `security.msgSecCheck` / `security.imgSecCheck` 均返回 `errcode 0`，记录见「微信内容安全探测记录」表。附带结论：**控制台「测试」页测不了云调用**，必须从小程序端触发）

## 课表云端实施（Ticket 03；2026-09-19 已部署并完成端上验收）

课表导出的解析跑在云函数 `timetable` 侧：客户端把选中的文件上传到**本人 openid 专属的云存储路径**，云函数下载 → 用 `xlsx` 解析成草稿 → **删除临时文件**；确认页确认后才写库。函数同时承担个人课表的读取与手工增删改，全部按调用上下文的 openid 过滤，客户端不直连数据库。截图识别（Ticket 05）复用同一条上传路径，识别由 `ai` 云函数的 `vision` 动作完成。

**状态（2026-09-19）**：集合 `timetable_courses`、云函数 `timetable` 与环境级函数权限（`timetable` 允许已登录用户调用，`newsSync` 仍为 `false`）已由负责人在控制台完成；负责人用真实样本在开发者工具走完导入并完成端上验收，逐项结果见下「部署后可验证的判据（人工）」，原始输出见 [Ticket 03 验证记录](evidence/p4-b/README.md#2026-09-19-云端端上验收)。**云存储权限与函数超时两项控制台配置已由负责人确认（2026-09-19）**：云存储权限为**「仅创建者可读写」**，`timetable` 函数超时为 **20 秒**；控制台「存储」里 `timetable-imports/` **无残留**（临时文件已删除）。**仍未验证**：两个微信号的用户隔离、确认页「放弃导入」路径、错误文件的可理解提示（仅桩测试）。本轮另修一处 UX 问题：在文件选择器里点取消（`cancel`）不再打出「课表操作失败：…cancel」诊断日志（行为本就正确：回到原页面、不写数据、不显示错误），见分支 `fix/import-cancel-quiet`。

**文件标识统一用 fileID**：客户端 `wx.cloud.uploadFile` 返回的 `cloud://…` 才是 fileID；`prepareUpload` / `preparePhotoUpload` 返回的 `cloudPath` 只是相对路径，只能交给 `uploadFile` 当上传目标。`importDraft` / `discardUpload` 接收的是 `fileID`，云函数**从 fileID 里解析出云存储路径**再校验「属于调用者 openid 前缀」（fileID 里的环境信息不参与比较），解析不出路径或不在本人前缀下都明确拒绝。把裸 cloudPath 当 fileID 传会在 `cloud.downloadFile` 处失败——那是 Ticket 03 的老写法，已修正并补了回归测试。

**`updateCourse` 是部分更新（Ticket 06 两轴复核修复）**：只覆盖请求里**显式给出**的课程字段，未给出的字段保持原值；`owner` / `semester` / `rawText` / `source` / `createdAt` 等由服务端掌握，客户端传了也不生效。手工编辑表单提交的是完整字段集，课表助手（06）只提交这次真正改动的字段——两层都不允许「只改时间」把教师、地点、学分、周次或备注一起清空。要清空某个字段，必须在请求里显式给空字符串。

代码位置与测试：

| 文件 | 职责 |
| --- | --- |
| `cloudfunctions/timetable/index.ts` | 云函数入口：`prepareUpload` / `preparePhotoUpload` / `importDraft` / `discardUpload` / `list` / `saveDraft` / `createCourse` / `updateCourse` / `deleteCourse` |
| `cloudfunctions/timetable/parse.ts` | 网格矩阵解析（依赖 npm `xlsx`，不进小程序包） |
| `cloudfunctions/timetable/record.ts` | 记录规范化和整批校验（不合规整批不写） |
| `tests/timetable-parse.test.cjs` | 4 份真实教务导出 + 异常版式 |
| `tests/timetable-flow.test.cjs` | 云存储与数据库桩上运行真实入口：导入不写库、临时文件删除、fileID 归属校验（含裸路径与别人的 fileID 被拒）、跨学生隔离、整批校验、手工三条路径 |
| `tests/timetable-pages.test.cjs`、`tests/timetable-view.test.cjs` | 页面编排、周次切换与按节次展示、产物不含 Excel 库 |
| `tests/timetable-photo.test.cjs` | 截图识别：文件头判格式、压缩阶梯、识别 JSON 解析（周次留空不当每周）、确认页出口、来源贯通 |

数据模型（集合 `timetable_courses`，一条课程一个文档）：

| 字段 | 说明 |
| --- | --- |
| `owner` | 调用上下文的 openid，**只由云函数写入**，所有查询与更新都带这个条件 |
| `id` | 客户端传入的服务端标识（`tc_` 前缀），页面间传参用它 |
| `name` / `credits` / `teacher` | 课程名、学分（原样保留，如 `0.25`）、教师 |
| `weekday` | 1-7 对应星期一至星期日 |
| `sectionRanges` | 节次区间数组，如 `[{start:1,end:2},{start:3,end:4}]` |
| `startSection` / `endSection` | 原文解析出的起止节；倒置或越界时保留原值，`sectionRanges` 为空并带 warning |
| `weeks` / `weeksRecognized` / `weekText` | 展开后的教学周、是否识别、周次原文 |
| `location` / `campus` / `siteNumber` / `note` | 地点、校区、场地编号、备注（教学班或方向） |
| `warnings` | 待核对提示，页面据此显示「待核对」与原文 |
| `source` / `semester` / `rawText` | 来源（`excel` / `manual` / `photo`）、学期标注、导入时的单元格原文；**截图识别来源为 `photo`，此时 `rawText` 为空**——截图识别后已删除、字段是模型重新表述的，没有可核对的「原文」，不拿合成文本冒充 |
| `createdAt` / `updatedAt` / `batch` | 时间戳与写入批次；`batch` 用于「先写新批次、成功后再删旧批次」的整份替换 |

**为什么没有给 `owner` 建索引**：数据量是个人的几十条，按 `owner` 全量读取即可；将来若按 `owner + semester` 或按周查询再补索引。

### 人工步骤（动作 / 对象 / 判据）

以下都是控制台操作，代码侧无法完成。**第 1–5 项已于 2026-09-19 由负责人完成或确认**：集合、云函数部署与函数权限已复核，课表页已能正常读到数据；云存储权限确认为**「仅创建者可读写」**；`timetable` 超时确认为 **20 秒**。第 4 项判据里「用第二个微信号读取他人文件应被拒」的端上定点复核与「用户隔离」同源，仍未实测。

1. **创建集合**（**已完成，2026-09-19 复核**）
   - 动作：在云开发控制台「数据库」新建集合 `timetable_courses`。
   - 对象：环境 `cloudbase-d2gjtbbwu3575cd7b` 的数据库。
   - 判据：集合列表里能看到它；权限为**最严格预设「所有用户不可读写」**（或自定义 `{"read": false, "write": false}`）。在开发者工具里用 `wx.cloud.database().collection('timetable_courses').get()` 应返回 `DATABASE_PERMISSION_DENIED`——客户端直连被拒是这一票的隔离要求之一。

2. **部署云函数**（**已完成，2026-09-19 复核**）
   - 动作：在开发者工具里右键 `dist/cloudfunctions/timetable`（或 CLI `cloud functions deploy --name timetable --remote-npm-install`）部署，**必须勾选/使用云端安装依赖**：该函数依赖 `wx-server-sdk@4.0.2` 与 `xlsx@0.18.5`。
   - 对象：云函数 `timetable`。
   - 判据：控制台「云函数 → timetable → 测试」运行 `{"action":"list"}` 返回 `ok: true, count: 0`（首次、无数据时）；运行 `{"action":"prepareUpload","fileName":"a.txt"}` 返回 `ok: false` 且提示只支持 `.xls/.xlsx`；运行 `{"action":"preparePhotoUpload","fileName":"a.gif"}` 返回 `ok: false` 且提示只支持 `.png/.jpg`。
   - **升级注意（Ticket 05 两轴复核）**：`importDraft` / `discardUpload` 的参数已从裸 `cloudPath` 改为 `fileID`（`cloud://…`），**客户端与云函数必须一起部署**。只更新一边会让导入直接失败：新客户端 + 老函数会被「参数不合法」拒（老函数把 `fileID` 当 `cloudPath` 校验，前缀不匹配），老客户端 + 新函数会被「请传入 fileID」拒。

3. **函数调用权限**（**已完成，2026-09-19 复核**）
   - 动作：仍在「云函数 → 权限控制」的环境级 JSON 里**只新增** `timetable` 一条，值与环境里 `*` 的表达式一致（例如 `"auth != null && auth.loginType != 'ANONYMOUS'"`）；**不要**把它设成 `false`——`timetable` 必须允许小程序端调用，隔离靠函数内的 openid 过滤，而不是靠禁止调用。
   - 对象：环境级函数安全规则 JSON（与 `newsSync: {"invoke": false}` 并列）。
   - 判据：小程序端 `wx.cloud.callFunction({name:'timetable', data:{action:'list'}})` 返回 `ok: true`；同时 `newsSync` 仍然返回 `-501023 permission denied`（不能改动既有规则）。

4. **云存储权限**（**已完成，2026-09-19 负责人确认**）
   - 动作：控制台「存储 → 权限设置」把默认权限改为**「仅创建者可读写」**（如需自定义规则则用 `resource.openid == auth.openid` 限定）。本次导入只写入 `timetable-imports/<openid 哈希>/` 下的临时文件。
   - 对象：环境云存储的整体权限（云存储规则不能按目录分别配置）。
   - 判据：小程序端用 `wx.cloud.getTempFileURL` 读取**别人**上传的文件应被拒；云函数（管理端）仍能 `downloadFile` 与 `deleteFile`。
   - **确认结果（2026-09-19）**：控制台权限设置为**「仅创建者可读写」**；云函数侧的下载与删除在本次导入中正常工作（解析成功、`timetable-imports/` 无残留）。判据前半条「用第二个微信号读取他人文件被拒」未单独实测，与「用户隔离」同源。

5. **函数超时（建议 20 秒）**（**已完成，2026-09-19 负责人确认**）
   - 动作：控制台「云函数 → timetable → 配置」把超时从默认 3 秒调到 20 秒。
   - 对象：云函数 `timetable` 的超时配置。
   - 判据：用小程序上传一份真实样本（约 20KB）能解析成功；解析本身的耗时量级很小（实现时在本机对 4 份样本各测一次为 1–13 毫秒，**该测量未纳入自动化验证记录**），耗时主要在下载与冷启动，20 秒足够。
   - **确认结果（2026-09-19）**：控制台配置确认为 **20 秒**；负责人的真实样本导入在 20 秒配置下成功解析（云端入库 15 门课程），判据成立。

### 部署后可验证的判据（人工）

状态列按 2026-09-19 的云端端上验收填写；原始输出见 [Ticket 03 验证记录](evidence/p4-b/README.md#2026-09-19-云端端上验收)。

| 验收项 | 判据 | 状态（2026-09-19） |
| --- | --- | --- |
| 导入走通 | 在开发者工具里把 `tests/fixtures/timetable/2026-2027学年第一学期班级课表.xls` 发给文件传输助手 → 导入页选择它 → 确认页显示 15 门课程、0 条待核对 → 保存后周课表出现课程 | **通过**：负责人用该样本走完导入（选文件仍为人工）；云端 15 门课程，课表页元信息「2026-2027学年第一学期 · 共 15 门课程」，`{"action":"list"}` 返回 `ok=true, count=15` |
| 解析不写库 | 导入过程不写入课表；点「放弃导入」后集合保持原样 | **部分验证（2026-09-19）**：负责人实测的是**在文件选择器里点取消**（日志 `chooseMessageFile:fail cancel`，这条路径不进入上传与解析）后集合条数不变；**确认页上点「放弃导入」按钮的路径仍未实测**——两者不是同一条路径，不能互相替代 |
| 临时文件删除 | 解析完成后「存储」里 `timetable-imports/` 下没有残留文件 | **通过**：负责人核对控制台「存储」，`timetable-imports/` 下无残留（2026-09-19）。注意 2026-09-18 记录的极端路径（上传成功后小程序被强杀，既未解析也未清理）仍可能残留，该风险单独保留 |
| 周次切换 | 周课表切到第 8 周能看到 8-17 周的课，切到第 7 周看不到（样本里 `[2-6,8-17]周`） | **通过**：负责人截图——第 8 周出现 `[8-17]周` 的《使用JSP开发Web应用系统》《软件工程（基于面向对象的软件设计）》等，第 7 周没有（只有 `[2-15]周` 的《军事理论》等） |
| 退出重进 | 杀掉小程序重进课表页，课程仍在 | **通过**：每次 `reLaunch` 课表页都从云端读到 15 门（`ok=true`） |
| 手工三条路径 | 新增一门课并出现在周课表；修改后展示更新；删除后消失 | **通过**：维护者脚本从模拟器调用，每次用临时课程——新增后 `count 15→16`；只提交 `teacher` 与 `location` 的部分更新未清空学分/备注/校区/场地编号/周次/星期；删除后 `count` 回到 15，结束后计数已还原、临时数据已清理 |
| 用户隔离 | 换另一个微信号进入课表页，看不到前一个账号的课程 | **未验证**：需要一个第二微信号 |

## P3 云端验收清单

对应 [开发规格](development-spec.md) 与 [开发阶段](development-phases.md) 的 P3-1 / P3-2。实测时间与命令见 [P2 / P3 验证记录](evidence/p2-p3/README.md)。

- [x] 云函数调用成功，数据库读写正常：`newsSync` 已部署并经小程序调用，10 篇入库
- [x] 一篇真实文章贯穿：抓取 → 入库 → 小程序列表 → 详情，来源与日期与原文一致
- [x] 开发者工具中普通客户端可读公开资讯且**写入被拒绝**：直写返回 `DATABASE_PERMISSION_DENIED`
- [ ] 未登录单页模式读取：规则按此目标配置，实际链路尚未验证，发布后由 Ticket 08 补测
- [x] 同一 URL 重复同步不产生重复条目：第二次同步 `inserted: 0, updated: 10`，集合仍为 10 条；2026-09-18 重新部署后再次复核，结果相同
- [x] 历史列表页 403 失败保留数据；本地回归补充无效正文、全部文章失败和部分成功
- [x] 修复版本已部署（2026-09-18，5 个文件 / 9.5 KB）并在云端复核
- [x] **云函数超时已从 3 秒调到 20 秒**（2026-09-18）；调整前默认同步量贴在上限上，会间歇性 `-504003`，见上「3 秒超时」
- [x] 维护者可手动触发同步：历史验收通过小程序调用与控制台测试完成；收紧函数权限后仅保留管理端触发
- [x] **`newsSync.invoke: false` 已应用并实测生效**：客户端调用返回 `-501023 permission denied`，资讯读取不受影响
- [ ] 定时触发按配置生效：尚未配置定时触发器（首次同步范围与失败处理先验证，见下）。**Ticket 04 已把触发器写进 `config.json`，但本轮未部署、未触发**，见「Ticket 04 人工步骤」步骤 B、C
- [x] 首页最近资讯入口与列表逐页加载（P3-2）：[Ticket 02](tasks/tickets/02-home-news-entry-and-paging.md) 已完成并在开发者工具通过 12 项检查（真实多页场景待 Ticket 04 扩大数据量后补验）
- [ ] **Ticket 04 扩大同步范围与每日定时**（本地代码与桩测试已完成，云端全部未验证）：两个栏目全量导入、按 URL 增量更新、限速 403 停止本轮、跨批续跑、外链条目只存标题日期链接、每日 06:00 定时触发至少成功一次、维护者手动触发仍可用且普通客户端仍被拒。逐项状态见 [Ticket 04](tasks/tickets/04-expand-sync-and-daily-schedule.md)
- [x] 验证记录写入 `docs/evidence/`，与 [P2 / P3 验证记录](evidence/p2-p3/README.md) 并列

<a id="ticket-04-人工步骤"></a>

## Ticket 04 人工步骤（动作 / 对象 / 判据；**步骤 A 的部署已完成，运行判据与 B–E 未执行**）

Ticket 04 改的是代码与配置，验证要在云上做。**2026-09-19 已完成的只有部署本身**（步骤 A 的「动作」），其余一律为**未验证**；代码侧的桩测试结论见 [Ticket 04](tasks/tickets/04-expand-sync-and-daily-schedule.md)。

### 步骤 A：部署新版 `newsSync`（**部署已完成，运行判据未取**）

- **动作**：构建出 `dist/cloudfunctions/newsSync`（含 `config.json`、`columns.js`）后，在开发者工具里右键该目录 →「上传并部署：云端安装依赖」；或执行 `cli.bat cloud functions deploy --project <仓库>/dist --names newsSync --remote-npm-install`。
- **对象**：云函数 `newsSync`（运行时 Nodejs16.13、超时 20 秒、权限 `invoke: false` 均保持不变）。
- **判据**：控制台「云函数 → newsSync」显示新的更新时间；「测试」页传 `{"column":"tw-tqsd","maxRequests":2}` 运行，返回里 `timeZone` 为 `Asia/Shanghai（UTC+8）`、`columns[0].label` 为 `学校官网 · 团委通知公告`、`requestsUsed` 为 2、`resumeHint` 有值。
- **2026-09-19 实测（部署部分）**：`npm run build` 后执行上面的 CLI 部署命令成功——**`newsSync` 部署 7 个文件 / 25.6 KB**（新增 `columns.js` 与带触发器的 `config.json`）；`cli cloud functions info` 读回 **Active / timeout 20 / Nodejs16.13**；控制台「云函数」列表显示 **最后更新 2026-09-19 12:07:52**、版本 `$LATEST` 流量 100%，配置页显示运行环境 Node.js 16.13、**内存 256 MB**、**执行超时 20 秒**；部署后从小程序端复测「普通客户端调用仍被拒绝」——返回 `-501023 permission denied`。
- **仍未取的判据**：「测试」页那一次 `{"column":"tw-tqsd","maxRequests":2}` 的返回未记录。**注意**：内嵌的云开发控制台 v2 里「云端测试」面板的 JSON 编辑器**不接受自动化输入**（输入与粘贴都不生效），这一步要人工在工具里点，或在能输入的环境里跑。
- **注意**：`config.json` 会随函数目录一起上传，定时触发器以它为准；若控制台此前手工建过触发器，以控制台显示为准并核对是否与 `config.json` 冲突。

### 步骤 B：确认每日 06:00 触发器

- **动作**：部署后在控制台「云函数 → newsSync → 触发器」查看触发器列表。
- **对象**：触发器 `newsSyncDaily`。
- **判据**：列表里存在名为 `newsSyncDaily` 的定时触发器，触发周期显示每天 06:00；按官方文档 cron 为七位「秒 分 时 日 月 星期 年」且**触发器时区为 UTC+8**，因此看到的时间就是东八区 06:00（本仓库 `config.json` 的 `0 0 6 * * * *`）。
- **依据**：[定时触发器](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions/triggers.html)（一个函数只支持一个触发器）。

### 步骤 C：等一次真实触发并留档

- **动作**：等到下一个 06:00 之后，在控制台「云函数 → newsSync → 日志」里找一次定时调用记录，抄下调用时间与返回结果；再读 `sync_state` 的两个文档。
- **对象**：定时触发日志、`sync_state` 的 `lastTrigger` / `lastTriggerName` / `lastRunAtLocal` / `lastOutcome` / `lastSuccessAt`。
- **判据**：日志里有一次 06:00（东八区）的调用；`lastTrigger` 为 `timer`、`lastTriggerName` 为 `newsSyncDaily`、`lastRunAtLocal` 形如 `2026-09-19 06:00:xx +08:00`；返回结果里的 `totals` 与 `columns[].message` 可读。**这是「定时触发至少实际成功一次」的唯一证据来源**，本地测试只覆盖了事件字段的解析。
- **若当天遇到官网限速**：日志会显示本轮停止、站点文档 `site` 与栏目文档的 `rateLimitedAt` 被写下，且 30 分钟内任何栏目都不再发起请求——这是设计行为，不要手工重试。

### 步骤 D：跑完首次全量导入

- **动作**：在控制台「测试」页反复运行 `newsSync`（建议按栏目标一跑：`{"column":"xyxw-xydt"}`，跑完再跑 `{"column":"tw-tqsd"}`），每次调用最多 10 次页面请求，直到返回 `backfillDone: true`。
- **对象**：两个栏目的 `backfillDone`、`backfillPage` 与 `news_articles` 的条数。
- **判据**：`news_articles` 里 `sourceLabel` 为 `学校官网 · 校园动态` 的记录 1252 条、`学校官网 · 团委通知公告` 155 条；`sync_state` 两个文档 `backfillDone` 为 `true`、`lastOutcome` 为 `ok`、`lastSuccessAt` 有值、`missing` 为空；重复的 `url` 数为 0（`url` 唯一索引兜底）。`backfillDone` 只有整轮零失败才会置 `true`，所以**看到它是 `true` 就说明没有空缺**。
- **现实成本（务必先读）**：正文抓取与列表页共享同一份 10 次配额，全量合计约 **155 批**（算术见「同步云函数」小节），按 1.3 秒间隔共约 34 分钟的实际请求时间；控制台一次一次点不现实，可选路径见「未决问题」。
- **若有失败条目**：返回里的 `missing`、栏目 `message` 与状态里的 `sync_state.missing` / `round.failures` 会列出没取到的 URL 与原因；确认原因后用 `{"column":"xyxw-xydt","reset":true}` 重跑该栏目的全量（按 URL 幂等更新，已入库的不会重复），跑完再看一次 `backfillDone` 与 `missing`。

### 步骤 E：扩大数据量后补验列表分页与索引

- **动作**：全量导入完成后，在开发者工具里打开资讯列表，上滑加载多页；并按需在控制台「数据库 → news_articles → 索引管理」补建 `date + id` 组合索引。
- **对象**：资讯列表的逐页加载；`news_articles` 的索引。
- **判据**：列表能连续加载多页且不出现重复条目、末页显示「已经到底了」；深偏移查询在 1252 条规模下仍可接受。这条是 [Ticket 02](tasks/tickets/02-home-news-entry-and-paging.md) 留下的待补验项，Ticket 04 提供数据前提，**本轮未执行**。

## 实施进度

- 2026-09-18：集合、唯一索引与安全规则配置完成；`newsSync` 云函数部署成功（5 个文件，`--remote-npm-install` 云端安装依赖）。
- 2026-09-18（本轮收尾）：修复版 `newsSync` 重新部署成功（5 个文件 / 9.5 KB），运行时 Nodejs16.13、超时 3 秒、状态 Active。连续调用复核：集合始终 10 条，每次 `inserted=0, updated=10`，重复同步不重复成立。
- 解析模块从 `miniprogram/services/news/` 迁入云函数（客户端本就不引用它），客户端不再打包解析逻辑与随包快照，资讯正文只来自云端。
- 小程序页面改为读云数据库：异步加载，区分「加载中 / 有数据 / 空 / 读取失败可重试」，失败不静默降级为旧内容。
- 2026-09-18（Ticket 04，**仅本地**）：新增团委通知公告栏目的列表/正文解析规则与真实片段 fixture；同步改为按栏目分批续跑（间隔 1.3 秒、单批 ≤10 次页面请求、每步落盘、限速 403 停止并冷却 30 分钟、外链条目不抓正文）；`config.json` 写入每日 06:00 的定时触发器；页面时间文案改为「最近写入 / 最近一次成功写入」。**未部署、未在云端验证**，人工步骤见上。
- 2026-09-18（Ticket 04 两轴审查修复，**仅本地**）：冷却改为**站点级**（`sync_state` 新增 `site` 文档），任一栏目撞 403 立即结束本轮、后续栏目不再请求；截止点判定移到「等够 1.3 秒之后、发请求之前」，同站跳转同样计数与节流，`WORK_DEADLINE_MS` 按 20 − 6 − 1 − 0.5 = 12.5 秒重算；`backfillDone` 改为**整轮零失败才置真**，有失败时新增 `missing` 清单并在 `resumeHint` 写明「还差 N 条、用 reset 补齐」；文章页解析不到「发布时间」时保留旧日期，不再每天重抓同一篇。新增 9 项测试（引擎 8 项：两栏目先后撞限速、站点冷却期内另一栏目零请求、冷却跨调用、等待越界不发请求、跳转节流、全量零失败才算完成、有失败不算完成、日期保留；解析 1 项：`title` 属性的标题与发表时间各自独立）。其中 8 项引擎测试**在修复前的代码上全部失败**（已把 HEAD 版本的 `index.ts` 装回本地跑过一遍确认），修复后 `npm test` 90 项全过。
- 2026-09-18（Ticket 01，**仅本地**）：新增云函数 `cloudfunctions/ai/`——统一模型调用入口（OpenAI 兼容 / Anthropic 两种接口格式、文本与多模态）、可切换的内容安全适配层（微信云调用为主，第三方支持 OpenAI / Anthropic 格式，文字与图片分开）、每次调用的耗时与 token/金额记账、月度成本上限（默认 50 元，接近阈值告警、达到上限拒绝）、三类失败分类与独立文案、未认证状态下微信内容安全接口的探测动作。两轴复核后修掉 4 处真缺陷（月度用量覆盖、云调用与下载无超时、402/429 混类、跳过检测被读成「检过且干净」），并补 23 项测试；`npm test` 136 项全过。**未部署、未配密钥、未探测、未做真实端到端调用**，人工步骤见「Ticket 01 人工步骤」。
- 2026-09-18（Ticket 05 课表截图识别导入与校对，**仅本地**）：导入页新增「拍照或从相册选择课表截图」入口（选图 → 压缩 → `preparePhotoUpload` → 上传 → `ai` 的 `vision` → 识别 JSON 解析为草稿 → 复用 03 的确认页与 `saveDraft`）；`source` 新增 `photo`（两端契约同步）；截图识别后删除云存储临时文件；三类独立失败文案。**未部署、未真机验证**，人工步骤见上「课表云端实施」。
- 2026-09-18（Ticket 05 两轴复核修复，**仅本地**）：截图格式改为**按文件头判定**（读不到字节才退回路径扩展名，两者都拿不到就明确拒绝并给可读提示）——相机与 `wx.compressImage` 的产物常是 JPEG，原先恒传 `课表截图.png` 会让 `imgSecCheck` 与模型的 `media_type` 与实际内容不符；上传/下载/识别统一用 `wx.cloud.uploadFile` 返回的 **fileID**，`importDraft` / `discardUpload` 的参数从裸 `cloudPath` 改为 `fileID`，云函数从 fileID 解析出云存储路径再校验 openid 前缀（**Ticket 03 的 Excel 路径是同一处老写法，一并修正；客户端与云函数必须一起部署**）；周次留空不再静默当成「每周」，只有模型显式 `everyWeek` 才算（页面按待核对展示）；图片被拒的文案与文字语义的「换个说法」分开（服务端新增 `AI_MSG_CONTENT_REJECTED_IMAGE`，客户端兜底按输入类型区分）；截图识别不再把字段拼成合成「原文」。测试见 [p5-b 记录](evidence/p5-b/README.md)。
- 2026-09-19（Ticket 01 云端收尾 + 探测路径修复）：`ai` 云函数已部署（Active / Nodejs16.13，11 个文件 / 42.4 KB），两个用量集合与模型环境变量已就绪（`usage` 返回 capYuan 50、告警线 40、单价 0.25 元/百万 token）。**微信内容安全探测改从控制台移到小程序端后跑通**：v2 形态下 `security.msgSecCheck` / `security.imgSecCheck` 均返回 `errcode 0`——未认证小程序可用官方云调用，`AI_SAFETY_PROVIDER` 保持默认 `wechat`，不需要第三方审核密钥。为此修掉一处会误导决策的缺陷：平台错误码 `-501001` / `-501007`（云调用未从小程序端触发）此前会被读成「微信接口不可用」并建议切第三方，现在探测记录带 `valid` / `invalidReason`，**无效测量不切换适配器**，错误码表补上这两个平台码并写明触发限制，新增 2 项测试（`npm test` 296 项全过）。新增两个小程序端入口：`npm run probe:wechat`（探测）、`npm run smoke:ai`（端到端）。
- 2026-09-19（Ticket 01 端到端跑通）：负责人在控制台把 `ai` 超时从默认 3 秒改成 **20 秒**，随后 `npm run smoke:ai` 从小程序端真实调用一次**成功**：`ok=true`、模型输出「链路已通」、`elapsedMs=4600`（超过 3 秒且未被截断，证明新超时生效）、内容安全 `provider=wechat checked=true passed=true errcode=0`、用量 105 token 已记账且当月累计可查。原始输出与「这次证明了什么、仍缺什么」见 [Ticket 01 端到端冒烟记录](evidence/p5-foundation/README.md)。**数据库侧抽查确认 `ai_usage_records` 无密钥字段与密钥值；云函数内存核实为 256MB**（日志 `Memory: 256MB MemUsage: 37.4MB`）。**仍未完成**：上限拦截实测（步骤 F）、图片路径（`vision`）真实调用。
- 2026-09-19（Ticket 03 云端端上验收）：负责人在控制台完成集合 `timetable_courses`、云函数 `timetable` 部署与环境级函数权限（`timetable` 允许已登录用户调用，`newsSync` 仍为 `false`）；用真实样本 `tests/fixtures/timetable/2026-2027学年第一学期班级课表.xls` 走完导入（选文件仍为人工），云端 **15 门课程**。端上验收覆盖：周次切换（第 8 周出现 `[8-17]周` 的课、第 7 周没有）、退出重进（每次 `reLaunch` 都从云端读到 15 门）、手工新增/修改/删除三条路径（临时课程，结束后计数还原并清理）；`npm run verify:wechat` **18 项全过**（课表页显示「已就绪」，部门问答两项为真实回答）。负责人并确认：云存储权限为**「仅创建者可读写」**、`timetable` 超时为 **20 秒**、控制台「存储」里 `timetable-imports/` **无残留**；「放弃导入不写库」实测的是**文件选择器取消**（`chooseMessageFile:fail cancel`）后集合条数不变。随后（分支 `fix/import-cancel-quiet`，提交 `f3aec80`）取消选择文件/图片不再打「课表操作失败：…cancel」诊断日志，`npm test` **298 项全过**（验收当时 297 项）。**同日补验（自动化，`mockWxMethod` 顶替文件选择器）**：用真实样本走完「选择 → 上传 → 云端解析」到确认页（草稿 15 门）后点**「放弃导入」**，确认框 → 回到引导态、草稿清空、云端条数不变；另用一段纯文本命名为 `.xls` 验证**不可解析文件的提示**（页面给出「未识别出课表矩阵：文件里没有找到「星期一 … 星期日」表头行…」，不含平台错误）。`verify:wechat` 因此为 **20 项全过**。**仍未验证**：两个微信号的用户隔离（需要一个第二微信号）。证据见 [Ticket 03 验证记录](evidence/p4-b/README.md#2026-09-19-两条尾巴的实测不可解析文件的提示与放弃导入)。

### 3 秒超时：默认同步量已经贴到上限（已解决，保留记录）

> **2026-09-18 已解决**：负责人把超时从 3 秒调到 **20 秒**（`cli cloud functions info` 读回确认），控制台以 `{"limit": 10}` 连跑 3 次全部成功（`elapsedMs` 2672 / 2734 / 2751 ms）。以下为问题定位过程的原始记录。

云函数超时配置为 **3 秒**，而一次默认同步（列表 1 次 + 10 篇文章 = 11 次请求，逐篇串行）实测耗时在 **2.5–3.0 秒**之间浮动，因此在边界上会**间歇性失败**。

实测记录（2026-09-18，从开发者工具调用真实云函数）：

| `limit` | 函数自报耗时 | 结果 |
| --- | --- | --- |
| 1 | 564 ms | 成功 |
| 3 | 903 ms | 成功 |
| 5 | 1486 ms | 成功 |
| 6 | 1682 ms | 成功 |
| 8 | 2244 ms | 成功 |
| 10 | 2480 ms | 成功（但同一参数在更早两次调用中返回 `-504003`） |
| 10 | — | **失败**：`errCode: -504003 Invoking task timed out after 3 seconds`（`FUNCTIONS_TIME_LIMIT_EXCEEDED`） |

注意失败时的表现具有误导性：函数在超时前已经写完了文章记录，`news_articles` 的 `updatedAt` 已推进，但调用方收到的是失败。**「调用报错」不等于「没写入」**，排查时不能只看返回值。

单篇成本约 200–230 ms，据此 3 秒大约只能容纳 8–10 篇。含义：

- 这是 P3-2 的**硬前置**。P3-2 要扩大抓取范围和页数，必须先解决超时（在云开发控制台调大函数超时时间，或把同步改成分批可续跑），否则每次同步都会在边界上抖动。
- 与上面的官网限速叠加：官网 WAF 要求「每秒不超过 1 个页面请求」，串行抓取每篇约 0.2 秒其实快于该上限，等于**同时受「官网限速」和「函数超时」两头夹**。分批抓取时要同时满足两者。
- 3 秒超时下，靠调用方的重试也不能解决——重试仍然会做完整轮抓取。

CLI 的 `cloud functions deploy` 没有超时参数（已用 `--help` 核实），**超时时间只能在云开发控制台修改**。这是人工步骤，见下方验收清单。

### 官网对云函数环境返回 403

首次调用云函数时，抓取 `https://lnc.edu.cn/xyxw/xydt` 返回 **403**；同一地址在本机 `curl` 返回 200。给请求加上常见浏览器请求头（`User-Agent`、`Accept`、`Accept-Language`）后恢复正常，因此判断为官网对缺少浏览器特征的请求做了拦截。云函数不携带 Cookie、不涉及身份伪装，只读取公开页面。

若后续再次出现 403，先检查请求头是否被改动，再考虑是否为官网调整了策略——失败信息会写进 `sync_state.lastError` 并由调用结果返回。

**另一类 403：CC 防护限速（2026-09-18 实测）。** 与上面「缺浏览器特征」不同，这类 403 带浏览器请求头也会出现。本地脚本连续抓取团委栏目时触发，响应体 392 字节，正文逐字为：

> 检测到您的IP在短时间内发起多次请求，疑似正在对网站进行CC攻击，因此您的IP将被冻结一段时间。……请您调整扫描软件的并发请求数设置（**每秒不能多于1个页面请求**），以免被系统自动冻结IP而影响扫描结果！

实测特征：冻结不是秒级，间隔 45 秒、180 秒后重试仍是同样的 403；静态资源（如 `content/tw/base/img/wx.jpg`）不受影响。含义与约束：

- 官网同步**必须串行且每秒不超过 1 个页面请求**。P3-2 计划扩大抓取范围与页数时，需按此上限估算耗时（例如 126 页列表 + 逐篇正文不可能在一次调用内完成）。
- 触发冻结后，继续重试只会延长冻结。同步逻辑遇到这类 403 应停止本轮并记录，而不是反复重试。
- 现有函数虽只抓列表第 1 页，但 11 次请求约 2.5–3.0 秒，已快于上述公开限速；云函数出口当次未被拦截不代表满足限速。Ticket 04 需将请求间隔纳入分批同步实现。

## 未决问题

- 全量抓取的范围：目前只实测过「校园动态」一个栏目，其余栏目（学校要闻、创新创业、产教融合、媒体报道）模板是否一致未核实；首次同步是只导入该栏目还是多栏目，由负责人在 P3-2 决定。（**已决**：首批为校园动态 + 团委通知公告，教务处暂缓，见 [P3-2 范围表](tasks/p3-2-news-updates.md)。）
- **首次全量导入的批数（Ticket 04 遗留决策点）**：票面写「首次全量约 15 批」，但正文抓取同样是页面请求，1.3 秒间隔 + 20 秒超时下必须与列表页共享同一份 ≤10 次配额，实际约 **155 批**（校园动态 1378 次请求 + 团委 171 次 = 1549 次）。**「约 15 批」是决策时由我给出的错误估算**（只算了列表页），此处如实更正；负责人已定的「每批 ≤10 次请求」参数没有被改动。可选路径：① 接受 155 次控制台「测试」运行（进度可续，但不现实）；② 把云函数超时调大到 60–300 秒，让单批容纳更多请求（需同步放宽 `MAX_REQUESTS_PER_CALL`，属**新增决策**，要负责人确认）；③ **把定时触发器临时改成每 5–10 分钟一次**，让平台自己跑完约 155 批（每 5 分钟一次约 13 小时、每 10 分钟一次约 26 小时；单次调用有 25 秒运行锁，不会并发压过 1.3 秒间隔），跑完把 cron 改回每日 06:00 —— 不改代码、不用手工重复；④ 用定时触发器的每日一次慢慢补齐（约 155 天，不建议）。**本票不擅自改动已定的参数**，等负责人选路。
- **定时任务与增量的关系**：全量导入未完成时，`mode: auto` 会把每日一次的配额也用于全量（从最新一页往旧页跑），此时不会单独跑「回看最近 3 页」；若负责人希望先保证每日新鲜度、把全量留作人工分批，可把定时任务改成显式 `mode`（需要新的配置入口，未实现）。
- 正文图片：需要为云函数或小程序配置图片域名后才能展示，当前只保留图片说明文字，页面已注明以原文为准。
- 数据保留策略（保留全部历史还是滚动窗口）未定。

## 本轮权限修复：函数调用权限与数据库权限分开

`newsSync` 是云函数名，数据库集合是 `news_articles` 和 `sync_state`。数据库禁止客户端写入不能代替函数的调用权限。

采用 [CloudBase 官方函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)：给 `newsSync` 设置 `invoke: false`，禁止客户端调用；管理端 API、控制台和定时触发器不受此客户端规则限制。无需给小程序新增维护者登录功能。

配置样例见 [newsSync-permissions.json](newsSync-permissions.json)。在云开发控制台「云函数 → 权限控制」读取现有环境规则，保留现有 `*` 和其他函数条目，只合并 `newsSync: { "invoke": false }`。文件里的 `*` 仅供无现有规则时参考，不要用它覆盖其他函数的权限。

**状态（2026-09-18 更新）：函数已重新部署，`invoke: false` 已由负责人应用并实测生效。**

部署本轮 `dist/cloudfunctions/newsSync` 后的实测：

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 1. 普通小程序端调用 `newsSync` 被拒绝 | **通过** | 客户端 `callFunction` 返回 `-501023 permission denied`；应用前同一调用曾成功返回正常结果，可作对照 |
| 2. 维护者可调用、重复同步不增加重复条目 | 通过 | 控制台以 `{"limit": 10}` 连跑 3 次，均 `ok:true, inserted:0, updated:10, failed:0`，集合始终 10 条 |
| 3. 小程序仍可直接读取 `news_articles` | 通过 | 收紧函数权限后，客户端读该集合仍返回 3 条数据 |
| 4. 客户端不能写公开内容 | 通过 | 客户端 `add()` 返回 `DATABASE_PERMISSION_DENIED` |
| 5. `sync_state` 不对客户端开放 | 通过 | 客户端读取该集合同样返回 `DATABASE_PERMISSION_DENIED` |

线上生效的环境规则（负责人填写，已核对）：

```json
{
    "*": {
        "invoke": "auth != null && auth.loginType != 'ANONYMOUS'"
    },
    "newsSync": {
        "invoke": false
    }
}
```

`*` 收紧了其他函数的调用门槛（要求已登录且非匿名），`newsSync` 单独设为完全不可由客户端调用。**注意**：这条规则只作用于客户端调用，管理端、定时触发器不受影响，所以 P3-2 的每日定时同步不会被挡住。

**剩余人工验证**：真机渲染与未登录单页模式（见下步骤三）。部署、超时和权限配置已完成。

<a id="p3-1-收尾剩余的三个人工步骤"></a>

## P3-1 收尾操作参考与剩余验证

步骤一、二保留为历史操作参考，均已于 2026-09-18 完成并复核，无需重复配置。只有步骤三仍未执行；普通真机渲染可现在验证，单页模式等待发布条件。

### 步骤一：云函数超时调整（已完成，历史参考）

**在哪里**：微信开发者工具 → 顶部工具栏「**云开发**」按钮 → 打开云开发控制台 → 左上角确认环境是 `cloudbase-d2gjtbbwu3575cd7b`。
（腾讯云控制台的 CloudBase 页面也可达，但需要腾讯云登录；微信开发者工具里的入口用微信身份即可，更省事。）

**怎么点**：

1. 左侧菜单 →「**云函数**」。
2. 在函数列表里点选 **`newsSync`**。
3. 打开该函数的「**配置**」（不同版本的入口名可能显示为「函数配置」或「版本与配置」）。
4. 找到「**超时时间**」，当时从 **3 秒**改为 **20 秒**；当前已确认是 20 秒。
5. 保存。

**依据**：官方文档写明普通云函数（事件触发）默认 3 秒、可选范围 1–900 秒，配置入口即「云开发平台 / 云函数 / 函数配置」。20 秒在范围内。

**判据**：回到该函数的「测试」页，运行参数填 `{"limit": 10}`，连续运行 3 次，每次都应返回 `ok: true`、`failed: 0`、`elapsedMs` 明显小于 20000，且不再出现 `-504003`。

> **Ticket 04 起 `limit` 的含义已变**：不再是「文章数」，而是「本次调用允许的页面请求数」（列表页与正文都算一次，上限仍为 10，参数名 `maxRequests` 更直观）；返回结构也从 `failed` 变成 `totals.failed`。上面这条历史判据仍能跑通（10 次请求），但读数时按新含义理解。

**为什么定 20 秒而不是更大**：一次同步的耗时受两个上限夹住——函数超时，和官网的限速。官网 WAF 明写「每秒不能多于 1 个页面请求」，若按 1 请求/秒估算，20 秒大约只够 20 次请求（≈ 19 篇文章）。当前函数实测更快（11 次请求 2.48 秒，约 4 次/秒，且云函数出口 IP 未被拦），但**限额是官网自己公布的，做大批量抓取时应按 1 次/秒设计**。所以更大的超时不会线性换到更多文章，P3-2 的扩大抓取要按「分批多次调用」设计，而不是「一次调大超时抓完」。

### 步骤二：收紧函数调用权限（已完成，历史参考）

**特别注意：这一步不是数据库权限。** 数据库的读写规则在左侧菜单的「**数据库 → 权限设置**」里，已经在更早的轮次配置完成（`news_articles` 自定义规则、`sync_state` 不可读写），**本轮不要动它**。本步改的是「谁能调用这个云函数」。

**在哪里**：同一个云开发控制台 → 左侧「**云函数**」→ 页面上的「**权限控制**」按钮（该配置页在官方文档里的路径是「云函数 > 权限管理 > 安全规则」）。

**怎么点**：

1. 先**读取现有规则的全文**（可能已有 `*` 与其他函数的条目），不要直接粘贴覆盖。
2. 在现有 JSON 里**只新增**一条 `newsSync`：

   ```json
   {
     "*": { "invoke": "auth != null" },
     "newsSync": { "invoke": false }
   }
   ```

   `newsSync` 那行是本步要加的内容；`*` 那一行只是示例，**以你读到的现有值为准，保持原样**。
3. 保存。

**规则格式的硬要求**（官方文档，写错会保存失败或误伤其他函数）：

- 这是**环境级**共享的 JSON，格式为 `{"函数名或通配符": {"invoke": 表达式}}`。
- **顶级必须包含 `*` 通配项**，每个函数配置**必须包含 `invoke`**。
- `invoke` 的值可以是 `true`、`false`、`"auth != null"`、`"auth.loginType != 'ANONYMOUS' && auth != null"` 这类表达式。
- 匹配优先级：先匹配**具体函数名**，未命中才落到 `*`。所以给 `newsSync` 写死 `false` 不会被 `*` 覆盖。
- **作用范围只限客户端调用**（SDK 的 `callFunction`）。管理端 API、**定时触发器**、数据库触发器**都不受这条规则影响**——所以 P3-2 将来配的每日定时同步不会被这步挡住。

**判据（两条都要过）**：

1. 在微信开发者工具的小程序端调用 `newsSync` 应**被拒绝**。配置前该调用成功，配置后已复核返回 `-501023 permission denied`。下面片段仅供后续复核：

   ```js
   wx.cloud.callFunction({ name: 'newsSync', data: {} })
     .then(r => console.log('仍然可以调用 —— 规则未生效', r.result))
     .catch(e => console.log('已被拒绝 —— 规则生效', e.errMsg));
   ```

2. 资讯页面（列表与详情）**仍能正常读取** `news_articles`。`invoke` 只管函数调用，不影响数据库读取；如果这一步之后资讯读不出来了，说明误改了数据库权限，需要回滚。

### 步骤三：真机与未登录单页模式（部分被阻塞）

**2026-09-18 更新：这一项做不全，原因见下。**

- **真机渲染验证：可做。** 小程序未备案也能用「预览」在真机上打开，所以「列表出内容、详情正文与官网原文一致、来源链接可复制」这三条现在就能验。
- **未登录单页模式：做不了。** 单页模式只能由「朋友圈打开分享的小程序页面」进入，而小程序**未完成认证与备案时无法转发朋友圈**（负责人实测）。因此这条在发布之前无法验证。

**解除条件**：完成微信认证 + 小程序备案 → 版本发布 → 页面开启 `onShareAppMessage` 与 `onShareTimeline` → 分享到朋友圈后从朋友圈打开。

**当前如何处理这条验收**：不标记为通过，也不删除。改为记录「设计上已覆盖、实测被备案阻塞」：

- 安全规则 `{"read": true, "write": false}` **不引用 `auth`**，因此登录与未登录两种情况都能读——这是设计层面的保证，依据是 [数据库安全规则](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/security-rules) 与官方「未登录模式」说明。
- 但「设计上成立」不等于「实测通过」。**解除阻塞后必须补测**，判据仍是：单页模式下不登录也能看到资讯正文。

### 备案与认证：如果要体验版或发布，现在就得启动

官方要求链条（[小程序备案操作指引](https://developers.weixin.qq.com/miniprogram/product/record/guidelines.html)、[申请小程序备案](https://developers.weixin.qq.com/doc/oplatform/openApi/OpenApiDoc/miniprogram-management/record/applyIcpFiling)）：

1. 备案前置条件：**小程序名称、图标、描述等基本信息已填写完成**；**至少一个审核通过的类目**；**非个人类型小程序必须完成微信认证**。
2. 流程与耗时：平台初审 1–2 个工作日 → 工信部短信核验（**收到后 24 小时内**完成，否则驳回）→ 通管局审核 **1–20 个工作日**。
3. 「管局审核通过后，将下发的小程序备案号，代表你的小程序已完成备案，**可以进入下一步版本发布等流程**」——即**没有备案号就不能发布**。

对项目的含义：

- 负责人提到「还没定小程序名字」——**名称是备案的前置条件**，名字不定就无法启动备案。名称还会被平台按备案规定预筛（违反公序良俗、与主体性质不符、涉及前置审批领域的关键词都会被拦）。
- 赛道页把「完成体验版配置或正式上线」列为**加分项**（非必需）。负责人已确认自己做过小程序、熟悉认证与备案流程，节点由其自行把握，此处只记录客观耗时供排期参考：认证 + 备案串起来最快两三周（通管局审核 1–20 个工作日）。
- **类目需要谨慎选**。备案要求「至少一个审核通过的类目」，而本作品聚合校园新闻资讯——按此前核查，`资讯-信息资讯` 只覆盖单一行业，跨两类以上资讯需 `文娱-资讯广场`（要《互联网新闻信息服务许可证》），时政类还需 `时政信息`（同证）。**学生团队拿不到该证**。选类目时若被判定为新闻资讯类，可能触发前置审批而卡住。这是需要在提交备案前想清楚的一点，不是提交后能补救的。
- 2026-09-19（Ticket 04 **新版部署上线**）：`npm run build` 后用 CLI 部署 `newsSync` 成功——**7 个文件 / 25.6 KB**（比旧版多 `columns.js` 与带触发器的 `config.json`）；`cli cloud functions info` 读回 **Active / timeout 20 / Nodejs16.13**；控制台「云函数」列表显示最后更新 **2026-09-19 12:07:52**、版本 `$LATEST` 流量 100%，配置页显示 Node.js 16.13 / 内存 256 MB / 执行超时 20 秒。部署后从小程序端复测**客户端调用仍被拒绝**（`-501023 permission denied`），安全规则未随部署失效。**仍未完成**：云端测试那一次 `{"column":"tw-tqsd","maxRequests":2}` 的返回判据（内嵌云开发控制台 v2 的「云端测试」JSON 编辑器不接受自动化输入，需人工点）、`newsSyncDaily` 触发器确认与首次全量导入（约 155 批）。另记一条环境事实：**开发者工具的 CLI 现在要求访问令牌**（设置 → 安全设置里「CLI 访问令牌」已开启），CLI 命令需带 `--token` 或用 `WECHAT_DEVTOOLS_CLI_TOKEN` 环境变量，令牌值只在本机使用、不写进仓库或文档。
- 2026-09-19（Ticket 05 用真实截图跑端上链路）：三张真实课表截图（教务系统班级课表页面，截图不入库）经模拟器文件系统 + `mockWxMethod('chooseMedia')` 走完「压缩判定（三张都 ≤1MB 故不压缩）→ 文件头判格式（PNG 魔数已读到）→ `preparePhotoUpload` → `uploadFile` → `ai` 的 `vision`（图片先过内容安全，`checked=true` / `errcode=0`）」；**模型这一环在当前配置下不通**：三条样本 + 一张 570 字节合成小图全部在 8000ms 处超时（`failureClass=model_unavailable`、`detail=模型调用超时：请求超时（8000ms）`、`model=qwen/qwen3.8-flash`），因此**字段准确率评估无法执行**。同时实测了失败态的三个出口（重试识别 / 重新选择文件 / 手工录入，后者实际跳到 `pages/timetable/edit/index`）。云存储侧核对：页面流程上传的临时文件**没有残留**（`timetable-imports/<openid>/` 为空）；排查中出现的 5 个文件是诊断脚本上传后未清理的，已删除，并给新增的 `scripts/smoke-ai-vision.cjs` 补上 `discardUpload`。**本轮没有执行 `saveDraft`**：它是整份替换本人课表，当前账号里是负责人真实导入的课表，不做写入（保存链路在 Ticket 03 已实测）。证据见 [P5-B 验证记录](evidence/p5-b/README.md)。
