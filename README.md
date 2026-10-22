# wx-match · AI 校园工具小程序

面向广东岭南职业技术学院学生的微信小程序，将学校公开信息、学生部门、校园资讯与个人课表放在同一个入口，并围绕部门问答、截图导入和课表操作接入 AI。

`wx-match` 是仓库代号，正式作品名称待定。本项目用于 AI 微信小程序开发挑战赛；参赛演示采用微信开发者工具「预览」，**不代表已正式发布或面向全校开放**。

[文档导航](docs/README.md) · [项目状态](docs/status.md) · [开发指南](docs/development/README.md) · [执行任务](docs/tasks/README.md) · [参赛交付](docs/competition/README.md)

## 已有功能与边界

| 模块 | 已有代码能力 | 关键边界 |
| --- | --- | --- |
| 校园信息 | 学校简介、学生部门列表与详情、官网资讯列表与正文 | 公开内容保留来源，缺失资料如实显示，不编造联系方式 |
| 个人课表 | Excel 导入、截图识别与校对、周课表、手工增删改、课表设置 | 由学生自行导入，不接入教务账号；个人数据按微信身份隔离 |
| 部门 AI 问答 | 根据已核实部门资料回答和追问 | 资料不足时明确告知，不把生成内容当作官方信息 |
| 课表 AI 助手 | 用自然语言查询课表、提出课程变更并由用户确认 | 模型失败时保留手工操作路径；安全、额度和模型失败分别提示 |

**代码、部署、模拟器验证和真机验证分开记录。** 2026-09-27 负责人确认人工验收 A1–C1 通过，但被测版本、原始样本和逐项结果仍待归档；不能据此宣称当前分支或全部 AI 指标已通过。详见 [项目状态](docs/status.md) 与 [人工验收清单](docs/testing/manual-acceptance.md)。

**课程项目答辩陪练（文字版）已实现并随 PR #124–#127 合入 main**：G0 素材、G1 首评、G2 设计、G3 最小流程、G4 部署与部分真机验证已交付；G5 素材及 #111/#112/#115/#116 的人类验收仍开放。校园通知 RAG 与 OCR 属于后续探索，不计入已完成能力。历史选题和当前规划在 [规划索引](docs/planning/README.md) 中区分。

## 当前版本与仓库收尾（2026-10-22）

- 代码基线：`main@00f95d6`，含 [PR #139](https://github.com/Iskuyal/wx-match/pull/139) 的岭南 UI 原生重写（16 条在用页面）；本次文档整理在其上提交，不改代码。
- 仓库收尾：远端仅保留 `main`；已合入的 3 条远端分支、2 条本地分支与 6 个遗留 worktree 已清理，合并历史保留在 PR 中。
- 验证边界：2026-10-22 依赖安全修复后，本机依赖审计（根 + 3 条云函数）、`typecheck`、767 项测试与 CI 全部通过（[CI run 39806450256](https://github.com/Iskuyal/wx-match/actions/runs/39806450256)）；未重新部署、未做真机验收。
- 依赖审计：`follow-redirects` 由 1.16.0 升至 1.16.1（2026-10-22 新披露 2 条高危公告），根与三条云函数锁文件均审计 0 漏洞。
- 赛事提交：七项说明内部稿已有；正式作品名/团队、最终真机录屏、学校授权与提交回执仍待负责人，见 [提交清单](docs/competition/submission.md)。

## 快速开始

需要 **Node.js 22 或以上版本**、npm 和微信开发者工具；CI 使用 Node.js 24。以下命令在仓库根目录执行：

```powershell
npm ci
npm run docs:check
npm run typecheck
npm test
```

`npm test` 会先构建，再运行测试。仅更新构建产物时运行 `npm run build`。

1. 在微信开发者工具中导入本仓库的 **`dist/`**，项目类型选择小程序。
2. AppID 和基础库设置以根目录 [project.config.json](project.config.json) 为准；团队 AppID 的使用需要相应权限。
3. 修改源码后重新构建。`dist/` 是可清理、可重建的输出目录，**不要在其中保存手工修改**。
4. 学校与部门的静态内容可用于基础页面预览；云端资讯、个人课表存储与 AI 需要可用云环境、已部署函数及对应配置。**本地构建不会部署云函数。**

首次配置、自动化连接、端上冒烟及编译缓存排查见 [本地开发与验证](docs/development/local-setup.md)；云环境配置见 [云开发手册](docs/development/cloud/README.md)。

## 常用检查

| 命令 | 检查范围 |
| --- | --- |
| `npm run docs:check` | 仓库 Markdown 的本地链接、资源路径和文档锚点，不访问外网 |
| `npm run typecheck` | 小程序与云函数 TypeScript 类型 |
| `npm test` | 可重复构建和 Node 自动化测试 |
| `npm run verify:wechat` | 已连接开发者工具中的页面操作与截图 |
| `npm run smoke:ai` / `npm run smoke:ai:vision` | 已配置云端的文字 / 图片 AI 链路，会产生真实调用 |

后两类命令需要先完成 [CLI 自动化连接](docs/development/local-setup.md#开发者工具自动化)，不能替代真机测试；成功结果按日期、版本和环境归档到 [验证记录](docs/evidence/README.md)。

## 代码与文档结构

```text
miniprogram/       原生微信小程序：页面、WXML/WXSS、功能服务
cloudfunctions/    ai、timetable、newsSync 三条云函数
scripts/           构建、文档检查、验证与维护脚本
tests/             自动化测试与真实导入样本
docs/              按用途分层的项目文档，入口为 docs/README.md
AGENTS.md          项目协作约定
CONTEXT.md         领域术语
dist/              构建输出（不提交）
artifacts/         本地验证输出（不提交）
submission-output/ 本地交付材料输出（不提交）
```

技术路线为 **原生微信小程序 + TypeScript/WXML/WXSS + 微信云开发**，不额外引入跨端框架。取舍见 [ADR-0001](docs/adr/0001-native-wechat-typescript.md)。

## 协作与交付

- 开始前阅读 [AGENTS.md](AGENTS.md)，按 [规格](docs/product/spec.md)、[阶段](docs/development/phases.md) 和任务验收标准推进。
- 阶段任务用 GitHub Issues；当前 12 张执行票保留在 [本地 Ticket](docs/tasks/tickets/README.md)，不重复建票。新增主线规划不自动变成已批准的实施任务。
- 分支策略：从 `main` 开短期分支，PR 合入后即删；2026-10-22 已把仓库收尾为仅 `main` 分支。
- 界面改动先做 HTML 设计图并渲染 PNG，评审定稿后再改页面；见 [设计约定](docs/design/README.md)。
- 密钥只在运行环境配置；真实样本、第三方模型处理和试点边界见 [数据使用说明](docs/product/data-usage.md)。
- 提交说明与交付报告使用中文；材料中的功能和效果必须有对应版本的证据。[提交清单](docs/competition/submission.md) 已按 2026-10-22 状态补充证据索引；七项说明内部稿已有，正式作品名、最终真机录屏、参赛包与学校回执仍待负责人。
