# openwright one-line bootstrap - Windows:
#
#   irm https://raw.githubusercontent.com/spencer-voorhees/openwright/main/install.ps1 | iex
#
# Fetches the repo into ~\openwright (git clone if git exists, zip
# snapshot otherwise) and hands off to the interactive setup wizard.
$ErrorActionPreference = "Stop"

$repo = "https://github.com/spencer-voorhees/openwright"
$dir  = if ($env:OPENWRIGHT_DIR) { $env:OPENWRIGHT_DIR } else { Join-Path $env:USERPROFILE "openwright" }

if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "openwright already at $dir - updating"
  git -C $dir pull --ff-only
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone $repo $dir
} else {
  Write-Host "git not found - downloading snapshot"
  $zip = Join-Path $env:TEMP "openwright.zip"
  Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "openwright-unzip"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp
  Move-Item (Join-Path $tmp "openwright-main") $dir
  Remove-Item $zip -Force
}

Set-Location $dir
powershell -ExecutionPolicy Bypass -File (Join-Path $dir "setup.ps1")

# This script runs in the caller's session (irm | iex), so it CAN fix
# the current shell's PATH - the openwright command works immediately.
$bunBin = Join-Path $env:USERPROFILE ".bun\bin"
if ($env:Path -notlike "*$bunBin*") { $env:Path = "$bunBin;$env:Path" }
