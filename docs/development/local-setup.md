# 本地开发与验证

以下命令均从仓库根目录执行。命令脚本以 [package.json](../../package.json) 为准；本页说明前置条件与常见陷阱，不记录每轮通过数字。

## 环境与安装

- Node.js ≥22、npm；CI 使用 Node.js 24。
- 微信开发者工具，以及使用项目 AppID 和云环境所需的团队权限。
- AI 密钥仅配置在云函数运行环境；本地类型检查和 Node 测试无需调用真实模型。

```powershell
npm ci
npm run docs:check
npm run typecheck
npm test
```

`npm test` 先执行 `npm run build`，再运行 `tests/*.test.cjs`。这些检查不等于部署成功或真机验收。

## 构建与导入

```powershell
npm run build
```

在微信开发者工具中导入 **`dist/`**。构建会编译小程序与三条云函数，并复制 WXML、WXSS、JSON 及根目录 `project.config.json`。基础库版本以根配置为准，不在 `dist` 内单独修改。

- 修改源码后重新构建；构建会清理生成目录内容，手工文件不要放在 `dist/`。
- `miniprogram/` 与 `cloudfunctions/` 才是源码；生成物和本地 `artifacts/` 不提交。
- 静态学校、部门资料可用于基础页面预览；资讯云读取、课表存储和 AI 功能需要云开发配置。
- `npm run verify:goals` 与 `npm run verify:campus-tools` 默认输出本地 `artifacts/verify/`，不覆盖历史证据；可通过 `WECHAT_VERIFY_OUTPUT` 指定新归档目录。新功能纠错的定向模拟器验收使用 `node scripts/verify-review-fixes.cjs`，临时目标日结束后恢复原本机数据。

本地构建不上传云函数。部署前读 [部署关卡](cloud/deployment.md)，不能把历史部署记录当作本次已部署。

## 开发者工具自动化

先在开发者工具中登录并启用 CLI 服务端口。下面的 `$cli` 必须替换为本机真实 CLI 路径；`$project` 从当前仓库自动解析。

```powershell
$cli = 'C:/path/to/微信web开发者工具/cli.bat'
$project = (Resolve-Path ./dist).Path
& $cli auto --project $project --auto-port 9420 --trust-project
npm run verify:wechat
```

页面自动化输出位于 `artifacts/verify/`。默认连接端口为 9420，可通过 `WECHAT_AUTO_PORT` 覆盖。重新构建后应重新执行 CLI auto，等待工具就绪再验证。

## 端上云函数冒烟

以下命令会连接真实云环境；模型调用可能计费，执行前确认函数部署、环境变量、维护者权限与预算。

| 命令 | 目的 |
| --- | --- |
| `npm run probe:wechat` | 探测微信内容安全调用路径 |
| `npm run smoke:ai` | 固定短文本的 AI 端到端调用 |
| `npm run smoke:ai:vision` | 合成小图的图片链路调用，不代表真实课表识别准确率 |
| `npm run smoke:settings` | 课表设置云端链路 |

它们都需要前一节的自动化连接。依赖微信内容安全的动作应从小程序端验证；控制台「测试」页的调用上下文不能替代端上票据。契约与前置见 [AI 手册](cloud/ai.md) 和 [课表手册](cloud/timetable.md)。

## 编译缓存异常

连续重建后，开发者工具可能仍引用旧文件或报“文件已存在却未定义”。先确认导入的是当前仓库的 `dist`，再清理编译缓存并重新打开项目：

```powershell
& $cli cache --clean compile --project $project
```

`$cli`、`$project` 沿用自动化一节的本机配置。不要通过修改生成文件修复此类问题。

## 测试与证据

- [自动化测试](../../tests/)覆盖页面行为、服务和云函数逻辑；[真实课表样本说明](../../tests/fixtures/timetable/README.md)记录来源与数据注意事项。
- [人工验收清单](../testing/manual-acceptance.md)覆盖真实版式、双账号、设备、模型效果及失败路径。
- [证据目录](../evidence/README.md)保留历史结果。新证据注明日期、Git 版本、部署版本、设备或环境、预期与实际结果。
- `npm run docs:check` 只检查本地文档引用，不校验外部网站可访问性，也不证明外部规则仍有效。
