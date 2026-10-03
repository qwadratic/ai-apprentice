#!/usr/bin/env bash
# Deploys origin/$DEPLOY_REF into /opt/apprentice/repo. Run as apprentice:
#   sudo -u apprentice /opt/apprentice/infra/deploy/deploy.sh [--force]
# Without --force it does nothing when the ref has not moved.
# On a failed health check it resets to the previous sha and exits 1.
set -euo pipefail

# Keep only what deploy needs; never hand secrets to install or build scripts.
DEPLOY_REF="${DEPLOY_REF:-main}"
for v in ELEVENLABS_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY RUNNER_TOKEN API_TOKEN; do unset "$v"; done
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1

REPO=/opt/apprentice/repo
HEALTH="${DEPLOY_HEALTH_URL:-http://127.0.0.1:8000/health}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

exec 9>/var/lib/apprentice/deploy.lock
flock -n 9 || { echo "deploy: another deploy is running"; exit 0; }

cd "$REPO"
log() { echo "deploy: $*"; }

install_and_build() {
  if [ -f pnpm-lock.yaml ]; then
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile || return 1
    pm=pnpm
  elif [ -f package-lock.json ]; then
    log "npm ci"
    npm ci --no-fund --no-audit || return 1
    pm=npm
  else
    log "no lockfile, skipping install"
    pm=npm
  fi
  if [ -f apps/api/package.json ] && jq -e '.scripts.build' apps/api/package.json >/dev/null; then
    log "building apps/api with $pm"
    ( cd apps/api && "$pm" run build ) || return 1
  fi
}

restart() {
  # set -e is inactive inside `if`, so every step returns explicitly.
  sudo -n /usr/bin/systemctl restart apprentice-runner.service || return 1
  sudo -n /usr/bin/systemctl restart apprentice-api.service
}

healthy() {
  local deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS -m 3 "$HEALTH" 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

old="$(git rev-parse HEAD)"
git fetch -q origin "$DEPLOY_REF"
new="$(git rev-parse "origin/$DEPLOY_REF")"
if [ "$old" = "$new" ] && [ $FORCE = 0 ]; then
  exit 0
fi
log "deploying $DEPLOY_REF ${old:0:12} -> ${new:0:12}"
git reset -q --hard "origin/$DEPLOY_REF"

if install_and_build && restart && healthy; then
  log "ok ${new:0:12}"
  exit 0
fi

log "FAILED at ${new:0:12}, rolling back to ${old:0:12}"
git reset -q --hard "$old"
install_and_build || log "rollback install/build failed"
restart || true
if healthy; then log "rolled back to ${old:0:12}"; else log "rollback unhealthy"; fi
exit 1
