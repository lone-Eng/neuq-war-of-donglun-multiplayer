# =========================================================
#  Dongqin Kill - single-file MOBILE build
#  Inlines index.html + css + js into one standalone HTML file
#  Run:  powershell -ExecutionPolicy Bypass -File .\build-mobile.ps1
#  (script is ASCII-only because PowerShell 5.1 reads .ps1 as ANSI;
#   all Chinese text comes from the source files, which are read as UTF-8)
# =========================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $root) { $root = (Get-Location).Path }

$stylePath  = Join-Path $root 'css\style.css'
$mobilePath = Join-Path $root 'css\mobile.css'
$indexPath  = Join-Path $root 'index.html'
foreach ($p in @($stylePath, $mobilePath, $indexPath)) {
  if (-not (Test-Path $p)) { throw "missing file: $p" }
}

$mainCss = Get-Content $stylePath  -Raw -Encoding UTF8
$mobCss  = Get-Content $mobilePath -Raw -Encoding UTF8

$jsFiles = @('data','fx','ai','engine','ui','selftest','net','tutorial','main')
foreach ($n in $jsFiles) {
  $p = Join-Path $root "js\$n.js"
  if (-not (Test-Path $p)) { throw "missing script: $p" }
  $code = Get-Content $p -Raw -Encoding UTF8
  if ($code -match '</script') { throw "js\$n.js contains </script> - cannot inline safely" }
}

# NOTE: this script must stay ASCII-only.
# PowerShell 5.1 parses .ps1 as ANSI/GBK, which would corrupt any Chinese
# literal written here. All Chinese text is taken from the UTF-8 source files.
$patch = @'
<script>
/* ---------- mobile runtime patch (ASCII only) ---------- */
(function(){
  var small = window.matchMedia('(max-width: 900px)').matches;
  if (small){
    var sb = document.getElementById('sidebar');
    if (sb) sb.classList.add('hide');          /* collapse the log drawer by default on phones */
  }
  document.addEventListener('dblclick', function(e){ e.preventDefault(); }, { passive:false });
})();
</script>
'@

$lines = Get-Content $indexPath -Encoding UTF8
$out = New-Object System.Collections.Generic.List[string]

foreach ($line in $lines){
  if ($line -match 'name="viewport"'){
    $out.Add('<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">')
  }
  elseif ($line -match '<title>'){
    $out.Add('  <title>' + [char]0x4E1C + [char]0x79E6 + [char]0x6740 + [char]0xFF1A + [char]0x70B9 + [char]0x540D + [char]0x518C + ' - Mobile</title>')
  }
  elseif ($line -match 'href="css/style\.css"'){
    $out.Add('  <style>')
    $out.Add($mainCss)
    $out.Add($mobCss)
    $out.Add('  </style>')
  }
  elseif ($line -match 'href="css/mobile\.css"'){
    # Already inlined right after style.css above - drop the <link> line,
    # otherwise the "no-ext-refs" check below would fail on href="css/.
    # (This file must stay ASCII-only; see the note at the top.)
  }
  elseif ($line -match '<script src="js/([A-Za-z]+)\.js"></script>'){
    $name = $Matches[1]
    $code = Get-Content (Join-Path $root "js\$name.js") -Raw -Encoding UTF8
    $out.Add("  <script>/* ===== $name.js ===== */")
    $out.Add($code)
    $out.Add('  </script>')
  }
  elseif ($line -match '</body>'){
    $out.Add($patch)
    $out.Add($line)
  }
  else { $out.Add($line) }
}

# Output name is FIXED, not derived from the folder name.
# It used to be "<foldername>-mobile.html", which broke as soon as the folder
# was renamed: the build would emit "Dongqin Kill - Online-mobile.html" while
# the file you actually send to your phone kept sitting there stale.
# Name is rebuilt from code points because this script must stay ASCII-only.
$sBrandName = [string]([char]0x4E1C + [char]0x79E6 + [char]0x6740)   # Dong Qin Sha
$target = Join-Path $root ($sBrandName + '-mobile.html')

# Write as UTF-8 WITHOUT BOM via .NET (Set-Content would add a BOM)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($target, ($out -join "`r`n"), $utf8NoBom)

$size = (Get-Item $target).Length
$text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)

# Key Chinese strings, assembled from code points (no CJK literals in this file).
# sDean = 0x9662 0x957F ; sPoint = 0x4E0A 0x8BFE 0x70B9 0x540D ; sDodge = 0x4EE3 0x8BFE
$sDean   = [string]([char]0x9662 + [char]0x957F)
$sPoint  = [string]([char]0x4E0A + [char]0x8BFE + [char]0x70B9 + [char]0x540D)
$sDodge  = [string]([char]0x4EE3 + [char]0x8BFE)
$sBrand  = [string]([char]0x4E1C + [char]0x79E6 + [char]0x6740)
$sStaff  = [string]([char]0x6559 + [char]0x52A1)

# The injected patch must be pure ASCII; non-ASCII here means the .ps1 itself
# was mis-decoded (PowerShell 5.1 reads .ps1 as ANSI/GBK) and produced garbage.
$patchIdx = $text.IndexOf('mobile runtime patch')
$patchBlock = if ($patchIdx -ge 0) { $text.Substring($patchIdx, [Math]::Min(600, $text.Length - $patchIdx)) } else { '' }
$patchAscii = $true
foreach ($ch in $patchBlock.ToCharArray()) { if ([int]$ch -gt 127) { $patchAscii = $false; break } }

$checks = [ordered]@{
  'inline-style'  = ($text -match '<style>')
  'inline-scripts'= ([regex]::Matches($text, '<script>').Count -ge 10)
  'deck-data'     = ($text -match 'buildDeck')
  'card-detail'   = ($text -match 'CARD_DETAIL')
  'rule-engine'   = ($text -match 'function useCard')
  'skills'        = ($text -match 'SKILLS')
  'selftest'      = ($text -match 'runSelfTest')
  'net-module'    = ($text -match 'window\.Net')
  'mobile-css'    = ($text -match 'max-width:\s*900px')
  'no-ext-refs'   = (-not ($text -match 'src="js/|href="css/'))
  'cjk-brand'     = $text.Contains($sBrand)
  'cjk-dean'      = ($text.Contains($sDean) -and $text.Contains($sStaff))
  'cjk-cards'     = ($text.Contains($sPoint) -and $text.Contains($sDodge))
  'patch-ascii'   = $patchAscii
  'no-bom'        = (-not ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF))
}
Write-Host ""
Write-Host ("built: " + $target)
Write-Host ("size : {0:N0} bytes ({1:N1} KB)" -f $size, ($size/1KB))
$bad = 0
foreach ($k in $checks.Keys){
  if ($checks[$k]) { Write-Host ("  [ok]   " + $k) }
  else { Write-Host ("  [FAIL] " + $k); $bad++ }
}
if ($bad -eq 0){ Write-Host "ALL CHECKS PASSED" -ForegroundColor Green }
else { Write-Host ("$bad check(s) failed") -ForegroundColor Yellow }

# Also refresh the source bundle. It is what lets a page opened as file://
# (i.e. index.html double-clicked) export a shareable replay -- such a page may
# not fetch its own js/ files, so the sources ship as a loadable script.
# Regenerating it here means one command keeps both artifacts in sync; the test
# suite fails loudly if it is ever left stale.
$srcBuilder = Join-Path $root 'tools\build-sources.ps1'
if (Test-Path $srcBuilder) {
  Write-Host ""
  & $srcBuilder
} else {
  Write-Host ""
  Write-Host ("skipped source bundle: " + $srcBuilder + " not found") -ForegroundColor Yellow
}
