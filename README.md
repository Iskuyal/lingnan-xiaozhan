# wx-match

AI 微信小程序开发挑战赛参赛项目。`wx-match` 是临时仓库名，正式作品名称待定。

当前状态见[项目状态](docs/status.md)：P1–P3 的基础页面和资讯链路、导入制课表及三个 AI 落点的代码已形成；课表改版与依赖整改随 PR #57 合入 `main`。云端部署、模拟器验收与真机效果分别记录，不以合并代码代替真实效果验收。

## 项目入口

- [项目设定与待定事项](CONTEXT.md)
- [项目当前状态与验证边界](docs/status.md)
- [数据使用说明](docs/data-usage.md)
- [真实环境人工验收清单](docs/testing/manual-acceptance.md)
- [开发规格与功能边界](docs/development-spec.md)
- [分段开发、依赖与验收](docs/development-phases.md)
- [框架选择](docs/adr/0001-native-wechat-typescript.md)
- [云开发环境与 P3 云端实施](docs/cloud-development.md)
- [赛事要求、评分与待核实事项](docs/competition.md)
- [赛事信息核实：已核实事实与待问清单](docs/tasks/competition-verification.md)
- [候选场景对比与选题建议](docs/tasks/scenario-comparison.md)
- [执行 Ticket（11 票，含依赖关系）](docs/tasks/tickets/README.md)
- [比赛工作流与阶段验收](docs/workflow.md)
- [作品说明模板与提交清单](docs/submission.md)
- [架构决策记录](docs/adr/README.md)
- [原始赛题文档](docs/reference/AI微信小程序开发挑战赛.md)
- [公众号文章作为资讯数据源的可行性核查](docs/reference/wechat-mp-access-research.md)
- [小程序使用他人公众号内容的规则边界](docs/reference/miniprogram-mp-content-rules.md)

## 协作

阶段任务在 [GitHub Issues](https://github.com/Iskuyal/wx-match/issues) 管理；当前 11 张执行票按负责人要求保存在 [本地 Ticket](docs/tasks/tickets/README.md)，不重复建 Issue。每个任务包含问题、范围、验收标准和成果证据；开发使用短期分支和 PR，提交说明及交付报告使用中文。

开始工作前阅读 [AGENTS.md](AGENTS.md)。原生 TypeScript 小程序代码位于 `miniprogram/`，构建产物位于 `dist/`，后台在 P3 引入微信云开发。

## 本地运行

使用 Node.js 22 或以上版本（本轮使用 24.16.0）和微信开发者工具。

```powershell
npm ci
npm run typecheck
npm test
```

`npm test` 会先构建，再执行页面行为测试。单独更新产物使用 `npm run build`。

在微信开发者工具中选择“导入项目”，目录选择本仓库下的 **dist**，项目类型为小程序。根目录 `project.config.json` 已配置团队真实 AppID；修改配置后重新构建，勿只编辑会被覆盖的 dist 配置。基础库锁定为历史验收使用的 3.17.2。

源文件修改后重新运行构建，开发者工具加载 dist 中的更新。构建会清理整个 dist 生成目录，配置修改应保存在根目录，勿将手工文件放在 dist。重新构建后运行自动化前，重新执行 CLI auto 并等待工具就绪。无需云环境、教务账号或模型密钥即可运行 P1。

## 自动化验证

启用微信开发者工具的 CLI 服务端口，并登录工具。使用你本机的 CLI 路径和 dist 绝对路径开启自动化，例如：

```powershell
& 'D:\微信web开发者工具\cli.bat' auto --project 'F:\VibeCoding\wx-match\dist' --auto-port 9420 --trust-project
npm run verify:wechat
```

验证脚本通过真实页面点击检查首页、学生部门列表与详情、课表状态页、资讯列表与详情，输出截图和结果至 `artifacts/verify/`。Node 测试只验证页面行为与微信 API 边界，不替代开发者工具验证。

AI 的三条云端链路同样从小程序端验证（过内容安全的动作**不能**用控制台「测试」页跑，见 [云开发文档](docs/cloud-development.md)）：`npm run probe:wechat`（微信内容安全接口探测）、`npm run smoke:ai`（文本端到端）、`npm run smoke:ai:vision`（图片路径端到端，内联合成小图、跑完自动清理云存储）。三者依赖上面同一条 `cli auto` 前置。

构建会整体重建 `dist`，开发者工具的增量编译在连续重建后可能残留旧状态（引用旧内容或报「文件已存在却未定义」）。出现这种情况时执行 `& 'D:\微信web开发者工具\cli.bat' cache --clean compile --project '<dist 绝对路径>'` 并重新打开项目，强制全量编译。

当前截图及环境见 [P2 / P3 验证记录](docs/evidence/p2-p3/README.md) 与 [P1 验证记录](docs/evidence/p1/README.md)。自动化 SDK 仅用于本机测试，其图像依赖通过 npm override 固定到兼容版本，不打入小程序包。

## 下一步

按[项目状态](docs/status.md)核对 GitHub 版本、云端部署和已验收范围；按[人工验收清单](docs/testing/manual-acceptance.md)补双账号、真实版式课表、AI 题集及真机结果。分带 `vision` 在合成小图上已有云端成功记录，真实课表截图的准确率尚未测定。正式作品名与参赛七项材料仍待完成，见[提交清单](docs/submission.md)。
