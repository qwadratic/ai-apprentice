---
id: TASK-4
title: VM backend on exe.dev
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 20:54'
updated_date: '2026-10-05 08:57'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A separate exe.dev VM hosts the API for both streams: one public HTTPS port (8000), SQLite and redacted media on persistent disk (/var/lib/apprentice/{db,media}), systemd, secrets in /etc/apprentice/env (0600) outside git, deploy from main with rollback, and an internal Claude runner on 127.0.0.1:8787 behind a bearer token. The runner uses CLAUDE_CODE_OAUTH_TOKEN for private development only; Anthropic's Agent SDK terms require API-key auth for anything third parties use, so before a judge-facing URL is shared it runs on ANTHROPIC_API_KEY (env change only). Owner @qwadratic delegates the work to the Claude Code agent on the VM with the brief in doc-5; children TASK-4.1 (VM, placeholder API, deploy) and TASK-4.2 (runner). The VM agent owns only infra/ and the VM; the real API server entry belongs to A's skeleton in apps/api and is started by the deploy once it exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 https://<vm>.exe.xyz/health answers 200 without exe.dev login; CORS allows only ALLOWED_ORIGINS
- [ ] #2 SQLite and media directories survive a VM reboot and a service restart
- [ ] #3 Secrets exist only in /etc/apprentice/env (mode 0600); the repo and the logs contain none
- [ ] #4 One command redeploys main and rolls back on a failed health check
- [ ] #5 The runner returns schema-valid JSON for a text call and a screenshot call; /health shows the auth mode
- [ ] #6 Before any judge-facing URL is shared, /health shows mode=apikey
- [ ] #7 doc-1 lists infra/ under the TASK-4 owner
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
VM backend on exe.dev is live and matches the code. Verified live on 2026-10-05: GET https://apprentice.exe.xyz/health returns 200 ok:true with modules ops, agent, screen, recording and no exe.dev login; a CORS preflight from https://qwadratic.github.io gets 204 with the origin echoed, a foreign origin gets 403 (AC1 checked on this evidence). AC6 (API-key mode before a judge-facing URL) is explicitly not done, by Ivan's own decision - see TASK-4.4. AC2, AC3, AC4, AC5 and AC7 are left unchecked: plausible from infra/README.md but not re-verified here by test or reboot. Status corrected from To Do to Done to match the shipped system (issue #103). Note for Ivan: subtasks TASK-4.1 and TASK-4.2 are still To Do even though the VM and runner they describe are demonstrably running in production; left untouched since this pass was only asked to fix TASK-1, TASK-4 and TASK-6.
<!-- SECTION:FINAL_SUMMARY:END -->
