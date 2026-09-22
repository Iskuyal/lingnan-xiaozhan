# PR #57 安全审计报告

- 审计日期：2026-09-22
- 审计对象：`chore/dependency-pin`（审计基线 `c28d347`）
- 目标分支：`main`
- 审计方式：依赖审计、敏感信息扫描、云函数身份与权限边界审查、网络请求与 CI 供应链检查、完整测试回归

## 结论

本次检查发现 1 项高风险、2 项中风险和 2 项低风险加固项。高、中风险位于基线已有的 AI 与资讯同步代码中，不是 PR #57 的依赖整改或课表 UI 重构新增的回归；PR #57 已消除当前依赖树中的已知 npm 漏洞，但不能替代源码授权检查。

建议：PR #57 可以保留其依赖整改成果，但在正式发布前应优先修复 SEC-01 和 SEC-02，并将 SEC-03 的调用权限从纯手工配置改为代码侧纵深防御。

## 发现

### SEC-01 高风险：AI 云函数可越权读取云存储文件

**位置**：`cloudfunctions/ai/index.ts:183-221`、`cloudfunctions/ai/index.ts:643-659`、`cloudfunctions/ai/index.ts:834-837`

`vision` 和 `moderateImage` 接受调用方提供的任意非空 `fileID`，随后直接以云函数权限执行 `cloud.downloadFile()`。代码没有验证：

- `fileID` 是否为合法的 `cloud://` 标识；
- 文件路径是否位于当前调用者的 `timetable-imports/<openid-hash>/` 前缀；
- 文件是否属于当前 `OPENID`。

云函数属于管理端，下载操作不受客户端“仅创建者可读写”规则约束。因此，只要其他用户的 `fileID` 泄露或被共享，普通调用者就可能让 AI 云函数读取并处理该文件；影响范围不限于课表截图，还可能覆盖同一云环境中的其他文件。

**现有正确范例**：`cloudfunctions/timetable/index.ts:65-97` 已实现 `cloud://` 解析、本人路径前缀和 `..` 拒绝逻辑，可抽成共享校验并在 AI 下载前调用。

**修复要求**：

1. 图片下载前必须取得非空 `OPENID`；
2. 只允许当前用户由 `preparePhotoUpload` 分配的路径；
3. 为“他人 fileID、裸路径、跨目录、空 OPENID”补充拒绝测试；
4. 错误返回中不要回显完整 `fileID`。

### SEC-02 中风险：AI 运维动作与全局额度缺少调用者隔离

**位置**：`cloudfunctions/ai/index.ts:59`、`cloudfunctions/ai/index.ts:749-850`、`cloudfunctions/ai/usage.ts:20-30`

云函数对客户端统一暴露 `chat`、`vision`、`moderateText`、`moderateImage`、`usage` 和 `probe`，未区分普通用户与维护者，也没有单用户速率或额度限制。

其中 `probe` 在配置加载、月度用量读取和成本上限判断之前直接执行，并同时调用微信文字、图片安全接口；它不记入现有月度汇总。当前项目文档记录未上架小程序的内容安全接口为每类 100 次/天，重复调用可耗尽全局日额度，导致其他用户的 AI 功能不可用。普通 `chat` / `vision` 调用也只有全局月度成本上限，缺少单用户约束。

`usage` 还会向所有可调用者返回全局调用次数、token、成本和上限，造成不必要的运维信息暴露。

**修复要求**：

1. 将 `probe`、`usage` 和独立审核动作移到维护者专用函数或增加服务端维护者白名单；
2. 对业务动作增加按 `OPENID` 的短周期限流与单用户额度；
3. `probe` 必须受独立冷却和次数限制；
4. 用量记录增加不可逆用户标识，避免存储明文 `openid`，同时支持滥用追踪。

### SEC-03 中风险：`newsSync` 授权完全依赖控制台手工规则

**位置**：`cloudfunctions/newsSync/config.json`、`cloudfunctions/newsSync/index.ts:955-1019`

文档记录当前云环境已人工配置 `newsSync.invoke=false`，因此已部署环境可能处于受保护状态；但仓库内 `config.json` 只声明定时触发器，入口代码也不校验定时来源或维护者身份。

若新环境部署、迁移或控制台权限漂移，客户端可能调用包含 `reset`、栏目选择和请求预算的同步入口，触发数据库写入及外部抓取。当前安全边界无法由代码审查和 CI 复现。

**修复要求**：入口默认只接受可信定时触发；确需手工调用时使用独立维护入口和不可伪造的服务端授权，不应只判断调用方可自填的事件字段。

### SEC-04 低风险：云函数依赖安装不可完全复现

三个云函数目录只有 `package.json`，没有独立 `package-lock.json`。构建脚本会把非 TypeScript 文件复制到部署目录，因此云端安装时传递依赖仍可能随时间变化。

PR #57 已固定直接依赖并用 `overrides` 修复已知高危传递依赖，这是有效改进；建议继续为每个独立部署单元生成并提交锁文件，部署时使用锁文件安装。

### SEC-05 低风险：CI 供应链仍可加固

`.github/workflows/check.yml` 使用 `actions/checkout@v4` 与 `actions/setup-node@v4` 可变标签，并执行允许依赖生命周期脚本的 `npm ci`。

建议将第三方 Action 固定到完整提交 SHA；若项目安装链路不依赖生命周期脚本，可评估使用 `npm ci --ignore-scripts`。

## 已确认的安全控制

- `npm audit`：critical/high/moderate/low/info 均为 0；当前锁定依赖共 175 个（生产 1、开发 174）。
- 当前文件与 Git 历史的常见私钥、GitHub token、OpenAI key、AWS key 模式扫描未发现真实凭据。
- `.env`、私钥文件和 `project.private.config.json` 已由 `.gitignore` 排除。
- 课表数据库读写按 `OPENID` 过滤，课表文件导入已进行本人路径校验。
- `newsSync` 的重定向仅跟随 `lnc.edu.cn` 及其子域，未发现重定向型 SSRF。
- GitHub Actions 权限为 `contents: read`，未发现向工作流输出密钥的逻辑。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm audit --json` | 0 个已知漏洞 |
| `npm run typecheck` | 通过 |
| `npm test` | 440/440 通过 |
| `git diff --check` | 通过 |
| Dependabot alerts | 仓库未启用 |
| Code scanning | 仓库未启用 |
| Secret scanning API | 当前仓库或权限下不可用 |
| Security policy | 未配置 `SECURITY.md` |

## 审计边界

本报告针对仓库代码、锁定依赖和 GitHub 可见配置。云开发控制台中的实时函数调用规则、数据库规则、存储规则和环境变量未通过仓库自动化读取，因此以文档中的人工复核记录为准；这也是 SEC-03 需要纵深防御的原因。
