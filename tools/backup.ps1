# =========================================================
#  Snapshot backup for the whole project.
#
#  This machine has no git installed, so this is the safety net:
#  it zips the source tree into backups\ with a timestamp, so a bad edit
#  is always one copy back rather than gone for good.
#
#  Usage:  powershell -ExecutionPolicy Bypass -File .\tools\backup.ps1
#          powershell -ExecutionPolicy Bypass -File .\tools\backup.ps1 -Note "before big refactor"
#
#  If you ever install git, `git init` + a commit is strictly better than
#  this. Until then, run this before any risky change.
#
#  NOTE: this script must stay ASCII-only (PowerShell 5.1 reads .ps1 as ANSI).
# =========================================================
param(
  [string]$Note = ''
)
$ErrorActionPreference = 'Stop'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $tools
$dest  = Join-Path $root 'backups'
if (-not (Test-Path $dest)) { $null = New-Item -ItemType Directory -Path $dest }

# Only the things worth keeping: source + build script + docs.
# Generated test output (_results.txt) and old backups are excluded.
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$zip   = Join-Path $dest ("dongqin-$stamp.zip")

$include = @(
  'index.html', 'server.py', 'start-server.bat', 'build-mobile.ps1',
  'README.md', 'css', 'js', 'tools'
)

$staging = Join-Path $env:TEMP ("dqk-backup-" + $stamp)
$null = New-Item -ItemType Directory -Path $staging

foreach ($item in $include){
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $staging $item
  if (Test-Path $src -PathType Container){
    Copy-Item $src $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}

# the mobile single-file build is what gets sent to phones -- keep it too
Get-ChildItem $root -Filter '*-mobile.html' -File -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $staging $_.Name) -Force }

# don't ship test scratch files inside the snapshot
Get-ChildItem $staging -Recurse -Filter '_results.txt' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

if ($Note) {
  $noteFile = Join-Path $staging 'BACKUP-NOTE.txt'
  [System.IO.File]::WriteAllText($noteFile, $Note, (New-Object System.Text.UTF8Encoding($false)))
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zip)
Remove-Item $staging -Recurse -Force

$size = [int]((Get-Item $zip).Length / 1KB)
Write-Host ""
Write-Host ("backup: " + $zip) -ForegroundColor Green
Write-Host ("size  : {0} KB" -f $size)

# keep the last 30 snapshots, prune older ones
$old = Get-ChildItem $dest -Filter 'dongqin-*.zip' | Sort-Object LastWriteTime -Descending
if ($old.Count -gt 30) {
  $old | Select-Object -Skip 30 | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host ("pruned: " + $_.Name) -ForegroundColor DarkGray
  }
}
Write-Host ("total : {0} snapshot(s) in backups\" -f (Get-ChildItem $dest -Filter 'dongqin-*.zip').Count)
Write-Host ""
