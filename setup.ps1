# openpod setup — Windows (PowerShell). Interactive, idempotent,
# zero-prerequisite.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1        guided
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Yes   install everything
#
# Nothing needs to be preinstalled: bun and uv ship their own
# installers, python comes from uv, and the agent CLIs install through
# bun's global shims (no node required).
param([switch]$Yes)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Step($m) { Write-Host "`n* $m" -ForegroundColor DarkYellow }
function Ok($m)   { Write-Host "  + $m" -ForegroundColor Green }
function Note($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Ask($q, $def = $true) {
  if ($Yes -or $env:OPENPOD_INSTALL_AGENTS -eq "1") { return $true }
  $suffix = if ($def) { "[Y/n]" } else { "[y/N]" }
  $r = Read-Host "  $q $suffix"
  if ($r -eq "") { return $def }
  return $r -match '^[yY]'
}

Write-Host "`n  openpod setup" -ForegroundColor White
Note "Installs only what's missing; touches this repo, ~/.bun, ~/.local."

# -- 1. bun ---------------------------------------------------------
Step "Runtime: bun"
$env:Path = "$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.local\bin;$env:Path"
if (Have "bun") { Ok "bun $(bun --version)" }
else {
  Note "bun is the only hard requirement — installing from bun.sh"
  powershell -c "irm bun.sh/install.ps1 | iex"
  Ok "bun $(bun --version)"
}

Step "JS dependencies"
bun install --silent
Ok "installed"

# -- 2. python via uv ----------------------------------------------
Step "Exporters: PDF + editable PPTX (python)"
$pybin = $null
if (Test-Path ".venv\Scripts\python.exe") {
  $pybin = ".venv\Scripts\python.exe"
  Ok "repo venv already present"
} elseif (Ask "Install an isolated Python toolchain for exports (via uv)?" $true) {
  if (-not (Have "uv")) {
    Note "installing uv (astral.sh)"
    powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  }
  uv venv -q --python 3.12 .venv
  uv pip install -q -r requirements.txt --python .venv\Scripts\python.exe
  $pybin = ".venv\Scripts\python.exe"
  Ok "python ready in .venv"
} else {
  Note "skipped — decks still preview live; PDF/PPTX export unavailable"
}
if ($pybin) {
  Note "fetching chromium for the exporters (one-time, ~120 MB)"
  & $pybin -m playwright install chromium | Out-Null
  Ok "chromium ready"
}

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

# -- 3. agent engines ----------------------------------------------
Step "Agent engines (need at least one)"

if ((Have "claude") -or $env:ANTHROPIC_API_KEY) { Ok "claude — available" }
elseif (Ask "Install Claude Code (for the Claude engine)?" $false) {
  bun add -g "@anthropic-ai/claude-code" | Out-Null
  Ok "claude installed — run 'claude' once to log in"
} else { Note "claude: skipped — set ANTHROPIC_API_KEY in .env, or install later" }

if (Have "copilot") { Ok "copilot — $(copilot --version 2>$null | Select-Object -First 1)" }
elseif (Ask "Install GitHub Copilot CLI?" $false) {
  bun add -g "@github/copilot" | Out-Null
  Ok "copilot installed"
} else { Note "copilot: skipped" }
if ((Have "copilot") -and -not ($env:COPILOT_GITHUB_TOKEN -or $env:GH_TOKEN -or $env:GITHUB_TOKEN)) {
  if ((-not $Yes) -and (Ask "Log in to Copilot now (device-code flow)?" $false)) { copilot login }
  else { Note "auth later: run 'copilot login' (or set COPILOT_GITHUB_TOKEN)" }
}

if (Have "codex") { Ok "codex — $(codex --version 2>$null)" }
elseif (Ask "Install OpenAI Codex CLI?" $false) {
  bun add -g "@openai/codex" | Out-Null
  Ok "codex installed"
} else { Note "codex: skipped" }
if (Have "codex") {
  codex login status *> $null
  if ($LASTEXITCODE -ne 0) {
    if ((-not $Yes) -and (Ask "Log in to Codex now (opens browser)?" $false)) { codex login }
    else { Note "auth later: run 'codex login'" }
  }
}

# -- 4. summary -----------------------------------------------------
Step "Done"
$any = (Have "claude") -or (Have "copilot") -or (Have "codex") -or $env:ANTHROPIC_API_KEY
if (-not $any) { Note "WARNING: no engine installed yet — openpod will start but can't generate" }
Write-Host ""
Write-Host "  Start it:   bun start" -ForegroundColor White
Note "http://localhost:8090 — db + Oneshot design system seed on first boot."
Write-Host ""
