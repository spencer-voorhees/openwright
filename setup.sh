#!/usr/bin/env bash
# openpod setup — interactive, idempotent, zero-prerequisite.
#
#   bash setup.sh        guided setup (asks before each optional piece)
#   bash setup.sh -y     non-interactive: install everything it can
#
# Nothing here needs to be preinstalled: bun and uv ship their own
# installers, python comes from uv, and the agent CLIs install through
# bun's global shims (no node required).
set -euo pipefail
cd "$(dirname "$0")"

YES=0
[ "${1:-}" = "-y" ] || [ "${OPENPOD_INSTALL_AGENTS:-}" = "1" ] && YES=1

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
step()  { printf '\n\033[1;38;5;208m● %s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
note()  { printf '  \033[2m%s\033[0m\n' "$1"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ask "Question?" default(y|n) → 0=yes
ask() {
  local q="$1" def="${2:-y}" reply
  if [ "$YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then [ "$def" = "y" ]; return; fi
  if [ "$def" = "y" ]; then printf '  %s [Y/n] ' "$q"; else printf '  %s [y/N] ' "$q"; fi
  read -r reply || reply=""
  case "$reply" in
    "") [ "$def" = "y" ] ;;
    y|Y|yes|YES) true ;;
    *) false ;;
  esac
}

printf '\n'
bold "  openpod setup"
note "Bring-your-own-agent deck workspace. This wizard installs only"
note "what's missing and never touches anything outside this repo,"
note "~/.bun, and ~/.local."

# ── 1. bun (runtime — required) ──────────────────────────────────
step "Runtime: bun"
export PATH="$HOME/.bun/bin:$PATH"
if have bun; then
  ok "bun $(bun --version)"
else
  note "bun is the only hard requirement — installing from bun.sh"
  curl -fsSL https://bun.sh/install | bash
  ok "bun $(bun --version)"
fi

step "JS dependencies"
bun install --silent
ok "installed"

# ── 2. python toolchain via uv (exports — recommended) ──────────
step "Exporters: PDF + editable PPTX (python)"
PYBIN=""
if [ -x ".venv/bin/python" ]; then
  PYBIN=".venv/bin/python"
  ok "repo venv already present"
elif ask "Install an isolated Python toolchain for exports (via uv)?" y; then
  if ! have uv; then
    note "installing uv (astral.sh) — single static binary, manages its own python"
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    export PATH="$HOME/.local/bin:$PATH"
  fi
  uv venv -q --python 3.12 .venv
  uv pip install -q -r requirements.txt --python .venv/bin/python
  PYBIN=".venv/bin/python"
  ok "python $(.venv/bin/python -V 2>&1 | cut -d' ' -f2) in .venv"
else
  note "skipped — decks still preview live; PDF/PPTX export will be unavailable"
fi
if [ -n "$PYBIN" ]; then
  note "fetching chromium for the exporters (one-time, ~120 MB)"
  "$PYBIN" -m playwright install chromium >/dev/null 2>&1 || "$PYBIN" -m playwright install chromium
  ok "chromium ready"
fi

# ── 3. env file ──────────────────────────────────────────────────
[ -f .env ] || cp .env.example .env

# ── 4. agent engines ─────────────────────────────────────────────
# CLI installs go through bun's global shims, so node/npm are not
# required. Each engine is optional — one working engine is enough.
step "Agent engines (need at least one)"

if have claude || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -f "$HOME/.claude/.credentials.json" ]; then
  ok "claude — available"
elif ask "Install Claude Code (for the Claude engine)?" n; then
  bun add -g @anthropic-ai/claude-code >/dev/null
  ok "claude installed — run 'claude' once to log in"
else
  note "claude: skipped — set ANTHROPIC_API_KEY in .env, or install later"
fi

if have copilot; then
  ok "copilot — $(copilot --version 2>/dev/null | head -1)"
elif ask "Install GitHub Copilot CLI?" n; then
  bun add -g @github/copilot >/dev/null
  ok "copilot installed"
else
  note "copilot: skipped"
fi
if have copilot && ! [ -n "${COPILOT_GITHUB_TOKEN:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  if [ "$YES" = "0" ] && ask "Log in to Copilot now (opens a device-code flow)?" n; then
    copilot login || note "login did not complete — run 'copilot login' later"
  else
    note "auth later: run 'copilot login' (or set COPILOT_GITHUB_TOKEN)"
  fi
fi

if have codex; then
  ok "codex — $(codex --version 2>/dev/null)"
elif ask "Install OpenAI Codex CLI?" n; then
  bun add -g @openai/codex >/dev/null
  ok "codex installed"
else
  note "codex: skipped"
fi
if have codex && ! codex login status >/dev/null 2>&1; then
  if [ "$YES" = "0" ] && ask "Log in to Codex now (opens browser)?" n; then
    codex login || note "login did not complete — run 'codex login' later"
  else
    note "auth later: run 'codex login'"
  fi
fi

# ── 5. summary ───────────────────────────────────────────────────
step "Done"
ANY=0
have claude  && { ok "claude ready";  ANY=1; } || true
[ -n "${ANTHROPIC_API_KEY:-}" ] && { ok "claude ready (API key)"; ANY=1; } || true
have copilot && { ok "copilot installed (check auth with 'copilot login')"; ANY=1; } || true
have codex   && { ok "codex installed (check auth with 'codex login status')"; ANY=1; } || true
[ "$ANY" = "1" ] || note "WARNING: no engine installed yet — openpod will start but can't generate"
printf '\n'
bold "  Start it:   bun start"
note "http://localhost:8090 — the db and the Oneshot design system"
note "seed themselves on first boot. Engine + model are picked per"
note "workspace; defaults live in Settings (gear in the left rail)."
printf '\n'
