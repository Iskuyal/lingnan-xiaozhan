# 安全整改云端核对（2026-09-24）

对应 [SEC-01 至 SEC-05 整改](../../review/security-remediation-2026-09-24.md)。代码基线为 `main` 合并提交 `0f184cd`（PR [#59](https://github.com/Iskuyal/wx-match/pull/59)）。测试资料只有固定短文本和不存在的云存储路径，没有上传真实课表或学生信息。

| 核对项 | 实际结果 | 证据边界 |
| --- | --- | --- |
| GitHub CI | PR #59 两项检查通过；本地 `npm run typecheck`、`npm test` 448/448，通过；根项目与三个云函数的依赖审计均为 0 项已知漏洞 | CI 与本地均不代表云端运行 |
| 构建产物 | `dist/cloudfunctions/ai` 与 `newsSync` 均包含 `index.js`、`config.json`、`package.json`、`package-lock.json` | 从合并后的 `main` 重新构建 |
| 云端部署 | 微信开发者工具 CLI 以 `--remote-npm-install` 分别部署 `ai`、`newsSync`、`timetable`，三次均报告成功；`info` 回读三条函数均为 Active、Nodejs16.13 | 信息页未展示完整环境变量及触发器状态，不据此断言它们已配置 |
| 代码读回 | CLI 下载三条云函数后，远端 `index.js` 与本地构建文件的 SHA-256 各自一致；三份 `package-lock.json` 同样一致；`newsSync/config.json` 的哈希也一致 | 证明上传内容一致；实际 06:00 触发仍须单独检查 |
| 课表依赖与只读链路 | 下载的 `timetable` 产物里 SheetJS 为 **0.20.3**；从小程序端调用本人 `list`、`getSettings` 均 `ok=true` | 只验证读取及运行时加载；未执行 Excel 导入、写入、跨账号隔离或设置修改 |
| AI 业务连通 | 从开发者工具模拟器调用 `smoke:ai`：`ok=true`、`failureClass` 为空、输出“链路已通”、`elapsedMs=5544`、微信文字安全 `checked=true passed=true` | 模拟器、小程序端真实云调用；只验证固定短文本，不是问答质量或真机验收 |
| 运维权限 | 同一小程序端以伪造 `OPENID/admin` 参数调用 `usage`，返回无权限且无全局用量 | 当前登录账号不是白名单维护者；尚未验证合法维护者路径 |
| 图片归属 | 使用不存在的他人哈希目录 `fileID` 调 `vision`，返回“文件不属于当前微信身份”，未进入图片审核或模型调用 | 验证非法路径拒绝；未借用真实他人文件，也未验证两账号本人图片流程 |
| 资讯同步入口 | 小程序端伪造 `Type: Timer`、`TriggerName` 和 `reset` 调 `newsSync`，平台返回 `permission denied` | 已部署环境的客户端调用规则仍在；代码内的定时来源守卫有本地回归测试，真实定时器待下一次运行核对 |
| 历史探针函数 | CLI 函数列表仍能看到 `xlsx-cdn-probe` | PR #57 的一次性云端安装探针尚待维护者删除；不计作本次五项审计修复已完成的证据 |

## 仍未完成的线上验收

1. `newsSyncDaily` 下次 06:00 是否实际触发、能否通过新的来源校验并推进 `sync_state`；`info` 页面与上传的 `config.json` 不能替代运行记录。
2. 两个微信号分别验证本人截图成功、他人 `fileID` 在下载前被拒，及个人分钟/日额度；当前只有单账号、伪造文件的安全冒烟。
3. `AI_ADMIN_OPENIDS` 合法维护者路径未验证。当前冒烟账号的 `usage` 被拒属预期；若需要 `usage`、`probe`，先在云端设置维护者白名单，再用该账号核对。
4. 人工验收清单中的真实课表准确率、部门/课表问答、双账号隔离和真机界面由负责人随后执行，仍标“未测”。
