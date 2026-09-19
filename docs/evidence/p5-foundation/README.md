# Ticket 01 端到端冒烟记录（2026-09-19）

`ai` 云函数的首次真实端到端调用：从小程序端发一句测试文本，经内容安全检测、模型调用、用量记账，拿回模型输出。执行人：负责人；执行方式：

```powershell
# 终端 A：打开开发者工具并开启自动化端口（保持窗口开着）
& "D:\微信web开发者工具\cli.bat" auto --project F:\VibeCoding\wx-match\dist --auto-port 9420 --trust-project

# 终端 B：仓库根（不是 dist）
cd /d F:\VibeCoding\wx-match
npm run smoke:ai
```

## 原始输出

```text
> wx-match@0.1.0 smoke:ai
> node scripts/smoke-ai.cjs

ok=true failureClass=(空) elapsedMs=4600
provider=openai model=deepseek/deepseek-v4.1-flash
模型输出：链路已通
内容安全：provider=wechat checked=true passed=true｜v2（scene=1）｜errcode=0｜errmsg=openapi.security.msgSecCheck:ok｜suggest=pass｜label=100
本次用量：105 token / 0.000026 元（estimated=false）
当月累计：18 次 / 0.000026 元（上限 50 元）

记录已写入 artifacts\verify\ai-smoke.json
```

（`artifacts/` 被 gitignore，原始 JSON 不随仓库提交；本段即当次运行的完整输出。）

## 这次证明了什么

| 结论 | 依据 |
| --- | --- |
| 模型调用链路打通（经第三方中转，OpenAI 兼容格式） | `ok=true`、`text=链路已通`、`provider=openai`、`model=deepseek/deepseek-v4.1-flash` |
| **云函数超时已是 20 秒**（人工步骤 C 完成） | `elapsedMs=4600` 而未被 `-504003 ... timed out after 3 seconds` 截断——3 秒超时下这一步会失败 |
| 内容安全走**微信官方**适配器且真的检测过 | `provider=wechat checked=true passed=true`、`errcode=0`、`suggest=pass`；未认证小程序可用云调用 |
| 用量与成本记账可用、累计可查 | 「本次用量」与「当月累计」两项均由云函数写出，上限读数为 50 元 |

## 仍未证明的

- **数据库侧无密钥外泄**：小程序包与云函数产物已由 `tests/ai-bundle.test.cjs` 断言不含密钥；还差在控制台打开 `ai_usage_records` / `ai_usage_monthly` 抽查一次，确认记录里没有密钥字段或值（Ticket 01 未勾选的那一条）。
- **月度上限真的会拦**：人工步骤 F（把 `AI_MONTHLY_CAP_YUAN` 临时改小、跑一次 `chat`、确认返回 `quota_exhausted` 且没有发起模型请求）尚未执行。
- **单价是否与中转实际一致**：本次 105 token 记为 0.000026 元，说明生效的是环境变量里配置的 **0.25 元/百万 token**；这个价格是否等于中转的真实计费仍需联调核对——**单价填低了，50 元上限就会形同虚设**。
- **图片路径（`vision`）与三类失败的降级文案**：本次只跑了文字 `chat`；截图识别（Ticket 05）与部门问答（Ticket 07）的真实调用仍未执行。
- 云函数**内存**未核实（按图片大小另行确认）。

## 第二轮（2026-09-19）：负责人确认余项 + `vision` 真实调用（**未通过**）

### 负责人确认

负责人告知 Ticket 01 剩余项已核实（记为负责人确认，未附原始输出）。本仓库此前记录的两项是：
月度上限拦截实测（人工步骤 F）与 `vision` 图片路径真实调用。

### `vision` 图片路径：我方独立复测未通过

用三张真实课表截图与一张合成小图分别调用 `ai` 的 `vision` 动作（链路：`timetable.preparePhotoUpload`
→ `wx.cloud.uploadFile` → `ai` vision），**全部在 8000ms 处超时失败**：

```text
ok=false failureClass=model_unavailable elapsedMs≈10s
provider=openai model=qwen/qwen3.8-flash
detail: 模型调用超时：请求超时（8000ms）：https://api.commandcode.ai/provider/v1/chat/completions
safety: provider=wechat checked=true passed=true（errcode=0）
```

- 与图片大小无关：594KB / 92KB / 570B 三种尺寸表现一致；
- 文本 `chat` 路径同时可用（`npm run smoke:ai` 4.6 秒返回）；
- 因此 **Ticket 01 的「`vision` 真实调用」一项按「已执行、未通过」记录**，不计为通过。

### 新增复测入口

```powershell
npm run smoke:ai:vision   # 内联合成小图，只验「上传 → 内容安全 → 模型」链路，不评估识别质量
```

脚本会打印完整返回（`failureClass` / `detail` / `safety` / 用量）并写
`artifacts/verify/ai-vision-smoke.json`；跑完会调 `discardUpload` 清理云存储，不留临时文件。
退出码：0 成功 / 1 调用没跑通 / 2 云函数返回失败。

候选修复方向见 [P5-B 验证记录](../p5-b/README.md) 的 Ticket 05 一节（`AI_EXTRA_BODY_JSON` 关思考、
`AI_TIMEOUT_MS` 提到 13000、或改 `AI_VISION_MODEL`）。

## 第三轮（2026-09-19）：内容安全当日配额用尽——端上表现、分类缺口与修复

### 事实（两次独立观测）

1. **服务端**：`npm run smoke:ai:vision` 返回 `failureClass=internal`、文案「AI 服务内部错误，请稍后重试。」，
   `detail` 里是 `msgSecCheck` 的 `45009 ... reach max api daily quota limit`；
   同一次返回里 `imgSecCheck` 仍是 `errcode=0`，再次印证**两条接口的配额各自计算**。
2. **界面**：`npm run verify:wechat` 18 项通过，但**降级分支这次真的被走到了**——
   部门问答面板显示的失败文案就是「AI 服务内部错误，请稍后重试。」。
   此前模型可用，这条分支从未执行过（见下方「同时修掉的验收脚本缺口」）。

**结论：「检测额度用尽」被归成 `internal`**，与开发规格「三类失败必须可区分」不符。
用户看到的下一步建议是「稍后重试」，而当天的重试只会一直失败——真正的选择是等次日恢复。

### 修复

- **安全层**：微信 `45009`（放进 `WECHAT_QUOTA_ERRCODES`，只收实测过的码）与第三方审核接口的 `402`
  都归 **`quota_exhausted`**；文案改用**当日检测配额**那一套
  （`AI_MSG_QUOTA_EXHAUSTED_SAFETY`，默认「内容安全检测的额度已用尽…通常次日恢复」），
  **与月度成本上限的文案分开**——后者说的是「下月再试」，把当日配额说成月度上限会让人白等一个月
  （与「429 不归 `quota_exhausted`」同一条理由：分类管的是可执行的下一步）。
- **非配额码不误伤**：`48001` / `61010` / `-501001` 仍是 `internal`（配置、权限、票据类，排查方向不同）。
- `AI_SAFETY_FAIL_MODE=open` 的逃生口行为不变：仍放行未检测内容，但 `checked=false`。

### 同时修掉的验收脚本缺口

`scripts/verify-wechat.cjs` 的 `currentErrorText` 原先**优先读 `#qa-offline`**，而它是与失败同时出现的
**固定说明句**（「部门资料随小程序包提供，AI 不可用时仍可正常查看列表与详情。」）：
读它只能证明「出过错」，读不出**是哪一类错**。因此那条「降级提示必须可识别」的断言
**此前从未真正执行过**——模型可用时不走降级分支；**一旦执行（模型不可用），它比对的是一句与失败原因
无关的常量，必然误报失败**（2026-09-19 配额用尽让它第一次执行就印证了这一点，见本节开头第 2 条）。
已改为优先读 `.qa-error`、`#qa-offline` 单独断言；`invalid_request`（「AI 请求参数不正确」）
**故意不在可接受的降级文案里**——它在这个流程里基本等于调用方把事件组装坏了，属于要修的缺陷。

> **措辞更正**：本段最初写成「此前永远不会失败」，与代码事实不符——按改动前的实现它是**必然失败**
> 而不是不会失败，只是从未有机会执行。原提交说明里的同一处措辞留在历史里（该提交已合并），以本段为准。

### 验证

- `npm test` **320 项全过**（本轮新增 5 项）：45009 归配额类且文案不含「下月」、`imgSecCheck` 同样、
  非配额码仍是 `internal`、第三方 402 保住分类、文案可被环境变量覆盖。
- `npm run verify:wechat` **18 项全过**（`verification.json`），且**降级分支这次是被真正执行的**。
- 这次全量验收**同时覆盖了 #43 换主题之后的界面**：主题提交在 2026-09-19 17:05 +0800，
  晚于上一次验收（16:04 +0800），此前岭南红金主题**没有任何界面证据**；本轮 18 项在新主题下全部通过。

### 未验证（不计为通过）

- **修复本身还没在云端生效**：`ai` 云函数仍是旧版，线上仍会把配额用尽报成「内部错误」。
  复测：重新部署 `ai` 后跑 `npm run smoke:ai:vision`（判据 `failureClass=quota_exhausted`、
  `message` 含「检测额度」且不含「下月」），并在界面上确认降级文案同步变化。
- 界面上**只实测了旧版文案**（「内部错误」）；新版配额文案的界面表现未实测。

## 第四轮（2026-09-20）：配额分类修复与分带并行都在云端验证通过

`ai` 重新部署（12 文件 / 52.4 KB）后，两块改动都拿到了云端证据。

### ① 配额分类修复：界面上确认到了新文案

复测的条件刚好合适——本轮开始时内容安全配额**仍是 `45009`**（北京时间已过午夜，说明它不是按自然日 0 点重置），
于是 `npm run verify:wechat` 走进了「AI 不可用」的降级分支，**页面上显示的是**：

```text
内容安全检测的额度已用尽，AI 功能暂时不可用；未上架小程序每天有检测次数上限，通常次日恢复。
```

同一屏、同一条件，**修复前显示的是**「AI 服务内部错误，请稍后重试。」（见本轮第二节的观测）。
即：`45009` 现在归 `quota_exhausted` 并给出「检测额度用尽」的独立文案，与月度上限的「下月再试」不再混用。
这是**端到端**的验证（云函数 → 客户端文案 → 页面），不只是桩测试。

### ② 内容安全探测：两条接口都恢复了

配额恢复后探测（`npm run probe:wechat`）：

```text
security.msgSecCheck [v2（带 openid）] errCode=0 verdict=pass 420ms
security.imgSecCheck [v2（带 openid）] errCode=0 verdict=pass 487ms
```

### ③ `vision` 路径：分带并行跑通

`AI_VISION_MODEL` 现为 `deepseek/deepseek-v4.1-flash`（不再是画画像时的 `qwen/qwen3.8-flash`）。
单带与 `bands: 'auto'`（6 带并行）**两条都 `ok=true`**，6 个并发调用全部成功。
逐项数字、三条假设的结论与成本口径见 [P5-B 验证记录](../p5-b/README.md#2026-09-20-第六轮云端实测通过分带并行在真实链路上成立)。

**仍未验证**：真实课表截图的识别（本轮只有合成小图）与字段准确率评估。
