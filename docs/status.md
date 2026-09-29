# 项目当前状态

云端部署状态核对日期：2026-09-24；本地自动化证据更新至 2026-09-28，开发者工具模拟器点测更新至 2026-09-26。**2026-09-27 负责人确认人工验收 A1–C1 全部通过，详细记录待归档**，见[人工验收清单](testing/manual-acceptance.md)；已测 Git/云函数版本尚未提供，不能外推到当前 `main`。此页是当前版本的状态入口；各 Ticket 和验收记录中的早期数字、故障与处理过程保留为历史证据。**代码合入、云端部署、模拟器验证、真机验证是四个不同状态。**

尚未完成的事项、决策关卡与人工验收的前置条件集中列在[待办总表](tasks/pending.md)；本页描述「现在是什么状态」，该页回答「接下来还剩哪几件事、谁做、判据是什么」。

## 版本边界

| 对象 | 已核实状态 | 证据与边界 |
| --- | --- | --- |
| GitHub `main` | 2026-09-29 核对为 `148b9da`；审查修复 [PR #67](https://github.com/Iskuyal/wx-match/pull/67)、部门动态 RAG [PR #69](https://github.com/Iskuyal/wx-match/pull/69)、选题归档 [PR #71](https://github.com/Iskuyal/wx-match/pull/71)、答辩陪练规划 [PR #72](https://github.com/Iskuyal/wx-match/pull/72)、内容安全检测窗口修复 [PR #74](https://github.com/Iskuyal/wx-match/pull/74)、失物招领非 AI 基线 [PR #76](https://github.com/Iskuyal/wx-match/pull/76) 与校园 AI 候选补充 [PR #77](https://github.com/Iskuyal/wx-match/pull/77) 已合入 | 代码合入与云端生效分别核对；答辩陪练目前只有规划，失物招领只到非 AI 基线 |
| 自动化与模拟器 | 2026-09-27 审查修复分支的 `npm run typecheck` 与 `npm test`（471/471）通过；部门动态 RAG 合并前 2026-09-28 记录 `npm test` 490/490 通过，见[部门 RAG 证据](evidence/department-rag/README.md)；同日内容安全检测窗口修复（审计 CT-01/CT-02）后 `npm test` **504/504** 通过，审计探针复跑见[证据](evidence/content-safety-audit-2026-09-27/README.md)。2026-09-26 的 `npm run verify:wechat` 24 项全过属于较早的模拟器记录 | 本地/CI 检查不等于当前代码已部署，也不等于新功能真机验收 |
| 云端 | 2026-09-24 从当时的 `main` 合并提交 `0f184cd` 部署 `ai`、`newsSync`、`timetable`，三条均 Active；当时远端入口文件与锁文件哈希读回一致，`timetable` 的 SheetJS 为 0.20.3。**该核对不适用于其后的主线代码。**2026-09-25 开发者工具中维护者探测按预期拒绝；文字冒烟 3/3 返回空模型响应 | [云端证据](evidence/security-remediation/README.md)、[复测记录](evidence/cloud-recheck/README.md)；新版 `ai`/`timetable` 部署、V1 独立定时器运行核验、V2 两账号服务端归属/额度及合法维护者路径仍待验；**内容安全窗口修复（V8）已随 PR #74 合入 `main`，但未部署，线上仍是修复前行为**，且需与新版客户端一起发 |
| 发布 | 本次参赛采用微信开发者工具「预览」做真机演示；认证、备案、体验版及正式发布不在已完成范围 | [Ticket 08](tasks/tickets/08-post-publish-single-page-mode.md) 为 `wontfix`，未登录单页模式未实测 |

## 功能与验收

| 功能 | 已有成果 | 仍需验证或完成 |
| --- | --- | --- |
| 首页、学生部门、官网资讯 | 页面与公开资料、云端资讯读取已实现；负责人确认 A5 真机路径和 C1 真实多页/定时核对通过 | 本轮设备、第二页与云端定时记录待归档；Ticket 04 的目标栏目全量入库另计 |
| Excel 课表与手工编辑 | 负责人确认 A1–A4 的导入、放弃、手工编辑与双账号界面隔离通过 | 样本、字段对照、设备与版本待归档；服务端越权及当前分支部署另计 |
| AI 基础与三个落点 | 负责人确认 B1–B4 的截图识别、两组问答题集与失败降级通过；2026-09-25 三次空模型响应是历史故障记录 | B1 逐字段准确率、B2/B3 逐题结果、逐次耗时/成本待归档；文字链路当前可靠性及当前分支部署另计 |
| 部门动态 RAG | 代码已随 PR #69 合入；离线题集 recall@1 为 4/5、recall@3 为 5/5 | 真实模型 10 题、引用正确性、云端部署与真机效果仍待验证 |
| 失物招领 | 非 AI 基线（发布、规则找线索、人工认领的五页面与 `lost-found` 云函数）连同设计图与离线评测集已随 [PR #76](https://github.com/Iskuyal/wx-match/pull/76) 合入，评测见[阶段证据](evidence/lost-found/README.md) | 范围本身尚未纳入已确认首版（[框架](tasks/lost-found-framework.md)的决策关卡 D1–D3 待负责人）；AI 图文匹配（LF-4）未开始、设计图待评审、云端部署与真机回归未做 |
| 校园通知 RAG、OCR | [Ticket 10](tasks/tickets/10-campus-rag-qa.md) 有语料 PoC；[Ticket 11](tasks/tickets/11-ocr-document-parsing.md) 有 OCR 清单与脚本 | 尚未形成可对学生开放的 RAG 问答或已抽检入库的 OCR 语料；国赛版方向，不能计入省赛已完成能力 |
| 课程项目答辩陪练 | [规划](tasks/ai-project-defense-plan.md)已合入 | 样本、设计、代码、真实模型与真机验收均未完成，不能列为已实现能力 |
| 参赛材料 | [七项材料模板](submission.md)与历史截图存在 | 正式作品名、校内收口日期、真机录屏、效果评估、七项完整正文、提交回执 |

[开发规格](development-spec.md)里的 AI 单次响应 ≤2 秒是原验收目标，已有文字冒烟约 4.6 秒；本轮逐次耗时尚未归档，不能写成已达标。负责人仍需决定是否调整分场景目标。

## 使用真实学生数据前的关口

1. [PR #57 安全审计](review/pr-57-security-audit.md)记录的 SEC-01 至 SEC-05 已有[代码整改](review/security-remediation-2026-09-24.md)；三条云函数已部署且代码哈希读回一致。负责人确认的 A4 仅覆盖双账号**界面隔离**、C1 覆盖资讯定时核对；**服务端越权调用、个人额度边界与安全规则在当前部署版本的验证仍需独立证据**。公开招募试点仍不在本次参赛范围。
2. [数据使用说明](data-usage.md)已记录当前处理链路，但第三方模型的保存期限、数据处理责任方、完整删除途径及校方授权范围尚待确定；仓库文档不等于已向小程序用户完成告知。
3. CLI 函数列表已确认 PR #57 遗留的一次性探针函数 `xlsx-cdn-probe` **仍存在**。它不属于 SEC-01 至 SEC-05 的业务入口，仍应由维护者在云开发控制台清理并保存结果。

真实效果的执行步骤与记录格式见[人工验收清单](testing/manual-acceptance.md)。
