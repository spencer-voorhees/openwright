#!/usr/bin/env bash
# openpod setup — idempotent; run from the repo root on a fresh machine.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── runtime: bun ──────────────────────────────────────────────────
say "bun"
if ! have bun; then
  echo "bun not found — installing (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
bun --version

say "js dependencies"
bun install

# ── python: exporters (PDF / editable PPTX) ──────────────────────
say "python exporters"
if have python3; then
  python3 -m pip install --user -q -r requirements.txt || \
    python3 -m pip install --user -q --break-system-packages -r requirements.txt
  python3 -m playwright install chromium
else
  echo "WARNING: python3 not found — PDF/PPTX export will be unavailable."
fi

# ── env file ─────────────────────────────────────────────────────
[ -f .env ] || cp .env.example .env

# ── agents: detect, offer installs ───────────────────────────────
say "agent engines"
FOUND=0

if have claude || [ -f "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "claude:  available (Claude Code login or ANTHROPIC_API_KEY)"
  FOUND=1
else
  echo "claude:  not set up — set ANTHROPIC_API_KEY in .env, or install Claude Code and run \`claude login\`"
fi

if have copilot; then
  echo "copilot: $(copilot --version 2>/dev/null | head -1)"
  echo "         (auth: run \`copilot\` once and /login, or set COPILOT_GITHUB_TOKEN)"
  FOUND=1
else
  if [ "${OPENPOD_INSTALL_AGENTS:-}" = "1" ] && have npm; then
    echo "copilot: installing @github/copilot..."
    npm install -g @github/copilot && FOUND=1
  else
    echo "copilot: not installed — \`npm install -g @github/copilot\` (or rerun with OPENPOD_INSTALL_AGENTS=1)"
  fi
fi

if have codex; then
  echo "codex:   $(codex --version 2>/dev/null)"
  codex login status >/dev/null 2>&1 && echo "         (logged in)" || echo "         (auth: run \`codex login\`)"
  FOUND=1
else
  if [ "${OPENPOD_INSTALL_AGENTS:-}" = "1" ] && have npm; then
    echo "codex:   installing @openai/codex..."
    npm install -g @openai/codex && FOUND=1
  else
    echo "codex:   not installed — \`npm install -g @openai/codex\` (or rerun with OPENPOD_INSTALL_AGENTS=1)"
  fi
fi

[ "$FOUND" = "1" ] || echo "WARNING: no agent engine is usable yet — set one up before generating."

say "done"
echo "Start the server:  bun start    (http://localhost:\${OPENPOD_PORT:-8090})"
echo "The database and built-in design system seed automatically on first boot."
