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
  [switch]$Export,
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

if (-not $Js -and -not $Page -and -not $Mobile -and -not $E2E -and -not $Export) { $Js = $true }
if ($All) { $Js = $true; $Page = $true; $Mobile = $true; $E2E = $true; $Export = $true }

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

# ---------------------------------------------------------------- export suite
# The replay export can only really be verified by OPENING the file it produces.
#   stage 1: the probe runs in a browser over http, builds the shareable HTML and
#            POSTs {results, html} to a sink.
#   stage 2: that HTML is written to disk and opened headless -- if the board and
#            the replay bar render, the export works.
# Stage 2 is the one that matters: a pure string check cannot tell "export OK"
# from "opens to a blank page", and a blank page is exactly how this broke twice.
function Invoke-ExportSuite {
  param(
    [string]$Label        = 'Replay export (shareable HTML)',
    [string]$PageQuery    = '',               # '&page=<url>': probe THAT build instead of this page
    [string]$ArtifactName = '_replay_export.html',
    [string]$RawSuffix    = ''
  )

  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor Cyan
  Write-Host "  $Label" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor Cyan

  $probe = Join-Path $tools 'export_probe.html'
  if (-not (Test-Path $probe)) {
    Write-Host "  skipped: $probe not found" -ForegroundColor Yellow
    return
  }

  # The probe must be served over http (file:// pages cannot fetch the sources,
  # and a file:// iframe cannot reach an http probe at all)
  $base = 'http://127.0.0.1:8080'
  try { $null = Invoke-WebRequest ($base + '/index.html') -UseBasicParsing -TimeoutSec 5 }
  catch {
    Write-Host "  skipped: no game server at $base (run server.py first)" -ForegroundColor Yellow
    $script:suitesRun++; $script:suitesFailed++
    return
  }

  $raw      = Join-Path $tools ('_export_raw' + $RawSuffix + '.json')
  $artifact = Join-Path $tools $ArtifactName
  if (Test-Path $raw) { [System.IO.File]::Delete($raw) }

  $sinkProc = Start-Process -FilePath 'python' `
    -ArgumentList @('-I', (Q $sink), '8900', (Q $raw)) `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 900

  $url = $base + '/tools/export_probe.html?sink=' + [uri]::EscapeDataString('http://127.0.0.1:8900') + $PageQuery
  # Own profile dir per run. Sharing one across back-to-back launches makes the
  # second hand its URL to the still-exiting first instance and quit immediately
  # -- the page never loads and the run times out with no output.
  $profileDir = Join-Path $env:TEMP ("dqk-export-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  $browser = Start-Process -FilePath $exe `
    -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run',
                    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
                    '--allow-file-access-from-files',
                    (Q "--user-data-dir=$profileDir"), $url) `
    -PassThru -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(180)
  while (-not (Test-Path $raw)) { if ((Get-Date) -gt $deadline) { break }; Start-Sleep -Milliseconds 400 }
  $null = cmd /c "taskkill /F /T /PID $($browser.Id) >nul 2>&1"
  if ($sinkProc -and -not $sinkProc.HasExited) { Stop-Process -Id $sinkProc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 700

  $script:suitesRun++
  if (-not (Test-Path $raw)) {
    Write-Host "  stage 1: no result within 180s" -ForegroundColor Red
    $script:suitesFailed++; return
  }

  $payload = $null
  try { $payload = ([System.IO.File]::ReadAllText($raw, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }
  catch { $payload = $null }
  if (-not $payload) {
    Write-Host "  stage 1: could not parse the probe payload" -ForegroundColor Red
    $script:suitesFailed++; return
  }

  Write-Host $payload.results
  $bad = ([regex]::Matches($payload.results, '\[FAIL\]')).Count

  # ---- stage 2: open the generated file and see whether it actually plays ----
  [System.IO.File]::WriteAllText($artifact, $payload.html, (New-Object System.Text.UTF8Encoding($false)))
  $dom = Run-Browser @('--headless=new', '--disable-gpu', '--no-first-run',
                       '--allow-file-access-from-files',
                       (Q "--user-data-dir=$($profileDir).s2"),
                       '--virtual-time-budget=6000', '--dump-dom', ([uri]$artifact).AbsoluteUri)
  $panels = ([regex]::Matches($dom, 'class="player-panel')).Count
  $cards  = ([regex]::Matches($dom, 'class="card ')).Count
  $barOk  = ($dom -notmatch 'id="replay-bar" class="hide"')
  # Detect the replay file's own error banner by its id, NOT by a style literal.
  # The boot script's SOURCE is inlined in the page, so matching 'z-index:99999'
  # hits that source text and calls every good file "blank" -- a false failure
  # that hid a real pass. The serialized element carries id="replay-error";
  # the script source never contains that exact quoted form.
  # (An id rather than a Chinese literal: this script must stay ASCII-only.)
  $blank  = ($dom -match 'id="replay-error"')

  Write-Host ("  artifact: " + $artifact)
  $s2 = [ordered]@{
    'artifact-renders-seats'    = ($panels -ge 2)
    'artifact-renders-hand'     = ($cards -ge 1)
    'artifact-shows-replaybar'  = $barOk
    'artifact-not-blank-error'  = (-not $blank)
  }
  foreach ($k in $s2.Keys) {
    if ($s2[$k]) { Write-Host ("  [ok]   " + $k) }
    else { Write-Host ("  [FAIL] " + $k); $bad++ }
  }
  Write-Host ("  (seats=" + $panels + " cards=" + $cards + ")")
  if ($bad -gt 0) { $script:suitesFailed++ }
}

function Run-Browser([string[]]$BrowserArgs) {
  # Errors from a native exe's stderr become terminating under
  # $ErrorActionPreference='Stop', so relax it just for this call.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return (& $exe @BrowserArgs 2>$null | Out-String) }
  finally { $ErrorActionPreference = $old }
}

# ---------------------------------------------------------------- sources bundle
# js/sources.js is what makes "export a shareable replay" work from file://.
# It is GENERATED, so it goes stale the moment anyone edits js/*.js -- and a
# stale bundle is invisible: the export still succeeds, it just silently
# contains last week's code. Regenerate into a temp file and compare hashes.
function Test-SourcesBundle {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor Cyan
  Write-Host "  Source bundle freshness (js/sources.js)" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor Cyan

  $gen = Join-Path $tools 'build-sources.ps1'
  $cur = Join-Path $root 'js\sources.js'
  $script:suitesRun++
  if (-not (Test-Path $gen)) {
    Write-Host "  skipped: $gen not found" -ForegroundColor Yellow
    return
  }
  if (-not (Test-Path $cur)) {
    Write-Host "  [FAIL] js\sources.js missing - run tools\build-sources.ps1" -ForegroundColor Red
    $script:suitesFailed++
    return
  }

  $tmp = Join-Path $env:TEMP ("dqk-sources-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8) + ".js")
  & $gen -Out $tmp 6>$null | Out-Null
  if (-not (Test-Path $tmp)) {
    Write-Host "  [FAIL] could not regenerate the bundle" -ForegroundColor Red
    $script:suitesFailed++
    return
  }

  $same = ((Get-FileHash $cur -Algorithm SHA256).Hash -eq (Get-FileHash $tmp -Algorithm SHA256).Hash)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue

  if ($same) {
    Write-Host "  [ok]   js/sources.js matches the current sources" -ForegroundColor Green
  } else {
    Write-Host "  [FAIL] js/sources.js is STALE - run tools\build-sources.ps1" -ForegroundColor Red
    Write-Host "         (a stale bundle makes file:// exports carry old code, silently)" -ForegroundColor DarkGray
    $script:suitesFailed++
  }
}

# ---------------------------------------------------------------- file:// export
# The double-click case: index.html opened as file://, where the browser refuses
# to let the page read its own js/ and css/. That path only works because
# build-sources.ps1 ships a bundle -- and it is a DIFFERENT code path from the
# http one, so the http suite says nothing about it.
function Invoke-FileExportProbe {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor Cyan
  Write-Host "  Replay export from a file:// page (double-click index.html)" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor Cyan

  $probe = Join-Path $tools 'file_export_probe.html'
  $script:suitesRun++
  if (-not (Test-Path $probe)) {
    Write-Host "  skipped: $probe not found" -ForegroundColor Yellow
    return
  }

  # Deliberately NO --allow-file-access-from-files: that flag is exactly what a
  # double-click does not have. The probe fails itself if it ever lands on a
  # page that can fetch its own files, so this cannot pass vacuously.
  $profileDir = Join-Path $env:TEMP ("dqk-file-export-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  $dom = Run-Browser @('--headless=new', '--disable-gpu', '--no-first-run',
                       '--no-default-browser-check', '--disable-extensions', '--mute-audio',
                       (Q "--user-data-dir=$profileDir"),
                       '--virtual-time-budget=8000', '--dump-dom', ([uri]$probe).AbsoluteUri)

  $m = [regex]::Match($dom, '(?s)<pre id="RESULTS">(.*?)</pre>')
  if (-not $m.Success) {
    Write-Host "  no results (page did not run)" -ForegroundColor Red
    $script:suitesFailed++
    return
  }
  $text = $m.Groups[1].Value
  Write-Host $text
  if (([regex]::Matches($text, '\[FAIL\]')).Count -gt 0) { $script:suitesFailed++ }
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

if ($Export) {
  # Freshness first: everything below builds on the bundle being current.
  Test-SourcesBundle
  Invoke-ExportSuite

  # The single-file build is the copy that actually gets sent to a phone, and its
  # export runs a DIFFERENT code path: every source is inlined, nothing is fetched.
  # Verifying only the multi-file export says nothing about this one.
  # The brand name is rebuilt from code points (this script must stay ASCII-only).
  $brand  = [string]([char]0x4E1C + [char]0x79E6 + [char]0x6740)
  # NOT $mobile: PowerShell variable names are case-insensitive, so that name IS
  # the [switch]$Mobile parameter, and assigning a path to it throws
  # "cannot convert String to SwitchParameter".
  $mobileBuild = Join-Path $root ($brand + '-mobile.html')
  if (Test-Path $mobileBuild) {
    # '&page=../<escaped brand>-mobile.html' resolves against the probe's own URL
    Invoke-ExportSuite -Label 'Replay export from the single-file mobile build' `
                       -PageQuery ('&page=../' + [uri]::EscapeDataString($brand) + '-mobile.html') `
                       -ArtifactName '_replay_export_mobile.html' -RawSuffix '_mobile'
  } else {
    Write-Host ""
    Write-Host "  skipped: single-file build not found (run build-mobile.ps1)" -ForegroundColor Yellow
  }

  Invoke-FileExportProbe
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
