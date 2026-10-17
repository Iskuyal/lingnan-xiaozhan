<#
.SYNOPSIS
  云配置向导：把「只有人能做的控制台 / 账号操作」一次走完，并在最后复验。

.DESCRIPTION
  为什么需要向导：这几步都在网页控制台里点，agent 做不了（内嵌的云开发控制台 v2 里，输入框不接受
  自动化输入；腾讯云要登录）。向导只做三件事：说清「在哪里、改什么、判据是什么」→ 自动打开页面 →
  记录结果，避免每次重新解释一遍。

  三站：
    A【必做】切换内容安全适配器，摆脱「未上架小程序文本检测 100 次/天」的配额（今天已因此挂过一次）
    B【顺带】修正「关思考」的键名（Ticket 05 的下一步，同一个控制台页面）
    C【顺带】腾讯云 OCR 密钥（Ticket 11 的前置，另一个网站）

  每一步都可以跳过（直接回车）。先看流程、不做任何改动：`.\scripts\wizard-cloud-config.ps1 -DryRun`

.NOTES
  为什么是 PowerShell 而不是 bash：本机是 Windows，`Start-Process` / `Read-Host` 是原生可用的，
  写 bash 反而要额外装环境。

  文件必须存成 UTF-8 **带 BOM**：本机跑的是 Windows PowerShell 5.1，它会把无 BOM 的 UTF-8
  脚本按 ANSI/GBK 解析，含中文的脚本直接语法报错（2026-09-19 实测踩到，加 BOM 后通过）。

  2026-10-17 收尾归档：本脚本写于 2026-09-19、当时未入仓，按原样保留作人工控制台操作参考。
  A 站（AI_SAFETY_PROVIDER 切 openai）已在 2026-10-03 前生效，真实 AI 返回 safety.provider=openai；
  B 站「关思考」键名与 C 站腾讯云 OCR 密钥仍是人工前置。文中 `docs/cloud-development.md`
  已迁移为 `docs/development/cloud/README.md`；Ticket 05、11 的当前状态以 docs/status.md 和
  docs/tasks/pending.md 为准。
#>

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'artifacts\wizard-cloud-config.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Show-Stop {
  param(
    [string]$Id,
    [string]$Title,
    [string]$Where,
    [string]$What,
    [string]$Judgement,
    [string]$Url
  )
  Write-Host ''
  Write-Host ('=' * 72) -ForegroundColor DarkGray
  Write-Host "$Id  $Title" -ForegroundColor Cyan
  Write-Host ('=' * 72) -ForegroundColor DarkGray
  Write-Host "在哪里：$Where"
  Write-Host "改什么：$What" -ForegroundColor Yellow
  Write-Host "判据　：$Judgement" -ForegroundColor Green
  if ($Url -ne '') {
    Write-Host "正在打开：$Url"
    if (-not $DryRun) { Start-Process $Url }
  }
}

function Confirm-Stop {
  param([string]$Id, [string]$Prompt = '做完按回车继续；跳过输入 s 再回车')
  if ($DryRun) { Write-Host '（演练：不等待输入，继续下一站）' -ForegroundColor DarkGray; return $true }
  $answer = Read-Host $Prompt
  if ($answer -eq 's') { Write-Log "$Id 跳过"; Write-Host '已跳过。' -ForegroundColor DarkYellow; return $false }
  Write-Log "$Id 完成（用户确认）"
  return $true
}

Write-Host ''
Write-Host ('云配置向导（wx-match）' + $(if ($DryRun) { '  —— 演练模式，不会打开页面、不会要求输入' } else { '' })) -ForegroundColor White
Write-Host '日志：' -NoNewline; Write-Host $log -ForegroundColor DarkGray
Write-Log $(if ($DryRun) { '向导开始（DryRun）' } else { '向导开始' })
Write-Host ''
Write-Host '提示：A 是必做项，B、C 可跳过；每一步都能直接回车跳过。' -ForegroundColor DarkGray
if (-not $DryRun) { Read-Host '准备好了按回车开始' }

# ---------------------------------------------------------------- A：内容安全适配器
$consoleUrl = 'https://mp.weixin.qq.com/'
Show-Stop -Id 'A' -Title '切换内容安全适配器（摆脱 100 次/天配额）' `
  -Where '微信开发者工具 → 顶部「云开发」→ 云函数 → ai → 配置 → 环境变量' `
  -What '把 AI_SAFETY_PROVIDER 的值从 wechat 改成 openai（只改这一个变量）' `
  -Judgement '不用填 BASE_URL / API_KEY / MODEL：代码里这三项默认复用 AI_BASE_URL / AI_API_KEY / AI_MODEL，已经配好且跑通过。改完不要重新部署，下一次调用即生效。' `
  -Url $consoleUrl

Write-Host ''
Write-Host '为什么这么改：' -ForegroundColor DarkGray
Write-Host '  未上架小程序的文本检测配额只有 100 次/天（官方口径），当天用完会让问答/助手/识图全部不可用' -ForegroundColor DarkGray
Write-Host '  （今天已经实测撞到 45009）。切到第三方后，用你自己的中转做审核判定，不再受这 100 次限制。' -ForegroundColor DarkGray
Write-Host '代价（认下来再改）：' -ForegroundColor DarkGray
Write-Host '  ① 每次 AI 调用会多一次「审核」模型调用（多花一点 token 与时间）；' -ForegroundColor DarkGray
Write-Host '  ② 图片审核也一并从微信官方换成第三方（官方图片接口本来正常，这是顺带的代价）；' -ForegroundColor DarkGray
Write-Host '  ③ 不要用 AI_SAFETY_FAIL_MODE=open 来绕过——它是仅排障的逃生口，生产不得使用。' -ForegroundColor DarkGray

if (Confirm-Stop -Id 'A' -Prompt '改完 AI_SAFETY_PROVIDER=openai 后按回车；跳过输入 s') {
  Write-Host ''
  Write-Host '复验（两步都要在小程序端跑，不能用控制台「测试」页）：' -ForegroundColor Cyan
  Write-Host '  1) 先确认开发者工具自动化端口开着（另一终端）：' -ForegroundColor DarkGray
  Write-Host ('     & "C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project "' + $repo + '\dist" --auto-port 9420 --trust-project') -ForegroundColor DarkGray
  Write-Host '  2) npm run probe:wechat   → 看输出里结论与 recommendedProvider' -ForegroundColor DarkGray
  Write-Host '  3) npm run smoke:ai        → 看返回值里 safety.provider 是否变成第三方（openai）' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '⚠ 注意：probe:wechat 本身也要过内容安全，会消耗一点配额；smoke:ai 是单次调用。' -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- B：关思考键名
Show-Stop -Id 'B' -Title '修正「关思考」的键名（Ticket 05 的下一步）' `
  -Where '同一个页面：云函数 → ai → 配置 → 环境变量' `
  -What '把 AI_EXTRA_BODY_JSON 的值改成 {"chat_template_kwargs":{"enable_thinking":false}}' `
  -Judgement '现在是 {"chat_template_kwargs":{"thinking":false}}，而 Qwen3 系模型认识的是 enable_thinking——很可能一直没生效（完成 token 2571 远大于正文约 500，符合"仍在输出思考"的表现）。' `
  -Url ''

Write-Host ''
Write-Host '改完怎么判：跑 npm run smoke:ai:vision，看完成 token 是否明显下降。' -ForegroundColor DarkGray
Write-Host '  下降 → 继续测真实截图；不降 → 说明中转忽略该参数，要走"换更快的多模态模型"或"客户端切块"。' -ForegroundColor DarkGray
Write-Host '（图片接口的配额与文本**分开计算**——实测文本报 45009 时图片仍正常，所以这一站可以先跑。）' -ForegroundColor DarkGray
Confirm-Stop -Id 'B' -Prompt '改完按回车；跳过输入 s' | Out-Null

# ---------------------------------------------------------------- C：腾讯云 OCR
Show-Stop -Id 'C' -Title '腾讯云 OCR 密钥（Ticket 11 的前置）' `
  -Where '腾讯云控制台 → 访问管理 → API 密钥管理；以及 文字识别 OCR → 开通服务' `
  -What '开通「文字识别 OCR」，创建一个访问密钥（SecretId / SecretKey）' `
  -Judgement '密钥只写进本机用户级环境变量与 .env（两者都已被 .gitignore 覆盖），绝不进仓库、不进小程序包、不发给任何人。' `
  -Url 'https://console.cloud.tencent.com/cam/capi'

Write-Host ''
Write-Host '为什么这站能省事：' -ForegroundColor DarkGray
Write-Host '  官网那批通知有 74 篇正文是海报扫描图（189 张图），另有约 60 份制度 PDF 是纯扫描件；' -ForegroundColor DarkGray
Write-Host '  OCR 出来它们才进得了检索语料。调用量约 189 次，先试 3 篇再决定全量。' -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host '（演练：跳过密钥输入与写文件）' -ForegroundColor DarkGray
  Write-Host '真实运行时会：把 SecretId / SecretKey 写进 ' -NoNewline -ForegroundColor DarkGray
  Write-Host '.env' -NoNewline
  Write-Host '（已 gitignore），并可选写入用户级环境变量；两者都不会出现在日志里。' -ForegroundColor DarkGray
} elseif (Confirm-Stop -Id 'C' -Prompt '拿到 SecretId / SecretKey 后按回车继续；跳过输入 s') {
  $secretId = Read-Host '粘贴 SecretId（直接回车则跳过）'
  if ($secretId -ne '') {
    $secretKey = Read-Host '粘贴 SecretKey'
    if ($secretKey -ne '') {
      $envFile = Join-Path $repo '.env'
      $content = @(
        '# 本机密钥，只用于本地脚本；已在 .gitignore 内，不进仓库',
        "TENCENT_SECRET_ID=$secretId",
        "TENCENT_SECRET_KEY=$secretKey",
        'TENCENT_OCR_REGION=ap-guangzhou'
      )
      Set-Content -Path $envFile -Value $content -Encoding UTF8
      Write-Host "已写入 $envFile" -ForegroundColor Green

      $persist = Read-Host '同时写入用户级环境变量（重启终端后仍有效）？y / 回车跳过'
      if ($persist -eq 'y') {
        [Environment]::SetEnvironmentVariable('TENCENT_SECRET_ID', $secretId, 'User')
        [Environment]::SetEnvironmentVariable('TENCENT_SECRET_KEY', $secretKey, 'User')
        [Environment]::SetEnvironmentVariable('TENCENT_OCR_REGION', 'ap-guangzhou', 'User')
        Write-Host '已写入用户级环境变量（新开的终端才会生效）。' -ForegroundColor Green
      }
      $env:TENCENT_SECRET_ID = $secretId
      $env:TENCENT_SECRET_KEY = $secretKey
      $env:TENCENT_OCR_REGION = 'ap-guangzhou'
      Write-Log 'C 完成（密钥已写入 .env，未记录到日志）'
      Write-Host ''
      Write-Host '下一步（本终端即可）：' -ForegroundColor Cyan
      Write-Host '  node scripts/ocr-backfill.cjs plan' -ForegroundColor DarkGray
      Write-Host '  node scripts/ocr-backfill.cjs run --limit 3   # 先试 3 篇，人工抽检顺序与错字率' -ForegroundColor DarkGray
    } else { Write-Host 'SecretKey 为空，已跳过。' -ForegroundColor DarkYellow }
  } else { Write-Host '未填，已跳过。' -ForegroundColor DarkYellow }
}

# ---------------------------------------------------------------- 收尾
Write-Host ''
Write-Host ('=' * 72) -ForegroundColor DarkGray
Write-Host '向导结束。回填证据的清单（别忘了，项目纪律要求每条结论可复现）：' -ForegroundColor White
Write-Host '  1. A 的复验输出（probe:wechat 那一行 JSON / smoke:ai 的返回值）→ 粘到 docs/development/cloud/README.md 的探测记录表' -ForegroundColor DarkGray
Write-Host '  2. B 的 vision token 读数 → 写进 docs/evidence/p5-b/README.md 与 Ticket 05' -ForegroundColor DarkGray
Write-Host '  3. C 的试跑与抽检结果 → 写进 Ticket 11 的验收项' -ForegroundColor DarkGray
Write-Log '向导结束'
Write-Host ''
