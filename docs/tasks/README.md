# 任务入口

这里只放可跟踪的执行事项；新增方向与讨论稿放在 [planning/](../planning/README.md)。先核对 [当前状态](../status.md)，再决定下一步；不要从历史 Ticket 的未勾选项推断当前功能尚未实现。

| 入口 | 用途 |
| --- | --- |
| [项目答辩练习G0提示词](project-defense-g0-prompt.md) | 交给其他执行者准备事实卡、冻结样例与评价规则；Issue #111 |
| [项目答辩练习G1提示词](project-defense-g1-prompt.md) | 交给其他执行者跑受控文字 PoC 与首次反馈评测；Issue #112，依赖 #111 |
| [项目答辩练习G1真实评测续跑提示词](project-defense-g1-resume-prompt.md) | 离线部分已交付后，接力跑真实调用与逐例判定；Issue #112 |
| [升学模型阶段提示词](advancement-model-prompt.md) | 新会话执行下一阶段模型版与真实引用评测 |
| [待办总表](pending.md) | 未决事项、未完成项、证据归档与负责人前置 |
| [11 张执行 Ticket](tickets/README.md) | 逐票的状态、依赖、验收标准和历史成果 |
| [资讯后续范围](p3-2-news-updates.md) | P3-2 的栏目、全量与增量同步决策 |
| [任务管理约定](../agents/issue-tracker.md) | 本地 Ticket 与 GitHub Issues 的分工 |
| [分流标签](../agents/triage-labels.md) | 五类状态的含义 |

## 使用规则

- 阶段任务在 GitHub Issues；当前 11 张执行票按负责人要求保留在仓库，不重复建 Issue。
- 同时检查 `Status`、`Blocked by` 和人工决策前置；完成一张本地票不自动关闭阶段 Issue。
- 实施结果、云端部署和效果验证分别记录。负责人确认通过但原始记录未归档的项目，不要求凭空重做，也不宣称已有完整证据。
- 新主线先完成规划中的决策关卡，再按任务载体约定拆票；整理文档不自动批准开发。
