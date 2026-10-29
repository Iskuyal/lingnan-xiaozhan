# AI 全落点 `internal` 故障：第三方内容安全鉴权失效（2026-10-29）

- 现场：学生测课表助手（`feature=timetable-assistant`）提问，页面显示「AI 服务内部错误，请稍后重试。」
- 环境：`cloudbase-d2gjtbbwu3575cd7b`；`cli cloud functions info`：`ai` Active / timeout 60 / Nodejs16.13。
- 结论：**不是模型、课表数据或页面问题**。云函数配的是第三方内容安全（`AI_SAFETY_PROVIDER=openai`，2026-10-02 为绕开微信当日配额而切换），该适配器的密钥已失效，检测请求返回 **HTTP 401**；`AI_SAFETY_FAIL_MODE=closed`（默认、正确的策略）因此拒绝全部 AI 调用。
- 处理（两步，均已验证）：① 先切回默认的 `wechat` 立即恢复（第 4.1 节）；② 换用/复用有效审核密钥后切回 `openai`，良性放行 + 违规仍被拦截（第 4.3 节）。**当前线上适配器为第三方 `openai`**；微信通道可作为随时可用的回滚方案。

## 1. 复现方式与原始返回

开发者工具开自动化端口后，从小程序端直接读云函数的未映射返回（页面文案与 `failureClass`/`detail` 不是一回事，必须看原始值）：

```text
"<微信开发者工具目录>\cli.bat" auto --project <仓库>/dist --auto-port 9420 --trust-project
node scripts/probe-ai-raw-response.cjs --feature=timetable-assistant --text="这周有几门课？"
```

原始记录见 [chat-internal-401.json](chat-internal-401.json)，关键字段逐字如下：

```json
{
  "ok": false,
  "failureClass": "internal",
  "message": "AI 服务内部错误，请稍后重试。",
  "detail": "内容安全检测不可用：HTTP 401（鉴权失败，检查 AI_API_KEY 与账号权限）：{\"error\":{\"message\":\"Invalid 'Authorization' header or token.\",\"type\":\"authentication_error\",\"code\":\"UNAUTHORIZED\"}}（AI_SAFETY_FAIL_MODE=closed，拒绝调用；可切换第三方适配器或改为 open，见 docs/development/cloud/ai.md）",
  "timings": { "preflightMs": 356, "accountingMs": 97, "inputSafetyMs": 1093 },
  "elapsedMs": 1498
}
```

失败点从 `timings` 就能读出来：只走到**输入内容安全**（`inputSafetyMs`）就结束，`provider` / `model` / `usage` 全空 ⇒ 模型调用从未发生。

## 2. 已排除的方向（同一轮实测，不是推断）

| 方向 | 读数 | 判据 |
| --- | --- | --- |
| 月度成本上限 | 当月 460 次、0.0996 元（上限 50 元） | 远未达上限，`quota_exhausted` 不成立 |
| 个人日额度 | 当日已用 6 / 上限 60 | 还有 54 次，不是额度拒绝 |
| 记账闸门 / 漏记冻结 | 本次 `accountingMs=97`，返回里没有闸门文案 | 闸门正常释放；`assertNoUnaccountedRecords` 未触发 |
| 模型密钥 | — | 请求在模型之前就失败，**该次调用不能证明模型密钥有效** |
| 微信官方内容安全 | `probe` 动作：`msgSecCheck` / `imgSecCheck` 均 `errcode 0` | 微信通道当时**可用**（记录见 [wechat-safety-probe.json](wechat-safety-probe.json)） |

## 3. 根因

2026-10-02 为绕开微信「未上架小程序 100 次/天」的检测配额，把 `AI_SAFETY_PROVIDER` 从默认的 `wechat` 切到第三方 `openai`，并设置 `AI_SAFETY_API_KEY`（见 [切换前验证记录](../project-defense-g4/safety-provider-switch-2026-10-02.md)）。本次复现显示该密钥已被中转以 `authentication_error / UNAUTHORIZED` 拒绝，而代码在 fail-closed 下按设计拒绝整次调用——用户只能看到通用的 `internal` 文案。

## 4. 修复（需在云开发控制台改环境变量；CLI 不支持环境变量）

云函数环境变量只能在 **云开发控制台 → 云函数 → ai → 配置 → 环境变量** 修改（`cli cloud functions deploy` 只传代码，`config.json` 只声明 `permissions.openapi`）。

| 方案 | 操作 | 代价 / 适用 |
| --- | --- | --- |
| **立即恢复（推荐先做）** | 把 `AI_SAFETY_PROVIDER` 改成 `wechat`（或删掉该变量，默认就是 `wechat`）；`AI_SAFETY_*` 其余项可保留不生效 | 免费、无需改代码或重新部署；回到「未上架小程序约 100 次检测/天、全部 AI 落点共享」的边界（见 [AI 文档](../../development/cloud/ai.md#内容安全适配层)） |
| 继续用第三方审核 | 换一个有效的 `AI_SAFETY_API_KEY`（若模型与该审核共用同一中转账号，还要同时更新 `AI_API_KEY`），再切回 `openai` | 要负责人提供新密钥；切换代价（成本、延迟、证据口径）见 10-02 记录，不能只改这一项就宣布完成 |

**改完后的验证顺序**（都用上面的探针脚本）：

1. `{"action":"probe"}` → 微信两条接口 `errcode 0`；
2. `--feature=timetable-assistant --text="这周有几门课？"` → `ok=true` 且 `safety.provider=wechat`；
3. 若第 2 步失败在**模型**且 `detail` 仍是 `HTTP 401`，说明 `AI_API_KEY` 也一起失效了，需要负责人提供新密钥，不能靠切换内容安全解决。

### 4.1 已执行与复测结果（2026-10-29 16:13 CST）

负责人把云函数环境变量 `AI_SAFETY_PROVIDER` 改为 `wechat`（未重新部署代码）。同一探针命令复测，原始记录见 [chat-after-fix.json](chat-after-fix.json)：

```json
{
  "ok": true,
  "failureClass": "",
  "feature": "timetable-assistant",
  "provider": "openai",
  "model": "deepseek/deepseek-v4.1-flash",
  "text": "我这边看不到你的课表，无法确定这周有几门课。请把本周课程表或日期范围发给我，我帮你数。",
  "safety": { "provider": "wechat", "api": "security.msgSecCheck", "passed": true, "checked": true,
              "detail": "v2（scene=1）｜errcode=0｜errmsg=openapi.security.msgSecCheck:ok｜suggest=pass｜label=100" },
  "timings": { "preflightMs": 369, "inputSafetyMs": 565, "modelNetworkMs": 3139, "outputSafetyMs": 758 },
  "usage": { "totalTokens": 128, "costYuan": 0.000032 }
}
```

结论：

1. 内容安全已回到微信官方通道，`checked=true`、`errcode=0`；
2. **模型密钥仍然有效**——失效的只是第三方审核那一个密钥，因此不需要换 `AI_API_KEY`；
3. 输入/输出两次检测都通过，端到端 4.99 秒返回，页面不再出现 `internal`。

代价提醒：现在全部 AI 落点共用「未上架小程序约 100 次检测/天」。演示或集中测试前用 `probe`/`getApiQuota` 确认余量；要恢复第三方审核必须换有效的 `AI_SAFETY_API_KEY`，并把切换代价与证据口径一起记录。

### 4.2 恢复第三方审核的具体操作（同日补充）

不要在线上试错：`AI_SAFETY_FAIL_MODE=closed` 下密钥无效会把**全部** AI 再次挡住。固定顺序是「本地验证密钥 → 改控制台环境变量 → 线上复测」：

1. **密钥来源**（二选一）：
   - **复用模型密钥**：删除 `AI_SAFETY_API_KEY` 覆盖项即可（代码默认回落到仍然有效的 `AI_API_KEY`），无需新申请；
   - 或在服务商（本项目记录为 CommandCode）控制台新建/轮换一把密钥；旧值被吊销后不能再用，新值只放云函数环境变量，不写进仓库、命令行历史或聊天记录。
2. **本地验证（免费之外只花 4 次审核调用，不碰线上）**：

   ```text
   npm run build
   $env:AI_SAFETY_API_KEY='<候选密钥>'
   npm run probe:safety-key -- --base-url=https://api.commandcode.ai/provider/v1 --model=deepseek/deepseek-v4-flash-fast
   ```

   脚本 `scripts/probe-safety-key.cjs` 直接 require 云函数的 `safety.js`/`config.js`，用生产审核提示词跑 4 类样本：良性课表内容应放行，广告引流/辱骂/赌博应拦截；**退出码 0 才继续**（无效密钥会打印本题第 1 节同样的 401 detail）。
3. **控制台环境变量**：`AI_SAFETY_PROVIDER=openai`、`AI_SAFETY_OPENAI_MODE=chat`（该中转 `/moderations` 是 404）、`AI_SAFETY_MODEL=deepseek/deepseek-v4-flash-fast`（**不能用业务模型**，它会在审核 token 预算下只输出 reasoning、正文为空）、`AI_SAFETY_BASE_URL`（可删，默认取 `AI_BASE_URL`）、`AI_SAFETY_API_KEY`（复用模型密钥时删除该项）。
4. **线上复测**：`node scripts/probe-ai-raw-response.cjs --feature=timetable-assistant --text="这周有几门课？"`，应得到 `safety.provider=openai`、`checked=true`、`ok=true`；失败时看返回的 `detail`。
5. **回滚**：`AI_SAFETY_PROVIDER` 改回 `wechat`。

完整判据与代价说明见 [AI 文档「恢复第三方审核」](../../development/cloud/ai.md#恢复第三方审核先本地验证再改线上)。

### 4.3 恢复第三方审核后的复测（2026-10-29 16:29 CST）

负责人恢复第三方审核配置后，用同一探针命令复测两条：一条正常提问、一条违规样本（验证审核不是只会放行）。

| 输入 | 期望 | 实测 | 原始记录 |
| --- | --- | --- | --- |
| 良性课表提问「这周有几门课？」 | 放行 | `ok=true`、`safety.provider=openai`、`passed=true`、`checked=true`；输入审核 1.82 秒、输出审核 1.67 秒，模型正常返回，本次成本 0.00004 元级 | [restore-openai-benign.json](restore-openai-benign.json) |
| 违规样本（代写作业 + 先付费交易） | 拦截 | `failureClass=content_rejected`、`allowed=false`、`checked=true`，`detail` 给出理由；输入审核 1.72 秒后即拒绝，**未进模型** | [restore-openai-reject.json](restore-openai-reject.json) |

结论：

1. 第三方审核恢复后**确实在工作**：正常内容放行，违规内容被 `allowed=false` 拦下——不是只会放行的橡皮图章；
2. 模型密钥全程有效，这次恢复没有动 `AI_API_KEY`；
3. 时延符合 10-02 记录的每次审核 1.7–2.9 秒；一次业务请求要过输入 + 输出两次审核（约 +3.4 秒），批量演示前要按 `AI_TOTAL_DEADLINE_MS` 复核余量。

边界：这两条只证明「恢复后链路可用且能拦截」，不证明模型答案的事实正确性；真机与页面层点击仍未验证。

## 5. 本轮已做的代码改动（不涉及云配置、未部署）

修复前客户端 `aiResultOf()` 把服务端返回的 `detail` 整个丢掉，`internal` 的六种成因在端上完全同形，只能靠原始返回排查。

- `miniprogram/services/ai.ts`：`AiCallResult` 增加 `detail`；失败时在控制台打印 `feature / failureClass / detail`（不上屏，服务端已剔除密钥）；客户端超时也带上可读 `detail`。
- `tests/departments-qa.test.cjs`：新增三项断言锁定「detail 透传 + 控制台上屏边界 + 成功不刷日志」。
- `scripts/probe-safety-key.cjs` + `npm run probe:safety-key`：切换第三方审核前的本地验证（复用云函数审核实现，4 类样本，退出码即判据）。
- 这些改动只需重新构建/上传小程序或本地运行，**不改变云端行为**；云端尚未改动前的任何 AI 请求仍按配置走。

## 6. 记录边界

- 本记录区分两类动作：**代码改动由本轮 agent 完成**（客户端 `detail` 透传、控制台日志与 `probe:safety-key` 验证脚本，只需重新构建/上传小程序或本地运行）；**云端环境变量修改由负责人在云开发控制台完成**（先 `wechat` 恢复、后 `openai` 恢复第三方审核），agent 没有改云端配置、没有部署云函数、没有调整额度或审核策略。
- 「AI 功能已恢复」的判据是第 4.1 / 4.3 节的同一路径复测（良性 `ok=true` + 违规 `content_rejected`），不是页面文案或代码合入。
- 本次复现与验证消耗 4 次真实业务 `chat` 调用（修复前 1 次失败、`wechat` 恢复后 1 次成功、恢复 `openai` 后良性 1 次成功 + 违规 1 次被拒），合计约 0.0003 元级；另跑了 1 次免费 `usage`、1 次免费 `probe`，以及用无效密钥测试 `probe:safety-key` 时的 4 次 401（未计费）。
- 未验证：真机、页面层（课表助手实际面板）的端到端点击；恢复 `openai` 后的长对话（多次审核叠加）时延；100 次/天配额方案下的演示排期（当前不依赖微信配额，回滚 `wechat` 时才适用）。
