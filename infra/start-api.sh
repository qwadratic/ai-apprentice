#!/usr/bin/env bash
# Starts the public API on PORT (default 8000) from the deployed checkout: the
# real apps/api (Express, TypeScript run with Node's type stripping, Node >= 22.18,
# no build output) once its sources and the root install are there, otherwise the
# dependency-free placeholder as a fallback. Needs HOST, PORT, RUNNER_URL, GIT_SHA
# and, from /etc/apprentice/env, ALLOWED_ORIGINS, RUNNER_TOKEN, ELEVENLABS_*, API_TOKEN.
set -euo pipefail
REPO=/opt/apprentice/repo
export HOST="${HOST:-0.0.0.0}" PORT="${PORT:-8000}"
export RUNNER_URL="${RUNNER_URL:-http://127.0.0.1:8787}"
GIT_SHA="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
export GIT_SHA
if [ -f "$REPO/apps/api/src/modules.ts" ] && [ -d "$REPO/node_modules/express" ]; then
  cd "$REPO/apps/api"
  exec node server.ts
fi
cd "$REPO/infra/placeholder-api"
exec node server.ts
