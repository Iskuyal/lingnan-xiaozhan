# 原生落地的首屏布局修订

2026-10-17，沿用负责人已确认的 [57 屏方向](../lingnan-ui-2026/README.md)。原生第一轮视觉复查发现课表、导入校对首屏说明过长，本目录先画布局并用 `node scripts/render-mockups.mjs` 输出 PNG，再定向调整原生模板；不改写原先的设计和评审历史。

- [课表 HTML](01-compact-timetable.html) / [PNG](png/01-compact-timetable.png)：页边距20px，窄屏16px；周次与日期同排，44px操作，作息说明与60px设置入口并排；七天66px列、节次44px行。
- [导入校对 HTML](02-compact-import.html) / [PNG](png/02-compact-import.png)：先显示课程与待核对计数；文件、班级、院系和导出时间折叠，44px明示展开；保留替换本人全部课程的可见后果。
- [材料目录 HTML](03-reader-directory.html) / [PNG](png/03-reader-directory.png)：目录按需展开，选择条目后收起，为短屏正文留出空间；44px目录动作与固定48px返回保持可用。

两图为静态示例，并非微信运行截图。原生实现和模拟器记录见[实现证据](../../evidence/lingnan-ui-2026-10-17/README.md)。现有列表、真实数据和本人确认接口不由本轮布局改变。
