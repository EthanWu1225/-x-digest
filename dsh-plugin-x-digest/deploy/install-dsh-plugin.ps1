<#
.SYNOPSIS
  把 dsh-plugin-x-digest 装进本机 DSH 的 profile（默认 desktop），或回滚。

.EXAMPLE
  .\deploy\install-dsh-plugin.ps1 -Token 'abc123'
  .\deploy\install-dsh-plugin.ps1 -Rollback

.NOTES
  1. 会写入 <DSH_HOME>\profiles\<profile>\node_modules\ 与同目录的 cordis.patch.yml；
  2. 改完必须重启 DSH 才生效（宿主插件只在启动时加载）；
  3. -Rollback 只删本脚本加的目录与 patch 块，不动别的配置。
#>
param(
  [string]$Profile = 'desktop',
  [string]$BaseUrl = 'http://127.0.0.1:8788',
  [string]$Token = '',
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$targetDir = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-plugin-x-digest'
$sourceDir = Split-Path -Parent $PSScriptRoot

$beginMarker = '# >>> x-digest plugin >>>'
$endMarker = '# <<< x-digest plugin <<<'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

if (-not (Test-Path $profileDir)) {
  throw "找不到 profile：$profileDir（用 -Profile 指定，比如 desktop / web）"
}

# ---------- 回滚 ----------
if ($Rollback) {
  if (Test-Path $targetDir) {
    Write-Step "删除 $targetDir"
    Remove-Item -Recurse -Force $targetDir
  }
  if (Test-Path $patchFile) {
    $lines = Get-Content $patchFile
    if ($lines -contains $beginMarker) {
      Write-Step "从 cordis.patch.yml 移除 x-digest 块"
      $out = New-Object System.Collections.Generic.List[string]
      $skip = $false
      foreach ($line in $lines) {
        if ($line.Trim() -eq $beginMarker) { $skip = $true; continue }
        if ($line.Trim() -eq $endMarker) { $skip = $false; continue }
        if (-not $skip) { $out.Add($line) }
      }
      Set-Content -Path $patchFile -Value $out -Encoding utf8
    }
  }
  Write-Host "回滚完成。重启 DSH 后插件即消失。" -ForegroundColor Green
  return
}

# ---------- 安装 ----------
if (-not (Test-Path (Join-Path $sourceDir 'package.json'))) {
  throw "看起来脚本不在插件目录的 deploy\ 下（找不到 $sourceDir\package.json）"
}
$pkg = Get-Content (Join-Path $sourceDir 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-plugin-x-digest') {
  throw "源目录不是 dsh-plugin-x-digest（package.json name=$($pkg.name)）"
}

Write-Step "复制插件到 $targetDir"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
foreach ($item in 'package.json', 'cordis.patch.yml', 'README.md', 'lib', 'LICENSE') {
  $src = Join-Path $sourceDir $item
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $targetDir $item
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  Copy-Item -Recurse -Force $src $dst
}

if (-not (Test-Path $patchFile)) {
  Write-Step "创建 $patchFile"
  Set-Content -Path $patchFile -Value '[]' -Encoding utf8
}

$patchText = Get-Content $patchFile -Raw
if ($patchText -notmatch [regex]::Escape($beginMarker)) {
  $backup = "$patchFile.x-digest.bak"
  Copy-Item $patchFile $backup -Force
  Write-Step "已备份原 patch 到 $backup"

  $block = @(
    '',
    $beginMarker,
    '- insert:',
    '    - id: x-digest',
    '      name: dsh-plugin-x-digest',
    '      config:',
    "        baseUrl: $BaseUrl",
    "        token: '$Token'",
    '        defaultHandles: ''''',
    $endMarker
  ) -join "`n"

  $trimmed = $patchText.TrimEnd()
  Set-Content -Path $patchFile -Value ($trimmed + "`n" + $block + "`n") -Encoding utf8
  Write-Step "已把 x-digest 写进 cordis.patch.yml"
} else {
  Write-Step "cordis.patch.yml 里已有 x-digest 块，跳过（要改地址就编辑它）"
}

Write-Host ''
Write-Host '装好了。注意两点：' -ForegroundColor Yellow
Write-Host '  1. 必须重启 DSH 才会加载（宿主插件只在启动时装配）；'
Write-Host '  2. 重启后确认工具出现在会话里：问一句「x_digest_status 看看服务状态」。'
Write-Host ''
Write-Host "回滚： .\deploy\install-dsh-plugin.ps1 -Rollback" -ForegroundColor DarkGray
