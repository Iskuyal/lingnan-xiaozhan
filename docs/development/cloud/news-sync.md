# 资讯同步与数据权限

按主题拆分的配置与操作参考。带日期的探测和部署记录是历史快照；执行前按当前代码和控制台状态复核。

[当前状态](../../status.md) · [云开发总览](README.md)

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

正文不在官网的条目（外链）：列表条目 URL 的域名不是 `lnc.edu.cn` 时**不抓正文**，只存标题、日期与原文链接（`paragraphs: []`）；官网页面 302 跳到域外（如 `mp.weixin.qq.com`）时同样不跟随跳转、不抓外链内容，计入本轮的 `offsite` 而不是失败。实测依据见 [官网资讯栏目与提取记录](../../product/sources/news.md) 的「通知公告类栏目」（教务处通知公告首条直接链到微信公众号）。

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

<a id="ticket-04-人工步骤"></a>

## Ticket 04 人工步骤（动作 / 对象 / 判据；**步骤 A 的部署已完成，运行判据与 B–E 未执行**）

Ticket 04 改的是代码与配置，验证要在云上做。**2026-09-19 已完成的只有部署本身**（步骤 A 的「动作」），其余一律为**未验证**；代码侧的桩测试结论见 [Ticket 04](../../tasks/tickets/04-expand-sync-and-daily-schedule.md)。

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
- **判据**：列表能连续加载多页且不出现重复条目、末页显示「已经到底了」；深偏移查询在 1252 条规模下仍可接受。这条是 [Ticket 02](../../tasks/tickets/02-home-news-entry-and-paging.md) 留下的待补验项，Ticket 04 提供数据前提，**本轮未执行**。
