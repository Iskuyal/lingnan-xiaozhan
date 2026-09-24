# 云端与模拟器链路复测（2026-09-24）

代码基线为 `main` 合并提交 `8947816`，工作区干净、GitHub 无开放 PR。执行方式：`微信开发者工具 CLI auto --project <仓库>/dist --auto-port 9420 --trust-project` 开启自动化端口后跑仓库内脚本；模拟器机型 iPhone 12/13 (Pro)，调试基础库 3.17.2，平台 `devtools`。测试输入只有固定短文本、仓库内合成小图和探针设置值，未上传真实课表或学生信息；`smoke:settings` 写入后已恢复旧值。

| 核对项 | 实际结果 | 证据边界 |
| --- | --- | --- |
| 本地静态与回归 | `npm run typecheck` 通过；`npm test` 448/448 通过（14.2s）；TASK 清单引用的 16 条本地文档路径全部存在 | 只证明代码与本仓库文档自洽，不代表云端运行 |
| 设置读写链路 | `npm run smoke:settings` 通过：`timetable` 云函数 `getSettings` → 写入探针值 → 读回一致 → 已恢复旧值，`roundTripSame=true` | 当前登录的**单个**微信号；跨账号互访与真实设备不在本项内 |
| 文字端到端 | `npm run smoke:ai` 通过：`ok=true`、`failureClass` 空、输出「链路已通」，`elapsedMs=5710`，107 token / 0.000027 元，微信 `msgSecCheck` `errcode=0`、`suggest=pass` | 固定短文本链路，不是问答质量或逐字段准确率评估 |
| 图片端到端 | `npm run smoke:ai:vision` 通过：`ok=true`、`elapsedMs=11606`，633 token / 0.000158 元，返回结构化课程草稿 JSON | 合成小图只验链路通不通；真实课表截图准确率待 Ticket 05 |
| 运维入口 | `npm run probe:wechat` 未拿到探测记录：返回 `failureClass=invalid_request`、`message=AI 请求参数不正确…`，而 `detail=这项 AI 维护操作仅向维护者开放` | 证明白名单为空时维护动作被拒（符合 SEC-02 设计）；合法维护者路径仍未验 |
| 页面级验收脚本 | `npm run verify:wechat` 在导入这一步之前未抛断言（首页校名、部门列表与详情、部门 AI 问答四条路径、课表页、设置页、管理页、导入引导页），随后中断 | 进度由脚本执行位置与截图时间戳推得，**未生成** `verification.json`，不作「整套通过」记录 |

## 验收脚本导入这一步为何断掉

`scripts/verify-wechat.cjs` 用 `mini.mockWxMethod('chooseMessageFile', …)` 顶替文件选择器，本次报 `Uncaught Error: wx.chooseMessageFile not exists`。在模拟器上下文中实测：

- `Object.keys(wx)` 含 `chooseMessageFile`，属性描述符为 `writable: true, configurable: true`，但**值为 `undefined`**，`callWxMethod('chooseMessageFile')` 报 `not a function`；
- 同时 `wx.canIUse('chooseMessageFile')` 返回 `true`，即能力判断与实际可用性不一致；
- 开发者工具主程序文件日期为 2026-09-07，本次环境与 09-20 那次留档的[课表改版验证记录](../timetable-ui-rework/README.md)完全一致（Stable 2.02.2608070、基础库 3.17.2、同机型），而该次 `verification.json` 为 24 项、结果 `passed`，其中包含经 `chooseMessageFile` 顶替跑通的真实样本导入；`scripts/verify-wechat.cjs` 与导入页自那之后没有相关改动。

结论：变化不在本仓库代码，工具侧行为与 09-20 不一致，**具体原因未查明**，不在本次范围内继续追查。待复核方式（按代价从小到大，均未验证）：清一次编译缓存 `cli.bat cache --clean compile --project <仓库>/dist` 后重跑；真机执行 Excel 导入（Ticket 03）；或确认开发者工具对该 API 的支持状态后再决定是否改脚本的注入方式。

## 顺带查出的两处偏差

1. `miniprogram/pages/timetable/import/index.ts:174` 直接调用 `wx.chooseMessageFile({...})`，没有存在性兜底。模拟器上点「选择文件」即为 `not a function`；真机若遇到该 API 缺失的微信版本，同样会抛错而不是给出可读提示，应并入 Ticket 03 的真机清单。
2. 维护者白名单拒绝被归类为 `invalid_request` 并配「请求参数不正确，请重试；若反复出现请联系维护者」，真实原因只在 `detail` 中；`scripts/probe-wechat.cjs` 又把「返回里没有 probe 记录」解释为「函数版本不对或 `action` 未被识别」。对普通用户不泄露内部原因是正确的，但对维护者排障方向是误导。

## 对现有待办的影响

- `newsSyncDaily` 下一次 06:00 是否实跑、两账号归属与个人分钟/日额度、真实截图逐字段准确率、固定 10 题问答质量、真机整条路径：本次**均未覆盖**，[人工验收清单](../../testing/manual-acceptance.md)保持原判定。
- 「单次 ≤2 秒」指标现有两次独立文字实测（5544ms、5710ms）与一次图片实测（11606ms）均未达标，仍待负责人裁定处理方式。
