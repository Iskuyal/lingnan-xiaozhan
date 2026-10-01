# 待办总表

核对日期：2026-09-30。原技术基线为 `main` 合并提交 `44d3ca9`（PR #65 界面改版合入后，`npm run typecheck` 与 `npm test` 459/459 通过）；人工验收 A1–C1 于 2026-09-27 由负责人确认全部通过，详细版本与结果待归档。**2026-09-28 新增**：内容安全审计的 CT-01 / CT-02 已修复并带回归测试（`npm test` 504/504），随 [PR #74](https://github.com/Iskuyal/wx-match/pull/74) 合入 `main`（合并提交 `50cb884`）；**09-29 已部署 `ai` 并完成 V8 输入拒绝与多片全检复验**；原输出超过 4 万字的构造仍只有本地证据，详见 V8。

本页把散在各 Ticket、人工验收清单与证据记录里的**未完成项及待归档证据**集中成一张清单，按「谁能做、卡在什么上」分组。**代码合入、云端部署、模拟器验证、真机验证是四个不同状态**。第二节的 A1–C1 已由负责人确认通过，保留操作索引仅为补齐证据，不代表代码还没写或需要重做。各票的完整过程与早期数字仍以票内为准，跨票版本边界见[项目状态](../status.md)。

09-30 新功能审查的 7 组缺陷修复与验收见[修复记录](../evidence/review-fixes-2026-09-30/README.md)。来源、设计整体定稿、模型层与真机验收仍独立核对，不因代码修复销项。

**负责人 2026-09-30 新指令：失物招领暂缓。** 已有基线和本轮权限修复保留；不继续其 AI 匹配、云端部署、双账号/真机验收，也不将这些列为当前功能收尾阻塞项。升学问答、个人课表安全及其他新功能验收继续按各自范围执行。

## 下一阶段功能完善目标（2026-09-30 负责人确认）

按顺序完成[升学问答模型版 → 真实题集与引用评测](../planning/next-phase-advancement-model.md)；[新会话提示词](advancement-model-prompt.md)可直接执行。
**2026-09-30 进展**：M1（模型版）已实现、`ai` 已部署并回读一致；M2 真实题集评测已跑完四轮（29 次真实模型调用），
逐题记录与判定见[证据](../evidence/advancement-model/README.md)。课表、设置、图片归属已获负责人确认通过，详细记录待归档，不再作为待执行前置；失物招领继续暂缓。

### 升学模型版的剩余项（按阻塞程度）

**09-30审查更新**：引用闸三类漏洞已修复并部署（15个JS回读一致）；当前模型仅选择/排列完整原句，改写降级。旧复算不证明语义支持100%。[第二批14题](../evidence/advancement-model/questions-next.json)已冻结，本地13/14，真实首评被个人日额度拦截，无模型输出。续跑命令与当前NO-GO见[审查](../review/advancement-model-2026-09-30.md)。以下首评43%保留为历史；04–07定稿与升学≤8秒决定已落实。

| # | 事项 | 判据 | 依据 |
| --- | --- | --- | --- |
| N1 | **独立效果估计未达标**：13 道新题首评事实题 3/7（守门 6/6），修复后新题只能算回归题（7/7） | 需要**又一批没见过的题**（≥10 道，同样先冻结）复测，事实题正确率 ≥80%、守门全对、引用支持 100% 才算独立达标。**不得在已用于修复的那 13 道上继续调参后冒称独立** | [证据第四节](../evidence/advancement-model/README.md) |
| N2 | **真实学生提问样本为 0**：13 道新题全是维护者设计题 | 有获许可的真实提问才标为真实提问；不开展公开招募，缺样本如实登记 | [题集](../evidence/advancement-model/questions.json) |
| N3 | **来源冲突场景无样本**：4 份语料 25 段里没有互相冲突的事实 | 要么找到真实冲突来源并登记，要么在来源目录写明"当前语料无冲突场景、检索无冲突检测" | 同上 gaps |
| N4 | **端上模型解释截图是回放**：当日个人日额度被评测用满，现场调用被拒 | 额度恢复后跑一次 `npm run verify:advancement`，用 `source: live` 的记录替换回放 | [端上结果](../evidence/advancement-model/README.md) |
| N5 | **已完成：负责人于 09-30 接受设计图 04–07，定稿** | 已同步设计说明；其他主题与01–03另计 | [设计说明](../design/advancement-qa/README.md) |
| N6 | 真机未测（`realDevice: false`）；升学时延已由负责人定为 ≤8 秒，旧记录为服务端耗时，须补端到端记录 | 真机走一遍；升学按发起请求至收到响应 ≤8 秒核对，保留超时降级；其他场景 D1 另计 | [人工验收清单](../testing/manual-acceptance.md) |

## 项目讲解与答辩练习的执行入口（09-30）

已按本轮要求完成实例/素材研究、方向确定、阶段任务与[授权PPT首版](../competition/principal-2026-10-08/README.md)。**09-30 状态**：G0 素材包已产出（[PR #118](https://github.com/Iskuyal/wx-match/pull/118) 仍 OPEN、Issue #111 仍 OPEN，未验收未合入）；G1 按冻结提示词的守卫只交付了**离线部分**——维护者脚本 `scripts/poc-project-defense.cjs` 的 `--plan` 装配自检（0 错误、装配指纹 `64b4d06b`）、13 项负例离线测试与逐例记录骨架，[真实模型评测未完成](../evidence/project-defense-g1/README.md)。G1–G4 依[阶段方案](../planning/project-defense-stages-2026-09-30.md)逐关解锁，真实调用与升学共用配额。**解锁前置**：先验收并合入 #118（真实评测需在该素材包上首次运行，留出样例独立性尚未消耗）。**续跑入口**：[G1 真实评测续跑提示词](project-defense-g1-resume-prompt.md)（可直接复制给其他执行者；顺序要求「留出样例首次结果必须早于任何提示词调整」）。新增功能的样本包、页面设计、业务代码、真实模型与真机验收仍未完成，不因规划与 PPT 交付销项。

## 一、需要负责人决定

这些是判断，不是实现；没有决定，下游只能空转。

### A. 提交硬前置

| # | 事项 | 判断点 | 挡住什么 | 依据 |
| --- | --- | --- | --- | --- |
| D1 | **AI 时延达标线的口径（升学已定，其他场景待定）** | 09-30 负责人确认升学问答 ≤8 秒（端到端），保留超时降级；其他场景仍需决定。 规格写的「单次响应 ≤2 秒」实测达不到：文字链路两次独立实测 5544ms、5710ms，图片链路 11606ms，且 `vision` 的固定开销约 11 秒、与图片大小无关。改成可测的分场景口径（例如文字问答 ≤10 秒、截图识别 ≤60 秒且有进度态），还是换更快的模型后重测 | P6 材料里的效果宣称；照现状写「≤2 秒」是不实陈述 | [CONTEXT.md](../../CONTEXT.md) 待决定表；[云端复测](../evidence/cloud-recheck/README.md) |
| D2 | **正式作品名称** | 定名即可 | ZIP 命名 `第九届传智杯-AI小程序赛道-作品名称.zip` 与作品说明 a 项 | [submission.md](../competition/submission.md) a 项；[CONTEXT.md](../../CONTEXT.md) 待决定表 |
| D3 | **校内收口时间与材料交接方式** | 学校统一上报，团队实际截止**早于**组委会的 2026-11-18；须问明校内收口时间、接收人与交接方式 | 阶段 5 材料冻结与阶段 6 归档的倒排 | [submission.md](../competition/submission.md) 提交验收清单第 11 项；[workflow.md](../development/workflow.md) |

### B. 范围与国赛版方向

| # | 事项 | 判断点 | 挡住什么 | 依据 |
| --- | --- | --- | --- | --- |
| D4 | **学校公众号是否进入产品** | 自动抓取与重排已核实不可行，仅剩「人工登记链接 + 打开原文、正文不入库」。人工维护成本是否值得 | 产品范围 | [CONTEXT.md](../../CONTEXT.md) 待决定表 |
| D5 | **Ticket 10 关卡 1：语料可行性**（已重开） | 三选一：C 先做 OCR/PDF 共用链路（票内推荐）／A 改做校园资讯问答／B 砍掉 RAG。PoC 实测官网可入库正文只有 168 篇、4.9 万字，其中 97 篇不足 200 字 | 国赛版方向 | [Ticket 10](tickets/10-campus-rag-qa.md) 决策关卡表 |
| D6 | **Ticket 04 首次全量的批数与维护者入口** | 票面估「约 15 批」，实际约 155 批（请求合计 1549 次）；四条路待选，其中「调大云函数超时」属新增决策。另：SEC-03 之后旧的手动补抓入口已废，若仍需该能力应**另建受服务端认证的维护者入口** | 资讯全量入库 | [Ticket 04](tickets/04-expand-sync-and-daily-schedule.md)、[cloud-development.md](../development/cloud/README.md) 未决问题一节 |
| D7 | **Ticket 11 关卡 3/4/5** | 一次性回填还是增量、是否设月度成本上限与密钥纪律、是否为 Ticket 05 顺带提供 OCR 能力 | OCR 语料链路 | [Ticket 11](tickets/11-ocr-document-parsing.md) 决策关卡表 |
| D8 | **Ticket 04 与 Ticket 10 的范围合并解释** | 04 里的团委通知公告 16 页 / 155 条仍要全量入库，这一条是对两处决定的合并解释 | 语料范围 | [Ticket 04](tickets/04-expand-sync-and-daily-schedule.md)、[Ticket 10](tickets/10-campus-rag-qa.md) |

### C. 口径、默认值与数据保留

| # | 事项 | 判断点 | 挡住什么 | 依据 |
| --- | --- | --- | --- | --- |
| D9 | **Ticket 10 关卡 3：指标口径** | 既有「单次 ≤2 秒」需改写为可测的两段式口径，等 PoC 拿到真实耗时再定 | 与 D1 同源 | [Ticket 10](tickets/10-campus-rag-qa.md) 决策关卡表 |
| D10 | **Ticket 01 默认值表与用量保留策略** | 票内 12 行默认值需认可或调整（含「OpenAI 兼容接口格式」仍是待验证假设、中转实际计费单价须按账单改，否则 50 元月度上限形同虚设）；`ai_usage_records` 保留策略等真实调用量出来再定 | 成本上限是否真的生效 | [Ticket 01](tickets/01-ai-foundation.md) 默认值表一节 |
| D11 | **限流窗口计数的过期清理** | 当前窗口计数无自动过期清理，公开试点前需按数据使用说明确定保存期限与清理办法 | 公开试点 | [安全整改记录](../review/security-remediation-2026-09-24.md) |
| D17 | **资讯去重键是否改掉** | 现有去重键是原文绝对 URL（`docs/product/sources/news.md` 去重键一节）。2026-09-26 全量浏览实测：官网把同一篇内容分别发到多个栏目，**每个栏目各生成一个 `content_<ID>`**，跨栏目同标题组 120 组，只按 URL 去重会多出 **142 条（14.3%）**；同栏目内也有 8 组同标题不同 ID。判断点：改为「栏目无关的标题归一化 + 事件日期」，还是维持 URL 去重并在列表接受重复。当前云端只有 10 条，尚未暴露 | 资讯全量入库后的列表观感；`newsSync` 的写入与去重实现 | [news-sources.md](../product/sources/news.md)「2025-2026 区间全量浏览」 |
| D18 | **团委来源资讯的日期用哪个** | 学院新闻站的「发布时间」与事件时间一致；**团委各栏目的发布时间是批量补录时间戳**——团委口径 249 条里 128 条集中在 2026-03-06（52）、03-09（18）、03-10（19）、09-22（39）四天，正文写的多是更早的事（如 `content_32583` 页面 2026-09-22、正文为 2025-04-16）。判断点：展示沿用官网发布时间（现状），还是对团委口径条目改为从正文提取事件时间；后者需要逐篇解析且存在提取不到的情况 | 资讯列表与详情显示的日期语义；`docs/product/sources/news.md` 里「列表页日期与文章页一致」的结论只覆盖校园动态，不能外推到团委 | [news-sources.md](../product/sources/news.md)、[departments-sources.md](../product/sources/departments.md)「2026-09-26 第三轮」 |

### D. 遗留确认

| # | 事项 | 判断点 | 挡住什么 | 依据 |
| --- | --- | --- | --- | --- |
| D12 | **往届作品或既有成果** | 核实后按实际填写历史说明 | submission f 项 | [submission.md](../competition/submission.md) f 项 |
| D13 | **P2/P3 审查尚未逐条确认的 6 条** | 数据来源是否可接受（A1 名录来自图片、A3 校区缺失、A4 联系方式缺失）、三个技术判断是否认可（B2 更新时间语义、B3 删除随包快照、B5 自定义安全规则）。其中 B3、B5 已实测有效，但「是否认可这个取舍」仍是判断 | 材料如实性 | [known-gaps.md](../review/p2-p3/known-gaps.md) |
| D14 | **Issue #24 的三问** | 上课第一周起算日用哪个候选（09-08 / 09-14 / 其他）、是否接受「课表页周次小条」形态、图片内日期类通知是否安排人工补录 | Ticket 03 的周次切换验收 | [Issue #24](https://github.com/Iskuyal/wx-match/issues/24) |
| D15 | **演示配额与测试夹具** | 演示脚本按「未上线小程序内容安全日上限 100 次」倒排，录屏与现场演示前用 `getApiQuota` 查额度；`tests/fixtures/timetable/`（含教师姓名与班级人数）是否随包提交 | 演示可用性；包内隐私 | [Ticket 09](tickets/09-p6-submission.md) |
| D16 | **界面改版的定稿与两条设计取舍** | `docs/design/campus-refresh/` 已定稿（2026-09-25，20 屏）；`docs/design/timetable-readability/` 状态仍是「待评审」，两条待拍板：网格里地点缩成「楼栋-房间」（原文留在列表与详情）是否接受、课名行数上限（高块 4 行 / 2 节块 3 行 / 1 节块 2 行）是否再收紧 | 设计说明的定稿状态；后续界面按哪一版对齐 | [课表返工设计说明](../design/timetable-readability/README.md) 待拍板项 |

## 二、负责人确认通过的人工验收：待归档原始证据

[人工验收清单](../testing/manual-acceptance.md)的 A1–C1 已由负责人确认全部按判据通过，本节以下操作表保留为验收内容索引，不再表示“待执行”。**仍缺**本轮 Git/云函数版本、设备、样本、B1 逐字段准确率、B2/B3 逐题结果及 C1 第二页与定时运行的原始记录；V1–V7 是验收之外的独立项目，不能因 A1–C1 的确认自动销项。

### 已确认通过：常规操作

| 编号 | 操作 | 通过判据 |
| --- | --- | --- |
| A1 | A 用 Excel 导入一份已知课表，检查确认页，再保存、退出重进 | 课程数、星期、节次、周次、教师、地点与原文件相符；未识别字段有提示；重进后仍在 |
| A2 | 用另一份 Excel 进入确认页点「放弃」；再选错误格式文件 | 原有课程不变；错误提示可理解，不出现平台错误原文 |
| A3 | 手工新增、修改、删除一门测试课；填写开学日和一节作息，退出重进 | 每步只改变指定字段；本周/今日提示按设定变化；设置可读回 |
| B4 | 断网后打开已保存课表再恢复网络；遇模型超时/额度不足时检查提示 | 已有课表可查看或明确提示读取失败；AI 失败按「模型/内容/额度」分开，手工编辑入口可达 |

### 已确认通过：双账号与真机

| 编号 | 操作 | 通过判据 | 前置 |
| --- | --- | --- | --- |
| A4 | A、B 分别打开课表；仅 A 保存测试课，再让 B 查看并导入 B 自己的课表 | B 看不到 A 的课；B 的导入不影响 A。09-27 记录覆盖界面隔离；09-30 已补确认课表、设置和图片归属通过，详细场景与结果待归档 | 负责人确认通过，账号代号与执行记录待归档（[归属确认](../testing/manual-acceptance.md#ownership-confirmation-2026-09-30)） |
| A5 | 至少一台真机走首页→部门→资讯→课表；有条件时安卓和 iOS 各一次 | 文字可读、按钮可点、弹层能关闭、返回路径正确；资讯有来源和日期；空态/失败态可理解 | 真机。现有证据全部来自开发者工具模拟器（`realDevice: false`） |

### 已确认通过：真实样本、模型与资讯

| 编号 | 操作 | 通过判据 | 前置 |
| --- | --- | --- | --- |
| B1 | 用三张获许可的真实课表截图识别，进确认页逐项校对，修正至少一项后保存 | 有结构化草稿；错误字段可改；保存值以学生确认为准；**临时上传文件清理结果有记录** | 获许可的真实截图；先按清单把三张原图人工抄成标准答案。准确率 ≥90%，算法见[清单](../testing/manual-acceptance.md) |
| B2 | 课表助手按固定 10 题提问；对新增/修改各试「取消」与「确认」 | ≥8/10 与课表原值一致；取消不写库；确认只改所说字段；**编造一次即不达标** | 真实模型调用；第 6、7 题用可丢弃课程 |
| B3 | 部门助手按固定 10 题提问 | ≥8/10 与部门来源一致；未公布时明确说无资料；**编造一次即不达标** | 真实模型调用；先写好每题来源与标准答案 |
| C1 | 资讯列表翻到第二页，打开详情对照原官网；维护者核对定时任务记录 | 标题、日期、正文、来源对应原文；多页无重复；**定时触发与失败留存有云端证据** | 云控制台；扩大同步后的真实多页数据 |

### 验收之外的云端项（同属「只有人能验」）

| # | 事项 | 判据 | 依据 |
| --- | --- | --- | --- |
| V1 | `newsSyncDaily` 下一次 06:00 是否实际触发、能否通过新的来源校验并推进 `sync_state` | 有真实运行记录。`info` 页面与上传的 `config.json` 不能替代运行记录 | [安全整改证据](../evidence/security-remediation/README.md) |
| V2 | 课表/设置/图片归属与个人限额分别核对 | **归属：2026-09-30 负责人确认三类测试通过，详细结果待归档**。不补造执行日期、具体场景、账号、代码/部署版本。**额度：09-29 已实测个人分钟默认 6 次限额；2026-09-30 评测把当日额度用满后，后续调用返回「今日 AI 调用次数已达上限，请稍后再试。」（fail-closed、发生在模型调用之前、页面按降级展示原文摘录）——**日额度确实生效**，但具体上限值是 30 还是被调过没有读到，计数值也取不到**。本次归属确认不等于所有云端安全项目已完成；09-29 原过程见文末历史记录 | [归属确认记录](../testing/manual-acceptance.md#ownership-confirmation-2026-09-30)、[整改记录](../review/security-remediation-2026-09-24.md) |
| V3 | `AI_ADMIN_OPENIDS` 合法维护者路径 | 先在云端设置维护者白名单，再用该账号核对 `usage` 与 `probe`。当前冒烟账号被拒属预期。**2026-09-29 复测仍为 `maintainer_not_allowlisted`**（`npm run probe:wechat`；`assertAdmin` 在任何微信调用之前，因此未占用探测的 10 分钟窗口、未消耗检测配额）⇒ 白名单未配置前，`usage` / `moderateText` / `moderateImage` 与有效探测记录都取不到，用量集合读数只能走控制台。**2026-09-29 部署后复测：已配置 `AI_ADMIN_OPENIDS` 但 `probe:wechat` 仍被拒**——`isAdmin` 把环境变量按英文逗号切分后要求**整项等于** openid，值里带 `usage;probe;` 这类前缀、分号或空格都不会匹配；改成纯 openid（多个用英文逗号分隔）后重跑即可确认。**同日改好值后复测：V3 通过** ✅——`npm run probe:wechat` 退出码 0，`probe.valid: true`、`openidPresent: true`（v2 形态）、`security.msgSecCheck` 620ms 与 `security.imgSecCheck` 559ms 均 `errcode 0`，结论「微信官方内容安全接口可调用：保持 `AI_SAFETY_PROVIDER=wechat`」（记录已回填[探测记录表](../development/cloud/README.md)）。同一次会话里维护者动作 `usage` 也读到了：**当月 790 次调用、212,525 token、0.0531 元**（上限 50 元/告警线 40 元，未告警） | 同上 |
| V4 | `newsSync` 首次全量入库 | 按 D6 选定的口径跑完分批导入（Ticket 04 口径约 155 批；Ticket 10 口径为团委 171 次 + 8 个新栏目 122 次 ≈ 30 批——两者范围不同） | [Ticket 04](tickets/04-expand-sync-and-daily-schedule.md)、[Ticket 10](tickets/10-campus-rag-qa.md) |
| V5 | 本机之外的记录格式 | 每项另存私有测试记录：`编号、日期时间、Git SHA、设备/微信版本、云函数版本、输入样本代号、预期、实际、耗时、成本、截图或录屏路径、问题链接`；截图遮掉姓名、班级、课表原文及个人信息 | [人工验收清单](../testing/manual-acceptance.md) |
| V6 | **文字链路的空响应**（2026-09-25 已连续复现 3 次） | `npm run smoke:ai -- --attempts=3` 三次都为 `failureClass=model_unavailable`、`retryable=true`、`detail=模型返回内容为空（OpenAI 兼容格式）`，耗时 3272/3347/3815ms，文本安全检测均通过；模型标识 `deepseek/deepseek-v4.1-flash`。本轮先查中转配置/服务端响应记录，不再重复消耗调用；修复或确认原因后再跑三次。历史 2026-09-24 那次 5201ms 空响应与此前 `ok=true` 记录仍保留。**2026-09-29 部署前**：当日 6 次真实文字调用**全部返回空内容**（V8 取证顺带产生，未按本条重跑三次）。**部署新版 `ai` 后（同日）**：`npm run smoke:ai -- --attempts=3` **3/3 成功**（`ok=true`、5227/4703/4720ms、输出「链路已通」、101~116 token）；单变量对照（同一条短提示、只把 `maxTokens` 提到 8192）也成功（243 completion token）⇒ **常规短请求已不复现**，与 2026-09-24→09-25「失败后又成功」的反复一致。**结构记录已取到**（新版 `ai` 的诊断生效；探针 2 的长输出请求复现为空）：`choices=1；finish_reason=stop；content=string；reasoning_content=present；error=missing；usage=present` ⇒ 内容都进了 `reasoning_content`、`content` 为空，代码只读 `content` 并按 `model_unavailable` 处理（诊断只报结构、不记录推理正文）。下一步是定口径：换答案落在 `content` 的模型，或接受现状——**不建议**把 `reasoning_content` 当正文上屏 | `artifacts/verify/ai-smoke.jsonl`（被 gitignore，只在执行机上）；[云端复测](../evidence/cloud-recheck/README.md) |
| V7 | **本地修复部署与旧数据兼容**（2026-09-27） | 审查修复已由 PR #67 合入 `main`；新版 `ai`、`timetable` 云函数仍缺部署与版本回读证据。**2026-09-29 只读回读完成**：下载已部署代码逐项比对，`ai` / `timetable` 仍是 2026-09-24 那一版（`ai` 缺 #67 的记账闸门、#69 的 `rag.js`、#74 的窗口拒绝与分片上限文案，含 2026-09-19 的探测有效性字段；`timetable` 缺 #67 的批次保护标记），`ai` 入口文件 SHA-256 见私有记录。**遗留闸门一条已可按代码判定**：写 `accounting-gate:<月份>` 的逻辑不在已部署版本里，线上不可能由现有部署产生它；但 `ai_usage_records` 数量与 `ai_usage_monthly.calls` 的核对**仍缺通道**（控制台或维护者白名单）。**2026-09-29 白名单配好后这条通道也打开了**：维护者动作 `usage` 可读当月的服务端汇总（调用数、token、金额、上限告警），首次读数见 V3 行；新版上线后未出现漏记拦截。部署前先核对当月 `ai_usage_records` 数量与 `ai_usage_monthly.calls`，避免既有漏记让新代码立即拦截；也须确认 `ai_usage_monthly` 不存在遗留 `accounting-gate:<月份>`，不得未核账就删闸门。部署后验证旧课表无批次标记时可读、首次整份替换只显示新课、手工新增仍可读，并回读云函数版本。空响应诊断只记录 `choices`、`finish_reason` 等结构，不记录正文；取得中转原始响应或结构诊断后再判断 V6 根因。**2026-09-29 已部署新版 `ai` 并回读**：控制台核对当月 `ai_usage_records` 776 条 vs `ai_usage_monthly.calls` 776（新版只在「记录数 > 汇总」时拦，776 = 776 不触发；遗留闸门按代码判定不存在）；`npm run build` 后 `cli cloud functions deploy --names ai --remote-npm-install` 成功（16 文件 / 75.6 KB）；**部署前把旧版下载留档**（`artifacts/rollback-2026-09-29/ai/`，`index.js` SHA-256 `a89b3127…`），部署后 `download` 回读与本地构建**逐字节一致**（`8707f5a3…`），`rag.js`、记账闸门、窗口拒绝与结构诊断标记齐全，`info` 仍 Active / timeout 60，首次调用未出现漏记拦截。**`timetable` 与 `newsSync` 仍是 2026-09-24 版**（本次只发 `ai`）：旧课表无批次标记可读、首次整份替换只显示新课、`newsSync` 触发器与全量入库仍待各自核对。**2026-09-29 同日又部署了 `timetable`**（7 文件 / 37.1 KB；旧版留档 `artifacts/rollback-2026-09-29/timetable/`，`index.js` SHA-256 `1b68c504…`），部署后 `download` 回读与本地构建**逐字节一致**（`3c59db57…`，批次标记 12 处）。**旧数据可读已实测**：`{"action":"list"}` 返回 **51 门课程**（旧版写入的数据里 50 门带旧格式 `batch`、1 门没有）、`getSettings` 正常，**没有触发**「课表批次标记损坏」的 fail-closed。仍未做：**首次整份替换只显示新课**与**手工新增仍可读**（都要写真实课表，建议用测试账号或先备份），`newsSync` 未动（其定时器判据见 V1） | [数据模型与部署说明](../development/cloud/README.md)；本轮本地回归不等于云端验收 |
| V8 | **内容安全检测窗口修复的部署与云端复验**（2026-09-28） | 代码已修并随 [PR #74](https://github.com/Iskuyal/wx-match/pull/74) 合入 `main`（合并提交 `50cb884`）：输入超 2 万字按 `invalid_request` 拒绝（不花检测配额、不进模型）、输出分片全检且超 4 万字按 `internal` 失败、不返回内容；本地 `npm test` 504/504 与审计探针复跑见[审计修复一节](../review/content-safety-audit-2026-09-27.md#修复2026-09-28)。**新版 `ai` 与新版客户端要一起发**（新服务端 + 旧客户端在长对话里会被「输入过长」拒绝）。云端判据已写成可执行探针：`npm run probe:ai-window`（前置：开发者工具已开自动化端口、`ai` 已部署修复版）——探针 1 的 3.2 万字输入应被拒且 `usage`/`safety` 为空（**不消耗检测配额**），探针 2 的长输出应 `safety.checked=true` 且无 `checked=false` 告警（**按片消耗配额，约 10~16 次**；模型没写够 2 万字时脚本如实标「未覆盖」，不算通过）。结果落在 `artifacts/verify/ai-window.json`。**本地桩证据与本地探针都不替代这一步**。**2026-09-29 云端实测**：探针与期望不符（exit 2）——探针 1 返回 `failureClass=model_unavailable` 并带「文本共 32019 字，仅检测了前 20000 字」告警，说明超长输入**没有**在检测与模型调用之前被拒绝、窗口外的 12019 字未检测就送进了模型（线上仍是修复前行为）；探针 2 输出 0 字、如实标「未覆盖」，按判据**不算通过**。两处前置缺陷：① 探针原先把整次云函数调用包在一次 `evaluate` 里，而开发者工具的自动化桥对单次 `evaluate` 有约 10 秒上限（实测 10010ms 报 `timeout waiting for automator response`），已由 [PR #79](https://github.com/Iskuyal/wx-match/pull/79) 改为轮询取结果；② 探针 2 的「覆盖」要求输出 ≥2 万字，而服务端把 `maxTokens` 硬钳在 1..8192（`cloudfunctions/ai/config.ts:229`），**输出侧判据目前不可达**，需先改服务端上限或改判据口径。另：「探针 1 不消耗检测配额」只在**部署修复版之后**成立——实测在修复前版本上它会照旧分 10 片送检。**2026-09-29 部署新版 `ai` 后实测：探针 1 通过**——`ok=false`、`failureClass=invalid_request`、`usage=null`、`safety=null`、`detail` 写明上限 20000、云函数耗时 **1469ms**（拒绝发生在检测与模型调用之前，这一档确实不消耗检测配额）⇒ **CT-01 的修复在线上生效**。**探针 2 仍 `covered=false`**（模型对该长输出提示返回空内容，结构见 V6），按判据**不算通过**；且「覆盖」在服务端 `maxTokens` 硬钳 1..8192 下不可达。**2026-09-29 输出侧改为 B 方案并已通过**：原判据要求模型自己写出 ≥2 万字，而实测模型每个字符要烧几十个 token（重复六个字 20 次＝120 字用 352 completion token，100 次＝600 字用 **5575** token，再往上都在 40 秒模型超时处失败）⇒ 那条路在**模型**这一侧就不可达；改为由**维护者动作 `moderateText` 送 6000 字（3 片）**验证「输出被切成多片并整段检完」（`moderateOutput` 走的就是同一个分片函数，只是片数上限 20 而非 10）。实测：`ok=true`、`safety.checked=true`、云函数耗时 2669ms ⇒ 探针整轮 **exit 0**（探针 1 与探针 2 都覆盖且符合期望）。**边界必须一起说**：这证明「多片全检链路在线上成立」，**不再证明 2 万字窗口被用满**；「单次输出超过 4 万字即按 `internal` 拒绝」那条 fail-closed 规则线上构造不出来（模型写不出那么长、也没有注入通路），仍只有单测与本地夹具覆盖。第三次探针（模型自写长输出）保留为**机会性**记录、不计入结论，模型或供应商换掉后可能又可用。**当天注意**：跑完这轮后**内容安全检测日配额已用尽**（`errcode 45009`，fail-closed，当天三处 AI 都不可用），需等次日恢复。**新版 `ai` 与新版客户端要一起发**：旧客户端在长对话里会被「输入过长」拒绝 | [审计报告](../review/content-safety-audit-2026-09-27.md)、[复现证据](../evidence/content-safety-audit-2026-09-27/README.md)、[云端说明](../development/cloud/README.md) |

## 三、代码与文档收尾（不需要等人）

| # | 事项 | 判据 | 依据 |
| --- | --- | --- | --- |
| I1 | 导入页的 `wx.chooseMessageFile` 存在性兜底（代码已完成，只剩真机分支） | 兜底已实现（`miniprogram/pages/timetable/import/index.ts` 的 `chooseFile()`：API 缺失时弹「暂不支持文件导入」并给出截图 / 手工录入两个出口，不调用云函数），`tests/timetable-pages.test.cjs` 的「缺少聊天记录选文件 API 时说明替代方案并留在引导页」覆盖该分支并通过。**模拟器里 API 实际可用，所以这条只在真机上才可能触发**——真机兼容性仍待验，不能用单测替代 | `miniprogram/pages/timetable/import/index.ts`、`tests/timetable-pages.test.cjs` |
| I2 | 维护者白名单拒绝仍沿用 `invalid_request` 分类 | 2026-09-25 `npm run probe:wechat` 实测识别 `maintainer_not_allowlisted` 并提示核对 `AI_ADMIN_OPENIDS`；云函数分类与用户文案未改，是否新增独立权限分类仍待定口径 | 同上；`cloudfunctions/ai/access.ts`、`scripts/probe-wechat.cjs` |
| I3 | `npm run verify:wechat` 的选文件 API 缺失分支 | 本轮 API 实际可用，Excel 错误文件、仓库样本放弃、无学分合成版式均已走过。**2026-09-26 复跑 24 项全过**、`verification.json` 重新生成（`result=passed`，`realDevice=false`）；09-25 那次「资讯阶段 automator timeout」是开发者工具长跑后退化，重开工具即恢复，不是脚本缺陷。缺失 API 时的 `partial` 分支仍未在模拟器实测 | [云端复测](../evidence/cloud-recheck/README.md) |
| I4 | 删除云端遗留探针函数 `xlsx-cdn-probe` | 云开发控制台删除并保存结果。它不属于 SEC-01 至 SEC-05 的业务入口 | [项目状态](../status.md)；[安全整改证据](../evidence/security-remediation/README.md) |
| I5 | Ticket 10 每日增量在 10 栏目下每批约 3 批但每日只触发 1 次 | **这条不改代码就不算完成**：减少 `INCREMENTAL_PAGES`、增加一次每日触发、或栏目轮转，三选一 | [Ticket 10](tickets/10-campus-rag-qa.md) |
| I6 | `date + id` 组合索引未建 | 按 Ticket 04 的索引建议建立 | [Ticket 04](tickets/04-expand-sync-and-daily-schedule.md) |
| I7 | AI 资讯 PoC 结论、复现资料与范围确认（已完成） | 实测报告由 PR #19 合入，脚本与 43 次原始调用记录由 PR #85 归档。首版 AI 范围已由规格定为部门问答、课表图片识别和课表助手；P3-2 首批栏目已定为校园动态与团委通知公告，因此 AI 资讯不属于首版。更大样本等后续研究不阻塞本 Issue | [产品规格](../product/spec.md)、[P3-2 范围](p3-2-news-updates.md)、[实测报告](../reference/ai-news-poc.md)、[复现资料](../reference/ai-news-poc/README.md)、[Issue #16](https://github.com/Iskuyal/wx-match/issues/16) |
| I8 | 已合并旧分支清理（2026-09-28 历史记录） | 前半段记录截至 09-28 的 15 条远端分支清理、PR #68/#69 合入，以及当时保留 PoC 原始证据分支的决定。**2026-09-29 复核更新**：PR #84 完成文档整理、PR #85 将 PoC 复现资料归档进 `main`；相关 PR 分支、5 条已合并远端分支和旧 `docs/ai-news-poc` 分支均已清理。**2026-09-30 复核更新**：核对 PR #95/#97/#102/#103/#104 各分支后清理 7 条远端分支——`docs/status-after-merge`（`ec75c48`）、`feat/goal-days`（`24f789f`）、`feat/advancement-poc`（`fc67353`）、`feat/campus-tools-main`（`fbd6f46`）、`feat/advancement-demo-main`（`41c62f8`），以及 PR #96/#98/#99/#100 关闭后的 `feat/campus-tools`（`29b8d89`）与 `feat/advancement-demo`（`c78d7c5`）。后两条是基于 `feat/goal-days`、`feat/advancement-poc` 的 stacked 分支，上游合入后历史分叉被判冲突，同内容分别重建为 PR #102、PR #103 合入；逐文件比对（含 `app.json`、`package.json` 的键值集合）确认它们**没有任何 `main` 缺少的内容**，唯一差异行是更旧的 `docs/status.md` 核对点与一句已被 #89 核验结论取代的说明，其 5 个提交对象（`4b30e82`、`3669ab5`、`29b8d89`、`1fb8a43`、`c78d7c5`）仍可从已关闭的 PR 取回。本地删除 `codex/restore-campus-refresh-home`（`55ab57b`，PR #88）与 `codex/issue-triage-2026-09-29`（`f145fff`，PR #87），`main` 与 `origin/main` 同步。**2026-09-30 二次复核（关掉最后一条）**：此前按「独立 worktree 占用」保留的 `codex/campus-ideas-p2-p3`（本地 `148b9da`、远端 `f8f8e40`）现已一并关掉——先移除占用它的 `F:/VibeCoding/wx-match-ai-plan` worktree，再删本地与远端分支。删本地时 `git branch -d` 报 `not fully merged`，那是**误导信号**：它比的是已被删除的 upstream，而 tip 正好比 upstream 领先一个提交（合并 PR #77 时生成的合并提交）；判据应是 tip 是否已进入 `main`——tip 的树与 `f8f8e40` 同为 `47e615d8`，且 `git merge-base --is-ancestor` 确认 tip 本身就是 `main` 的祖先，故 `-D` 零损失。移除该 worktree 是安全的：它的 `node_modules` 是独立安装的真目录（非 junction，`test -L` 为假），移除后主检出的 121 项未变，目录内只有可重建的 `dist/` 与 `node_modules/`。**至此远端与本地都只剩 `main`**，逐条 `merge-base --is-ancestor` 确认全仓库已无任何 `main` 之外的内容。仍然留着的只有 `review/pr26`、`review/pr27` 遗留的 3 条 stash（含一条标注「别人的…勿丢」，本轮只读未动，其目标文件均已随 Ticket 01 进入 `main`） | [PR #68](https://github.com/Iskuyal/wx-match/pull/68)；[PR #69](https://github.com/Iskuyal/wx-match/pull/69)；[PR #77](https://github.com/Iskuyal/wx-match/pull/77)；[PR #84](https://github.com/Iskuyal/wx-match/pull/84)；[PR #85](https://github.com/Iskuyal/wx-match/pull/85)；[PR #96](https://github.com/Iskuyal/wx-match/pull/96)；[PR #98](https://github.com/Iskuyal/wx-match/pull/98)；[PR #102](https://github.com/Iskuyal/wx-match/pull/102)；[PR #103](https://github.com/Iskuyal/wx-match/pull/103) |

## 四、明确不在本次范围

写在这里是为了不被误当漏项。

- **Ticket 08 发布后单页模式**：`wontfix`。本次参赛不做认证、备案与体验版，P6 用「预览」做真机演示，材料中如实标注未发布。注意票面的第一条验收（页面开启分享接口）**从未实现**——全仓库没有 `onShareAppMessage` / `onShareTimeline`；将来若走发布路径，要补的不只是单页模式实测，分享能力本身也要做。
- **Ticket 10 校园通知 RAG 与 Ticket 11 OCR**：国赛版方向，**不能计入省赛已完成能力**。Ticket 11 目前只差腾讯云密钥即可跑通，但省赛可暂缓。Ticket 10 的 `recall` / `answer` 两个子命令目前跑不起来——`scripts/rag-poc.cjs` 引用的题库 `docs/evidence/p6-rag/questions.json` 尚未产出。
- **认证、备案、体验版与正式发布**：不在已完成范围。

## 五、排期上的硬约束

1. **内容安全配额**：未上线小程序的内容安全检测有**日上限 100 次**，用尽后当天 fail-closed，问答、助手与识图全部不可用。演练、录屏、现场演示与验收在抢同一份额度，需按 D15 倒排。
2. **两个截止日期**：省赛报名与提交截止 2026-11-18，但**学校统一上报**，校内收口更早且尚未确认（D3）；国赛报名 2026-12-10 至 12-21、提交截止 2026-12-27。
3. **独立云端项**：V1 的实际触发、V2 的归属证据归档与剩余额度验证、V3 的合法维护者路径、V4 的全量入库及 V7 的新版部署，仍按各自判据核对；A1–C1 通过不自动覆盖它们。
4. **真实结果的边界**：2026-09-25/26 仓库中的 UI 与交互证据来自开发者工具模拟器，`realDevice: false`；2026-09-27 负责人另行确认 A1–C1 全部通过，但本轮真实设备、模型与版本记录尚未归档，不能把旧模拟器截图当作本轮证据。

## V2 历史记录（2026-09-29，保留原过程）

以下是补充确认前的原记录，当前归属状态按上方 V2 与 09-30 负责人确认读取。

两个微信号分别验证本人截图成功、他人 `fileID` 在下载前被拒、个人额度生效。当前只有单账号与伪造文件冒烟。**2026-09-29 部分推进**：成本/额度侧的**月度汇总**已可由维护者读取（当月 790 次调用、212,525 token、0.0531 元，上限 50 元，未告警），但**个人**分钟/日额度与两账号归属仍要两个微信号实测——模拟器只登录一个账号，这一项保持未验证，不用单账号桩值代替。**2026-09-29 单账号可验的部分已验**：同一分钟内并发发 7 次 `chat`，其中一次返回 `quota_exhausted` +「本分钟 AI 调用次数已达上限，请稍后再试。」+ detail「本分钟调用次数超过 6 次」⇒ **个人分钟额度（默认 6/分）在服务端确实生效**；另有 3 次撞在记账闸门上（`internal`「AI 记账闸门正在使用或待核对」），说明闸门在正常工作且会释放（后续请求能继续）。**仍未验**：个人**日**额度（30/天，打满需 30 次调用，成本高，建议用控制台读计数器代替）与两账号归属（需第二个已同意参与的微信号）
