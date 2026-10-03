#!/usr/bin/env bash
# Idempotent installer. Run from a clone with: sudo infra/install.sh
# Copies infra/ to /opt/apprentice/infra, builds the runner, installs the
# systemd units and the sudoers rule, and (re)starts runner and API.
# The deploy timer is installed but left disabled.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/apprentice/infra
UNITS=(apprentice-runner.service apprentice-api.service apprentice-deploy.service apprentice-deploy.timer)

id apprentice >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/apprentice --shell /bin/bash apprentice
install -d -o root -g root -m 755 /opt/apprentice
install -d -o apprentice -g apprentice -m 750 /var/lib/apprentice /var/lib/apprentice/db /var/lib/apprentice/media /var/lib/apprentice/runner-cwd /var/lib/apprentice/sessions
if [ ! -d /opt/apprentice/repo/.git ]; then
  install -d -o apprentice -g apprentice -m 755 /opt/apprentice/repo
  sudo -u apprentice git clone -q https://github.com/qwadratic/ai-apprentice.git /opt/apprentice/repo
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
ALLOWED_ORIGINS=
DATABASE_PATH=/var/lib/apprentice/db/apprentice.sqlite
MEDIA_DIR=/var/lib/apprentice/media
RUNNER_MODEL=claude-sonnet-5-5
RUNNER_CONCURRENCY=2
DEPLOY_REF=main
DEBUG_ENDPOINTS=
EOF
  )
fi
for v in ELEVENLABS_AGENT_ID_INTERVIEWER ELEVENLABS_AGENT_ID_TUTOR; do
  grep -q "^$v=" /etc/apprentice/env || echo "$v=" >> /etc/apprentice/env
done
chown root:root /etc/apprentice/env
chmod 600 /etc/apprentice/env

# Copy infra/ (without build output) and build the runner in place.
install -d -o root -g root -m 755 "$DEST"
rsync -a --delete --exclude node_modules --exclude dist "$SRC"/ "$DEST"/
sha="$(git -C "$SRC" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$SRC" status --porcelain -- . 2>/dev/null)" ]; then sha="$sha-dirty"; fi
echo "$sha" > "$DEST/GIT_SHA"
chown -R root:root "$DEST"
chmod 755 "$DEST/start-api.sh" "$DEST/deploy/deploy.sh" "$DEST/install.sh"
( cd "$DEST/claude-runner" && npm ci --include=optional --no-fund --no-audit --loglevel=error && npm run -s build )

# Units and sudoers.
for u in "${UNITS[@]}"; do install -m 644 "$DEST/systemd/$u" /etc/systemd/system/"$u"; done
visudo -cqf "$DEST/systemd/apprentice-sudoers"
install -m 440 -o root -g root "$DEST/systemd/apprentice-sudoers" /etc/sudoers.d/apprentice
systemctl daemon-reload
systemctl enable --quiet apprentice-runner.service apprentice-api.service
systemctl restart apprentice-runner.service apprentice-api.service
echo "installed infra $sha; deploy timer: $(systemctl is-enabled apprentice-deploy.timer 2>/dev/null || true)"
