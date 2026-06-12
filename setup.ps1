# openwright setup - Windows (PowerShell). Interactive, idempotent,
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
function FindBin($name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($d in @("$env:USERPROFILE\.bun\bin", "$env:USERPROFILE\.local\bin")) {
    foreach ($ext in @(".exe", ".cmd", "")) {
      if (Test-Path "$d\$name$ext") { return "$d\$name$ext" }
    }
  }
  if (Have "npm") {
    $p = npm prefix -g 2>$null
    if ($p) {
      foreach ($ext in @(".cmd", ".exe", "")) {
        if (Test-Path "$p\$name$ext") { return "$p\$name$ext" }
      }
    }
  }
  return $null
}
function Step($m) { Write-Host "`n* $m" -ForegroundColor DarkYellow }
function Ok($m)   { Write-Host "  + $m" -ForegroundColor Green }
function Note($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Ask($q, $def = $true) {
  if ($Yes -or $env:OPENWRIGHT_INSTALL_AGENTS -eq "1") { return $true }
  $suffix = if ($def) { "[Y/n]" } else { "[y/N]" }
  $r = Read-Host "  $q $suffix"
  if ($r -eq "") { return $def }
  return $r -match '^[yY]'
}

Write-Host "`n  openwright setup" -ForegroundColor White
Note "Installs only what's missing; touches this repo, ~/.bun, ~/.local."

# -- 1. bun ---------------------------------------------------------
Step "Runtime: bun"
$env:Path = "$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.local\bin;$env:Path"
if (Have "bun") { Ok "bun $(bun --version)" }
else {
  Note "bun is the only hard requirement - installing from bun.sh"
  powershell -c "irm bun.sh/install.ps1 | iex"
  Ok "bun $(bun --version)"
}

Step "JS dependencies"
bun install --silent
bun link 2>$null | Out-Null
Ok "installed (+ openwright CLI on PATH)"

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
  Note "skipped - decks still preview live; PDF/PPTX export unavailable"
}
if ($pybin) {
  Note "fetching chromium for the exporters (one-time, ~120 MB)"
  & $pybin -m playwright install chromium | Out-Null
  Ok "chromium ready"
}

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

# -- 3. agent engines ----------------------------------------------
Step "Agent engines (at least one required)"

$claudeBin  = FindBin "claude"
$copilotBin = FindBin "copilot"
$codexBin   = FindBin "codex"
$haveClaude  = [bool]($claudeBin -or $env:ANTHROPIC_API_KEY)
$haveCopilot = [bool]$copilotBin
$haveCodex   = [bool]$codexBin

if ($haveClaude)  { Ok "detected: claude $(if ($claudeBin) { "($claudeBin)" } else { "(API key)" })" }
if ($haveCopilot) { Ok "detected: copilot ($copilotBin)" }
if ($haveCodex)   { Ok "detected: codex ($codexBin)" }
if (-not ($haveClaude -or $haveCopilot -or $haveCodex)) { Note "no compatible agent CLI found on this machine" }

function InstallEngine($which) {
  switch ($which) {
    "claude"  { bun add -g "@anthropic-ai/claude-code" | Out-Null; $script:haveClaude  = $true; Ok "claude installed - run 'claude' once to log in" }
    "copilot" { bun add -g "@github/copilot" | Out-Null;           $script:haveCopilot = $true; Ok "copilot installed" }
    "codex"   { bun add -g "@openai/codex" | Out-Null;             $script:haveCodex   = $true; Ok "codex installed" }
  }
}

if ((-not $haveClaude)  -and (Ask "Install Claude Code?" $false))        { InstallEngine "claude" }
if ((-not $haveCopilot) -and (Ask "Install GitHub Copilot CLI?" $false)) { InstallEngine "copilot" }
if ((-not $haveCodex)   -and (Ask "Install OpenAI Codex CLI?" $false))   { InstallEngine "codex" }

# Enforce the minimum: openwright can't generate without an engine.
if (-not ($haveClaude -or $haveCopilot -or $haveCodex)) {
  if ($Yes) {
    Note "installing Claude Code as the default engine"
    InstallEngine "claude"
  } else {
    Write-Host "  openwright needs at least one agent engine." -ForegroundColor White
    while (-not ($haveClaude -or $haveCopilot -or $haveCodex)) {
      $pick = Read-Host "  Pick one to install - 1) Claude  2) Copilot  3) Codex"
      switch ($pick) {
        "1" { InstallEngine "claude" }
        "2" { InstallEngine "copilot" }
        "3" { InstallEngine "codex" }
        default { Note "enter 1, 2, or 3" }
      }
    }
  }
}

# Default engine for new workspaces - first available wins.
$defaultEngine = "claude"
if (-not $haveClaude -and $haveCopilot) { $defaultEngine = "copilot" }
elseif (-not $haveClaude -and -not $haveCopilot -and $haveCodex) { $defaultEngine = "codex" }
if (-not (Select-String -Path ".env" -Pattern "^OPENWRIGHT_AGENT=" -Quiet -ErrorAction SilentlyContinue)) {
  Add-Content ".env" "OPENWRIGHT_AGENT=$defaultEngine"
  Note "default engine: $defaultEngine (change in Settings or .env)"
}

# Auth walkthroughs.
if ($haveCopilot -and -not ($env:COPILOT_GITHUB_TOKEN -or $env:GH_TOKEN -or $env:GITHUB_TOKEN)) {
  if ((-not $Yes) -and (Ask "Log in to Copilot now (device-code flow)?" $false)) { & $(if ($copilotBin) { $copilotBin } else { "copilot" }) login }
  else { Note "copilot auth later: run 'copilot login' (or set COPILOT_GITHUB_TOKEN)" }
}
if ($haveCodex) {
  & $(if ($codexBin) { $codexBin } else { "codex" }) login status *> $null
  if ($LASTEXITCODE -ne 0) {
    if ((-not $Yes) -and (Ask "Log in to Codex now (opens browser)?" $false)) { & $(if ($codexBin) { $codexBin } else { "codex" }) login }
    else { Note "codex auth later: run 'codex login'" }
  }
}

# -- 4. summary -----------------------------------------------------
Step "Done"
if ($haveClaude)  { Ok "claude ready" }
if ($haveCopilot) { Ok "copilot installed (auth: 'copilot login')" }
if ($haveCodex)   { Ok "codex installed (auth: 'codex login status')" }
Write-Host ""
Write-Host "  Start it:   openwright start" -ForegroundColor White
Note "(if the command is not found, open a NEW terminal first - the"
Note "PATH update lands in fresh sessions)"
Note "Also: openwright stop / status / logs / open / update"
Write-Host ""
