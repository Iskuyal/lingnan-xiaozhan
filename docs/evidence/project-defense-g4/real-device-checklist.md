# G4 · 真机验收清单（**待负责人执行**）

- 对应 [Issue #115](https://github.com/Iskuyal/wx-match/issues/115) 的「真实设备」一项。
- **本页是执行清单，不是结果**。截至 2026-10-02，真机**一次都没跑**，`realDevice` 记为 `false`。
- 本环境**无法操作物理设备**（需要真人拿手机扫码并点击），因此这一步只能由负责人完成并回传记录。

## 0. 2026-10-02 实测：adb 能做什么、不能做什么

负责人已连接真机并开启 USB 调试，本轮实测了自动化边界（原始设备信息见 [real-device-facts-2026-10-02.json](real-device-facts-2026-10-02.json)）：

**能做的**

| 能力 | 实测 |
| --- | --- |
| 识别设备 | `adb devices` 看到真机 `513dcd80`（另有一台 `emulator-5554` 平板模拟器，**必须用 `-s` 指定真机**，否则 adb 报 `more than one device/emulator`） |
| 读设备信息 | **Xiaomi `25113PN0EC`｜Android 17（SDK 37）｜微信 8.0.78** |
| 唤醒/解锁 | `input keyevent KEYCODE_WAKEUP` 可用；实测当时 `isKeyguardShowing=false`（未锁屏） |
| 推送文件 | 可把预览二维码推到手机相册：`/sdcard/Pictures/g4qr.png`，并已广播媒体扫描 |
| 解出预览链接 | 预览码实为 **JPEG**（尽管扩展名是 `.png`），用 `jpeg-js` + `jsqr` 解出：`https://mp.weixin.qq.com/a/~~<ticket>~~` |

**不能做的（本轮实测确认，别再白试）**

| 限制 | 表现 |
| --- | --- |
| **无法从外部打开小程序** | 该短链交给系统后**被浏览器 Via（`mark.via`）抢走**；用 `am start -p com.tencent.mm` 强制指定微信时返回 `unable to resolve Intent` —— **微信不注册 https 的 VIEW 处理器**，外部喂链接这条路不通 |
| **无法读取/驱动微信界面** | 微信是**自绘 UI**：`uiautomator dump` 对 `com.tencent.mm` 只回 **1 个节点 / 407 字节**，没有文本也没有可点元素。因此**扫一扫、相册选择、以及小程序内部的点击都无法可靠自动化** |
| 无法用截图辅助 | 执行端模型**不支持图像输入**，看不了截屏 ⇒ 连「盲点 + 截图纠偏」的退路也没有 |

**结论**：真机这条路**必须由人点**，自动化只能帮到「把二维码放进手机相册」为止。

**给负责人的最省事走法（4 步，不用拿相机对着电脑屏幕）**

1. 手机已连电脑且已解开锁屏
2. 打开微信 →「**+**」→「**扫一扫**」
3. 右上角「**相册**」→ 选 **`g4qr.png`**（已在 `/sdcard/Pictures/`）
4. 小程序打开后，按下面第 2 节走 9 步路径

> 预览码有时效。过期后重新生成 + 推送：
> ```powershell
> $adb = 'C:\Users\dusta\AppData\Local\Android\Sdk\platform-tools\adb.exe'
> & '<开发者工具目录>\cli.bat' preview --project '<worktree>\dist' --qr-format image `
>   --qr-output '<worktree>\artifacts\device\g4-qr.png' --info-output '<worktree>\artifacts\device\g4-qr-info.json'
> & $adb -s 513dcd80 push '<worktree>\artifacts\device\g4-qr.png' /sdcard/Pictures/g4qr.png
> & $adb -s 513dcd80 shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/g4qr.png
> ```
> （`artifacts/` 是 gitignore 的，临时产物不入库。）

## 1. 取得预览二维码

预览构建**不消耗 AI 额度**，与真实调用无关，可以提前先生成。已实测可用的命令：

```powershell
$env:WECHAT_DEVTOOLS_CLI_TOKEN = '<令牌>'   # 令牌只在本机使用，不写进仓库/证据/提交
& 'D:\微信web开发者工具\cli.bat' preview `
  --project 'F:\VibeCoding\wx-match-g4\dist' `
  --qr-format image `
  --qr-output  'F:\VibeCoding\wx-match-g4\artifacts\verify\g4-preview-qr.png' `
  --info-output 'F:\VibeCoding\wx-match-g4\artifacts\verify\g4-preview-info.json'
```

- 2026-10-02 实测结果：`√ preview`，退出码 0，包体 **436.4 KB**（446,921 字节），AppID `wxdcef3a86d7e9eeff`。
- **二维码有时效**（预览码通常几十分钟内有效）。过期就重跑上面这条命令，`artifacts/` 是 gitignore 的，不会入库。
- 用**项目真实 AppID** 对应的、已获得体验权限的微信号扫码。

## 2. 扫码后要走的路径

与模拟器端到端**同一条路径**（不要只点开首页就算过）：

1. 首页 → 点「**项目讲解与答辩练习**」入口
2. 材料页应列出 **2 份**材料 → 选 **`FC-1`（课表导入与校对）**
3. 第 1 轮：写 ≥20 字、引用材料条目编号（如 `F1`、`F4`）的回答 → 提交
4. 等到**四节反馈**上屏：`【引用核对】【是否对应回答】【待验证保留】【追问】`，且追问指向你这段回答的缺口
5. 点「用这个追问开始第 2 轮」→ 再写一轮（引用 `F2`、`F5`）
6. 第 3 轮：**故意把 `F8` 说成「已验证」**（`F8` 的三项状态就是「待验证」）→ 看反馈有没有**保留为待验证**
7. 复盘：三个维度是否都显示「已反馈」
8. 重答一处薄弱项 → 提交 → 看是否进入结束态
9. 退出练习再重新进入：材料选择、回答、反馈应**全部清空**

## 3. 必须记录（回传这几项）

| 项 | 说明 |
| --- | --- |
| 机型 | 具体型号（如 iPhone 15 / 小米 14） |
| 基础库版本 | 小程序调试基础库版本 |
| 微信版本 | 客户端版本 |
| 网络 | Wi-Fi / 移动数据 |
| 逐轮结果 | 每轮拿到四节反馈 / 失败，**附失败时的实际文案与 `failureClass`** |
| 逐轮耗时 | 客户端端到端秒数（模拟器实测 12–23 秒） |
| `realDevice` | 真机跑就是 `true`；**没跑就写 `false`，不许写成通过** |

专项观察（模拟器测不到的部分）：

- **软键盘遮挡**：输入框与提交按钮在键盘弹出时是否可见可点
- **长文本换行**：接近 500 字上限时输入框与反馈卡片是否溢出/截断
- **返回手势后状态不串**：iOS 侧滑返回再进来，是否回到材料页而不是残留上一轮反馈

## 4. ⚠️ 额度：先认清是**哪一个**上限

两个上限的 `failureClass` 都是 `quota_exhausted`，但排障方向完全不同：

| 现象 | 实际是 | 怎么办 |
| --- | --- | --- |
| 文案「**内容安全检测的额度已用尽**…」，`detail` 含 **`errcode=45009`** / `fail reach max api daily quota limit` | 微信侧 `msgSecCheck` **当日配额**（未上架期 100 次/天，**所有功能共用**） | 当天不要再试；次日恢复。**不要**去查模型或密钥 |
| 文案「**今日 AI 调用次数已达上限**，请稍后再试。」 | 服务端**个人日调用计数**（`AI_USER_DAILY_LIMIT`，代码默认 30；**生效值读不到**） | 换账号或次日 |

- **本阶段（2026-10-02）实际是前者**：真实调用被 **45009** 拦住。
- 一条完整路径约 **15–20 次内容安全检测**，而 100 次/天是全部功能共享的。因此建议顺序：
  1. 先在模拟器确认链路（**已完成**：三轮四节反馈 + 复盘通过，失败路径 13/13）；
  2. 真机优先只跑**一轮 + 四节反馈**这一个最关键的点，确认端上渲染与键盘行为；
  3. 额度允许再补完整路径。
- 真机失败时**照抄原始文案与 `failureClass` 回传**，不要凭印象归类——本轮就是因为页面把两种额度映射成同一句话，一度把 45009 误记成个人日计数。

## 5. 不得据此声称

- 真机通过（**除非真的扫码跑过并回传记录**）；
- 新功能已上线、已被学生使用；
- 真实学习效果达标、引用核对 100%（那是 G1 对维护者自编样例的结论）。
