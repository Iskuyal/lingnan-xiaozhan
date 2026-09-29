# 云开发手册

按主题拆分的配置与操作参考。带日期的探测和部署记录是历史快照；执行前按当前代码和控制台状态复核。

[当前状态](../../status.md) · [云开发总览](README.md)

2026-09-24 安全整改说明：新增代码与部署核对见[整改记录](../../review/security-remediation-2026-09-24.md)。新版 `newsSync` 仅接受平台定时触发，本文历史“控制台手动测试/同步”步骤在新版部署后不再适用；`ai` 运维动作需先在云端配置维护者白名单。云函数是否已部署该版，以控制台读回为准。

**2026-09-28 新增待部署项**：内容安全检测窗口修复（CT-01/CT-02，见[审计报告](../../review/content-safety-audit-2026-09-27.md)的修复一节）已随 [PR #74](https://github.com/Iskuyal/wx-match/pull/74) 合入 `main`（合并提交 `50cb884`），改动是 `ai` 云函数与客户端，**线上仍是修复前行为**。部署后需复验：超长输入（>2 万字）被拒且不消耗检测配额、超长输出分片全检后才返回。判据已写成可执行探针 `npm run probe:ai-window`（两个探针：3.2 万字输入期望 `invalid_request` 且 `usage`/`safety` 为空；长输出期望 `checked=true` 且无 `checked=false` 告警，模型没写够 2 万字时如实标「未覆盖」）。**探针 1 不消耗检测配额，探针 2 会按片消耗（约 10~16 次）**。`timetable` 与 `newsSync` 不受本次改动影响。客户端与云函数要一起更新：新客户端自剪历史、旧服务端仍按旧口径放行；新服务端 + 旧客户端在长对话里会收到「输入过长」拒绝而不能继续（见待办总表 V8）。

**2026-09-29 只读回读与实测补充**：

- **已部署版本仍停在 2026-09-24 那一版。** 用 `cli cloud functions download` 把 `ai`、`timetable` 下载到本机逐项比对：`ai` 缺 #67 的记账闸门、#69 的 `rag.js`、#74 的窗口拒绝与分片上限文案（含 2026-09-19 的探测有效性字段）；`timetable` 缺 #67 的批次保护标记。`functions info` 只见状态与超时（`ai` 60 秒、`timetable` 20 秒），**不提供版本号或更新时间**，所以「是否已部署某版」只能靠这条下载比对或控制台读回。
- **探针实测与期望不符（`exit 2`）**：探针 1 返回 `model_unavailable` 并带「文本共 32019 字，仅检测了前 20000 字」告警——超长输入没有被提前拒绝，窗口外的 12019 字未检测就进了模型；探针 2 输出 0 字、如实标「未覆盖」（按判据不算通过）。
- **两处前置缺陷**（都不改代码就没法拿到判据）：① 探针原先把整次云函数调用包在一次 `evaluate` 里等待，而开发者工具的自动化桥对单次 `evaluate` 有约 10 秒上限（实测 10010ms 报 `timeout waiting for automator response`），已由 [PR #79](https://github.com/Iskuyal/wx-match/pull/79) 改为轮询取结果；② 探针 2 的「覆盖」要求输出 ≥2 万字，而服务端把 `maxTokens` 硬钳在 1..8192（`cloudfunctions/ai/config.ts`），**即使部署了修复版这一档也只会得到「未覆盖」**，需先提高服务端上限或改判据口径。
- **配额边界更正**：「探针 1 不消耗检测配额」只在**修复版已部署之后**成立。部署的是修复前版本时，超长输入不会被提前拒绝，会照旧按 2 万字分 10 片送检再进模型——上午实测就是花了这 10 片。演示或录屏前请按 D15 先查额度。

**2026-09-29 当天中午：`ai` 已部署新版（上面那条待部署项到此为止；`timetable`/`newsSync` 仍未动）**

- 部署命令：`npm run build` → `cli cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <dist>`（16 文件 / 75.6 KB）。部署前把旧版下载留档到 `artifacts/rollback-2026-09-29/ai/`（被 gitignore，只在执行机上），便于回退。
- **回读方式**：`download` 拉回已部署代码与本地构建比对，`index.js` **逐字节一致**（SHA-256 `8707f5a3…`；旧版是 `a89b3127…`），`rag.js`、记账闸门、窗口拒绝与分片上限、空响应结构诊断标记齐全；`info` 仍 Active / timeout 60。
- **部署后判据**：探针 1 **通过**（`invalid_request`、`usage`/`safety` 为空、1469ms 就拒绝 ⇒ 拒绝早于检测与模型调用）；探针 2 仍「未覆盖」（模型对该长输出提示返回空内容），**不算通过**；`smoke:ai` 3/3 成功（部署前同日 6/6 为空）。
- **部署前的账目核对**（本文件要求的）：控制台读回当月 `ai_usage_records` 776 条、`ai_usage_monthly.calls` 776；新版只在「记录数 > 汇总」时暂停调用，776 = 776 不触发。首次调用也未出现漏记拦截。
- **`AI_ADMIN_OPENIDS` 的取值格式**：`isAdmin` 按英文逗号切分后要求**整项等于** openid，所以值就填纯 openid（多个用英文逗号分隔）；带 `usage;probe;` 这类前缀、分号或空格都不匹配，症状是维护者探测仍返回「未通过白名单」。配好后实测通过（`probe:wechat` 退出码 0、`valid: true`、两条接口 `errcode 0`），维护者 `usage` 也读到了当月用量。
- **输出侧判据改成「多片全检」（B 方案，2026-09-29 决定）**：原判据要求模型自己写出 ≥2 万字才判「覆盖」，但服务端把 `AI_MAX_TOKENS` 钳在 1..8192（上限写在 `cloudfunctions/ai/config.ts`），而当前模型每个字符要烧几十个 token（实测：重复六个字 20 次＝120 字用 352 completion token，100 次＝600 字用 5575 token，再往上都在 40 秒模型超时失败）⇒ 模型写不出 2 万字，那条路永远「未覆盖」。改为由**维护者动作 `moderateText` 送 6000 字（3 片）**验证「输出被切成多片并整段检完」——`moderateOutput` 走的是同一个分片函数，只是片数上限 20 而非 10。实测 `ok=true`、`safety.checked=true`、2669ms。**这一档消耗 3 次检测调用**，且需要维护者白名单（非维护者会被跳过，脚本按「没有覆盖证据」退出 3）。**边界**：它证明「多片全检链路成立」，**不再证明 2 万字窗口被用满**；「输出 >4 万字即不返回」的 fail-closed 规则仍只有单测与本地夹具覆盖。第三次探针（模型自写长输出）保留为机会性记录、不计入结论。
- **`timetable` 同日也部署了**（7 文件 / 37.1 KB）：旧版留档到 `artifacts/rollback-2026-09-29/timetable/`（`index.js` SHA-256 `1b68c504…`），回读与本地构建**逐字节一致**（`3c59db57…`，批次标记 12 处）。**旧数据可读已实测**：`{"action":"list"}` 返回 51 门课程（旧版数据里 50 门带旧格式 `batch`、1 门没有）、`getSettings` 正常，没有触发「课表批次标记损坏」的 fail-closed。`newsSync` 仍未部署。
- **当天内容安全检测日配额已用尽**：这一轮验证把 100 次/天用满，最后一个探针直接返回 `errcode 45009 fail reach max api daily quota limit`。默认 `AI_SAFETY_FAIL_MODE=closed` ⇒ **当天三处 AI 落点全不可用**，需等次日恢复；演示或录屏前必须按 D15 先查额度（或按本文档的 `clear_quota` 路径处理）。

## 环境信息

| 项 | 值 | 说明 |
| --- | --- | --- |
| 环境 ID | `cloudbase-d2gjtbbwu3575cd7b` | 环境标识，不是密钥，可写入代码与文档 |
| AppID | 见根目录 `project.config.json` | 环境与该 AppID 关联 |
| 开通日期 | 2026-09-18 | 由项目负责人在微信开发者工具「云开发」中开通 |
| 归属 | 项目团队 | 团队账号下的环境，非个人测试环境 |
| 接入形态 | 云函数 + 文档数据库 | 见 [ADR-0001](../../adr/0001-native-wechat-typescript.md) |
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

## 凭据

- AI 密钥（P5）等一律放云函数的环境变量，由云开发控制台注入；不进 Git、不进小程序包、不写入数据库。ADR-0001 明确「微信前端不保存模型密钥」。
- 环境 ID 不是密钥，可以入库。
