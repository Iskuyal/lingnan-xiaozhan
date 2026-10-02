# G4 · `ai` 云函数部署留档与回读比对（2026-10-01/02）

- 对应 [Issue #115](https://github.com/Iskuyal/wx-match/issues/115)；判据见 [G4 主清单](../README.md)。
- 分支 `codex/project-defense-g4`，HEAD `39405fe`（合并 PR #124/#125/#126 之后的 `main`）。
- 环境 `cloudbase-d2gjtbbwu3575cd7b`，函数 `ai`；**只部署了 `ai`**，未动 `newsSync` / `timetable`。
- **只写分支与 SHA，不写个人磁盘绝对路径**（CLI 命令里的 `<dist>` 指本 worktree 的 `dist/`）。

## 1. 部署前留档（回退用）

`cli cloud functions deploy` 之前先 `download` 了线上版本：

```text
cli cloud functions download --env cloudbase-d2gjtbbwu3575cd7b --name ai \
  --path docs/evidence/project-defense-g4/deploy/before-2026-10-01 --project <dist>
```

- **`download` 这次成功**。G3 阶段记的 `code 17「二维码输出路径无效或不存在」`在本轮没有复现——当时是「开发者工具未登录/项目未打开」的会话状态问题，不是权限问题。
- 下载产物含 `node_modules/`（约 5,830 个文件 / 22 MB）。**`node_modules` 不入库**：部署走 `--remote-npm-install`，依赖由云端安装，回读判据只比**函数根目录入口文件**。
- **未变化的入口文件也不入库**（`dist/` 在本仓库是 gitignore 的构建产物，把 40 份编译结果塞进 `docs/` 与仓库约定相冲）。入库的是：
  - `manifest.json`：20 个根目录文件在**本地构建 / 部署前留档 / 部署后回读**三处的 SHA-256 与字节数——「20/20 一致」这条结论就是它算出来的；
  - `before-2026-10-01/index.js`、`after-2026-10-01/index.js`：本次**唯一被更新**的入口文件，两边都留一份才能 diff 出那 +55 行；
  - `after-2026-10-01/defense.js`、`after-2026-10-01/defense-materials.js`：本次**新增**的两个文件。
- 同目录合计约 124 KB（未剪枝前约 548 KB）。**要复跑比对需先重新 `download`**，命令见本文第 1、3 节。

## 2. 部署

```text
cli cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai \
  --remote-npm-install --project <dist 绝对路径>
```

结果：`success: true`，**filesCount 20，packSize 97.3 KB**，耗时约 15 秒（16:44:44 → 16:44:59）。

## 3. 回读判据：函数根目录入口文件逐字节一致

部署后 `download` 到 `deploy/after-2026-10-01/`，与本地 `dist/cloudfunctions/ai` 逐文件比 SHA-256：

**20/20 逐字节一致，0 个不一致，0 个缺失。**

变化的只有三处，其余 17 个文件前后哈希完全相同：

| 文件 | 旧版 | 新版 | 变化 |
| --- | --- | --- | --- |
| `index.js` | 50,883 B<br>`bfe30a9c…` | 55,204 B<br>`73fd785a…` | **更新**（+55 行，0 行删除） |
| `defense.js` | 不存在 | 10,557 B<br>`b0db018c…` | **新增** |
| `defense-materials.js` | 不存在 | 7,193 B<br>`e2e7c316…` | **新增** |

完整三方清单（本地构建 = 回读产物；旧版为部署前留档）：

| 文件 | 本地 | 回读 | 本地=回读 | 旧版 SHA-256 | 新版 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| access.js | 5789 | 5789 | 一致 | f296aedf…4a9b | f296aedf…4a9b |
| advancement.js | 18388 | 18388 | 一致 | aa5fa06e…e5c1 | aa5fa06e…e5c1 |
| advancement-corpus.js | 8500 | 8500 | 一致 | 3126a6b3…f69bd | 3126a6b3…f69bd |
| config.js | 10240 | 10240 | 一致 | 59f65fc5…5f39 | 59f65fc5…5f39 |
| config.json | 117 | 117 | 一致 | b380eda2…7320 | b380eda2…7320 |
| defense.js | 10557 | 10557 | 一致 | —（旧版无此文件） | b0db018c…f46f |
| defense-materials.js | 7193 | 7193 | 一致 | —（旧版无此文件） | e2e7c316…d54f |
| department-corpus.js | 5228 | 5228 | 一致 | 345d09e7…e9e4e | 345d09e7…e9e4e |
| errors.js | 8100 | 8100 | 一致 | a0df416d…f89f | a0df416d…f89f |
| http.js | 7080 | 7080 | 一致 | a98fa322…0f741 | a98fa322…0f741 |
| index.js | 55204 | 55204 | 一致 | bfe30a9c…8942 | 73fd785a…302b |
| package.json | 374 | 374 | 一致 | 4d7b5fb2…4c33e | 4d7b5fb2…4c33e |
| package-lock.json | 46478 | 46478 | 一致 | b689f939…6fca | b689f939…6fca |
| probe.js | 9039 | 9039 | 一致 | 90599bea…b63c | 90599bea…b63c |
| providers.js | 14686 | 14686 | 一致 | b449dea3…558a | b449dea3…558a |
| rag.js | 7030 | 7030 | 一致 | fc9cf279…6e08 | fc9cf279…6e08 |
| safety.js | 26122 | 26122 | 一致 | ddc81f3d…b301 | ddc81f3d…b301 |
| types.js | 77 | 77 | 一致 | d43aa81f…3230 | d43aa81f…3230 |
| usage.js | 17501 | 17501 | 一致 | de3cdb76…272e | de3cdb76…272e |
| vision.js | 13537 | 13537 | 一致 | ff4b005a…da5f8 | ff4b005a…da5f8 |

> 上表为便于阅读把哈希截断为前后各 6 位。**完整 64 位 SHA-256 见 [manifest.json](manifest.json)**（20 个文件 × 本地/部署前/部署后 三处）。
> 复现方式：按第 1、3 节重新 `download`，再跑
> `node scripts/defense-g4-deploy-readback.cjs --dist=dist/cloudfunctions/ai --archive=<回读目录> --against=<部署前留档目录>`
> ——该脚本就是生成 `manifest.json` 的那一个，会逐文件比 SHA-256 并打印「一致 N / 不一致 M」，不一致时退出码非 0。

## 4. `info` 回读

```text
cli cloud functions info --names ai --env cloudbase-d2gjtbbwu3575cd7b --project <dist>
```

| 字段 | 部署前 | 部署后 |
| --- | --- | --- |
| status | Active | **Active** |
| timeout | 60 | **60** |
| runtime | Nodejs16.13 | **Nodejs16.13** |

部署后的原始输出留档：[info-after-2026-10-02.txt](info-after-2026-10-02.txt)（2026-10-02 复读，仍为 Active / 60 / Nodejs16.13）。

## 5. 部署内容对既有功能的影响（本轮改动面）

部署前/后 `index.js` 的 `git diff --no-index` 结果：**+55 行、-0 行**，全部落在
`if (log.feature === DEFENSE_FEATURE)` 守卫内或为答辩练习新增的常量：

- 新增常量 `MAX_DEFENSE_MATERIAL_CHARS` / `MAX_DEFENSE_MATERIAL_ID_CHARS` / `DEFENSE_REJECTED_MESSAGE`
- 新增 `require("./defense")`
- `runModelAction` 内：声明 `defenseMaterial`、按 feature 注入材料并**覆盖** `system`、模型返回后做格式与引用校验

**升学 / 部门 / 课表 / 资讯路径一行未改**。这解释了为什么部署后既有功能回归通过（见 [主清单](../README.md) 的回归一节）。

补丁原文留档（可直接复核每一行）：[index-js-diff-2026-10-01.patch](index-js-diff-2026-10-01.patch)
——由归档的 `before-2026-10-01/index.js` 与 `after-2026-10-01/index.js` 直接 `git diff --no-index` 得到，共 84 行输出。

## 6. 环境变量：未改，但值**读不到**

- 本轮**没有修改任何环境变量**，没有调高限额、没有关闭 `AI_MODERATE_OUTPUT`、没有改 `AI_SAFETY_FAIL_MODE`。
- 但**值读不到**：`cloudfunctions/ai/config.json` 里没有 `envVariables` 字段，`cli cloud functions info` 只回 `status`/`timeout`/`runtime`（与 [G1 证据](../../project-defense-g1/README.md) 记的一致，环境变量只在云控制台）。
- 因此「环境变量未改」是**执行事实**（本次没有执行任何改环境变量的动作），**不是**从 CLI 读回来的核对结论。
- 配置仍然**功能正常**的间接证据：部署后 `poc:defense:usage` 返回 `ok:true`（`AI_EXTRA_BODY_JSON` 非法时 `ai` 会全动作 fail-closed），且升学与答辩练习都能真实调用模型（见主清单）。

## 7. 未做 / 不做

- **没有**部署 `newsSync` / `timetable`。
- **没有**为 PoC 改动业务代码。
- **没有**留存旧版完整控制台配置（与 2026-09-24 那次记录同样的缺口）：只有函数根目录文件与 `info` 三字段，**不写成「已完整备份」**。
