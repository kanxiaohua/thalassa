# =====================================================================
#  识海 · 扫描 assets/music/ ，把里面的音频写成 data/music.js
#  双击 scan-music.cmd 运行即可；也可以在本窗口里看它扫到了什么。
# =====================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir  = Join-Path $root 'assets\music'
$out  = Join-Path $root 'data\music.js'

$exts = @('.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus')

if (-not (Test-Path $dir)) {
  Write-Host "没有找到文件夹：$dir" -ForegroundColor Red
  exit 1
}

$files = @(Get-ChildItem -LiteralPath $dir -File |
  Where-Object { $exts -contains $_.Extension.ToLower() } |
  Sort-Object { $_.Name.ToLower() })

# 保留原来的淡入 / 换曲间隔 / 退让比例
$fadeIn = 5; $switchEvery = 190; $duck = 0.38
if (Test-Path $out) {
  $old = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8)
  if ($old -match 'fadeIn:\s*([\d.]+)')       { $fadeIn      = [double]$Matches[1] }
  if ($old -match 'switchEvery:\s*([\d.]+)')  { $switchEvery = [double]$Matches[1] }
  if ($old -match 'duck:\s*([\d.]+)')         { $duck        = [double]$Matches[1] }
}

function Esc([string]$s) {
  return $s.Replace('\', '\\').Replace("'", "\'")
}

$rows = New-Object System.Collections.Generic.List[string]
foreach ($f in $files) {
  $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
  # 去掉开头的排序号：01 xxx / 1. xxx / 02_xxx
  $title = $name -replace '^\s*\d+\s*[\.\-_、）\)]*\s*', ''
  $title = $title -replace '_', ' '
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $name }
  $rel = 'assets/music/' + $f.Name
  $rows.Add("    { file: '" + (Esc $rel) + "', title: '" + (Esc $title) + "', gain: 0.38 }")
}

$body = if ($rows.Count -gt 0) { "`r`n" + ($rows -join ",`r`n") + "`r`n  " } else { '' }

$js = @"
/* =====================================================================
 *  识海 · 背景音乐清单
 * ---------------------------------------------------------------------
 *  这个文件由 scan-music.cmd 自动生成，一般不用手改。
 *  想换曲子：往 assets/music/ 里丢文件，再双击一次 scan-music.cmd。
 *  文件名前面的数字只用来排序（01_xxx.mp3、02_yyy.mp3），不会被显示。
 *
 *  switchEvery：两首之间多久换一次（秒）。0 = 不自动换。
 *  fadeIn    ：第一首淡入要几秒。
 *  duck      ：打开一条记忆时，音乐退到多大（0.38 = 38%）。
 * ===================================================================== */

window.MUSIC = {
  fadeIn: $fadeIn,
  switchEvery: $switchEvery,
  duck: $duck,
  tracks: [$body]
};
"@

# PS 5.1 需要 BOM 才能在别处正确读回；浏览器按 UTF-8 读没问题
[IO.File]::WriteAllText($out, $js, (New-Object Text.UTF8Encoding($true)))

Write-Host ''
if ($rows.Count -eq 0) {
  Write-Host "assets/music/ 里没有音频文件。" -ForegroundColor Yellow
  Write-Host "把 mp3 / m4a / flac 放进去，再运行一次这个脚本。" -ForegroundColor Yellow
} else {
  Write-Host ("扫到 " + $rows.Count + " 首：") -ForegroundColor Green
  foreach ($r in $rows) { Write-Host ("  " + $r.Trim()) -ForegroundColor Gray }
  Write-Host ''
  Write-Host "已写入 data/music.js —— 刷新页面，点一下屏幕就能听到。" -ForegroundColor Green
}
