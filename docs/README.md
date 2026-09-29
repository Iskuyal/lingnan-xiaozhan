# 文档导航

找文档按用途，不按创建时间。**现况看 [status.md](status.md)，待办看 [tasks/pending.md](tasks/pending.md)，范围看 [product/spec.md](product/spec.md)**；历史证据、候选方案和提交模板不覆盖这三个入口。

## 按任务阅读

| 你要做什么 | 阅读顺序 |
| --- | --- |
| 了解项目并运行 | [项目 README](../README.md) → [本地开发](development/local-setup.md) |
| 确认范围与用词 | [产品定位](product/README.md) → [领域术语](../CONTEXT.md) → [产品规格](product/spec.md) |
| 开始开发或接任务 | [协作指令](../AGENTS.md) → [开发指南](development/README.md) → [任务索引](tasks/README.md) |
| 判断新增方向 | [规划索引](planning/README.md)，先区分已选规划与历史讨论 |
| 配置、部署或排查云端 | [云开发手册](development/cloud/README.md)，再读对应函数章节 |
| 修改界面 | [设计约定与主题索引](design/README.md)，先评审设计图再改代码 |
| 验收、复测或审查 | [验证指南](testing/README.md) → [证据索引](evidence/README.md) / [审查索引](review/README.md) |
| 准备参赛交付 | [赛事要求](competition/README.md) → [提交清单](competition/submission.md) |
| 追溯依据与旧方案 | [内容来源](product/sources/README.md)、[参考资料](reference/README.md)、[历史归档](archive/README.md) |

## 目录职责

| 位置 | 保存什么 | 不保存什么 |
| --- | --- | --- |
| [status.md](status.md) | 当前实现、部署与验证边界 | 完整操作日志、未来功能宣称 |
| [product/](product/README.md) | 产品定位、功能规格、数据使用、内容来源 | 每轮测试数字和故障日志 |
| [development/](development/README.md) | 阶段、工作流、本地运行与云开发手册 | 未批准的新产品方案 |
| [tasks/](tasks/README.md) | 待办、执行票、依赖和验收判据 | 发散讨论稿 |
| [planning/](planning/README.md) | 新方向规划及其讨论过程 | 已完成成果 |
| [competition/](competition/README.md) | 赛事约束、核实结果、提交模板 | 产品运行说明 |
| [design/](design/README.md) | 设计说明、HTML 源图与 PNG 评审件 | 冒充真实界面的效果图 |
| [testing/](testing/README.md) | 验证入口和人工验收清单 | 没有执行的“通过”记录 |
| [evidence/](evidence/README.md) | 带版本、日期、环境的验收证据 | 自动覆盖当前状态的历史结论 |
| [review/](review/README.md) | 审查发现、整改与复核记录 | 脱离版本的当前风险断言 |
| [reference/](reference/README.md) | 原始赛题、规则调研、外部参考 | 无来源的产品承诺 |
| [archive/](archive/README.md) | 被替代的方案、整理前快照与早期实施过程 | 当前执行指令 |
| [adr/](adr/README.md) | 已确认且有实际取舍的架构决策 | 尚未确认的候选方案 |
| [domain/](domain/lost-found.md) | 失物招领状态机、权限与安全边界 | 已批准首版功能的宣称 |
| agents/ | [领域文档规则](agents/domain.md)、[任务载体](agents/issue-tracker.md)、[分流标签](agents/triage-labels.md) | 重复的产品规格 |

## 单一事实来源

- **领域术语**只在根目录 [CONTEXT.md](../CONTEXT.md) 定义；产品边界归规格，待决定项归待办。
- **当前状态**引用证据，不复制整段日志。代码合入、云端部署、模拟器验证、真机验证分别记录。
- **规划**注明「讨论 / 已选规划 / 实施中 / 已验收」的真实阶段；选型通过不意味着功能已实现。
- **历史**保留当时的日期、版本、测试数字和未通过项；需要修正当前判断时更新状态入口，不改写历史。
- **外部资料**保留核查时间及来源。整理路径不等于重新核实了外部规则、价格或服务可用性。

## 修改文档时

1. 更新已有权威文档优先；新增页面放入对应目录，并补到该目录索引。
2. 文档互引使用相对 Markdown 链接；代码位置使用仓库相对路径。避免把个人磁盘绝对路径作为公共入口。
3. 移动文件时同步更新链接、锚点、脚本提示和代码注释里的路径。历史截图、设计源图与原始样本原位保留。
4. 从仓库根目录运行 `npm run docs:check`；改变检查脚本时同时运行 `node --test tests/docs.test.cjs`。
5. 涉及实现时再按开发指南运行类型、行为和端上检查。文档整理本身不改变验收结论。
