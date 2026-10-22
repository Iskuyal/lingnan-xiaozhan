# 任务入口

这里只放可跟踪的执行事项；新增方向与讨论稿放在 [planning/](../planning/README.md)。先核对 [当前状态](../status.md) 与 [待办总表](pending.md)，再决定下一步；G0–G4提示词保留历史，不能当作当前未做事项重新执行；不要从历史 Ticket 的未勾选项推断当前功能尚未实现。

| 入口 | 用途 |
| --- | --- |
| [项目答辩练习G0历史提示词](project-defense-g0-prompt.md) | 交给其他执行者准备事实卡、冻结样例与评价规则；Issue #111 |
| [项目答辩练习G1历史提示词](project-defense-g1-prompt.md) | 交给其他执行者跑受控文字 PoC 与首次反馈评测；Issue #112，依赖 #111 |
| [项目答辩练习G1历史续跑提示词](project-defense-g1-resume-prompt.md) | 离线部分已交付后，接力跑真实调用与逐例判定；Issue #112 |
| [项目答辩练习G4部署与真实验收提示词](project-defense-g4-prompt.md) | 合并 PR #124–#126 → 部署回读 → 端到端与真机 → 新冻结样例首评与对照；Issue #115 |
| [项目答辩练习G4收尾与G5交接提示词](project-defense-g4-resume-prompt.md) | G4 已执行完（PR #127）：收人类复核与待拍板项，把时延/额度/审核配置写成 G5（10-08）输入；Issue #115 / #116 |
| [G1首评重跑历史提示词](project-defense-g1-first-eval-prompt.md) | 2026-10-01未合入的历史交接；G1已由后续首评覆盖，当前从待办总表执行 |
| [答辩练习agent清单历史提示词](project-defense-agent-doable-prompt.md) | 2026-10-02交接记录；A1–A5已由后续收尾覆盖，当前从待办总表执行 |
| [升学模型阶段提示词](advancement-model-prompt.md) | 模型已接入；先核账与取得预算配置决定，再恢复真实独立题与引用验收 |
| [待办总表](pending.md) | 未决事项、未完成项、证据归档与负责人前置 |
| [12 张执行 Ticket](tickets/README.md) | 逐票的状态、依赖、验收标准和历史成果 |
| [资讯后续范围](p3-2-news-updates.md) | P3-2 的栏目、全量与增量同步决策 |
| [任务管理约定](../agents/issue-tracker.md) | 本地 Ticket 与 GitHub Issues 的分工 |
| [分流标签](../agents/triage-labels.md) | 五类状态的含义 |

## 使用规则

- 阶段任务在 GitHub Issues；当前 12 张执行票按负责人要求保留在仓库，不重复建 Issue。
- 同时检查 `Status`、`Blocked by` 和人工决策前置；完成一张本地票不自动关闭阶段 Issue。
- 实施结果、云端部署和效果验证分别记录。负责人确认通过但原始记录未归档的项目，不要求凭空重做，也不宣称已有完整证据。
- 新主线先完成规划中的决策关卡，再按任务载体约定拆票；整理文档不自动批准开发。
