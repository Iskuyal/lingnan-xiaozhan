# A1 · `ai` 云函数依赖升级部署与回读（2026-10-02）

- 对应主记录：[../README.md](../README.md)；环境 `cloudbase-d2gjtbbwu3575cd7b`，函数 `ai`；**只部署了 `ai`**，未动 `newsSync` / `timetable`。
- 本轮部署的唯一目的：把 `overrides.axios` 由 `0.33.0` 升到 `0.34.0`（公告 `GHSA-9fr6-4gfg-395g` / `GHSA-x97p-jq2g-jp4f` 的 0.x 修复版本）。**没有**改业务代码、**没有**改环境变量。
- 分支 `codex/project-defense-a-cleanup`，基线 `main` = `6b1835d`。命令里的 `<dist>` 指本 worktree 的 `dist/`。

## 1. 部署前留档（回滚用）

```text
cli cloud functions download --env cloudbase-d2gjtbbwu3575cd7b --name ai \
  --path docs/evidence/project-defense-g5/deploy/before-2026-10-02 --project <dist>
```

- ⚠️ **`--path` 指向的目录必须先存在**：不存在时这条命令**必现** `code 17 二维码输出路径无效或不存在`（同一会话、已登录、项目已打开）。先建目录再执行即可成功。
- 下载产物含 `node_modules/`（5,832 个文件 / 22 MB）。**`node_modules` 不入库**：部署走 `--remote-npm-install`，依赖由云端按上传的 `package.json` + `package-lock.json` 安装，回读判据只比**函数根目录入口文件**。
- 入库的是「部署前 / 部署后」两处**发生了变化的**根目录文件（`package.json`、`package-lock.json`）与 [manifest.json](manifest.json)（20 个根目录文件在**本地构建 / 部署前 / 部署后**三处的 SHA-256 与字节数）。

## 2. 部署

```text
cli cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai \
  --remote-npm-install --project <dist 绝对路径>
```

结果：`success: true`、**filesCount 20**、**packSize 97.3 KB**。

## 3. 回读判据：函数根目录入口文件逐字节一致

部署后 `download` 到 `after-2026-10-02/`，与本地 `dist/cloudfunctions/ai` 逐文件比 SHA-256：

**20/20 逐字节一致，0 个不一致、0 个缺失。**

与部署前相比只有两个文件变化（其余 18 个哈希完全相同）：

| 文件 | 部署前 | 部署后 | 变化 |
| --- | --- | --- | --- |
| `package.json` | 374 B<br>`4d7b5fb2…4c33e`（`overrides.axios = 0.33.0`） | 374 B<br>`4e9a22d3…`（`overrides.axios = 0.34.0`） | **更新**（同一长度，只有版本号不同） |
| `package-lock.json` | 46,478 B<br>`b689f939…6fca` | 46,478 B<br>`f611d6cc…` | **更新**（锁里的 axios 由 `0.33.0` 换 `0.34.0`） |

> 复跑方式：按第 1、3 节重新 `download`（两处都要），再跑
> `node scripts/defense-g4-deploy-readback.cjs --dist=dist/cloudfunctions/ai --archive=<回读目录> --against=docs/evidence/project-defense-g5/deploy/before-2026-10-02`
> ——该脚本逐文件比 SHA-256，不一致时退出码非 0。
> ⚠️ 入库的两个归档目录**已剪枝**（只留变化的那两个文件、删掉了 `node_modules` 与 18 个未变文件），所以**用它们单独复跑会报缺失**；要复跑必须重新 `download`。完整 20 个文件的哈希见 [manifest.json](manifest.json)（未剪枝前生成）。

## 4. `info` 回读

```text
cli cloud functions info --names ai --env cloudbase-d2gjtbbwu3575cd7b --project <dist>
```

| 字段 | 值 |
| --- | --- |
| status | **Active** |
| timeout | **60** |
| runtime | **Nodejs16.13** |

原始输出留档：[info-after-2026-10-02.txt](info-after-2026-10-02.txt)。

## 5. 环境变量：本轮**未改**，值仍然**读不到**

- 本轮**没有执行任何改环境变量的动作**；`cli cloud functions info` 只回 `status` / `timeout` / `runtime`，环境变量只能在云开发控制台看。
- 但**线上仍是第三方审核**这件事，本轮用**真实调用**读实了：成功那次返回 `safety.provider="openai"`（见 [../real-call-success-2026-10-02.json](../real-call-success-2026-10-02.json)），且没有出现 `errcode=45009`。这与 [G4 的切换记录](../../project-defense-g4/safety-provider-switch-2026-10-02.md) 一致：切换**只改环境变量、没有重新部署代码**。
- ⇒ 「部署前回读的 `package.json` 里 axios 还是 0.33.0」说明**线上跑的依赖确实是旧版**，本次部署把锁与清单一起更新了——这正是「部署真的生效」的判据。

## 6. 未做 / 不做

- **没有**部署 `newsSync` / `timetable`（它们本轮只改了清单与锁，未重新部署；CI 的审计判据覆盖它们，但线上仍是旧版依赖——**如实记为缺口**）。
- **没有**为部署改动业务代码。
- **没有**留存旧版完整控制台配置（与 2026-09-24、2026-10-01 同样的缺口）：只有函数根目录文件与 `info` 三字段，**不写成「已完整备份」**。
