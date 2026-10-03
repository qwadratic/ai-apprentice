---
id: TASK-4.1
title: 'exe.dev VM: provisioning, public placeholder API, systemd and deploy'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-4
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Brief: doc-5, steps 1, 3, 4, 5 and 6. Done by the Claude Code agent on the VM; it owns only infra/ and the VM, works on branch infra/vm-backend and hands over a patch (git format-patch) that Ivan applies, unless Ivan gives it push access. Placeholder API in infra/placeholder-api on the single public port 8000 (/health, exact-origin CORS, 12 MB body cap, /runner/* test proxy behind API_TOKEN); start-api.sh runs A's apps/api build when it exists. Idempotent install.sh, systemd units, deploy.sh with rollback, a 1-minute deploy timer created disabled. The exe.dev proxy is private by default and only one port can be public: `ssh exe.dev share set-public <vm>` is required.

Estimate: about 2 h of agent time. Card key: D-vm-backend.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GET https://<vm>.exe.xyz/health returns 200 without exe.dev login; preflight from an allowed origin gets 204 with the origin echoed, a foreign origin gets no CORS header
- [ ] #2 Proxy behaviour measured and written in infra/README.md: largest POST that passes (at least 6 MB) with a recommended chunk size of at most 5 MB for A's recording upload, SSE events arriving one per second, free disk size
- [ ] #3 `sudo reboot` and `systemctl restart` keep /var/lib/apprentice; services restart after a crash
- [ ] #4 deploy.sh pulls main, installs by the lockfile the repo has, restarts, and rolls back on a failed health check; the timer exists and is disabled
- [ ] #5 A 13 MB body gets 413; /runner/* without the token gets 401
- [ ] #6 No secret appears in git, logs or command output; infra/README.md lists Ivan's manual steps and the env contract for A and B (PORT, HOST, DATABASE_PATH, MEDIA_DIR, RUNNER_URL, RUNNER_TOKEN)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
