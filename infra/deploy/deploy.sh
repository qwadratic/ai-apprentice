#!/usr/bin/env bash
# Deploys one commit into /opt/apprentice/repo, the checkout the services run
# from (runner, API). Installed by infra/install.sh as
# /opt/apprentice/bin/apprentice-deploy and run as user apprentice by
# apprentice-deploy.service (timer: every minute):
#   sudo systemctl start apprentice-deploy.service   # manual deploy; reads /etc/apprentice/env
#   sudo -u apprentice /opt/apprentice/bin/apprentice-deploy [--force | --build-only]
#
# Which commit (DEPLOY_SOURCE):
#   pages (default)  the sha in $DEPLOY_JSON_URL, published by release.yml. It must
#                    be 40 hex characters and an ancestor of origin/main; if the file
#                    is missing or invalid, nothing happens (no fallback to main).
#   ref              origin/$DEPLOY_REF (default main), for manual use.
#
# Builds and restarts only what changed between the old and the new commit,
# health-checks, and on failure checks the old commit out again and exits 1.
# A sha that failed is skipped until a new one is published or --force is given.
# systemd units, sudoers, install.sh and this script are never applied here:
# when they change, the paths are logged with "run sudo infra/install.sh".
# --force rebuilds and restarts everything; --build-only builds the current
# checkout without restarting (used by install.sh).
set -euo pipefail

DEPLOY_SOURCE="${DEPLOY_SOURCE:-pages}"
DEPLOY_REF="${DEPLOY_REF:-main}"
DEPLOY_JSON_URL="${DEPLOY_JSON_URL:-https://qwadratic.github.io/ai-apprentice/deploy.json}"
# Keep only what deploy needs; never hand secrets to install or build scripts.
for v in ELEVENLABS_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY RUNNER_TOKEN API_TOKEN; do unset "$v"; done
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1

REPO=/opt/apprentice/repo
STATE=/var/lib/apprentice
FAILED_FILE="$STATE/deploy.failed-sha"
DEPLOYED_FILE="$STATE/deployed-sha"
HEALTH="${DEPLOY_HEALTH_URL:-http://127.0.0.1:8000/health}"

FORCE=0
MODE=deploy
case "${1:-}" in
  --force) FORCE=1 ;;
  --build-only) MODE=build ;;
  "") ;;
  *) echo "usage: $0 [--force | --build-only]" >&2; exit 2 ;;
esac

exec 9>"$STATE/deploy.lock"
flock -n 9 || { echo "deploy: another deploy is running"; exit 0; }

cd "$REPO"
log() { echo "deploy: $*"; }

# What each service is built from; a change there rebuilds and restarts it.
RUNNER_PATHS=(infra/claude-runner infra/start-runner.sh)
API_PATHS=(apps packages infra/placeholder-api infra/start-api.sh package.json pnpm-lock.yaml package-lock.json pnpm-workspace.yaml tsconfig.base.json)
# Applied only by `sudo infra/install.sh`.
INSTALL_PATHS=(infra/systemd infra/install.sh infra/deploy)

changed() { # from to paths...
  local from=$1 to=$2
  shift 2
  ! git diff --quiet "$from" "$to" -- "$@"
}

checkout() {
  # The checkout holds no data (that lives in /var/lib/apprentice). Untracked and
  # ignored files go, except dependency and build dirs that are rebuilt when
  # their sources change.
  git checkout -q --detach --force "$1" &&
    git clean -qfdx -e /node_modules -e /infra/claude-runner/node_modules -e /infra/claude-runner/dist
}

# set -e is inactive inside `if` and `&&` chains, so every step returns explicitly.
build_runner() {
  [ -f infra/claude-runner/package.json ] || return 0
  log "building infra/claude-runner (npm ci + tsc)"
  (cd infra/claude-runner && npm ci --include=optional --no-fund --no-audit --loglevel=error && npm run -s build) || return 1
}

build_api() {
  local pm=npm
  if [ -f pnpm-lock.yaml ]; then
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile || return 1
    pm=pnpm
  elif [ -f package-lock.json ]; then
    log "npm ci"
    npm ci --no-fund --no-audit || return 1
  fi
  if [ -f apps/api/package.json ] && jq -e '.scripts.build' apps/api/package.json >/dev/null; then
    log "building apps/api with $pm"
    (cd apps/api && "$pm" run build) || return 1
  fi
  # The placeholder runs on Node's type stripping; it needs an install only if
  # it ever gets runtime dependencies.
  local p=infra/placeholder-api/package.json
  if [ -f $p ] && jq -e '(.dependencies // {}) | length > 0' $p >/dev/null; then
    log "installing infra/placeholder-api runtime dependencies"
    (cd infra/placeholder-api && npm ci --omit=dev --no-fund --no-audit --loglevel=error) || return 1
  fi
  return 0
}

RESTART_RUNNER=0
RESTART_API=0
build_changed() { # from to; decides what to rebuild and restart
  local from=$1 to=$2
  RESTART_RUNNER=0
  RESTART_API=0
  if [ $FORCE = 1 ] || changed "$from" "$to" "${RUNNER_PATHS[@]}" || [ ! -f infra/claude-runner/dist/server.js ]; then RESTART_RUNNER=1; fi
  if [ $FORCE = 1 ] || changed "$from" "$to" "${API_PATHS[@]}"; then RESTART_API=1; fi
  if [ $RESTART_RUNNER = 1 ]; then build_runner || return 1; fi
  if [ $RESTART_API = 1 ]; then build_api || return 1; fi
  return 0
}

restart() {
  if [ $RESTART_RUNNER = 1 ]; then
    log "restarting apprentice-runner"
    sudo -n /usr/bin/systemctl restart apprentice-runner.service || return 1
  fi
  if [ $RESTART_API = 1 ]; then
    log "restarting apprentice-api"
    sudo -n /usr/bin/systemctl restart apprentice-api.service || return 1
  fi
  return 0
}

healthy() {
  local deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS -m 3 "$HEALTH" 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ $MODE = build ]; then
  build_runner
  build_api
  log "built $(git rev-parse --short=12 HEAD)"
  exit 0
fi

# ---- which commit -----------------------------------------------------------
case "$DEPLOY_SOURCE" in
  pages)
    if ! json="$(curl -fsS --max-time 10 "$DEPLOY_JSON_URL" 2>/dev/null)"; then
      log "deploy.json missing at $DEPLOY_JSON_URL; nothing to do"
      exit 0
    fi
    new="$(jq -r '.sha // empty' <<<"$json" 2>/dev/null || true)"
    if ! [[ "$new" =~ ^[0-9a-f]{40}$ ]]; then
      log "deploy.json invalid (no 40-hex sha); nothing to do"
      exit 0
    fi
    git fetch -q origin main
    if ! git merge-base --is-ancestor "$new" origin/main 2>/dev/null; then
      log "deploy.json sha ${new:0:12} is not on origin/main; nothing to do"
      exit 0
    fi
    ;;
  ref)
    git fetch -q origin "$DEPLOY_REF"
    new="$(git rev-parse "origin/$DEPLOY_REF")"
    ;;
  *)
    log "unknown DEPLOY_SOURCE=$DEPLOY_SOURCE (pages or ref)"
    exit 2
    ;;
esac

old="$(git rev-parse HEAD)"
if [ "$old" = "$new" ] && [ $FORCE = 0 ]; then
  exit 0
fi
if [ $FORCE = 0 ] && [ "$(cat "$FAILED_FILE" 2>/dev/null)" = "$new" ]; then
  exit 0 # failed before; publish a fix or run with --force
fi
log "deploying ($DEPLOY_SOURCE) ${old:0:12} -> ${new:0:12}"
manual="$(git diff --name-only "$old" "$new" -- "${INSTALL_PATHS[@]}" | tr '\n' ' ')"
if [ -n "$manual" ]; then
  log "not applied, run sudo infra/install.sh from a clone at ${new:0:12}: $manual"
fi
checkout "$new"

if build_changed "$old" "$new" && restart && healthy; then
  rm -f "$FAILED_FILE"
  echo "$new" > "$DEPLOYED_FILE"
  log "ok ${new:0:12} (runner restarted: $RESTART_RUNNER, api restarted: $RESTART_API)"
  exit 0
fi

log "FAILED at ${new:0:12}, rolling back to ${old:0:12}"
echo "$new" > "$FAILED_FILE"
checkout "$old"
build_changed "$new" "$old" || log "rollback build failed"
restart || true
if healthy; then log "rolled back to ${old:0:12}"; else log "rollback unhealthy"; fi
exit 1
