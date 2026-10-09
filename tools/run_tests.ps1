# =========================================================
#  DongQinSha - one-stop test runner (no Node.js required).
#
#  Runs the real game code in a real browser engine (Edge/Chrome headless)
#  and collects results through a tiny Python result sink.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1            # JS suite (default)
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1 -All       # everything
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1 -Js -Net   # + host<->client network round trip
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1 -Page      # real index.html smoke
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1 -E2E       # two real browsers, full online game
#    powershell -ExecutionPolicy Bypass -File .\tools\run_tests.ps1 -Mobile    # smoke the built single-file
#
#  -Net / -E2E need server.py running (default http://127.0.0.1:8080).
#  -Mobile needs the single-file build to exist (run build-mobile.ps1 first).
#
#  NOTE: this script must stay ASCII-only. PowerShell 5.1 reads .ps1 as
#  ANSI/GBK, so Chinese literals written here would be corrupted.
# =========================================================
param(
  [switch]$Js,
  [switch]$Page,
  [switch]$Mobile,
  [switch]$E2E,
  [switch]$All,
  [switch]$Net,
  [string]$NetUrl = 'http://127.0.0.1:8080'
)
$ErrorActionPreference = 'Stop'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $tools
$sink  = Join-Path $tools 'result_sink.py'
$results = Join-Path $tools '_results.txt'
$sinkPort = 8899

# Start-Process joins -ArgumentList with plain spaces and does NOT quote the
# elements, so paths containing spaces must be quoted by hand.
function Q([string]$s) { return '"' + $s + '"' }

$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$exe = $null
foreach ($b in $browsers) { if (Test-Path $b) { $exe = $b; break } }
if (-not $exe) { throw "Neither Chrome nor Edge was found." }

if (-not $Js -and -not $Page -and -not $Mobile -and -not $E2E) { $Js = $true }
if ($All) { $Js = $true; $Page = $true; $Mobile = $true; $E2E = $true }

$suitesRun = 0
$suitesFailed = 0

# ---------------------------------------------------------------- helpers

function Invoke-Suite {
  param(
    [string]$Name,
    [string]$PageFile,     # the harness page we actually load (it does the reporting)
    [string]$ExtraQuery,
    [string]$Marker,
    [string]$TargetPath    # optional: the page UNDER TEST, passed to the harness as ?page=
  )

  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor Cyan
  Write-Host "  $Name" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor Cyan

  $src = Join-Path $tools $PageFile
  if (-not (Test-Path $src)) {
    Write-Host "  skipped: $src not found" -ForegroundColor Yellow
    return
  }
  if ($TargetPath -and -not (Test-Path $TargetPath)) {
    Write-Host "  skipped: $TargetPath not found" -ForegroundColor Yellow
    return
  }

  # The sink removes any stale results file on startup, which is how we tell
  # "this run finished" from "an old run left something behind".
  $sinkProc = Start-Process -FilePath 'python' `
    -ArgumentList @('-I', (Q $sink), "$sinkPort", (Q $results)) `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 900

  $url = ([uri]$src).AbsoluteUri + '?sink=' + [uri]::EscapeDataString("http://127.0.0.1:$sinkPort")
  if ($TargetPath) {
    $url = $url + '&page=' + [uri]::EscapeDataString(([uri]$TargetPath).AbsoluteUri)
  }
  if ($ExtraQuery) { $url = $url + '&' + $ExtraQuery }
  Write-Host "  harness: $src" -ForegroundColor DarkGray
  if ($TargetPath) { Write-Host "  target : $TargetPath" -ForegroundColor DarkGray }

  # Each suite gets its OWN --user-data-dir. Reusing one across suites makes the
  # second launch hand the URL off to the still-exiting first instance and exit
  # immediately -- the page never loads and the suite times out with no output.
  $profileDir = Join-Path $env:TEMP ("dqk-headless-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))

  $browser = Start-Process -FilePath $exe `
    -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run',
                    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
                    '--allow-file-access-from-files',
                    (Q "--user-data-dir=$profileDir"), $url) `
    -PassThru -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(240)
  while (-not (Test-Path $results)) {
    if ((Get-Date) -gt $deadline) { break }
    Start-Sleep -Milliseconds 400
  }
  # Kill the whole browser process tree. Done through cmd.exe on purpose:
  # under PowerShell 5.1 + $ErrorActionPreference='Stop', redirecting a native
  # command's stderr makes each stderr line a NativeCommandError that TERMINATES
  # the script -- and taskkill writes "could not be terminated" for child
  # processes it has already reaped. cmd does its own redirection, so nothing
  # leaks back into PowerShell.
  $null = cmd /c "taskkill /F /T /PID $($browser.Id) >nul 2>&1"
  if ($sinkProc -and -not $sinkProc.HasExited) {
    Stop-Process -Id $sinkProc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800

  if (-not (Test-Path $results)) {
    Write-Host "  no results within 240s" -ForegroundColor Red
    $script:suitesRun++
    $script:suitesFailed++
    return
  }

  $text = [System.IO.File]::ReadAllText($results, [System.Text.Encoding]::UTF8)
  Write-Host $text

  # ${Marker} braces are required: "$Marker-TOTAL" would parse as a variable
  # named Marker-TOTAL (PowerShell allows '-' in unbraced variable names).
  $m = [regex]::Match($text, "${Marker}-TOTAL (\d+) ${Marker}-FAILED (\d+)")
  $script:suitesRun++
  if (-not $m.Success) {
    Write-Host "  suite did not finish" -ForegroundColor Red
    $script:suitesFailed++
    return
  }
  if ([int]$m.Groups[2].Value -ne 0) { $script:suitesFailed++ }
}

# ---------------------------------------------------------------- run

Write-Host ""
Write-Host "browser: $exe"

if ($Js) {
  $q = ''
  if ($Net) { $q = 'net=' + [uri]::EscapeDataString($NetUrl) }
  Invoke-Suite -Name 'JS suite (codec / projection / wire / engine)' `
               -PageFile 'js_test.html' -ExtraQuery $q -Marker 'JS'
}

if ($Page) {
  Invoke-Suite -Name 'Real page smoke (index.html)' `
               -PageFile 'page_smoke.html' -Marker 'SMOKE'
}

if ($Mobile) {
  # 'Dongqin Kill' rebuilt from code points -- this script must stay ASCII-only
  $brand = [string]([char]0x4E1C + [char]0x79E6 + [char]0x6740)
  Invoke-Suite -Name 'Single-file mobile build smoke' `
               -PageFile 'page_smoke.html' -Marker 'SMOKE' `
               -TargetPath (Join-Path $root ($brand + '-mobile.html'))
}

if ($E2E) {
  # Parenthesise the concatenation: without it PowerShell parses
  # "-ExtraQuery 'server=' + x" as THREE arguments and "+" lands in -PageFile.
  Invoke-Suite -Name 'Two-browser online end-to-end' `
               -PageFile 'e2e_online.html' -Marker 'E2E' `
               -ExtraQuery ('server=' + [uri]::EscapeDataString($NetUrl))
}

Write-Host ""
Write-Host ("=" * 60)
if ($suitesFailed -eq 0) {
  Write-Host "  ALL $suitesRun SUITE(S) PASSED" -ForegroundColor Green
} else {
  Write-Host "  $suitesFailed of $suitesRun SUITE(S) FAILED" -ForegroundColor Red
}
Write-Host ("=" * 60)
Write-Host ""
exit $(if ($suitesFailed -eq 0) { 0 } else { 1 })
