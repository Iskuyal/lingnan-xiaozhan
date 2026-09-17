# wx-match

AI 微信小程序开发挑战赛参赛项目。`wx-match` 是临时仓库名，正式作品名称待定。

当前阶段：P1 首页入口、P2 学生部门、P3 资讯栏目（不含云端同步）已实现并通过微信开发者工具验收，记录见 [P2 / P3 验证记录](docs/evidence/p2-p3/README.md)；云端同步、教务接入与 AI 能力按后续阶段推进。

## 项目入口

- [项目设定与待定事项](CONTEXT.md)
- [开发规格与功能边界](docs/development-spec.md)
- [分段开发、依赖与验收](docs/development-phases.md)
- [框架选择](docs/adr/0001-native-wechat-typescript.md)
- [云开发环境与 P3 云端实施](docs/cloud-development.md)
- [赛事要求、评分与待核实事项](docs/competition.md)
- [比赛工作流与阶段验收](docs/workflow.md)
- [作品说明模板与提交清单](docs/submission.md)
- [架构决策记录](docs/adr/README.md)
- [原始赛题文档](docs/reference/AI微信小程序开发挑战赛.md)

## 协作

任务在 [GitHub Issues](https://github.com/Iskuyal/wx-match/issues) 管理。每个任务包含问题、范围、验收标准和成果证据；开发使用短期分支和 PR，提交说明及交付报告使用中文。

开始工作前阅读 [AGENTS.md](AGENTS.md)。原生 TypeScript 小程序代码位于 `miniprogram/`，构建产物位于 `dist/`，后台在 P3 引入微信云开发。

## 本地运行

使用 Node.js 22 或以上版本（本轮使用 24.16.0）和微信开发者工具。

```powershell
npm ci
npm run typecheck
npm test
```

`npm test` 会先构建，再执行页面行为测试。单独更新产物使用 `npm run build`。

在微信开发者工具中选择“导入项目”，目录选择本仓库下的 **dist**，项目类型为小程序。配置默认使用 `touristappid`，可验证 P1 本地公开页面；真机预览、上传和云开发需使用团队实际 AppID。修改根目录 `project.config.json` 的 `appid` 后重新构建，勿只编辑会被覆盖的 dist 配置。基础库锁定为本轮验证的 3.17.2。

源文件修改后重新运行构建，开发者工具加载 dist 中的更新。构建会清理整个 dist 生成目录，配置修改应保存在根目录，勿将手工文件放在 dist。重新构建后运行自动化前，重新执行 CLI auto 并等待工具就绪。无需云环境、教务账号或模型密钥即可运行 P1。

## 自动化验证

启用微信开发者工具的 CLI 服务端口，并登录工具。使用你本机的 CLI 路径和 dist 绝对路径开启自动化，例如：

```powershell
& 'D:\微信web开发者工具\cli.bat' auto --project 'F:\VibeCoding\wx-match\dist' --auto-port 9420 --trust-project
npm run verify:wechat
```

验证脚本通过真实页面点击检查首页、学生部门列表与详情、课表状态页、资讯列表与详情，输出截图和结果至 `artifacts/verify/`。Node 测试只验证页面行为与微信 API 边界，不替代开发者工具验证。

构建会整体重建 `dist`，开发者工具的增量编译在连续重建后可能残留旧状态（引用旧内容或报「文件已存在却未定义」）。出现这种情况时执行 `& 'D:\微信web开发者工具\cli.bat' cache --clean compile --project '<dist 绝对路径>'` 并重新打开项目，强制全量编译。

当前截图及环境见 [P2 / P3 验证记录](docs/evidence/p2-p3/README.md) 与 [P1 验证记录](docs/evidence/p1/README.md)。自动化 SDK 仅用于本机测试，其图像依赖通过 npm override 固定到兼容版本，不打入小程序包。

## 下一步

P2 与 P3 的非云端部分已交付并经开发者工具验收；云开发环境已开通，P3 云端部分（云函数、数据库、构建接入）可按 [云开发环境与 P3 云端实施](docs/cloud-development.md) 开始，运行时与 SDK 版本在执行时核实锁定。其余阻断项为 P4-A 教务接入可行性调研与 P5-A AI 能力定案。微信真机预览尚未执行。教务接入与 AI 能力按阶段单独验证；正式作品名仍待定。比赛截止日期按 [赛事要求](docs/competition.md) 管理，原文冲突需向组委会确认。
