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

# Locate a CLI the way the server does: PATH first, then the bins the
# setup shell often misses (bun shims, ~/.local, npm global prefix).
find_bin() {
  local name="$1" d p
  command -v "$name" 2>/dev/null && return 0
  for d in "$HOME/.bun/bin" "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    [ -x "$d/$name" ] && { echo "$d/$name"; return 0; }
  done
  if have npm; then
    p="$(npm prefix -g 2>/dev/null || true)"
    [ -n "$p" ] && [ -x "$p/bin/$name" ] && { echo "$p/bin/$name"; return 0; }
  fi
  return 1
}

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
# required. At least one engine is mandatory — openpod can't generate
# without one.
step "Agent engines (at least one required)"

CLAUDE_BIN="$(find_bin claude || true)"
COPILOT_BIN="$(find_bin copilot || true)"
CODEX_BIN="$(find_bin codex || true)"
HAVE_CLAUDE=0; HAVE_COPILOT=0; HAVE_CODEX=0
{ [ -n "$CLAUDE_BIN" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -f "$HOME/.claude/.credentials.json" ]; } && HAVE_CLAUDE=1
[ -n "$COPILOT_BIN" ] && HAVE_COPILOT=1
[ -n "$CODEX_BIN" ]   && HAVE_CODEX=1

[ "$HAVE_CLAUDE" = "1" ]  && ok "detected: claude $([ -n "$CLAUDE_BIN" ] && echo "($CLAUDE_BIN)" || echo "(API key)")"
[ "$HAVE_COPILOT" = "1" ] && ok "detected: copilot ($COPILOT_BIN)"
[ "$HAVE_CODEX" = "1" ]   && ok "detected: codex ($CODEX_BIN)"
[ "$HAVE_CLAUDE$HAVE_COPILOT$HAVE_CODEX" = "000" ] && note "no compatible agent CLI found on this machine"

install_engine() {
  case "$1" in
    claude)  bun add -g @anthropic-ai/claude-code >/dev/null && HAVE_CLAUDE=1  && ok "claude installed — run 'claude' once to log in" ;;
    copilot) bun add -g @github/copilot >/dev/null           && HAVE_COPILOT=1 && ok "copilot installed" ;;
    codex)   bun add -g @openai/codex >/dev/null             && HAVE_CODEX=1   && ok "codex installed" ;;
  esac
}

# Offer the missing ones (optional while at least one exists).
[ "$HAVE_CLAUDE" = "0" ]  && ask "Install Claude Code?" n          && install_engine claude  || true
[ "$HAVE_COPILOT" = "0" ] && ask "Install GitHub Copilot CLI?" n   && install_engine copilot || true
[ "$HAVE_CODEX" = "0" ]   && ask "Install OpenAI Codex CLI?" n     && install_engine codex   || true

# Enforce the minimum: if still nothing, the wizard requires a pick.
if [ "$HAVE_CLAUDE$HAVE_COPILOT$HAVE_CODEX" = "000" ]; then
  if [ "$YES" = "1" ] || [ ! -t 0 ]; then
    note "installing Claude Code as the default engine"
    install_engine claude
  else
    bold "  openpod needs at least one agent engine."
    while [ "$HAVE_CLAUDE$HAVE_COPILOT$HAVE_CODEX" = "000" ]; do
      printf '  Pick one to install — 1) Claude  2) Copilot  3) Codex : '
      read -r pick || pick=1
      case "$pick" in
        1) install_engine claude ;;
        2) install_engine copilot ;;
        3) install_engine codex ;;
        *) note "enter 1, 2, or 3" ;;
      esac
    done
  fi
fi

# Default engine for new workspaces — first available wins; the app's
# Settings page can change it any time.
DEFAULT_ENGINE="claude"
[ "$HAVE_CLAUDE" = "0" ] && [ "$HAVE_COPILOT" = "1" ] && DEFAULT_ENGINE="copilot"
[ "$HAVE_CLAUDE" = "0" ] && [ "$HAVE_COPILOT" = "0" ] && [ "$HAVE_CODEX" = "1" ] && DEFAULT_ENGINE="codex"
if ! grep -q '^OPENPOD_AGENT=' .env 2>/dev/null; then
  printf 'OPENPOD_AGENT=%s\n' "$DEFAULT_ENGINE" >> .env
  note "default engine: $DEFAULT_ENGINE (change in Settings or .env)"
fi

# Auth walkthroughs for engines that are installed but not logged in.
if [ "$HAVE_COPILOT" = "1" ] && [ -z "${COPILOT_GITHUB_TOKEN:-}${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  if [ "$YES" = "0" ] && ask "Log in to Copilot now (opens a device-code flow)?" n; then
    "${COPILOT_BIN:-copilot}" login || note "login did not complete — run 'copilot login' later"
  else
    note "copilot auth later: run 'copilot login' (or set COPILOT_GITHUB_TOKEN)"
  fi
fi
if [ "$HAVE_CODEX" = "1" ] && ! "${CODEX_BIN:-codex}" login status >/dev/null 2>&1; then
  if [ "$YES" = "0" ] && ask "Log in to Codex now (opens browser)?" n; then
    "${CODEX_BIN:-codex}" login || note "login did not complete — run 'codex login' later"
  else
    note "codex auth later: run 'codex login'"
  fi
fi

# ── 5. summary ───────────────────────────────────────────────────
step "Done"
[ "$HAVE_CLAUDE" = "1" ]  && ok "claude ready"
[ "$HAVE_COPILOT" = "1" ] && ok "copilot installed (auth: 'copilot login')"
[ "$HAVE_CODEX" = "1" ]   && ok "codex installed (auth: 'codex login status')"
printf '\n'
bold "  Start it:   bun start"
note "http://localhost:8090 — the db and the Oneshot design system"
note "seed themselves on first boot. Engine + model are picked per"
note "workspace; defaults live in Settings (gear in the left rail)."
printf '\n'
