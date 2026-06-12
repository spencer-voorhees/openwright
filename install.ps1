# openpod one-line bootstrap — Windows:
#
#   irm https://raw.githubusercontent.com/spencer-voorhees/openpod/main/install.ps1 | iex
#
# Fetches the repo into ~\openpod (git clone if git exists, zip
# snapshot otherwise) and hands off to the interactive setup wizard.
$ErrorActionPreference = "Stop"

$repo = "https://github.com/spencer-voorhees/openpod"
$dir  = if ($env:OPENPOD_DIR) { $env:OPENPOD_DIR } else { Join-Path $env:USERPROFILE "openpod" }

if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "openpod already at $dir — updating"
  git -C $dir pull --ff-only
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone $repo $dir
} else {
  Write-Host "git not found — downloading snapshot"
  $zip = Join-Path $env:TEMP "openpod.zip"
  Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "openpod-unzip"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp
  Move-Item (Join-Path $tmp "openpod-main") $dir
  Remove-Item $zip -Force
}

Set-Location $dir
powershell -ExecutionPolicy Bypass -File (Join-Path $dir "setup.ps1")
