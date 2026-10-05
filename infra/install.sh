#!/usr/bin/env bash
# Idempotent installer for what needs root. Run from a clone: sudo infra/install.sh
# Installs the systemd units, the sudoers rule and the deploy script
# (/opt/apprentice/bin/apprentice-deploy). The services themselves run from the
# deployed checkout /opt/apprentice/repo, which deploy.sh moves; on the first
# install that checkout is set to the commit this installer comes from.
# Then it builds the checkout and (re)starts runner, API and the deploy webhook
# (ops) and arms the path unit that turns webhook requests into deploys. The
# deploy timer is installed but its enabled/disabled state is left as it is.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
CLONE_SHA="$(git -C "$SRC" rev-parse HEAD)"
REPO=/opt/apprentice/repo
as_app() { sudo -u apprentice -H "$@"; }
UNITS=(apprentice-runner.service apprentice-api.service apprentice-ops.service apprentice-deploy.service apprentice-deploy.timer apprentice-deploy-request.service apprentice-deploy-request.path)

id apprentice >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/apprentice --shell /bin/bash apprentice
install -d -o root -g root -m 755 /opt/apprentice
install -d -o apprentice -g apprentice -m 750 /var/lib/apprentice /var/lib/apprentice/db /var/lib/apprentice/media /var/lib/apprentice/runner-cwd /var/lib/apprentice/sessions
if [ ! -d /opt/apprentice/repo/.git ]; then
  install -d -o apprentice -g apprentice -m 755 /opt/apprentice/repo
  sudo -u apprentice git clone -q https://github.com/qwadratic/clipa.git /opt/apprentice/repo
fi
install -d -o root -g root -m 700 /etc/apprentice
if [ ! -f /etc/apprentice/env ]; then
  # umask only for this file; the rest of the install (dist/) must stay readable.
  ( umask 077
  cat > /etc/apprentice/env <<EOF
# Secrets for apprentice services. root:root 0600. Edit with: sudoedit /etc/apprentice/env
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID_INTERVIEWER=
ELEVENLABS_AGENT_ID_TUTOR=
# Exactly ONE of the next two. The OAuth token is for private development only.
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=
RUNNER_TOKEN=$(openssl rand -hex 32)
API_TOKEN=$(openssl rand -hex 32)
DEPLOY_WEBHOOK_SECRET=$(openssl rand -hex 32)
ALLOWED_ORIGINS=
DATABASE_PATH=/var/lib/apprentice/db/apprentice.sqlite
MEDIA_DIR=/var/lib/apprentice/media
RUNNER_MODEL=claude-sonnet-5-5
RUNNER_CONCURRENCY=2
DEPLOY_SOURCE=pages
DEPLOY_REF=main
DEPLOY_BRANCH=main
DEBUG_ENDPOINTS=
EOF
  )
fi
for v in ELEVENLABS_AGENT_ID_INTERVIEWER ELEVENLABS_AGENT_ID_TUTOR DEPLOY_WEBHOOK_SECRET; do
  grep -q "^$v=" /etc/apprentice/env || echo "$v=" >> /etc/apprentice/env
done
chown root:root /etc/apprentice/env
chmod 600 /etc/apprentice/env

# Deploy script, units and sudoers (the parts deploy.sh never changes).
install -d -o root -g root -m 755 /opt/apprentice/bin
install -m 755 -o root -g root "$SRC/deploy/deploy.sh" /opt/apprentice/bin/apprentice-deploy
for u in "${UNITS[@]}"; do install -m 644 "$SRC/systemd/$u" /etc/systemd/system/"$u"; done
visudo -cqf "$SRC/systemd/apprentice-sudoers"
install -m 440 -o root -g root "$SRC/systemd/apprentice-sudoers" /etc/sudoers.d/apprentice
if [ -n "$(git -C "$SRC" status --porcelain -- . 2>/dev/null)" ]; then
  echo "note: infra/ in this clone has uncommitted changes; units and deploy script were installed from them"
fi

# The deployed checkout. The first time it runs services, start it at this
# installer's commit; after that deploy.sh owns it.
as_app git -C "$REPO" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
if [ ! -f "$REPO/infra/start-runner.sh" ]; then
  as_app git -C "$REPO" cat-file -e "$CLONE_SHA^{commit}" 2>/dev/null ||
    { echo "commit ${CLONE_SHA:0:12} is not on GitHub yet; push it, then rerun" >&2; exit 1; }
  as_app git -C "$REPO" checkout -q --detach --force "$CLONE_SHA"
  echo "$CLONE_SHA" > /var/lib/apprentice/deployed-sha
  chown apprentice:apprentice /var/lib/apprentice/deployed-sha
  echo "deployed checkout set to ${CLONE_SHA:0:12}"
fi
as_app /opt/apprentice/bin/apprentice-deploy --build-only

systemctl daemon-reload
systemctl enable --quiet apprentice-runner.service apprentice-api.service apprentice-ops.service apprentice-deploy-request.path
systemctl restart apprentice-runner.service apprentice-api.service apprentice-ops.service
systemctl start apprentice-deploy-request.path
# Before this layout, infra/ was copied to /opt/apprentice/infra.
rm -rf /opt/apprentice/infra
echo "installed from ${CLONE_SHA:0:12}; serving $(as_app git -C "$REPO" rev-parse --short=12 HEAD); deploy timer: $(systemctl is-enabled apprentice-deploy.timer 2>/dev/null || true)"
