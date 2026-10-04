#!/usr/bin/env bash
# Deploys one commit into /opt/apprentice/repo, the checkout the services run
# from (runner, API, ops). Installed by infra/install.sh as
# /opt/apprentice/bin/apprentice-deploy and run as user apprentice:
#   apprentice-deploy-request.service (started by the .path unit when the
#     webhook writes deploy-request.json):  apprentice-deploy --request
#   apprentice-deploy.service (manual, or the optional timer):  apprentice-deploy
#   sudo systemctl start apprentice-deploy.service   # manual deploy; reads /etc/apprentice/env
#   sudo -u apprentice /opt/apprentice/bin/apprentice-deploy [--force | --build-only | --request]
#
# Which commit:
#   --request        the sha in /var/lib/apprentice/deploy-request.json, written by
#                    POST /ops/deploy (infra/ops) after checking its HMAC signature.
#   DEPLOY_SOURCE=pages (default)  the sha in $DEPLOY_JSON_URL, published by release.yml.
#   DEPLOY_SOURCE=ref              origin/$DEPLOY_REF (default main), for manual use.
# A requested or published sha must be 40 hex characters and an ancestor of
# origin/main; otherwise nothing happens (no fallback to main).
#
# Builds and restarts only what changed between the last deployed commit
# (/var/lib/apprentice/deployed-sha) and the new one, health-checks (/health
# and /ops/deploy/status through port 8000), and on failure checks the last
# deployed commit out again and exits 1. A sha that failed is skipped by manual
# and timer runs until a new one comes or --force is given; a signed webhook
# request for it is an explicit retry. Every install or build step has a
# 10 min timeout. Progress goes to /var/lib/apprentice/deploy-status.json
# (GET /ops/deploy/status).
# systemd units, sudoers, install.sh and this script are never applied here:
# when they change, the paths are logged with "run sudo infra/install.sh".
# --force rebuilds and restarts everything; --build-only builds the current
# checkout without restarting (used by install.sh).
set -euo pipefail

DEPLOY_SOURCE="${DEPLOY_SOURCE:-pages}"
DEPLOY_REF="${DEPLOY_REF:-main}"
DEPLOY_JSON_URL="${DEPLOY_JSON_URL:-https://qwadratic.github.io/ai-apprentice/deploy.json}"
# Keep only what deploy needs; never hand secrets to install or build scripts.
for v in ELEVENLABS_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY RUNNER_TOKEN API_TOKEN DEPLOY_WEBHOOK_SECRET; do unset "$v"; done
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
# A stalled git transfer fails instead of hanging the deploy.
export GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=30
STEP_TIMEOUT=600 # seconds for each install or build step

REPO=/opt/apprentice/repo
STATE=/var/lib/apprentice
FAILED_FILE="$STATE/deploy.failed-sha"
DEPLOYED_FILE="$STATE/deployed-sha"
REQUEST_FILE="$STATE/deploy-request.json"
STATUS_FILE="$STATE/deploy-status.json"
HEALTH="${DEPLOY_HEALTH_URL:-http://127.0.0.1:8000/health}"
OPS_STATUS="${DEPLOY_OPS_STATUS_URL:-http://127.0.0.1:8000/ops/deploy/status}"

FORCE=0
MODE=deploy
case "${1:-}" in
  --force) FORCE=1 ;;
  --build-only) MODE=build ;;
  --request) DEPLOY_SOURCE=request ;;
  "") ;;
  *) echo "usage: $0 [--force | --build-only | --request]" >&2; exit 2 ;;
esac

exec 9>"$STATE/deploy.lock"
if [ "$DEPLOY_SOURCE" = request ]; then
  # A webhook request waits for a running deploy instead of being dropped.
  flock -w 900 9 || { echo "deploy: waited 15 min for the deploy lock; giving up"; exit 1; }
else
  flock -n 9 || { echo "deploy: another deploy is running"; exit 0; }
fi

cd "$REPO"
log() { echo "deploy: $*"; }

# What each service is built from; a change there rebuilds and restarts it.
RUNNER_PATHS=(infra/claude-runner infra/start-runner.sh)
API_PATHS=(apps packages infra/placeholder-api infra/start-api.sh package.json pnpm-lock.yaml package-lock.json pnpm-workspace.yaml tsconfig.base.json)
OPS_PATHS=(infra/ops)
# Applied only by `sudo infra/install.sh`.
INSTALL_PATHS=(infra/systemd infra/install.sh infra/deploy)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
new=""
STARTED_AT=""
write_status() { # state message [finished]
  local tmp="$STATUS_FILE.$$.tmp"
  jq -n --arg sha "$new" --arg state "$1" --arg message "$2" --arg source "$DEPLOY_SOURCE" \
    --arg started "$STARTED_AT" --arg finished "${3:-}" \
    '{sha: $sha, state: $state, source: $source,
      started_at: (if $started == "" then null else $started end),
      finished_at: (if $finished == "" then null else $finished end),
      message: $message}' > "$tmp" && mv "$tmp" "$STATUS_FILE"
}

changed() { # from to paths...
  local from=$1 to=$2
  shift 2
  ! git diff --quiet "$from" "$to" -- "$@"
}

checkout() {
  # The checkout holds no data (that lives in /var/lib/apprentice). Untracked and
  # ignored files go, except dependency dirs and build output, which are kept
  # until their sources change and they are rebuilt.
  git checkout -q --detach --force "$1" &&
    git clean -qfdx -e node_modules -e /infra/claude-runner/dist -e /apps/api/dist
}

# set -e is inactive inside `if`, `||` and `&&`, so every step returns explicitly.
build_runner() {
  [ -f infra/claude-runner/package.json ] || return 0
  log "building infra/claude-runner (npm ci + tsc)"
  (cd infra/claude-runner && timeout $STEP_TIMEOUT npm ci --include=optional --no-fund --no-audit --loglevel=error &&
    timeout $STEP_TIMEOUT npm run -s build) || return 1
}

build_api() {
  local pm=npm
  rm -rf apps/api/dist # kept by git clean; rebuilt here or gone
  if [ -f pnpm-lock.yaml ]; then
    log "pnpm install --frozen-lockfile"
    timeout $STEP_TIMEOUT pnpm install --frozen-lockfile || return 1
    pm=pnpm
  elif [ -f package-lock.json ]; then
    log "npm ci"
    timeout $STEP_TIMEOUT npm ci --no-fund --no-audit || return 1
  fi
  if [ -f apps/api/package.json ] && jq -e '.scripts.build' apps/api/package.json >/dev/null; then
    log "building apps/api with $pm"
    (cd apps/api && timeout $STEP_TIMEOUT "$pm" run build) || return 1
  fi
  # The placeholder and ops run on Node's type stripping; they need an install
  # only if they ever get runtime dependencies.
  local p
  for p in infra/placeholder-api infra/ops; do
    if [ -f $p/package.json ] && jq -e '(.dependencies // {}) | length > 0' $p/package.json >/dev/null; then
      log "installing $p runtime dependencies"
      (cd $p && timeout $STEP_TIMEOUT npm ci --omit=dev --no-fund --no-audit --loglevel=error) || return 1
    fi
  done
  return 0
}

RESTART_RUNNER=0
RESTART_API=0
RESTART_OPS=0
FULL=$FORCE # rebuild and restart everything
build_changed() { # from to; decides what to rebuild and restart
  local from=$1 to=$2
  RESTART_RUNNER=0
  RESTART_API=0
  RESTART_OPS=0
  if [ $FULL = 1 ] || changed "$from" "$to" "${RUNNER_PATHS[@]}" || [ ! -f infra/claude-runner/dist/server.js ]; then RESTART_RUNNER=1; fi
  if [ $FULL = 1 ] || changed "$from" "$to" "${API_PATHS[@]}"; then RESTART_API=1; fi
  if [ $FULL = 1 ] || changed "$from" "$to" "${OPS_PATHS[@]}"; then RESTART_OPS=1; fi
  if [ $RESTART_RUNNER = 1 ]; then build_runner || return 1; fi
  if [ $RESTART_API = 1 ] || [ $RESTART_OPS = 1 ]; then build_api || return 1; fi
  return 0
}

restart() {
  local u
  for u in runner api ops; do
    local var="RESTART_${u^^}"
    if [ "${!var}" = 1 ]; then
      log "restarting apprentice-$u"
      sudo -n /usr/bin/systemctl restart "apprentice-$u.service" || return 1
    fi
  done
  return 0
}

healthy() {
  local deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS -m 3 "$HEALTH" 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1 &&
      curl -fsS -m 3 -o /dev/null "$OPS_STATUS" 2>/dev/null; then
      return 0
    fi
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

# Sets $new to the commit to deploy; returns 1 when there is nothing to do.
select_sha() {
  case "$DEPLOY_SOURCE" in
    request)
      if [ ! -f "$REQUEST_FILE" ]; then
        log "no deploy request; nothing to do"
        return 1
      fi
      new="$(jq -r '.sha // empty' "$REQUEST_FILE" 2>/dev/null || true)"
      ;;
    pages)
      local json
      if ! json="$(curl -fsS --max-time 10 "$DEPLOY_JSON_URL" 2>/dev/null)"; then
        log "deploy.json missing at $DEPLOY_JSON_URL; nothing to do"
        return 1
      fi
      new="$(jq -r '.sha // empty' <<<"$json" 2>/dev/null || true)"
      ;;
    ref)
      git fetch -q origin "$DEPLOY_REF" || return 1
      new="$(git rev-parse "origin/$DEPLOY_REF")"
      return 0
      ;;
    *)
      log "unknown DEPLOY_SOURCE=$DEPLOY_SOURCE (pages, ref or request)"
      return 1
      ;;
  esac
  if ! [[ "$new" =~ ^[0-9a-f]{40}$ ]]; then
    log "$DEPLOY_SOURCE: no valid 40-hex sha; nothing to do"
    [ "$DEPLOY_SOURCE" = request ] && STARTED_AT="$(now)" && write_status failed "request has no valid sha" "$(now)"
    return 1
  fi
  git fetch -q origin main || log "git fetch failed; checking against the known origin/main"
  if ! git merge-base --is-ancestor "$new" origin/main 2>/dev/null; then
    log "sha ${new:0:12} is not on origin/main; nothing to do"
    [ "$DEPLOY_SOURCE" = request ] && STARTED_AT="$(now)" && write_status failed "sha is not on origin/main" "$(now)"
    return 1
  fi
  return 0
}

# One deploy of $new. Returns 0 when deployed or nothing to do, 1 on failure.
deploy_once() {
  local old head deployed manual
  # The base is the last sha that passed its health check, not HEAD: an
  # interrupted deploy leaves HEAD on an unproven commit.
  head="$(git rev-parse HEAD)"
  deployed="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"
  if [[ "$deployed" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$deployed^{commit}" 2>/dev/null; then old="$deployed"; else old="$head"; fi
  FULL=$FORCE
  STARTED_AT="$(now)"
  if [ "$old" = "$new" ] && [ "$head" = "$new" ] && [ $FORCE = 0 ]; then
    [ "$DEPLOY_SOURCE" = request ] && write_status ok "already deployed" "$(now)"
    return 0
  fi
  if [ "$head" != "$old" ]; then
    log "checkout is at ${head:0:12}, last deployed ${old:0:12}: full rebuild"
    FULL=1
  fi
  # A signed webhook request is an explicit retry of a failed sha.
  if [ $FORCE = 0 ] && [ "$DEPLOY_SOURCE" != request ] && [ "$(cat "$FAILED_FILE" 2>/dev/null)" = "$new" ]; then
    return 0
  fi
  log "deploying ($DEPLOY_SOURCE) ${old:0:12} -> ${new:0:12}"
  write_status running "deploying from ${old:0:12}"
  manual="$(git diff --name-only "$old" "$new" -- "${INSTALL_PATHS[@]}" | tr '\n' ' ')"
  if [ -n "$manual" ]; then
    log "not applied, run sudo infra/install.sh from a clone at ${new:0:12}: $manual"
  fi
  if ! checkout "$new"; then
    log "checkout of ${new:0:12} failed"
    write_status failed "checkout failed" "$(now)"
    return 1
  fi

  if build_changed "$old" "$new" && restart && healthy; then
    rm -f "$FAILED_FILE"
    echo "$new" > "$DEPLOYED_FILE"
    log "ok ${new:0:12} (runner restarted: $RESTART_RUNNER, api restarted: $RESTART_API, ops restarted: $RESTART_OPS)"
    write_status ok "deployed${manual:+; run sudo infra/install.sh for: $manual}" "$(now)"
    return 0
  fi

  log "FAILED at ${new:0:12}, rolling back to ${old:0:12}"
  echo "$new" > "$FAILED_FILE"
  checkout "$old" || log "rollback checkout failed"
  build_changed "$new" "$old" || log "rollback build failed"
  restart || true
  if healthy; then
    log "rolled back to ${old:0:12}"
    write_status rolled_back "build, restart or health check failed; rolled back to ${old:0:12}" "$(now)"
  else
    log "rollback unhealthy"
    write_status failed "deploy failed and the rollback to ${old:0:12} is unhealthy" "$(now)"
  fi
  return 1
}

rc=0
if [ "$DEPLOY_SOURCE" = request ]; then
  # A request that arrives while a deploy runs does not start a second one
  # (systemd merges the start), so look again after each deploy.
  for _ in 1 2 3; do
    select_sha || break
    handled="$new"
    deploy_once || rc=1
    next="$(jq -r '.sha // empty' "$REQUEST_FILE" 2>/dev/null || true)"
    [ "$next" = "$handled" ] && break
  done
else
  if select_sha; then deploy_once || rc=1; fi
fi
exit $rc
