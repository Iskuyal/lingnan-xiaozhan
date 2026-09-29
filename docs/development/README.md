# 开发指南

新成员先读 [本地开发与验证](local-setup.md)，接任务时再读对应功能手册。项目使用原生微信小程序 + TypeScript，技术取舍见 [ADR-0001](../adr/0001-native-wechat-typescript.md)。

## 开始一次改动

1. 按 [产品规格](../product/spec.md) 确认范围，按 [领域术语](../../CONTEXT.md) 统一用词。
2. 在 [任务索引](../tasks/README.md) 确认执行载体、依赖和验收条件；查看 [项目状态](../status.md) 的版本边界。
3. 说明最小实施计划及验证方式；界面改动先按 [设计约定](../design/README.md)完成设计评审。
4. 按下表查阅相关手册，完成检查后记录真实结果；提交说明和报告使用中文。

## 开发资料

| 文档 | 何时读取 |
| --- | --- |
| [本地开发与验证](local-setup.md) | 首次运行、构建、CLI 自动化、缓存排查 |
| [开发阶段](phases.md) | 理解 P0–P6、功能依赖和交付边界 |
| [协作与比赛工作流](workflow.md) | 分支、PR、任务验收与交付倒排 |
| [云开发手册](cloud/README.md) | 环境接入、部署、资讯、课表和 AI |
| [验证指南](../testing/README.md) | 区分自动化、模拟器、真机及证据 |
| [文档导航与维护规则](../README.md) | 新增、移动或整理文档 |

当前范围和历史阶段记录可能包含不同时间点的信息；冲突先核对版本，不用某次测试数字代替当前分支结果。

## 协作模板

新增 GitHub 任务使用[任务模板](../../.github/ISSUE_TEMPLATE/task.md)，提交 PR 使用[审查模板](../../.github/pull_request_template.md)。模板是填写结构，不代表其中的检查已经执行；现有本地 Ticket 按[任务约定](../agents/issue-tracker.md)维护。
