# 正式名称「岭南小栈」原生复核（2026-10-29 22:10）

## 背景

负责人 2026-10-29 晚决定：正式作品名由早前的「课表小栈」改为 **「岭南小栈」**（同日 20:24 的预算/审核决定不变）。此前「课表小栈」同步后，原生模拟器导航仍显示旧工作名「校园工具」，判断为开发者工具**编译缓存**未刷新；失败记录保留在 [fresh-department-2026-10-29-round2/name-visual-review.json](../fresh-department-2026-10-29-round2/name-visual-review.json)（`observedTitle: 校园工具`，重开曾阻断）。

## 本轮动作

1. 源码：`miniprogram/app.json` 与 `miniprogram/pages/home/index.json` 的 `navigationBarTitleText` 改为「岭南小栈」；`project.config.json` 描述改为「岭南小栈校园信息与课表工具」；工程名 `wx-match` 不变。
2. 设计图：更新 [app-name-2026-10-29](../../design/app-name-2026-10-29/README.md)（仅文字替换，布局/导航排版不变），PNG 重新渲染。
3. 回归：`tests/app-identity.test.cjs` 断言同步为「岭南小栈」。
4. 缓存：`npm run build` 后执行 `cli cache clean --clean compile`，再用 `cli auto --project dist --auto-port 9420 --trust-project` 重开项目。
5. 截图复核：原生模拟器首页截图为 [home-lingnan.png](home-lingnan.png)，导航标题为「岭南小栈」；原始记录见 [name-visual-review-2026-10-29.json](name-visual-review-2026-10-29.json)。

## 结果

| 检查 | 结果 |
| --- | --- |
| `dist/app.json` 默认导航 | `岭南小栈` |
| `dist/pages/home/index.json` 首页导航 | `岭南小栈` |
| `dist/project.config.json` 描述 | `岭南小栈校园信息与课表工具` |
| 原生模拟器首页导航（截图人工核对） | **岭南小栈** |
| `tests/app-identity.test.cjs` | 通过（随 `npm test`） |

## 边界

- 原生模拟器截图，**不是真机**；不证明 320px 窄屏、系统字号或真机导航表现。
- 仅代表源码/配置与当前模拟器渲染；**不代表微信后台注册名称、正式发布或学校审核已修改**。
- 旧名「校园工具」「课表小栈」只保留在历史稿、旧截图与日期记录中，不回头改写。
