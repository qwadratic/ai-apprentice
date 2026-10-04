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
# Workspace packages ship their build output in gitignored dist/ folders. deploy.sh's
# git clean (for example on a runner-only deploy) can remove them while this service
# keeps running, so a later restart (a reboot) would crash-loop. Rebuild what is missing.
if [ -f "$REPO/packages/contracts/package.json" ] && [ ! -f "$REPO/packages/contracts/dist/index.js" ]; then
  echo "start-api: packages/contracts/dist is missing; building it" >&2
  (cd "$REPO" && timeout 300 npm run build --workspace @apprentice/contracts) >&2 ||
    echo "start-api: building @apprentice/contracts failed" >&2
fi
# A half-finished install can leave a node_modules/express folder behind, so
# require that express actually loads before choosing apps/api.
if [ -f "$REPO/apps/api/src/modules.ts" ] &&
  (cd "$REPO/apps/api" && node -e "import('express').then(() => process.exit(0), () => process.exit(1))") 2>/dev/null; then
  cd "$REPO/apps/api"
  exec node server.ts
fi
echo "start-api: apps/api is not runnable at ${GIT_SHA}; falling back to infra/placeholder-api" >&2
cd "$REPO/infra/placeholder-api"
exec node server.ts
