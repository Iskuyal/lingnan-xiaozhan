# PR #57 安全审计整改记录

范围：[原审计](pr-57-security-audit.md)的 SEC-01 至 SEC-05。此记录区分**代码修复**与**已部署验证**；本地测试通过不能证明云端已生效。

| 项 | 代码处理 | 可重复验证 | 云端状态 |
| --- | --- | --- | --- |
| SEC-01 图片越权读取 | `ai` 在 `downloadFile` 前核对平台 `openid`、个人哈希目录及由上传接口生成的图片文件名；错误不回显 `fileID` | `tests/security-audit.test.cjs` 覆盖他人文件、裸路径、跨目录、空身份与独立审核动作 | 已部署并用伪造他人路径在小程序端验证拒绝；双账号复核待做 |
| SEC-02 运维入口与额度 | `usage`、`probe`、独立审核仅允许 `AI_ADMIN_OPENIDS`；业务调用按用户每分钟/每日计数；探测每十分钟至多一次；用量记录只存 SHA-256 用户摘要，普通响应不返回全局汇总 | 同一测试文件覆盖普通用户伪造身份、短周期与日额度、探测冷却、记录字段 | 已部署，普通账号的 `usage` 被拒且固定短文本业务调用成功；合法维护者与限额边界待验 |
| SEC-03 资讯同步授权 | `newsSync` 同时核验本次平台上下文 `TRIGGER_SRC=timer`、微信来源 `SOURCE=wx_trigger`、预定触发器名；拒绝后不访问官网或数据库 | `tests/newsSync-flow.test.cjs` 用真实 CloudBase 上下文解析器验证伪造 `Timer` 事件被拒 | 已部署且客户端调用被平台拒绝；下一次真实定时触发待验 |
| SEC-04 可重复安装 | 三个云函数均提交独立 `package-lock.json`；CI 逐个执行 `npm ci --ignore-scripts` | 本地三份锁文件干净安装、加载 SDK 与 SheetJS 0.20.3 | 三条云函数均重部署并读回锁文件哈希一致；`timetable` 云端 SheetJS 为 0.20.3 |
| SEC-05 CI 供应链 | `checkout` / `setup-node` 固定到官方版本提交 SHA；CI `npm ci --ignore-scripts` 并审计根项目与三个云函数依赖 | 本地同命令与 PR #59 两项 GitHub Actions 检查通过 | 云端无关 |

本地完整回归（2026-09-24）：`npm run typecheck` 通过，`npm test` **448/448** 通过；根项目及三个云函数的 `npm ci --ignore-scripts` 均通过，四处 `npm audit --audit-level=low` 均为 0 项已知漏洞。三个云函数已能从各自锁文件安装并加载 SDK；`timetable` 安装到 SheetJS 0.20.3。GitHub Actions 结果与云端部署另记，不能用本地数值代替。

## 运行方式变化

- `newsSync` 只接受 `config.json` 指定的 `newsSyncDaily` 平台定时触发。旧文档中的控制台“测试”或客户端手动同步在新版部署后会返回拒绝；这保留了定时增量与按游标续跑，**手动选择栏目、重置全量目前没有维护者入口**。若再次需要该能力，应另建受服务端认证的维护入口，不恢复对事件字段的信任。
- AI 运维脚本 `probe:wechat` 与 `verify:wechat` 中的用量查询必须从列在云函数环境变量 `AI_ADMIN_OPENIDS` 的微信号运行。默认白名单为空，即运维动作全部拒绝；不要把 openid 或密钥硬编码进仓库。
- `AI_USER_MINUTE_LIMIT` 默认为 6 次，`AI_USER_DAILY_LIMIT` 默认为 30 次。每次业务请求先占用额度，失败也计数；窗口计数与探测窗口复用已受限的 `ai_usage_monthly` 集合，使用固定 `_id` 和原子自增，额外记录不含明文 openid。配置项仅在云函数环境中设置。
- 当前窗口计数尚无自动过期清理；公开试点前需按[数据使用说明](../product/data-usage.md)确定保存期限与清理办法，避免长期累积。
- 改动云函数后需重新构建、部署并读回版本；云端生效前仍按[当前状态](../status.md)中的旧安全边界处理，不使用真实学生资料做试点。

## 依据与待核实项

- 腾讯云[定时触发器事件](https://intl.cloud.tencent.com/document/product/583/9708?lang=en)说明 `Type/TriggerName` 是事件字段；它们可由普通调用者仿造，不能单独用于授权。[CloudBase 上下文解析器](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/env.md)接受本次入口 `context`，避免只依赖复用实例的环境变量。[CloudBase 实例复用说明](https://docs.cloudbase.net/cloud-function/instance)也提醒跨来源读取环境变量可能残留。
- GitHub Actions SHA 由官方 `actions/checkout` v4.2.2 和 `actions/setup-node` v4.4.0 的 Git tag 指向确认；以后升级须重新核对官方提交。
- 三条云函数的部署、入口文件与锁文件哈希、固定短文本及拒绝路径已核对，记录见[云端证据](../evidence/security-remediation/README.md)。`AI_ADMIN_OPENIDS` 合法账号、两账号和 `newsSyncDaily` 实际触发仍需分别验证。
