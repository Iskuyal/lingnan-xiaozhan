# 三人共享约定

## 开工与范围

- 平台为原生微信小程序TypeScript/WXML/WXSS。实施的是已经确认的 [岭南红设计](../../design/lingnan-red-2026-11-11/README.md)：先看PNG，再按同名HTML和共享CSS中的数字还原。79张是分镜数量，不是79个应用路由。
- 只实施17个在用旧路由及新增 `pages/study/index`、`pages/campus/index`。现有5个失物招领路由保留，44–48/50附录不恢复入口、不扩大实施。
- 读取根 `AGENTS.md`、`CONTEXT.md`、`docs/product/spec.md`、`docs/development/phases.md`、`docs/development/workflow.md`、`docs/competition/README.md`、设计说明和相关ADR；课表读ADR-0004，学习计划读ADR-0005。旧首页保留、暂不设tab等历史口径已被本轮批准的设计覆盖。
- 每人用独立clone或worktree、独立依赖/构建/证据目录和自动化端口。仅切三个分支而共用一个工作目录不算隔离。端口建议A=9461、B=9462、C=9463。
- 启动核对负责人指定的交接SHA包含业务基线 `a35f9d9f1c11bba60e32cb65e314f629cceeb2ba`，记录初始HEAD；工作区已有他人改动时保留它们。不要拉入无关main更新、强推、清理他人文件或提交缓存/密钥。

## 文件归属

下表产品路径均相对于 `miniprogram/`。

| 人员 | 唯一可写的产品区域 |
| --- | --- |
| A | `app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`ui/campus/`、`components/ui-v2/`、`assets/ui-v2/`；`pages/home/`、`pages/study/`、`pages/campus/`、`pages/departments/`、`pages/news/` |
| B | `pages/timetable/`、`ui/timetable/`；`services/timetable/palette.ts`仅可调整视觉色值，保留取色及用户数据语义 |
| C | `pages/goals/`、`pages/calendar/`、`pages/fitness/`、`pages/advancement/`、`pages/defense/`、`ui/study/` |

测试及验证脚本各用 `ui-v2-a-*`、`ui-v2-b-*`、`ui-v2-c-*` 前缀；证据分别写 `docs/evidence/lingnan-ui-implementation/a/`、`b/`、`c/`。已有模块专属测试可由该模块负责人更新；公共测试、`tests/lib/`、共享验证脚本、package与锁文件、全局文档索引仅由A维护，必要时交Codex集成处理。A也不能为迁就页面改坏业务断言。

三人共用的冻结区：云函数、既有 `services/` 业务逻辑和存储结构（B的色板视觉例外除外）、原设计HTML/PNG、历史证据。UI适配放页面或各自 `ui/`。确需修改冻结区时，先给出复现、所需接口和影响，记录为跨范围问题；继续不依赖它的工作，不自行重写业务。

## 公共视觉与导航

- 主色 `#c41c23`，以已定稿尺寸、层级和状态为准。旧token名称和值保留，新增灰白表面可由A增补新token。B/C在基础到位前使用既有token（带同值fallback）和图稿字面值，不依赖A尚未交付的组件、class或新token。局部样式用模块前缀，A保留旧公共class兼容性，避免全局选择器污染别人的页。
- 不把静态稿页脚、模拟状态栏、假胶囊、示例课程/时钟带进产品。必要的字段补齐和原生适配可自行处理并记录；若会改变布局，先在自己的 `docs/design/lingnan-ui-implementation-a/`、`-b/` 或 `-c/` 画最少的补充HTML/PNG，引用原图编号，不覆盖79张冻结原稿，不重开整体视觉方向或重复索取已给的确认。
- 使用真实WXML控件、数据与事件实现；设计PNG只作对照，不把整张图铺成页面或用固定示例填满业务流程。
- 四个tab固定为今天 `/pages/home/index`、课表 `/pages/timetable/index`、学习 `/pages/study/index`、校园 `/pages/campus/index`。A负责真实tab注册、图标及公共导航；不在每页画一个无法保持状态的假底栏。其他现有页面路径和入参保留。
- 普通详情返回、分享直达、系统返回、tab切换和键盘/安全区按当前基础库核对。不要复制HTML模拟状态栏、胶囊坐标、DOM事件、浏览器CSS技巧到WXML来假装原生实现。课表初始定位用实际数据和原生可用机制实现。

### 跨tab意图：A实现，B消费，A/C调用

公共文件 `miniprogram/ui/navigation.ts` 的导出接口固定如下，不自行改名：

```ts
export type UiTab = 'today' | 'timetable' | 'study' | 'campus';
export type TimetableIntent =
  | { kind: 'assistant'; text?: string }
  | { kind: 'week'; week: number }
  | { kind: 'plan-week'; planDate: string };
export function openUiTab(tab: UiTab): Promise<void>;
export function openTimetable(intent?: TimetableIntent): Promise<void>;
export function consumeTimetableIntent(): TimetableIntent | null;
```

仅此模块持有临时导航key `lingnan/ui-timetable-intent/v1`。存储封装为 `{id, createdAt, intent}`；五分钟有效，一次性消费，校验类型、日期和数值，非法/过期返回null。路由失败仅清理自己写入的同id意图，保留页面输入。它不是业务存储，不改课程或已保存计划。

B在课表显示时消费意图，等课程和设置读取完成再应用：`assistant`只打开助手并预填，**不自动调用模型或写课**；`week`选择指定有效周；`plan-week`按实际日历日期和已有学期设置映射，映射不了就说明，不强制当第1周。保留旧启动query兼容：有效启动query仅首次进入生效，之后使用新的用户导航意图，不因每次onShow重放旧query。

基础分支发布前，B/C可以开发样式、页面和模块内测试。公共导入和跨tab回归在合入同一个 `NAV_SHA` 后完成；不要私造第二个导航模块、改app.json、写兼容假路由来掩盖依赖。

## 业务底线与验证

- 课程确认前不写入；限定周次不扩大到全部周；部分成功只重试失败项，保留幂等和撤销。课程名、节次、日期、教室来自真实数据，图上的9条课程和固定日期只是示例。
- 未填作息不编造钟点；读取失败不等于无课。AI先整理带原话的约束，再由用户核对、规则排程；计划只存本机并独立于正式课程。沿用原数据key/格式，不做清空或迁移来换取界面效果。
- 修复bug先保留失败复现；路由、数据和新增交互增加有意义的回归。纯样式用渲染核对，不堆只断言class字符串的测试。保留业务覆盖；更新旧视觉接线断言须说明与新设计的对应关系，不能删断言来凑通过。
- 每人运行 `npm run typecheck`、`npm test`、`npm run docs:check`，以及自己的模块原生验证。基线918项测试是历史参照，报告实际N/pass/fail/skip，不照抄旧结果。
- 模拟器使用虚构数据及固定模型响应；先读现有验证脚本，确认不会走真实请求后再复用。优先复用 `scripts/lib/mini-connect.cjs`；给每次实际待测构建独立项目路径，避免IDE缓存造成WXML新、JS旧。截图核对390px、320px、长文本、空/错误、底部固定区及返回恢复；320仅浏览器辅助时明确标注。
- 本轮没有新增真实业务AI、云函数部署、真实课程增删改、体验版/正式发布授权。既有真实AI单次许可已用完，不自动重试。持久化测试用隔离数据并在finally恢复；不覆盖用户目标和计划，不用设计PNG冒充原生截图。

## 交付与审查

各人只提交自己的范围，中文commit，推送个人分支；不互相合并最终模块、不合main、不关闭整体验收。公共基础的同一 `NAV_SHA` 可以合入个人分支。A负责公共进度文件；B/C只写自己的报告及Issue评论，避免多人覆盖同一状态。

每份报告包含：角色、起始交接SHA、业务基线、NAV_SHA、完整HEAD、分支/PR地址、改动文件、设计图编号到实际页面/状态的对应、测试命令和实际结果、原生截图路径/数据身份、未解决项。基础未到位的场景如实标依赖；最终模块交付前补齐可执行回归，不把自测写成Codex审查通过。

报告内固定实际被测的代码提交；证据/报告随后提交形成的最终HEAD在交付消息给出。说明两者之间是否只有证据与文档；若又改了代码，重跑相关验证，不能把前一版通过移给后一版。

Codex最终复查冻结基线到集成HEAD的全部差异（包含公共基础），分别审规范与规格，复跑完整测试、导航跨模块流程和关键原生截图；实现画面不能沿用图稿8.5/8.6作为自己的运行验收成绩。
