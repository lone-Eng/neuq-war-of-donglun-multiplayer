# =========================================================
#  Build the standalone player guide (东秦杀-教程.html).
#
#  Inlines js/data.js into tools/guide.src.html so the character / card
#  tables in the guide are generated from the SAME data the game uses --
#  they can never drift out of sync.
#
#  Usage:  powershell -ExecutionPolicy Bypass -File .\tools\build-guide.ps1
#
#  NOTE: this script must stay ASCII-only. PowerShell 5.1 reads .ps1 as
#  ANSI/GBK, so Chinese literals written here would be corrupted. All
#  Chinese text lives in guide.src.html and data.js (both UTF-8).
# =========================================================
$ErrorActionPreference = 'Stop'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $tools

$src     = Join-Path $tools 'guide.src.html'
$dataJs  = Join-Path $root  'js\data.js'
if (-not (Test-Path $src))    { throw "missing $src" }
if (-not (Test-Path $dataJs)) { throw "missing $dataJs" }

$dataCode = Get-Content $dataJs -Raw -Encoding UTF8
if ($dataCode -match '</script') { throw "js\data.js contains </script> - cannot inline safely" }

$page = Get-Content $src -Raw -Encoding UTF8
if ($page.IndexOf('<!--INLINE-DATA-->') -lt 0) { throw "guide.src.html has no <!--INLINE-DATA--> marker" }

$block = "<!-- ===== js/data.js (inlined) ===== -->`r`n<script>`r`n" + $dataCode + "`r`n</script>"
$out = $page.Replace('<!--INLINE-DATA-->', $block)

# output name rebuilt from code points (this script must stay ASCII-only)
$brand  = [string]([char]0x4E1C + [char]0x79E6 + [char]0x6740)   # Dong Qin Sha
$suffix = [string]([char]0x6559 + [char]0x7A0B)                  # Jiao Cheng
$target = Join-Path $root ($brand + '-' + $suffix + '.html')

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($target, $out, $utf8NoBom)

# ---- self-check ----
$size = (Get-Item $target).Length
$text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)

# Chinese needles assembled from code points (no CJK literals in this file)
$sBrand   = $brand
$sDean    = [string]([char]0x9662 + [char]0x957F)                                    # Yuan Zhang
$sPoint   = [string]([char]0x4E0A + [char]0x8BFE + [char]0x70B9 + [char]0x540D)       # Shang Ke Dian Ming
$sDodge   = [string]([char]0x4EE3 + [char]0x8BFE)                                     # Dai Ke
$sSign    = [string]([char]0x8F85 + [char]0x5BFC + [char]0x5458 + [char]0x7B7E + [char]0x5B57)  # Fu Dao Yuan Qian Zi
$sChar    = [string]([char]0x6B66 + [char]0x5C06)                                     # Wu Jiang

$checks = [ordered]@{
  'inline-data'   = ($text -match 'window\.GameData')
  'chars-data'    = ($text -match 'const CHARACTERS = \[')
  'card-detail'   = ($text -match 'CARD_DETAIL')
  'render-script' = ($text -match 'id=.char-grid.')
  'no-marker'     = ($text -notmatch 'INLINE-DATA')
  'no-ext-refs'   = (-not ($text -match 'src="js/|href="css/|src="\.\./'))
  'cjk-brand'     = $text.Contains($sBrand)
  'cjk-dean'      = $text.Contains($sDean)
  'cjk-cards'     = ($text.Contains($sPoint) -and $text.Contains($sDodge))
  'cjk-sign'      = $text.Contains($sSign)
  'cjk-chars'     = $text.Contains($sChar)
  'has-doctype'   = ($text -match '<!DOCTYPE html>')
  'responsive'    = ($text -match 'name="viewport"')
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
