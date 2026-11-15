# ADR-0003：单周停课写进课程的周次集合，不新增「例外记录」

日期：2026-11-10。状态：已选定并实施（AI 创新点 A「通知一键调课」，`services/timetable/notice.ts`）。

## 背景

设计图 02 与 [AI 创新点提案](../design/ai-innovation-2026-11/README.md) 的第 3 个待拍板项提出：班群通知里「第 12 周周三全天停课」这种**只影响某一周**的变更，在数据层怎么表示？

两条路：一是把它摊平进课程已有的 `weeks: number[]`（把 12 从集合里去掉）；二是新增「例外/覆盖」记录，课程本身不动，读取视图时再叠加。

课程数据的形状由云函数 `timetable` 决定：`StoredCourse` 继承 `CourseFields`，周次就是一个 `number[]` 加上 `weekText` 原文，`weeksRecognized` 标记原文是否被识别。导入走「整份替换」（`saveDraft`），没有任何存放例外表的集合。这个约束在 `cloudfunctions/timetable/types.ts` 与 `record.ts` 里是硬性的：`normalizeCourseFields` 只认 `CourseFields` 的字段。

## 决策与理由

1. **停课 = 从课程的 `weeks` 里剔除那几周，同时重算 `weekText`。** 视图层（`view.ts` 的 `occursInWeek`、`buildGrid`、`coursesForWeek`）本来就是按 `weeks` 判断这门课这周上不上，摊平之后不需要改任何读取路径。
2. **不新增例外集合。** 新增集合意味着：web 端要引入「课程 + 例外」两次查询与合并；`saveDraft` 的整份替换语义要重新定义（例外跟着被替换吗）；导入重跑时旧例外要不要保留。这三个问题都会把一次「改周次」放大成一次数据模型迁移，而它回答的仍只是「第 12 周不上」。
3. **写入口径统一在 `applyPlan`。** 勾选的提案先被翻译成 `CourseInput`（复用 `assistant.ts` 的 `buildChangeInput`，未指定的字段从当前课程原样带过来），再走已有的 `updateCourse`。所以「通知调课」和「手工编辑课程」写的是同一条路径、同一套校验，没有第二条写入通道。
4. **撤销靠写入前的快照，不靠例外记录。** `applyPlan` 给每条 update 步骤带上 `before = snapshotInput(current)`，`invertPlan` 倒序把 `before` 写回去。10 秒撤销因此在语义上就是「把快照写回来」，不需要反向推导周次。

## 方案比较

| 方案 | 取舍 |
| --- | --- |
| 摊平进 `weeks`（选定） | 零数据模型变更、读取路径不改、撤销就是写回快照；代价是丢失「这门课原本每周都上」的原始形态，只能靠 `weekText` 原文与撤销窗口兜底 |
| 新增「例外/覆盖」记录 | 语义最准、原始课程不动；但要改云表、改两次查询与合并、重新定义整份替换语义，工作量与回归面都远超这一条变更的价值 |
| 停课只做本地提示，不写数据 | 最保守；但学生下次打开课表还是看到那节课，等于没做 |

## 限制与验证

- **每周课停一周需要知道学期总周数。** `weeks` 为空表示「每周都上」，要摊平就必须先展开成 1..totalWeeks。`remainingAfterCancel` 在 `totalWeeks < 1` 时返回 problem、写进 `blocked`、`defaultChecked = false`，`applyPlan` 直接跳过——不会写出空 `weeks` 造成「这门课没了」。单测锁定在 `tests/timetable-notice.test.cjs`「解析:每周都上的课要停一周时按总周数展开,不知道总周数就标阻塞」。
- **周次原本就没识别出来**（`weeksRecognized === false`）同样标阻塞，让人去课程里手动改，而不是猜。
- **停到一周不剩**时返回「这门课只有这几周，停课后就没有剩余周次了；请在课表里直接删除这门课」，不替学生做删除决定。
- **唯一的空 `weeks` 出口是「补课且通知没写周次」**，语义是「每周都上」，与手工表单一致；这不是停课的残留。

## 影响

- **数据**：没有新集合、没有新字段，`timetable_courses` 结构与 ADR 之前完全一致。导入重跑（整份替换）会覆盖这些调整——这与手工改课程被覆盖是同一件事，不额外承诺保留。
- **界面**：提案卡显示「将写入」的前后对照；应用后 10 秒内可撤销，撤销也是走同一条 `updateCourse`。
- **测试**：`tests/timetable-notice.test.cjs` 19 项覆盖四条动作（停课/改地点/改时间/补课）与冲突分级。

## 关联

- [ADR-0002](0002-department-activity-rag.md)：同为「先立结构、后扩语料」的思路，但本 ADR 的结论相反——这里选择**不**引入新结构。
- [AI 创新点与界面升级提案](../design/ai-innovation-2026-11/README.md)：待拍板项 3 由此关闭。
- Ticket 05（截图识别）与本决策相邻但不同链路：截图识别产出草稿交人工逐条确认，本 ADR 管的是确认之后写进哪。
