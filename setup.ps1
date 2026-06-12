# openpod setup — Windows (PowerShell). Idempotent; run from the repo root.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "`n== bun"
if (-not (Have "bun")) {
  Write-Host "bun not found — installing (https://bun.sh)"
  powershell -c "irm bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}
bun --version

Write-Host "`n== js dependencies"
bun install

Write-Host "`n== python exporters"
$py = $null
foreach ($c in @("python3", "python", "py")) { if (Have $c) { $py = $c; break } }
if ($py) {
  & $py -m pip install --user -q -r requirements.txt
  & $py -m playwright install chromium
} else {
  Write-Host "WARNING: python not found — PDF/PPTX export will be unavailable."
}

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

Write-Host "`n== agent engines"
$found = $false

if ((Have "claude") -or $env:ANTHROPIC_API_KEY) {
  Write-Host "claude:  available (Claude Code login or ANTHROPIC_API_KEY)"
  $found = $true
} else {
  Write-Host "claude:  not set up — set ANTHROPIC_API_KEY in .env, or install Claude Code and run 'claude login'"
}

if (Have "copilot") {
  Write-Host "copilot: $(copilot --version 2>$null | Select-Object -First 1)"
  Write-Host "         (auth: run 'copilot' once and /login, or set COPILOT_GITHUB_TOKEN)"
  $found = $true
} elseif ($env:OPENPOD_INSTALL_AGENTS -eq "1" -and (Have "npm")) {
  Write-Host "copilot: installing @github/copilot..."
  npm install -g "@github/copilot"; $found = $true
} else {
  Write-Host "copilot: not installed — 'npm install -g @github/copilot' (or rerun with OPENPOD_INSTALL_AGENTS=1)"
}

if (Have "codex") {
  Write-Host "codex:   $(codex --version 2>$null)"
  $found = $true
} elseif ($env:OPENPOD_INSTALL_AGENTS -eq "1" -and (Have "npm")) {
  Write-Host "codex:   installing @openai/codex..."
  npm install -g "@openai/codex"; $found = $true
} else {
  Write-Host "codex:   not installed — 'npm install -g @openai/codex' (or rerun with OPENPOD_INSTALL_AGENTS=1)"
}

if (-not $found) { Write-Host "WARNING: no agent engine is usable yet — set one up before generating." }

Write-Host "`n== done"
Write-Host "Start the server:  bun start    (http://localhost:8090)"
Write-Host "The database and built-in design system seed automatically on first boot."
