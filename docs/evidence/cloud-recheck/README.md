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

## 2026-09-25 微信开发者工具点测补记

环境：微信开发者工具 2.02.2609231、模拟器机型 iPhone 12/13 (Pro)、微信 8.0.5、基础库 3.17.2、平台 `devtools`。通过安装目录的 `cli.bat auto --project <仓库>/dist --auto-port 9420 --trust-project` 打开当前 `dist`，再用项目的 `verify:wechat` 与小范围 automator 操作。以下是模拟器证据，不等于真机人工验收；[人工验收清单](../../testing/manual-acceptance.md)的记录栏保持未测。

| 核对项 | 本轮实测 | 结论边界 |
| --- | --- | --- |
| A2 导入降级与放弃 | 纯文本伪装 `.xls` 显示可读的“未识别课表矩阵”提示；仓库课表样本进入确认页后放弃，云端课程数仍为 50；无学分合成版式解析出 3 门、0 条阻塞、3 条待核对 | 未保存课程；未用真实个人截图；只证明模拟器中的错误态、确认页与放弃边界 |
| A3 表单/设置页面 | 手工新增表单与课表设置页可渲染，设置预览显示未设开学日 | 没有提交新增、修改、删除或设置写入 |
| B3 部门问答 | 开发者工具里观察到三次公开问题回答：学生会下设部门、未公布联系方式、再次询问下设部门；回答带官网来源或明确说官网未公布 | 只覆盖少量公开问答，不是固定 10 题评分，B3 仍未验收 |
| C1 资讯首条 | 列表有 10 条且页脚为“已经到底了”；详情显示 81 段正文、复制原文入口，返回后列表仍有 10 条。首条标题、日期 `2026-09-12`、URL 和正文首段与[学校官网原文](https://lnc.edu.cn/xyxw/xydt/content_32118)一致（正文按空白归一后比较） | 当前没有第二页；没有核对定时任务，C1 整项仍未验收 |
| 维护者探测诊断 | 当前账号收到 `invalid_request`；脚本识别为 `maintainer_not_allowlisted`，提示检查 `AI_ADMIN_OPENIDS`；没有执行实际探测 | 符合非白名单账号的预期拒绝；合法维护者路径仍待测 |
| 文字链路 V6 | `npm run smoke:ai -- --attempts=3` 三次都返回 `model_unavailable`、`retryable=true`、`模型返回内容为空（OpenAI 兼容格式）`；耗时分别 3272、3347、3815ms，微信文本内容安全三次均 `checked=true/passed=true`；模型标识为 `deepseek/deepseek-v4.1-flash` | 本轮连续 3 次复现空响应，文字 AI 当前不稳定；不能用 9/24 的成功冒烟代表本轮可用。记录在本机忽略目录 `artifacts/verify/ai-smoke.jsonl`，尚未定位模型中转端原因 |
| 整套 `verify:wechat` | 已通过部门与课表页面、错误文件、导入放弃、无学分版式、编辑表单及资讯导航中的多个步骤；脚本随后因 automator `timeout waiting for automator response` 中断，没有写出本轮 `verification.json` | 不能据此标记整套通过；实际模拟器的 `wx.chooseMessageFile` 是函数，因此缺失 API 的 `partial` 分支本轮没有触发 |

本轮没有进行真实截图识别、课表助手 10 题、两账号隔离、真机路径、断网/额度故障、资讯第二页或定时任务测试；也没有新增或修改用户课表。V6 出现三次连续空响应后停止继续冒烟，先查模型中转配置与服务端响应记录再复测。

## 2026-09-29 云端版本回读与内容安全窗口探针

本轮是**只读回读 + 真实云端探针**，全部在开发者工具模拟器里跑（`realDevice: false`），云环境 `cloudbase-d2gjtbbwu3575cd7b`，本地仓库 SHA `1267889`（探针修复分支 `e875323`，合入 `1ffdd4c`）。**未做**真机、两账号、真实截图与固定 10 题。逐条字段（含哈希、耗时、配额估算）见私有记录 `artifacts/verify/private-record-2026-09-29-cloud-recon.md`（被 gitignore，只在执行机上）；探针原始结果在 `artifacts/verify/ai-window.jsonl`。

| 核对项 | 本轮实测 | 结论边界 |
| --- | --- | --- |
| 已部署 `ai` / `timetable` 版本 | `functions info`：`ai` Active / timeout 60 / Nodejs16.13；`timetable`、`newsSync` Active / timeout 20 / Nodejs16.13。再用 `functions download` 下载代码逐项比对：`ai` 缺 #67 的记账闸门、#69 的 `rag.js`、#74 的窗口拒绝与分片上限文案（含 2026-09-19 的探测有效性字段）；`timetable` 缺 #67 的批次保护标记 | 确认仍停在 2026-09-24 那一版。CLI **不提供版本号与更新时间**，所以这类判断只能靠下载比对或控制台读回 |
| 遗留 `accounting-gate` | 写 `accounting-gate:<月份>` 的逻辑不在已部署的 `usage.js` 里 | 按已部署代码判定：线上不可能由现有部署写出这种文档。数据库本身仍未读——缺控制台或维护者通道 |
| 维护者路径（V3） | `npm run probe:wechat` → `diagnosis=maintainer_not_allowlisted`、`failureClass=invalid_request` | 与 2026-09-25 一致，仍未配置白名单。`assertAdmin` 在微信调用之前，因此**未占用探测的 10 分钟窗口、未消耗检测配额**；`usage` / `moderateText` / `moderateImage` 同样取不到 |
| 窗口探针 1（V8，3.2 万字输入） | `ok=false`、`failureClass=model_unavailable`、`usage=null`、`safety.checked=**false**`，带告警「文本共 32019 字，仅检测了前 20000 字」；云函数耗时 10118ms | **与期望不符**：超长输入没有被提前拒绝，窗口外的 12019 字未检测就送进模型 ⇒ 线上仍是修复前行为 |
| 窗口探针 2（V8，长输出） | 模型返回 0 字（`model_unavailable`），判定 `covered=false` | **未覆盖，按判据不算通过**。另有结构性限制：覆盖要求输出 ≥2 万字，而服务端把 `maxTokens` 硬钳在 1..8192，这一档目前不可达 |
| 文字链路（V6） | 当日 6 次真实文字调用**全部**返回空内容（短文本 5345ms；超长输入 9424 / 10118ms；长输出 41651 / 42254ms），`detail=模型返回内容为空（OpenAI 兼容格式）` | 症状仍在，未按 V6 的决定重跑三次；`choices` / `finish_reason` 结构诊断只在 ≥2026-09-27 的代码里，**已部署版本没有这段**，要先部署才能取到 V6 要的结构记录 |
| 检测配额消耗 | 估算约 50 片（日上限 100） | **无法查询剩余额度**（`getApiQuota` 需小程序 access_token，而 AppSecret 不在本机；`usage` 动作被白名单拦截）。演示/录屏前请按 D15 先查额度 |

**本轮顺带修掉的工具缺陷**：探针原先把整次云函数调用包在一次 `evaluate` 里等待结果，而开发者工具的自动化桥对单次 `evaluate` 有约 10 秒上限（实测 3.2 万字那次恰好在 10010ms 报 `timeout waiting for automator response`），于是连续两次 `exit 1`、`probes` 为空——这也解释了 2026-09-25 那次 `verify:wechat` 的同名中断。已改为「发起后立刻返回 + 短 `evaluate` 轮询」（[PR #79](https://github.com/Iskuyal/wx-match/pull/79)），请求体、判定逻辑与结果文件形状都不变，退出码语义（0 通过 / 1 没跑通 / 2 不符 / 3 未覆盖）也不变。

### 2026-09-29 部署 `ai` 新版后的复验

同一天中午按 V7 的关卡部署了 `ai`（**只发 `ai`**，`timetable`/`newsSync` 未动）并复跑判据。

| 步骤 | 实测 | 边界 |
| --- | --- | --- |
| 部署前账目核对（控制台） | 当月 `ai_usage_records` 776 条、`ai_usage_monthly.calls` 776；遗留 `accounting-gate` 由负责人确认「不清楚」，但按代码判定不可能存在（写闸门的逻辑不在旧版里） | 新版只在「记录数 > 汇总」时暂停调用，776 = 776 不触发 |
| 旧版留档 | `artifacts/rollback-2026-09-29/ai/`（`index.js` SHA-256 `a89b3127…`），供回退 | 被 gitignore，只在执行机上 |
| 部署 | `cli cloud functions deploy --names ai --remote-npm-install` 成功：16 文件 / 75.6 KB；`info` 仍 Active / timeout 60 / Nodejs16.13 | 部署**不**重置超时与环境变量 |
| 版本回读 | `download` 回读的 `index.js` 与本地构建**逐字节一致**（`8707f5a3…`）；`rag.js`、`accounting-gate`、窗口拒绝与分片上限、结构诊断 `choices=` 标记齐全 | CLI 不给版本号，这类判断只能这样比对 |
| 首次调用是否被账目拦 | 未出现「记录多于汇总」拦截 | 说明预检有效 |
| 窗口探针 1（V8） | **通过**：`ok=false`、`failureClass=invalid_request`、`usage=null`、`safety=null`、`detail` 写明 20000、云函数耗时 **1469ms**（拒绝早于检测与模型调用）⇒ CT-01 修复在线上生效 | 这一档现在确实不消耗检测配额 |
| 窗口探针 2（V8） | 仍 `covered=false`（模型对该长输出提示返回 0 字）⇒ **不算通过** | 覆盖还受 `maxTokens` 1..8192 硬钳限制 |
| `smoke:ai --attempts=3`（V6） | **3/3 成功**：`ok=true`、5227/4703/4720ms、输出「链路已通」、101~116 token | 部署前同日 6/6 为空 ⇒ 常规短请求已恢复；不能据此说「代码修好了空响应」 |
| 空响应的结构（V6 要的判据） | 探针 2 复现时取到：`choices=1；finish_reason=stop；content=string；reasoning_content=present；error=missing；usage=present` | 内容都进了 `reasoning_content`、`content` 为空；代码只读 `content` 并按 `model_unavailable` 处理，诊断只报结构、不记录推理正文 |
| 单变量对照（V6） | 同一条短提示、只把 `maxTokens` 提到 8192 → `ok=true`、4 字、243 completion token | 触发器是「长输出任务」而非 `maxTokens` 值 |
| 维护者路径（V3） | 配 `AI_ADMIN_OPENIDS` 后 `probe:wechat` **仍被拒**（`maintainer_not_allowlisted`） | 值为 `usage;probe;<openid>` 形式不匹配（按逗号切分后要求整项等于 openid）；改成纯 openid 再复测 |
| 配额消耗 | 本轮部署后新增约 5 片（探针 2 输出为空 ⇒ 0 片；探针 1 0 片；smoke 3 次各 1 片；对照 1 片） | 加上上午的约 50 片，当天已用掉一半以上；演示前务必按 D15 查额度 |

**仍未做**：`timetable`/`newsSync` 的部署与旧数据兼容验证（V7）、真实定时器（V1）、两账号服务端归属/额度（V2）、真机与真实截图（B1/A5 仍待归档）、`verify:wechat` 全量复跑。
