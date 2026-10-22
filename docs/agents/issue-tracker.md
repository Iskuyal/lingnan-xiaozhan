# Issue tracker: GitHub

本仓库的需求、规格与任务使用 GitHub Issues，通过 `gh` CLI 操作。仓库从 `git remote -v` 获取；在仓库外操作时显式指定 `--repo Iskuyal/wx-match`。

## 当前执行票的例外

负责人已要求 [当前 12 张执行票](../tasks/tickets/README.md) 以仓库文件管理，不另建 GitHub Issues。GitHub #3–#6 保留阶段级范围；这 12 张票的状态、依赖、验收和成果链接更新在对应文件中。执行时同时检查 `Status` 与 `Blocked by`，实现依赖和待决策项全部解除后才能开工。

引用本地任务使用 `Ticket 03` 和文件链接，引用 GitHub 任务使用 `Issue #3`，避免编号混淆。PR 链接对应文件，必要时关联阶段 Issue；完成一张本地票不自动关闭阶段 Issue。其他新增需求仍按下方 GitHub 约定处理。

## 操作约定

- 创建：`gh issue create --title "任务标题" --body-file <正文文件>`。多行正文写 UTF-8 文件，保留真实换行。
- 读取：`gh issue view <编号> --comments`；需要结构化信息时加 `--json number,title,body,labels,comments`。
- 列出：`gh issue list --state open --json number,title,body,labels`，按需增加标签筛选。
- 评论：`gh issue comment <编号> --body-file <正文文件>`。
- 分类：`gh issue edit <编号> --add-label <标签>` 或 `--remove-label <标签>`。
- 关闭：验收达成后执行 `gh issue close <编号>`，保留成果和验证证据链接。

每条任务写明问题、范围、验收标准、评分维度、依赖和成果证据。信息充分且验收标准明确后才能标记 `ready-for-agent`。状态词义见 `triage-labels.md`。

技能要求“publish to the issue tracker”时按任务所属载体保存：上述 12 张执行票更新本地文件，其他任务创建 GitHub Issue；要求“fetch the relevant ticket”时读取对应文件，或 Issue 及评论。PR 与 Issue 共享编号空间，遇到歧义先判断对象类型。

## Pull requests as a triage surface

**PRs as a request surface: no.** PR 用于审查实现，不默认视为外部需求入口。

## Wayfinding operations

使用 wayfinder 时，以带 `wayfinder:map` 标签的 Issue 保存 Notes / Decisions-so-far / Fog；子任务按 research、prototype、grilling、task 使用 `wayfinder:<type>` 标签。
优先通过 GitHub sub-issues 关联子任务；不可用时在主 Issue 放任务列表，并在子任务写 `Part of #<编号>`。
依赖优先使用 GitHub 原生 issue dependencies；不可用时在任务顶部写 `Blocked by: #<编号>`。
选取主任务顺序中第一个未关闭、未分配且无未完成依赖的任务；认领时分配负责人，完成后记录结论、证据并关闭。
相关标签只在实际使用该流程时创建。
