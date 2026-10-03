#!/usr/bin/env bash
# Starts the public API on PORT (default 8000): the real apps/api build when it
# exists in the deployed repo, otherwise the placeholder.
set -euo pipefail
REPO=/opt/apprentice/repo
INFRA=/opt/apprentice/infra
export HOST="${HOST:-0.0.0.0}" PORT="${PORT:-8000}"
export RUNNER_URL="${RUNNER_URL:-http://127.0.0.1:8787}"
GIT_SHA="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
export GIT_SHA
if [ -f "$REPO/apps/api/dist/server.js" ]; then
  cd "$REPO/apps/api"
  exec node dist/server.js
fi
exec node "$INFRA/placeholder-api/server.ts"
