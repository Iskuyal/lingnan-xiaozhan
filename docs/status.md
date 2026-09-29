# 项目当前状态

云端部署状态核对日期：**2026-09-29**（当天部署 `ai` 新版并回读，逐字节一致；`timetable`、`newsSync` 未动，仍为 2026-09-24 版）；本地自动化证据更新至 2026-09-28，开发者工具模拟器点测更新至 2026-09-26。**2026-09-27 负责人确认人工验收 A1–C1 全部通过，详细记录待归档**，见[人工验收清单](testing/manual-acceptance.md)；已测 Git/云函数版本尚未提供，不能外推到当前 `main`。此页是当前版本的状态入口；各 Ticket 和验收记录中的早期数字、故障与处理过程保留为历史证据。**代码合入、云端部署、模拟器验证、真机验证是四个不同状态。**

尚未完成的事项、决策关卡与人工验收的前置条件集中列在[待办总表](tasks/pending.md)；本页描述「现在是什么状态」，该页回答「接下来还剩哪几件事、谁做、判据是什么」。

## 版本边界

| 对象 | 已核实状态 | 证据与边界 |
| --- | --- | --- |
| GitHub `main` | **2026-09-29 本轮合并后为 `8cd748f`**：工具与来源核验合计四张 PR 已合入——目标日 [PR #95](https://github.com/Iskuyal/wx-match/pull/95)（#90）、升学/实习来源目录与 20 题检索 PoC [PR #97](https://github.com/Iskuyal/wx-match/pull/97)（#93）、官方来源核验 + 校历与考试日期卡 + 体测估算 [PR #102](https://github.com/Iskuyal/wx-match/pull/102)（#89/#91/#92，`feat/campus-tools-main`）、带出处的升学问答本地演示 [PR #103](https://github.com/Iskuyal/wx-match/pull/103)（#94，`feat/advancement-demo-main`）；此前的核对点是 `c0c6b20`，此前已合入的 PR 有：审查修复 [PR #67](https://github.com/Iskuyal/wx-match/pull/67)、部门动态 RAG [PR #69](https://github.com/Iskuyal/wx-match/pull/69)、选题归档 [PR #71](https://github.com/Iskuyal/wx-match/pull/71)、答辩陪练规划 [PR #72](https://github.com/Iskuyal/wx-match/pull/72)、内容安全检测窗口修复 [PR #74](https://github.com/Iskuyal/wx-match/pull/74)、状态页核对 [PR #75](https://github.com/Iskuyal/wx-match/pull/75)、失物招领非 AI 基线 [PR #76](https://github.com/Iskuyal/wx-match/pull/76) 与校园 AI 候选补充 [PR #77](https://github.com/Iskuyal/wx-match/pull/77) 已合入 | **本行是核对点，不是「当前主线」的实时值**——此后每次合入（含状态文档自身的 PR）都会让 `main` 前进，不逐次追记，下次核对时一并刷新。代码合入与云端生效分别核对；答辩陪练目前只有规划，失物招领只到非 AI 基线 |
| 自动化与模拟器 | 2026-09-27 审查修复分支的 `npm run typecheck` 与 `npm test`（471/471）通过；部门动态 RAG 合并前 2026-09-28 记录 `npm test` 490/490 通过，见[部门 RAG 证据](evidence/department-rag/README.md)；同日内容安全检测窗口修复（审计 CT-01/CT-02）后 `npm test` **504/504** 通过，审计探针复跑见[证据](evidence/content-safety-audit-2026-09-27/README.md)。2026-09-26 的 `npm run verify:wechat` 24 项全过属于较早的模拟器记录 | 本地/CI 检查不等于当前代码已部署，也不等于新功能真机验收 |
| 云端 | 2026-09-24 从当时的 `main` 合并提交 `0f184cd` 部署 `ai`、`newsSync`、`timetable`，三条均 Active；当时远端入口文件与锁文件哈希读回一致，`timetable` 的 SheetJS 为 0.20.3。**该核对不适用于其后的主线代码。**2026-09-25 开发者工具中维护者探测按预期拒绝；文字冒烟 3/3 返回空模型响应。**2026-09-29 上午回读**确认三条仍停在 2026-09-24 版（`ai` 缺 #67 记账闸门、#69 部门动态检索、#74 窗口拒绝与分片上限文案）；**当天先后部署了新版 `ai`（16 文件 / 75.6 KB）与 `timetable`（7 文件 / 37.1 KB）**，两条都先把旧版下载留档（`ai/index.js` `a89b3127…`、`timetable/index.js` `1b68c504…`），部署后 `download` 回读与本地构建**逐字节一致**（`ai` `8707f5a3…`、`timetable` `3c59db57…`），`info` 仍 Active（`ai` timeout 60）；**`newsSync` 未动**，仍是 2026-09-24 版 | [云端证据](evidence/security-remediation/README.md)、[复测记录](evidence/cloud-recheck/README.md)；**内容安全窗口修复（V8）的输入侧已在线上验证**（探针 1：`invalid_request`、`usage`/`safety` 为空、1469ms 就拒绝），**输出侧按 B 方案改为「多片全检」判据并已通过**（维护者送检 6000 字＝3 片、`safety.checked=true`、2669ms；探针整轮 exit 0）——**该判据不再等价于「2 万字窗口被用满」**，「输出 >4 万字即不返回」仍只有单测覆盖；**须与新版客户端一起发**（旧客户端在长对话里会被「输入过长」拒绝）；**V7 旧数据可读已实测**（`list` 返回 51 门课程、无「批次标记损坏」），首次整份替换与手工新增仍待验；**V3 已通过**（`probe:wechat` 退出码 0、`valid: true`、两条接口 `errcode 0`），维护者 `usage` 读到当月 **790 次调用 / 212,525 token / 0.0531 元**（上限 50、告警线 40，未告警）；**V2** 单账号部分已验（第 7 次同分钟调用返回「本分钟调用次数超过 6 次」），两账号归属与个人日额度仍待验；V1 独立定时器待日志。**2026-09-29 当天内容安全检测日配额已用尽（`errcode 45009`，fail-closed）**，AI 三处落点当天不可用，演示前须重查额度 |
| 发布 | 本次参赛采用微信开发者工具「预览」做真机演示；认证、备案、体验版及正式发布不在已完成范围 | [Ticket 08](tasks/tickets/08-post-publish-single-page-mode.md) 为 `wontfix`，未登录单页模式未实测 |

## 功能与验收

| 功能 | 已有成果 | 仍需验证或完成 |
| --- | --- | --- |
| 首页、学生部门、官网资讯 | 页面与公开资料、云端资讯读取已实现；负责人确认 A5 真机路径和 C1 真实多页/定时核对通过 | 本轮设备、第二页与云端定时记录待归档；Ticket 04 的目标栏目全量入库另计 |
| Excel 课表与手工编辑 | 负责人确认 A1–A4 的导入、放弃、手工编辑与双账号界面隔离通过 | 样本、字段对照、设备与版本待归档；服务端越权及当前分支部署另计 |
| AI 基础与三个落点 | 负责人确认 B1–B4 的截图识别、两组问答题集与失败降级通过；2026-09-25 三次空模型响应是历史故障记录 | B1 逐字段准确率、B2/B3 逐题结果、逐次耗时/成本待归档；文字链路当前可靠性及当前分支部署另计 |
| 部门动态 RAG | 代码已随 PR #69 合入；离线题集 recall@1 为 4/5、recall@3 为 5/5 | 真实模型 10 题、引用正确性、云端部署与真机效果仍待验证 |
| 目标日（本机倒计时） | [PR #95](https://github.com/Iskuyal/wx-match/pull/95) 合入：本机存储、Asia/Shanghai 日历日、未到期/今天/已过期三组与编辑页；设计图 5 张、模拟器验收 9 项、整机回归 25 项，见[证据](evidence/goal-days/README.md) | 设计图仍是**待评审**（4 条待拍板项）；真机未测；`realDevice: false` |
| 校历与考试日期卡 | [PR #102](https://github.com/Iskuyal/wx-match/pull/102) 合入：版本化人工核准数据（四六级 4 条有官方日期）、无日期事项的三种降级、`validateEvents()` 自检；模拟器 6 项，见[证据](evidence/campus-tools/README.md) | 报名截止不显示（公告写明各考点自定）；学校校历与普通话只有官方入口；设计图待评审；真机未测 |
| 体测估算 | [PR #102](https://github.com/Iskuyal/wx-match/pull/102) 合入：按《国家学生体质健康标准（2014年修订）》大学组评分表本地计算，附加分与等级、缺项说明；来源核验见[文档](product/sources/fitness-standard.md) | BMI「超重」一档原表未给分（不给总分与等级）；「低于最低档按 0 分」是估算器口径、待拍板；学校实际采用规则未核实；真机未测 |
| 升学 / 实习问答 | [PR #97](https://github.com/Iskuyal/wx-match/pull/97) 合入来源目录与 20 题检索 PoC（[报告](evidence/advancement-poc/README.md)：来源约束检索 20 题全过、关键词检索在 7 道守门题上 0%）；[PR #103](https://github.com/Iskuyal/wx-match/pull/103) 合入**不接模型**的本地演示页（原文摘录 + 出处卡片 + 澄清/拒答） | **模型作答这一层未验**（内容安全日配额用尽）：引用核对、成本与时延缺数据；20 题在评测集上调参、语料仅 25 段；设计图待评审；模拟器与真机未做 |
| 失物招领 | 非 AI 基线（发布、规则找线索、人工认领的五页面与 `lost-found` 云函数）连同设计图与离线评测集已随 [PR #76](https://github.com/Iskuyal/wx-match/pull/76) 合入，评测见[阶段证据](evidence/lost-found/README.md) | 范围本身尚未纳入已确认首版（[框架](planning/lost-found-framework.md)的决策关卡 D1–D3 待负责人）；AI 图文匹配（LF-4）未开始、设计图待评审、云端部署与真机回归未做 |
| 校园通知 RAG、OCR | [Ticket 10](tasks/tickets/10-campus-rag-qa.md) 有语料 PoC；[Ticket 11](tasks/tickets/11-ocr-document-parsing.md) 有 OCR 清单与脚本 | 尚未形成可对学生开放的 RAG 问答或已抽检入库的 OCR 语料；国赛版方向，不能计入省赛已完成能力 |
| 课程项目答辩陪练 | [规划](planning/ai-project-defense-plan.md)已合入 | 样本、设计、代码、真实模型与真机验收均未完成，不能列为已实现能力 |
| 参赛材料 | [七项材料模板](competition/submission.md)与历史截图存在 | 正式作品名、校内收口日期、真机录屏、效果评估、七项完整正文、提交回执 |

[开发规格](product/spec.md)里的 AI 单次响应 ≤2 秒是原验收目标，已有文字冒烟约 4.6 秒；本轮逐次耗时尚未归档，不能写成已达标。负责人仍需决定是否调整分场景目标。

## 使用真实学生数据前的关口

1. [PR #57 安全审计](review/pr-57-security-audit.md)记录的 SEC-01 至 SEC-05 已有[代码整改](review/security-remediation-2026-09-24.md)；三条云函数已部署且代码哈希读回一致。负责人确认的 A4 仅覆盖双账号**界面隔离**、C1 覆盖资讯定时核对；**服务端越权调用、个人额度边界与安全规则在当前部署版本的验证仍需独立证据**。公开招募试点仍不在本次参赛范围。
2. [数据使用说明](product/data-usage.md)已记录当前处理链路，但第三方模型的保存期限、数据处理责任方、完整删除途径及校方授权范围尚待确定；仓库文档不等于已向小程序用户完成告知。
3. CLI 函数列表已确认 PR #57 遗留的一次性探针函数 `xlsx-cdn-probe` **仍存在**。它不属于 SEC-01 至 SEC-05 的业务入口，仍应由维护者在云开发控制台清理并保存结果。

真实效果的执行步骤与记录格式见[人工验收清单](testing/manual-acceptance.md)。
