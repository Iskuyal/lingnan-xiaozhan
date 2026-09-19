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
