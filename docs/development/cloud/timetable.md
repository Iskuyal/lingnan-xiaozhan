# 课表云函数与导入存储

按主题拆分的操作与配置参考。文中带日期的部署、探测结果保留为历史快照；执行前按当前代码和控制台配置复核。

[当前状态](../../status.md) · [云开发总览](README.md)

## 课表云端实施（Ticket 03；2026-09-19 已部署并完成端上验收）

课表导出的解析跑在云函数 `timetable` 侧：客户端把选中的文件上传到**本人 openid 专属的云存储路径**，云函数下载 → 用 `xlsx` 解析成草稿 → **删除临时文件**；确认页确认后才写库。函数同时承担个人课表的读取与手工增删改，全部按调用上下文的 openid 过滤，客户端不直连数据库。截图识别（Ticket 05）复用同一条上传路径，识别由 `ai` 云函数的 `vision` 动作完成。

**状态（2026-09-19）**：集合 `timetable_courses`、云函数 `timetable` 与环境级函数权限（`timetable` 允许已登录用户调用，`newsSync` 仍为 `false`）已由负责人在控制台完成；负责人用真实样本在开发者工具走完导入并完成端上验收，逐项结果见下「部署后可验证的判据（人工）」，原始输出见 [Ticket 03 验证记录](../../evidence/p4-b/README.md#2026-09-19-云端端上验收)。**云存储权限与函数超时两项控制台配置已由负责人确认（2026-09-19）**：云存储权限为**「仅创建者可读写」**，`timetable` 函数超时为 **20 秒**；控制台「存储」里 `timetable-imports/` **无残留**（临时文件已删除）。**仍未验证**：两个微信号的用户隔离、确认页「放弃导入」路径、错误文件的可理解提示（仅桩测试）。本轮另修一处 UX 问题：在文件选择器里点取消（`cancel`）不再打出「课表操作失败：…cancel」诊断日志（行为本就正确：回到原页面、不写数据、不显示错误），见分支 `fix/import-cancel-quiet`。

**文件标识统一用 fileID**：客户端 `wx.cloud.uploadFile` 返回的 `cloud://…` 才是 fileID；`prepareUpload` / `preparePhotoUpload` 返回的 `cloudPath` 只是相对路径，只能交给 `uploadFile` 当上传目标。`importDraft` / `discardUpload` 接收的是 `fileID`，云函数**从 fileID 里解析出云存储路径**再校验「属于调用者 openid 前缀」（fileID 里的环境信息不参与比较），解析不出路径或不在本人前缀下都明确拒绝。把裸 cloudPath 当 fileID 传会在 `cloud.downloadFile` 处失败——那是 Ticket 03 的老写法，已修正并补了回归测试。

**`updateCourse` 是部分更新（Ticket 06 两轴复核修复）**：只覆盖请求里**显式给出**的课程字段，未给出的字段保持原值；`owner` / `semester` / `rawText` / `source` / `createdAt` 等由服务端掌握，客户端传了也不生效。手工编辑表单提交的是完整字段集，课表助手（06）只提交这次真正改动的字段——两层都不允许「只改时间」把教师、地点、学分、周次或备注一起清空。要清空某个字段，必须在请求里显式给空字符串。

代码位置与测试：

| 文件 | 职责 |
| --- | --- |
| `cloudfunctions/timetable/index.ts` | 云函数入口：`prepareUpload` / `preparePhotoUpload` / `importDraft` / `discardUpload` / `list` / `saveDraft` / `createCourse` / `updateCourse` / `deleteCourse` |
| `cloudfunctions/timetable/parse.ts` | 网格矩阵解析（依赖 npm `xlsx`，不进小程序包） |
| `cloudfunctions/timetable/record.ts` | 记录规范化和整批校验（不合规整批不写） |
| `tests/timetable-parse.test.cjs` | 4 份真实教务导出 + 异常版式 |
| `tests/timetable-flow.test.cjs` | 云存储与数据库桩上运行真实入口：导入不写库、临时文件删除、fileID 归属校验（含裸路径与别人的 fileID 被拒）、跨学生隔离、整批校验、手工三条路径 |
| `tests/timetable-pages.test.cjs`、`tests/timetable-view.test.cjs` | 页面编排、周次切换与按节次展示、产物不含 Excel 库 |
| `tests/timetable-photo.test.cjs` | 截图识别：文件头判格式、压缩阶梯、识别 JSON 解析（周次留空不当每周）、确认页出口、来源贯通 |

数据模型（集合 `timetable_courses`，一条课程一个文档）：

| 字段 | 说明 |
| --- | --- |
| `owner` | 调用上下文的 openid，**只由云函数写入**，所有查询与更新都带这个条件 |
| `id` | 客户端传入的服务端标识（`tc_` 前缀），页面间传参用它 |
| `name` / `credits` / `teacher` | 课程名、学分（原样保留，如 `0.25`）、教师 |
| `weekday` | 1-7 对应星期一至星期日 |
| `sectionRanges` | 节次区间数组，如 `[{start:1,end:2},{start:3,end:4}]` |
| `startSection` / `endSection` | 原文解析出的起止节；倒置或越界时保留原值，`sectionRanges` 为空并带 warning |
| `weeks` / `weeksRecognized` / `weekText` | 展开后的教学周、是否识别、周次原文 |
| `location` / `campus` / `siteNumber` / `note` | 地点、校区、场地编号、备注（教学班或方向） |
| `warnings` | 待核对提示，页面据此显示「待核对」与原文 |
| `source` / `semester` / `rawText` | 来源（`excel` / `manual` / `photo`）、学期标注、导入时的单元格原文；**截图识别来源为 `photo`，此时 `rawText` 为空**——截图识别后已删除、字段是模型重新表述的，没有可核对的「原文」，不拿合成文本冒充 |
| `createdAt` / `updatedAt` / `batch` / `staged` / `headBound` | 时间戳与写入批次；新导入记录先标 `staged: true`，批次标记提交前不进入可见课表；可见批次下新建的手工课标 `headBound: true`，让首次导入的旧数据清理只触及历史记录。旧课程没有后两个字段，按旧数据读取 |

**本地待部署修复（2026-09-27）**：同一集合增加一条 `_id=timetable-head-<openid SHA-256>` 的内部标记文档，不带 `owner`，其 `activeBatch` 决定当前可见课程。新批次全部写完后才单文档切换；清理旧批次失败时返回 `cleanupPending`，下次列表读取重试清理，旧课不会混入。提交应答丢失时先读回标记再判断结果，不盲删可能已生效的批次。部署后需用已有旧课表验证无标记时的兼容读取、首次替换和失败重试；本地桩测试不能代替云端验证。
失败写入留下的隐藏批次只有超过 60 秒才会在后续列表读取时尝试清理，以免误删正在进行的导入。手工新增、修改或删除与整份导入交错时，云函数会核对可见批次；若已切换，则返回冲突并要求刷新，不把失效批次上的操作报告为成功。

**为什么没有给 `owner` 建索引**：数据量是个人的几十条，按 `owner` 全量读取即可；将来若按 `owner + semester` 或按周查询再补索引。

### 人工步骤（动作 / 对象 / 判据）

以下都是控制台操作，代码侧无法完成。**第 1–5 项已于 2026-09-19 由负责人完成或确认**：集合、云函数部署与函数权限已复核，课表页已能正常读到数据；云存储权限确认为**「仅创建者可读写」**；`timetable` 超时确认为 **20 秒**。第 4 项判据里「用第二个微信号读取他人文件应被拒」的端上定点复核与「用户隔离」同源，仍未实测。

1. **创建集合**（**已完成，2026-09-19 复核**）
   - 动作：在云开发控制台「数据库」新建集合 `timetable_courses`。
   - 对象：环境 `cloudbase-d2gjtbbwu3575cd7b` 的数据库。
   - 判据：集合列表里能看到它；权限为**最严格预设「所有用户不可读写」**（或自定义 `{"read": false, "write": false}`）。在开发者工具里用 `wx.cloud.database().collection('timetable_courses').get()` 应返回 `DATABASE_PERMISSION_DENIED`——客户端直连被拒是这一票的隔离要求之一。

2. **部署云函数**（**已完成，2026-09-19 复核**）
   - 动作：在开发者工具里右键 `dist/cloudfunctions/timetable`（或 CLI `cloud functions deploy --name timetable --remote-npm-install`）部署，**必须勾选/使用云端安装依赖**：该函数依赖 `wx-server-sdk@4.0.2` 与 `xlsx@0.18.5`。
   - 对象：云函数 `timetable`。
   - 判据：控制台「云函数 → timetable → 测试」运行 `{"action":"list"}` 返回 `ok: true, count: 0`（首次、无数据时）；运行 `{"action":"prepareUpload","fileName":"a.txt"}` 返回 `ok: false` 且提示只支持 `.xls/.xlsx`；运行 `{"action":"preparePhotoUpload","fileName":"a.gif"}` 返回 `ok: false` 且提示只支持 `.png/.jpg`。
   - **升级注意（Ticket 05 两轴复核）**：`importDraft` / `discardUpload` 的参数已从裸 `cloudPath` 改为 `fileID`（`cloud://…`），**客户端与云函数必须一起部署**。只更新一边会让导入直接失败：新客户端 + 老函数会被「参数不合法」拒（老函数把 `fileID` 当 `cloudPath` 校验，前缀不匹配），老客户端 + 新函数会被「请传入 fileID」拒。

3. **函数调用权限**（**已完成，2026-09-19 复核**）
   - 动作：仍在「云函数 → 权限控制」的环境级 JSON 里**只新增** `timetable` 一条，值与环境里 `*` 的表达式一致（例如 `"auth != null && auth.loginType != 'ANONYMOUS'"`）；**不要**把它设成 `false`——`timetable` 必须允许小程序端调用，隔离靠函数内的 openid 过滤，而不是靠禁止调用。
   - 对象：环境级函数安全规则 JSON（与 `newsSync: {"invoke": false}` 并列）。
   - 判据：小程序端 `wx.cloud.callFunction({name:'timetable', data:{action:'list'}})` 返回 `ok: true`；同时 `newsSync` 仍然返回 `-501023 permission denied`（不能改动既有规则）。

4. **云存储权限**（**已完成，2026-09-19 负责人确认**）
   - 动作：控制台「存储 → 权限设置」把默认权限改为**「仅创建者可读写」**（如需自定义规则则用 `resource.openid == auth.openid` 限定）。本次导入只写入 `timetable-imports/<openid 哈希>/` 下的临时文件。
   - 对象：环境云存储的整体权限（云存储规则不能按目录分别配置）。
   - 判据：小程序端用 `wx.cloud.getTempFileURL` 读取**别人**上传的文件应被拒；云函数（管理端）仍能 `downloadFile` 与 `deleteFile`。
   - **确认结果（2026-09-19）**：控制台权限设置为**「仅创建者可读写」**；云函数侧的下载与删除在本次导入中正常工作（解析成功、`timetable-imports/` 无残留）。判据前半条「用第二个微信号读取他人文件被拒」未单独实测，与「用户隔离」同源。

5. **函数超时（建议 20 秒）**（**已完成，2026-09-19 负责人确认**）
   - 动作：控制台「云函数 → timetable → 配置」把超时从默认 3 秒调到 20 秒。
   - 对象：云函数 `timetable` 的超时配置。
   - 判据：用小程序上传一份真实样本（约 20KB）能解析成功；解析本身的耗时量级很小（实现时在本机对 4 份样本各测一次为 1–13 毫秒，**该测量未纳入自动化验证记录**），耗时主要在下载与冷启动，20 秒足够。
   - **确认结果（2026-09-19）**：控制台配置确认为 **20 秒**；负责人的真实样本导入在 20 秒配置下成功解析（云端入库 15 门课程），判据成立。

### 部署后可验证的判据（人工）

状态列按 2026-09-19 的云端端上验收填写；原始输出见 [Ticket 03 验证记录](../../evidence/p4-b/README.md#2026-09-19-云端端上验收)。

| 验收项 | 判据 | 状态（2026-09-19） |
| --- | --- | --- |
| 导入走通 | 在开发者工具里把 `tests/fixtures/timetable/2026-2027学年第一学期班级课表.xls` 发给文件传输助手 → 导入页选择它 → 确认页显示 15 门课程、0 条待核对 → 保存后周课表出现课程 | **通过**：负责人用该样本走完导入（选文件仍为人工）；云端 15 门课程，课表页元信息「2026-2027学年第一学期 · 共 15 门课程」，`{"action":"list"}` 返回 `ok=true, count=15` |
| 解析不写库 | 导入过程不写入课表；点「放弃导入」后集合保持原样 | **部分验证（2026-09-19）**：负责人实测的是**在文件选择器里点取消**（日志 `chooseMessageFile:fail cancel`，这条路径不进入上传与解析）后集合条数不变；**确认页上点「放弃导入」按钮的路径仍未实测**——两者不是同一条路径，不能互相替代 |
| 临时文件删除 | 解析完成后「存储」里 `timetable-imports/` 下没有残留文件 | **通过**：负责人核对控制台「存储」，`timetable-imports/` 下无残留（2026-09-19）。注意 2026-09-18 记录的极端路径（上传成功后小程序被强杀，既未解析也未清理）仍可能残留，该风险单独保留 |
| 周次切换 | 周课表切到第 8 周能看到 8-17 周的课，切到第 7 周看不到（样本里 `[2-6,8-17]周`） | **通过**：负责人截图——第 8 周出现 `[8-17]周` 的《使用JSP开发Web应用系统》《软件工程（基于面向对象的软件设计）》等，第 7 周没有（只有 `[2-15]周` 的《军事理论》等） |
| 退出重进 | 杀掉小程序重进课表页，课程仍在 | **通过**：每次 `reLaunch` 课表页都从云端读到 15 门（`ok=true`） |
| 手工三条路径 | 新增一门课并出现在周课表；修改后展示更新；删除后消失 | **通过**：维护者脚本从模拟器调用，每次用临时课程——新增后 `count 15→16`；只提交 `teacher` 与 `location` 的部分更新未清空学分/备注/校区/场地编号/周次/星期；删除后 `count` 回到 15，结束后计数已还原、临时数据已清理 |
| 用户隔离 | 换另一个微信号进入课表页，看不到前一个账号的课程 | **未验证**：需要一个第二微信号 |
