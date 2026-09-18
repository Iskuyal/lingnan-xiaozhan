# 项目协作指令

## 编码前思考

不要假设。不要隐藏困惑。呈现权衡。

- 明确说明假设；存在影响实现的歧义时，列出解释并询问。
- 有更简单的方法时，说明它和原方案的权衡。
- 困惑时指出不清楚的地方，澄清后再执行依赖该答案的工作。

## 目标驱动执行

定义成功标准，循环验证直到达成。

- 添加验证：先为无效输入编写测试，再让测试通过。
- 修复 bug：先编写复现测试，再修复并验证。
- 重构：确保重构前后相关测试通过。
- 多步骤任务先说明简短计划，每步写出对应的验证方式。
- 完成报告说明改动、验证结果及尚未解决的问题；区分模板、计划和实际完成的成果。

## 比赛与提交

规划功能或安排阶段时，阅读 `docs/competition.md` 和 `docs/workflow.md`；准备参赛材料时阅读 `docs/submission.md`。
开发前读取 `docs/development-spec.md`、`docs/development-phases.md` 及相关 ADR。原生微信小程序 + TypeScript、课表导入制和三个 AI 落点已定；正式名称、导入范围及 AI 成本与评估等按文档中的决策关卡处理。
Git 提交说明和提交报告使用中文，报告说明提交内容；允许 Conventional Commits 前缀。

## Agent skills

### Issue tracker

阶段任务使用 GitHub Issues，当前执行票按负责人要求保存在 `docs/tasks/tickets/`；创建、读取或更新任务前阅读 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认分流标签；分类任务前阅读 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context；探索项目或修改领域概念前按 `docs/agents/domain.md` 读取领域文档。
