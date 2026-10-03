#!/usr/bin/env bash
# Starts the Claude runner from the deployed checkout (built by deploy.sh).
set -euo pipefail
REPO=/opt/apprentice/repo
GIT_SHA="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
export GIT_SHA
cd "$REPO/infra/claude-runner"
exec node dist/server.js
