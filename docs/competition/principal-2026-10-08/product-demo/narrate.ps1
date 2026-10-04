$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
if(-not (Test-Path -LiteralPath (Join-Path $repoRoot 'miniprogram/app.json'))){$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path}
$buildDir=Join-Path $repoRoot 'artifacts/product-demo-v6'
$voices=Get-Content -LiteralPath (Join-Path $buildDir 'voices.json') -Raw -Encoding utf8 | ConvertFrom-Json
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Huihui Desktop')
$synth.Rate=3
try {
  for($i=0;$i -lt $voices.Count;$i++){
    $synth.SetOutputToWaveFile((Join-Path $buildDir ('voice-{0:00}.wav' -f $i)))
    $synth.Speak($voices[$i].text)
    $synth.SetOutputToNull()
  }
}finally{$synth.Dispose()}
Write-Output ('Local Chinese narration: '+$voices.Count+' segments')
