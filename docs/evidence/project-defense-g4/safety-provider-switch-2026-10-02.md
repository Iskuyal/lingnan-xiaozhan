# G4 · 内容安全换第三方审核：切换前验证记录（2026-10-02）

- 对应 [Issue #115](https://github.com/Iskuyal/wx-match/issues/115)；主清单见 [README.md](README.md)。
- **为什么会有这份文件**：G4 剩余的真实调用全被微信内容安全当日配额拦住（`errcode=45009`）。负责人批准把 `AI_SAFETY_PROVIDER` 从默认的 `wechat` 换成第三方审核，以绕开微信侧的日配额。**换内容安全是配置级改动，必须留下验证记录与代价说明**，不能只在 PR 里说一句「切了」。
- **本页记录的全部是「切之前」的预验证**：直接打中转的 HTTP 接口做的，**没有**经过 `ai` 云函数，也**没有**改动任何环境变量。截至本文写入时，线上仍是 `wechat`。

## 1. 中转能力探测

`POST {base}/chat/completions`（`base = https://api.commandcode.ai/provider/v1`）→ **200**，可用。

`POST {base}/moderations` → **404**（`omni-moderation-latest` / `text-moderation-latest` / `text-moderation-stable` 三个模型名都是 404）。

⇒ **`AI_SAFETY_OPENAI_MODE=moderations` 这条路不通**，只能走代码里的 chat 模式：把 `MODERATION_SYSTEM_PROMPT` 发给模型，让模型自己吐 `{"allowed":…}`，再由 `parseModerationJson` 解析。

## 2. 现有模型不能当审核员（关键坑）

审核提示词要求「只输出一个 JSON 对象」，而 `deepseek/deepseek-v4.1-flash`（当前业务模型）把输出预算全花在 `reasoning_content` 上：

| max_tokens | finish_reason | content | reasoning 长度 |
| --- | --- | --- | --- |
| 256（`AI_SAFETY_MAX_TOKENS` 代码默认） | `length` | **空** | 1173 |
| 2048（`clamp(...,16,2048)` 的**上限**） | `length` | **空** | 7809 |
| 4096（已超代码上限） | `stop` | 有 JSON | 4898 |

`cloudfunctions/ai/config.ts` 把 `AI_SAFETY_MAX_TOKENS` **硬夹在 2048**。所以「只把 `AI_SAFETY_PROVIDER` 切过去、不换模型」会让审核**永远拿不到可解析 JSON** → `unavailable` → 在 `AI_SAFETY_FAIL_MODE=closed` 下**整个 `ai` 函数 fail-closed**（升学问答 / 课表助手 / 识图一起挂）。这正是 2026-10-01 `AI_EXTRA_BODY_JSON` 非法那次踩过的坑。

## 3. 选定的模型

| 模型 | 256 tokens 结果 | 2048 tokens 结果 |
| --- | --- | --- |
| `deepseek/deepseek-v4-flash-fast` | `stop`，干净 JSON ✓ | `stop`，干净 JSON ✓ |
| `deepseek/deepseek-v4-flash` | `stop`，干净 JSON ✓ | `stop`，干净 JSON ✓ |

**选定 `deepseek/deepseek-v4-flash-fast`**：在默认 token 预算（256）下就稳定 `finish_reason=stop`，reasoning 仅 ~90–120 字符。

## 4. 替换后的审核**确实会拦**（不是只会放行）

用 4 类输入直接打中转，判定与耗时（原始记录见 [safety-provider-switch-verification-2026-10-02.json](safety-provider-switch-verification-2026-10-02.json)）：

| 输入 | 判定 | 耗时 |
| --- | --- | --- |
| 正常课表功能说明 | `allowed: true` ✓ 放行 | 2903 ms |
| 广告引流 / 代写收费 / 私聊 | **`allowed: false`** ✓ 拦下 | 1887 ms |
| 辱骂脏话 | **`allowed: false`** ✓ 拦下 | 2073 ms |
| 校园赌博 | **`allowed: false`** ✓ 拦下 | 1705 ms |

⇒ 这**不是**把内容安全变成橡皮图章：`false` 能正常产生，`AI_SAFETY_FAIL_MODE=closed` 下会照旧 fail-closed。这一点必须先证，否则「换审核」等于偷偷关掉安全。

> **记录口径**：上面 JSON 里的 `reason` 中文字符串在本机被抓成了乱码，那是**我这份 PowerShell 抓取脚本的编码问题**，不是中转返回错；判定用的 `allowed` 布尔值不受影响。要引用理由原文需重新以 UTF-8 抓取。

## 5. 需要设置的环境变量（在云开发控制台，CLI 做不到）

`cli cloud functions` 只有 `list / info / deploy / inc-deploy / download`，`deploy` 也没有环境变量参数；`cloudfunctions/ai/config.json` 只有 `permissions.openapi`。官方[《Managing Cloud Functions in Developer Tools》](https://developers.weixin.qq.com/miniprogram/en/dev/wxcloud/guide/functions/ide.html)列的全是右键菜单操作，**没有**用 `config.json` 写环境变量的说明 ⇒ 环境变量只能在**云开发控制台 → 云函数 → ai → 配置 → 环境变量**改。

| 变量 | 值 |
| --- | --- |
| `AI_SAFETY_PROVIDER` | `openai` |
| `AI_SAFETY_MODEL` | `deepseek/deepseek-v4-flash-fast` |
| `AI_SAFETY_BASE_URL` | `https://api.commandcode.ai/provider/v1` |
| `AI_SAFETY_API_KEY` | 负责人提供（**不写进仓库、不写进证据**） |
| `AI_SAFETY_OPENAI_MODE` | `chat`（**填 `moderations` 会 404**） |

`AI_SAFETY_BASE_URL` / `AI_SAFETY_API_KEY` / `AI_SAFETY_MODEL` 在代码里都有默认值（默认回落到业务模型那一套），但**显式设置**可以避免依赖读不到的默认值。

**回滚**：把 `AI_SAFETY_PROVIDER` 改回 `wechat`（或删掉这 5 条）即可；其余环境变量不受影响。

## 6. 必须写进结论的代价

1. **成本上升**：第三方审核是**模型调用**，比微信 `msgSecCheck` 贵得多，而且每次都要记账（`usage` 会涨）。切换期间的金额不能与切换前直接对比。
2. **延迟变长**：单次审核实测 **1.7–2.9 秒**。一次业务请求要过 2–4 次审核 ⇒ 约 **+4～12 秒**。答辩练习本来就 12–23 秒，叠加后更贴近 `AI_TOTAL_DEADLINE_MS=50000`，有撞超时的风险。真出现超时会如实记 `failureClass=model_unavailable`，不硬凑成功。
3. **证据口径必须标注**：切换期间跑出来的那一批，安全路径用的是**第三方审核**，与线上默认的 `wechat` 不一致。这批结果要单独标注批次，不能与默认配置下的结果混在一起统计。

## 7. 截至本文的状态

- 预验证**已做完**（本文 + 同目录 JSON）。
- 环境变量**尚未修改**：2026-10-02 10:28 实测仍是 `wechat` 路径（`detail` 显示 `v2（scene=1）｜errcode=45009`）。
- 因此 G4 剩余 4 项（重答收尾、8 例首评、对照实验、真机）**仍未执行**。
