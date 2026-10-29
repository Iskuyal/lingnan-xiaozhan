# 部署关卡与环境复核

按主题拆分的配置与操作参考。带日期的探测和部署记录是历史快照；执行前按当前代码和控制台状态复核。

[当前状态](../../status.md) · [云开发总览](README.md)

## 2026-10-29：有overrides时随包上传已锁定依赖

本轮在三条函数下载包中复现：`--remote-npm-install`部署后，业务文件与锁文件虽与本地一致，实际依赖仍命中axios、lodash.set、lodash.unset通告。不能只审锁文件或只比根文件就称运行依赖安全。以下流程优先于后文带日期的旧远端安装步骤。

1. 从已通过CI的提交执行`npm run build`，先下载旧函数完整原包作为代码回退；环境变量另按实际能取得的字段登记，不将代码包称为完整环境备份。
2. 依次执行`npm ci --ignore-scripts --prefix dist/cloudfunctions/ai`，以及timetable/newsSync对应命令；审计这三份依赖并检查没有需要按目标平台构建的原生`.node`模块。存在原生模块时不能直接把Windows安装包上传Linux运行时。
3. **安装完部署依赖后不要再执行build**，它会清理dist。CLI部署三条函数时**不加`--remote-npm-install`或`-r`**，随包上传已干净安装的node_modules；不改模型、审核、额度、环境变量或既有触发规则。
4. 再次完整下载，分别核对根文件哈希、node_modules的实际包版本与安全通告；不把实际安装版本与锁文件一致性混成一个结论。
5. 通过小程序端先做只读usage等验证；真实业务按授权预算与冻结样例执行。函数Active、部署成功和定时实际运行仍分别判断，业务写入及真机另计。

本轮具体初次不合格回读、改用本地依赖后的结果与停止边界见[10-29收尾证据](../../evidence/closeout-2026-10-29/README.md)。旧部署记录不覆盖。

## 安全整改部署关卡（2026-09-24）

1. 从已通过 CI 的提交构建 `dist/`；确认 `dist/cloudfunctions/{ai,newsSync,timetable}/package-lock.json` 存在。部署前把旧云函数版本或控制台配置记下，便于出错时回退。
2. 用微信开发者工具 CLI 的 `cloud functions deploy --env <环境 ID> --names ai newsSync timetable --project <dist 绝对路径> --remote-npm-install` 更新三条函数；依赖由各自锁文件约束。`timetable` 一并部署是为了让 PR #57 的 SheetJS 0.20.3 与本轮锁文件在线上生效。
3. `AI_ADMIN_OPENIDS` 是 `ai` 云函数环境变量，填写允许执行 `usage`、`probe`、独立审核的维护者微信 `openid`，多个值用英文逗号分隔。未配置时运维动作默认拒绝；普通 `chat`/`vision` 仍可按自身身份与个人额度调用。`AI_USER_MINUTE_LIMIT` 默认 6，`AI_USER_DAILY_LIMIT` 默认 30，可按真实配额调整。不要把白名单、模型密钥或 CLI 令牌写进仓库。
4. 读回 `ai`、`newsSync` 的 Active 状态、更新时间、超时和触发器；保留 `newsSync.invoke: false`。新版 `newsSync` 需要平台来源 `wx_trigger` 和本次调用上下文的 `TRIGGER_SRC=timer`，客户端即使伪造 `Type: Timer` 也会在抓取前被拒绝。下一次 06:00 触发后再核对状态记录；只凭部署成功不能标定时链路通过。
5. 核对 AI 图片他人 `fileID` 在下载前被拒、普通账号不能读 `usage` 或跑 `probe`、维护者探测冷却、业务调用限额。需要两账号和小程序端真实环境；代码测试与 CLI 信息页不替代这一步。

腾讯云[定时事件结构](https://intl.cloud.tencent.com/document/product/583/9708?lang=en)中的 `Type` 和 `TriggerName` 来自 `event`，客户端也能提交同名字段；平台来源从[本次调用上下文](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/env.md)解析。实例复用可能使全局环境变量残留，见[CloudBase 说明](https://docs.cloudbase.net/cloud-function/instance)。

2026-09-24 实施结果：上述第 1 步的构建与锁文件确认、第 2 步三条函数部署已完成；旧云函数的控制台配置没有完整导出，不把它写成已备份。三条均 Active，远端入口文件和锁文件哈希与本地合并提交一致，`timetable` 下载产物中 SheetJS 为 0.20.3，课表只读调用成功。`ai` 的固定短文本成功，当前账号的运维 `usage` 被拒、伪造图片路径被拒；普通客户端调用 `newsSync` 被平台拒。第 3 步合法维护者白名单、以及第 4、5 步中的**真实定时器和双账号验证**仍待完成，逐项见[安全整改云端证据](../../evidence/security-remediation/README.md)。

状态（2026-09-18 收尾记录）：P3-1 修复版云函数已部署，超时已调整为 20 秒，`newsSync.invoke: false` 已应用并通过客户端复核。证据见 [审查验证记录](../../review/p2-p3/verification.md) 及本文权限复核表。普通真机渲染与未登录单页模式尚未实测，分别由 P6 真机回归与 Ticket 08 跟踪。

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

## P3 云端验收清单

对应 [开发规格](../../product/spec.md) 与 [开发阶段](../phases.md) 的 P3-1 / P3-2。实测时间与命令见 [P2 / P3 验证记录](../../evidence/p2-p3/README.md)。

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
- [x] 首页最近资讯入口与列表逐页加载（P3-2）：[Ticket 02](../../tasks/tickets/02-home-news-entry-and-paging.md) 已完成并在开发者工具通过 12 项检查（真实多页场景待 Ticket 04 扩大数据量后补验）
- [ ] **Ticket 04 扩大同步范围与每日定时**（本地代码与桩测试已完成，云端全部未验证）：两个栏目全量导入、按 URL 增量更新、限速 403 停止本轮、跨批续跑、外链条目只存标题日期链接、每日 06:00 定时触发至少成功一次、维护者手动触发仍可用且普通客户端仍被拒。逐项状态见 [Ticket 04](../../tasks/tickets/04-expand-sync-and-daily-schedule.md)
- [x] 验证记录写入 `docs/evidence/`，与 [P2 / P3 验证记录](../../evidence/p2-p3/README.md) 并列

<a id="ticket-04-人工步骤"></a>
