param([string]$Suffix='v6')
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
if(-not (Test-Path -LiteralPath (Join-Path $repoRoot 'miniprogram/app.json'))){$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path}
$buildDir=Join-Path $repoRoot 'artifacts/product-demo-v6'
$outDir=Split-Path $PSScriptRoot -Parent
$renderDir=Join-Path $buildDir ('slides-'+$Suffix.Replace('.','-'))
New-Item -ItemType Directory -Path $renderDir -Force | Out-Null
$pptx=Join-Path $outDir ('校园工具-产品演示优化-'+$Suffix+'.pptx')
$pdf=Join-Path $outDir ('校园工具-产品演示优化-'+$Suffix+'.pdf')
if(Test-Path -LiteralPath $pptx){throw '请使用新的修订文件名，保留已有成品'}
$model=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'showcase-model.json') -Raw -Encoding utf8 | ConvertFrom-Json
$font='Microsoft YaHei'
$palette=@{ink='#2b2422';muted='#6b5d57';paper='#fdf7f5';red='#8c1614';brand='#c41c23';gold='#c69a28';line='#e2d1c8';white='#ffffff'}
function RGB($h){$h=$h.TrimStart('#');return [Convert]::ToInt32($h.Substring(0,2),16)+([Convert]::ToInt32($h.Substring(2,2),16)-shl 8)+([Convert]::ToInt32($h.Substring(4,2),16)-shl 16)}
$records=[Collections.Generic.List[object]]::new()
function Txt($s,$name,$text,$x,$y,$w,$h,$size,$color,$bold=$false){
 $sh=$s.Shapes.AddTextbox(1,$x,$y,$w,$h);$sh.Name=$name
 $sh.TextFrame.MarginLeft=0;$sh.TextFrame.MarginRight=0;$sh.TextFrame.MarginTop=0;$sh.TextFrame.MarginBottom=0;$sh.TextFrame.AutoSize=0;$sh.TextFrame.WordWrap=-1
 $r=$sh.TextFrame.TextRange;$r.Text=$text.Replace("`n","`r");$r.Font.Name=$font;$r.Font.NameFarEast=$font;$r.Font.Size=$size;$r.Font.Bold=$(if($bold){-1}else{0});$r.Font.Color.RGB=(RGB $color);$r.ParagraphFormat.SpaceAfter=4;$r.ParagraphFormat.Bullet.Visible=0
 $records.Add([pscustomobject]@{slide=$s.SlideIndex;name=$name;shape=$sh;x=$x;y=$y;w=$w;h=$h})
 return $sh
}
function Line($s,$x1,$y1,$x2,$y2,$color,$width=1){$l=$s.Shapes.AddLine($x1,$y1,$x2,$y2);$l.Line.ForeColor.RGB=(RGB $color);$l.Line.Weight=$width;return $l}
function Note($s,$text){$s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text=$text}
function Slide($title,$dark=$false){
 $s=$deck.Slides.Add($deck.Slides.Count+1,12);$s.FollowMasterBackground=0;$s.Background.Fill.ForeColor.RGB=(RGB $(if($dark){$palette.red}else{$palette.paper}))
 $fg=if($dark){$palette.white}else{$palette.ink};$muted=if($dark){'#eadac7'}else{$palette.muted}
 $null=Line $s 48 39 83 39 $palette.gold 4
 $null=Txt $s 'title' $title 47 62 850 63 32 $fg $true
 $null=Txt $s 'folio' ($s.SlideIndex.ToString('00')) 876 503 32 20 11 $muted
 $null=Txt $s 'demo-nature' '演示画面：合成数据 · 固定模拟AI响应' 49 515 748 20 12 $muted
 return $s
}
Add-Type -AssemblyName System.Drawing
function Pic($s,$path,$x,$y,$height){$img=[Drawing.Image]::FromFile($path);try{$width=$height*$img.Width/$img.Height}finally{$img.Dispose()};return $s.Shapes.AddPicture($path,0,-1,$x,$y,$width,$height)}
function PicWidth($s,$path,$x,$y,$width){$img=[Drawing.Image]::FromFile($path);try{$height=$width*$img.Height/$img.Width}finally{$img.Dispose()};return $s.Shapes.AddPicture($path,0,-1,$x,$y,$width,$height)}
$app=New-Object -ComObject PowerPoint.Application
$deck=$app.Presentations.Add(0);$deck.PageSetup.SlideWidth=960;$deck.PageSetup.SlideHeight=540
try{
 $s=Slide '校园工具' $true
 $null=Txt $s 'cover-main' "功能介绍、使用过程`n与最终结果" 48 184 565 135 38 '#ffffff' $true
 $null=Txt $s 'cover-sub' '校园信息与个人安排 · 微信小程序项目汇报' 49 345 565 55 21 '#eadac7'
 $null=Txt $s 'cover-date' '广东岭南职业技术学院题材 · 2026年10月4日' 49 446 630 35 15 '#eadac7'
 $null=Pic $s (Join-Path $buildDir 'home-phone.png') 708 46 436
 Note $s '校园工具为当前小程序导航名称，正式作品名称待定。材料基线d01380a；项目状态记录更新至2026-09-30。展示画面由代码复现，课表与AI响应为合成示例；不是新增上线或真机证据。'

 $s=Slide '项目范围与学生任务'
 $groups=@(@('个人课表','Excel / 截图导入 → 校对 → 周课表','查询、手工维护、AI确认变更'),@('校园信息','学生部门 → 资料详情与追问','校园资讯 → 正文与原文来源'),@('日常辅助','目标日、考试信息与体测参考','升学资料 → 范围确认与出处'))
 for($i=0;$i -lt 3;$i++){$y=151+$i*106;$null=Txt $s ('group'+$i) $groups[$i][0] 48 $y 185 42 26 $palette.red $true;$null=Txt $s ('path'+$i) $groups[$i][1] 256 $y 648 38 21 $palette.ink;$null=Txt $s ('pathsub'+$i) $groups[$i][2] 256 ($y+44) 648 39 18 $palette.muted;$null=Line $s 48 ($y+93) 904 ($y+93) $palette.line 1}
 Note $s '范围依据docs/product/spec.md与docs/status.md。共12项演示主题，每项记录用途、操作和结果。答辩练习与暂缓失物招领不计入当前主要成果。'

 foreach($f in $model.features){
  $s=Slide $f.title
  $dual=$f.id-in @('week','query','change','department','calendar','advancement')
  $leftWidth=if($dual){433}else{548};$stepWidth=if($dual){389}else{480}
  if($f.id-eq 'photo'){
   $null=Txt $s 'purpose-label' '功能介绍' 49 135 110 22 13 $palette.muted
   $null=Txt $s 'purpose' $f.intro 160 132 739 44 23 $palette.ink $true
   $null=Txt $s 'photo-stage1' '01 选择课表截图' 49 198 206 35 20 $palette.red $true
   $null=PicWidth $s (Join-Path $buildDir 'photo-input-focus.png') 49 248 184
   $null=Txt $s 'photo-stage2' '02 校对草稿，再确认' 294 198 307 35 20 $palette.red $true
   $null=PicWidth $s (Join-Path $buildDir 'photo-draft-focus.png') 294 248 300
   $null=PicWidth $s (Join-Path $buildDir 'photo-save-focus.png') 294 374 300
   $null=Txt $s 'photo-stage3' '03 保存为个人课表' 663 198 245 35 20 $palette.red $true
   $null=PicWidth $s (Join-Path $buildDir 'excel-result-focus.png') 663 248 241
   $null=Txt $s 'photo-result' '最终结果：图片 → 课程草稿 → 6门课程进入周课表' 49 486 851 37 20 $palette.red $true
   Note $s '代码复现：合成截图→固定模拟识别→校对草稿→确认保存。三阶段示例不代表真实识别准确率或云端模型成功证据。功能范围依据docs/product/spec.md。'
   continue
  }
  if($f.id-eq 'fitness'){
   $null=Txt $s 'purpose-label' '功能介绍' 49 135 110 22 13 $palette.muted
   $null=Txt $s 'purpose' $f.intro 160 132 739 44 23 $palette.ink $true
   $null=Txt $s 'fitness-process' ('使用过程：'+($f.steps-join ' → ')) 49 196 850 38 18 $palette.ink
   $fit=@(@('项目','分数','权重'),@('体重指数（BMI）','80','15%'),@('肺活量','80','15%'),@('50米跑','85','20%'),@('坐位体前屈','80','10%'),@('立定跳远','80','10%'),@('引体向上','80','10%'),@('1000米跑','80','20%'))
   $shape=$s.Shapes.AddTable(8,3,49,246,476,224);$table=$shape.Table;$widths=@(290,86,100)
   for($col=1;$col-le 3;$col++){$table.Columns.Item($col).Width=$widths[$col-1]}
   for($row=1;$row-le 8;$row++){for($col=1;$col-le 3;$col++){$cell=$table.Cell($row,$col).Shape;$cell.TextFrame.MarginLeft=10;$cell.TextFrame.MarginRight=6;$cell.TextFrame.MarginTop=4;$cell.TextFrame.MarginBottom=3;$cell.TextFrame.TextRange.Text=$fit[$row-1][$col-1];$cell.TextFrame.TextRange.Font.Name=$font;$cell.TextFrame.TextRange.Font.NameFarEast=$font;$cell.TextFrame.TextRange.Font.Size=14;$cell.TextFrame.TextRange.Font.Color.RGB=(RGB $(if($row-eq 1){$palette.white}else{$palette.ink}));$cell.Fill.ForeColor.RGB=(RGB $(if($row-eq 1){$palette.red}else{$palette.paper}))}}
   $null=Txt $s 'fitness-score' '81' 559 285 165 108 64 $palette.red $true
   $null=Txt $s 'fitness-result' '参考总分' 560 393 157 37 20 $palette.ink
   $null=Pic $s (Join-Path $buildDir 'fitness-phone.png') 745 216 257
   $null=Txt $s 'fitness-note' '七项合成输入；结果为参考估算，不代表学校正式成绩' 49 491 810 31 14 $palette.muted
   Note $s '本页可编辑表格展示七项合成结果与权重：80×15%+80×15%+85×20%+80×10%+80×10%+80×10%+80×20%=81。依据登记大学组规则的演示口径。学校采用规则、最低档处理与正式成绩另行核对。'
   continue
  }
  $null=Txt $s 'purpose-label' '功能介绍' 49 140 510 25 13 $palette.muted
  $null=Txt $s 'purpose' $f.intro 49 171 $leftWidth 58 23 $palette.ink $true
  $null=Txt $s 'steps-label' '使用过程' 49 246 535 23 13 $palette.muted
  for($i=0;$i -lt 3;$i++){$y=281+$i*37;$null=Txt $s ('step-number'+$i) (($i+1).ToString('00')) 49 $y 38 30 15 $palette.red $true;$null=Txt $s ('step'+$i) $f.steps[$i] 93 $y $stepWidth 31 20 $palette.ink}
  $null=Line $s 49 407 $(if($dual){482}else{598}) 407 $palette.gold 2
  $null=Txt $s 'result-label' '最终结果' 49 422 95 24 13 $palette.muted
  $null=Txt $s 'result' $f.outcome 148 418 $(if($dual){334}else{450}) 58 23 $palette.red $true
  $null=Txt $s 'result-detail' $(if($dual){$f.delta}else{$f.detail}) 49 480 $(if($dual){433}else{550}) 34 12 $palette.muted
  if($dual){
   $null=Pic $s (Join-Path $buildDir ($f.id+'-phone.png')) 510 145 338
   $focusTitle=if($f.id-eq 'week'){'保存后的课程'}elseif($f.id-eq 'change'){'提案关键字段'}elseif($f.id-eq 'calendar'){'日期与出处'}elseif($f.id-eq 'department'){'回答与依据'}elseif($f.id-eq 'query'){'查询结果'}else{'原文与出处'}
   $fieldText=switch($f.id){'week'{"新增：自主学习`n周三 · 第9–10节`n第1–16周 · B301`n修改：数据库应用`n周三 · 第5–6节`n第1–16周 · B308"};'change'{"课程：项目实践`n星期四 · 第9–10节`n第1–16周 · B408`n取消：保持7门`n确认：保存为8门"};'calendar'{"四级口语考试`n2026-11-21`n中国教育考试网`n核查2026-09-29`n报名以考点公告为准"};'department'{"秘书处、组织部、`n宣传部、广播台`n学生组织机构简介`n学校官网 · 团委`n核查2026-09-18"};'query'{"第5周 · 星期三`n数据库应用`n第5–6节 · B308`n自主学习`n第9–10节 · B301"};'advancement'{"2026广东普通专升本`n网上预报名时间：`n1月12日09:00至`n19日18:00`n广东省教育考试院`n核查2026-09-30"}}
   $null=Txt $s 'dual-field-title' $focusTitle 712 157 193 42 16 $palette.red $true
   $null=Txt $s 'dual-fields' $fieldText 712 214 193 260 16 $palette.ink $true
   Note $s ($f.note+'。真实界面上下文与原生可编辑字段配对；字段为合成示例或带适用年的历史资料，不是本轮真机/模型验收。')
   continue
  }
  if($f.id-eq 'change'){
   $null=Txt $s 'proposal-fields-title' '待本人确认的新增提案' 620 143 285 48 17 $palette.red $true
   $null=Txt $s 'proposal-fields-native' "课程：项目实践`n星期四 · 第9–10节`n适用：第1–16周`n地点：B408`n取消保持7门；确认后8门" 620 205 285 185 19 $palette.ink $true
   $null=PicWidth $s (Join-Path $buildDir 'change-controls-focus.png') 620 420 285
  }elseif($f.id-eq 'excel'){
   $processShot=if($f.id-eq 'excel'){'excel-edit-focus.png'}else{'change-proposal-focus.png'}
   $resultShot=if($f.id-eq 'excel'){'excel-result-focus.png'}else{'change-result-focus.png'}
   $processTitle=if($f.id-eq 'excel'){'使用过程：修正地点'}else{'使用过程：本人确认提案'}
   $resultTitle=if($f.id-eq 'excel'){'最终结果：课程地点可见'}else{'最终结果：新课程入表'}
   $null=Txt $s 'process-zoom-title' $processTitle 650 140 255 30 16 $palette.red $true
   $null=PicWidth $s (Join-Path $buildDir $processShot) 650 177 252
   $null=Txt $s 'result-zoom-title' $resultTitle 650 338 255 30 16 $palette.red $true
   $null=PicWidth $s (Join-Path $buildDir $resultShot) 650 371 252
  }elseif($f.id-eq 'query'-or $f.id-eq 'department'-or $f.id-eq 'advancement'){
   $focused=if($f.id-eq 'query'){'query-answer-focus.png'}elseif($f.id-eq 'department'){'department-answer-focus.png'}else{'advancement-source-focus.png'}
   $focusTitle=if($f.id-eq 'query'){'查询结果：课程与地点'}elseif($f.id-eq 'department'){'回答与资料依据'}else{'适用范围、原文与出处'}
   $quote=if($f.id-eq 'query'){"第5周星期三`n第5–6节：数据库应用 · B308`n第9–10节：自主学习 · B301"}elseif($f.id-eq 'department'){"秘书处、组织部、宣传部、广播台`n来源：学生组织机构简介`n发布：学校官网 · 团委`n登记核查：2026-09-18"}else{"2026年 · 广东 · 普通专升本`n网上预报名时间为`n2026年1月12日09:00至19日18:00`n出处：广东省教育考试院"}
   $null=Txt $s 'evidence-focus-title' $focusTitle 620 143 285 50 17 $palette.red $true
   $null=Txt $s 'result-native-quote' $quote 620 205 285 164 19 $palette.ink $true
   $null=Line $s 620 384 905 384 $palette.gold 2
   $null=Txt $s 'evidence-focus-note' $(if($f.id-eq 'advancement'){'2026历史资料样例；无法核对时原文降级'}else{'固定模拟响应；只展示已有资料与课程结果'}) 620 410 285 51 13 $palette.muted
  }elseif($f.id-eq 'week'-or $f.id-eq 'calendar'){
   $title=if($f.id-eq 'week'){'保存后的完整课程结果'}else{'已登记考试资料'}
   $fields=if($f.id-eq 'week'){"新增：自主学习`n周三 · 第9–10节 · 第1–16周`n地点：B301`n修改：数据库应用`n周三 · 第5–6节 · 第1–16周`n地点：B305 → B308"}else{"大学英语四级口语考试`n日期：2026-11-21`n来源：中国教育考试网`n核查：2026-09-29`n报名：以所在考点公告为准"}
   $null=Txt $s 'fields-title' $title 620 144 285 52 17 $palette.red $true
   $null=Txt $s 'fields-native' $fields 620 205 285 245 19 $palette.ink $true
  }else{$null=Pic $s (Join-Path $buildDir ($f.id+'-phone.png')) 679 120 353}
  $null=Txt $s 'image-note' '代码复现产品画面' 677 484 230 22 11 $palette.muted
  Note $s ($f.note+'。操作结果见代码演示时间'+$f.shot+'秒。资料依据：docs/product/spec.md、docs/status.md及product-demo/showcase-model.json。具体结果为演示数据，不作为当前实际用户数据或新验收成果。')
 }

 $s=Slide '确认、校对与来源核对'
 $data=@(@('场景','结果形成之前','取消 / 失败时'),@('Excel与截图导入','课程草稿 → 人工校对 → 确认保存','不覆盖已有课表，支持换方式或手工录入'),@('AI课程变更','提案 → 字段核对 → 本人确认','取消不改变课表，模型失败可手工维护'),@('资料问答','适用范围 → 资料依据 → 来源核对','未公布则说明；无法核对时展示原文'))
 $shape=$s.Shapes.AddTable(4,3,49,154,857,250);$table=$shape.Table;$widths=@(180,316,361)
 for($c=1;$c -le 3;$c++){$table.Columns.Item($c).Width=$widths[$c-1]}
 for($r=1;$r -le 4;$r++){for($c=1;$c -le 3;$c++){$cell=$table.Cell($r,$c).Shape;$cell.TextFrame.MarginLeft=12;$cell.TextFrame.MarginRight=10;$cell.TextFrame.MarginTop=10;$cell.TextFrame.MarginBottom=7;$cell.TextFrame.TextRange.Text=$data[$r-1][$c-1];$cell.TextFrame.TextRange.Font.Name=$font;$cell.TextFrame.TextRange.Font.NameFarEast=$font;$cell.TextFrame.TextRange.Font.Size=16;$cell.TextFrame.TextRange.Font.Color.RGB=(RGB $(if($r-eq 1){$palette.white}else{$palette.ink}));$cell.TextFrame.TextRange.Font.Bold=$(if($r-eq 1){-1}else{0});$cell.Fill.ForeColor.RGB=(RGB $(if($r-eq 1){$palette.red}else{$palette.paper}))}}
 $null=Txt $s 'controls-summary' 'AI进入具体任务，用户保留确认权；资料与结果保留核对入口。' 49 447 855 51 22 $palette.red $true
 Note $s '业务控制依据docs/product/spec.md、miniprogram/services/timetable/assistant.ts和cloudfunctions/ai。此页描述实现机制，不宣称模型效果达到100%。'

 $s=Slide '技术实现与后续完善' $true
 $null=Txt $s 'architecture' '原生微信页面 → 云开发业务服务 → 结果与用户确认' 49 155 854 94 27 $palette.white $true
 $null=Txt $s 'technical' 'TypeScript / WXML / WXSS；模型密钥在云端，个人课表按身份隔离' 49 278 854 72 21 '#eadac7'
 $null=Txt $s 'next' '后续重点：效果评测、真机证据与参赛材料归档' 49 380 854 65 25 $palette.white $true
 $null=Txt $s 'evidence-boundary' '代码演示、模拟器、云端和真机分别记录；升学模型独立效果仍待验收。' 49 473 850 36 14 '#eadac7'
 Note $s '现况依据docs/status.md；正式发布、学校授权、完整材料与最终提交回执未计为已完成。'

 foreach($slide in $deck.Slides){$slide.SlideShowTransition.EntryEffect=1793;$slide.SlideShowTransition.Duration=.4;foreach($sh in $slide.Shapes){if($sh.Name -match '^purpose$|^step[0-9]|^result$'){$effect=$slide.TimeLine.MainSequence.AddEffect($sh,10,0,3);$effect.Timing.Duration=.25}}}
 $deck.SaveAs($pptx,24);$deck.SaveAs($pdf,32);$deck.Export($renderDir,'PNG',1600,900)
 $audit=@();foreach($r in $records){$bound=$r.shape.TextFrame.TextRange.BoundHeight;$audit+=[pscustomobject]@{slide=$r.slide;name=$r.name;boxHeight=$r.h;textHeight=$bound;overflow=($bound-gt ($r.h+2));outOfBounds=($r.x+$r.w-gt 960-or $r.y+$r.h-gt 540)}}
 $audit|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $buildDir ('ppt-layout-'+$Suffix+'.json')) -Encoding utf8
 $issues=@($audit|Where-Object{$_.overflow-or $_.outOfBounds})
 Write-Output ('Slides: '+$deck.Slides.Count+'; layout findings: '+$issues.Count);$issues|Format-Table
 Write-Output $pptx;Write-Output $pdf
}finally{$deck.Close();if($app.Presentations.Count-eq 0){$app.Quit()};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck);[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}
