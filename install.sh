#!/usr/bin/env bash
# openpod one-line bootstrap (works once the repo is public):
#
#   curl -fsSL https://raw.githubusercontent.com/spencer-voorhees/openpod/main/install.sh | bash
#
# Clones (or updates) the repo into ~/openpod and hands off to the
# interactive setup wizard. Pass -y through for hands-off installs:
#   curl -fsSL .../install.sh | bash -s -- -y
set -euo pipefail

REPO_HTTPS="https://github.com/spencer-voorhees/openpod"
DIR="${OPENPOD_DIR:-$HOME/openpod}"

if [ -d "$DIR/.git" ]; then
  echo "openpod already at $DIR — updating"
  git -C "$DIR" pull --ff-only || echo "(pull skipped — local changes)"
elif command -v git >/dev/null 2>&1; then
  git clone "$REPO_HTTPS" "$DIR"
else
  # No git: fetch a tarball snapshot instead.
  echo "git not found — downloading snapshot"
  mkdir -p "$DIR"
  curl -fsSL "$REPO_HTTPS/archive/refs/heads/main.tar.gz" | tar xz -C "$DIR" --strip-components=1
fi

cd "$DIR"
exec bash setup.sh "$@"
