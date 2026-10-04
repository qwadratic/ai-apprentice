---
id: TASK-4.5
title: VM serves apps/api (agent and ops modules) instead of infra/placeholder-api
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
updated_date: '2026-10-04 01:16'
labels:
  - shared
  - infra
dependencies: []
parent_task_id: TASK-4
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The VM's port 8000 switches from infra/placeholder-api to A's apps/api with B's agent module (PR #19) and an infra-owned ops module that forwards /ops/* raw to 127.0.0.1:8788 (deploy health check needs it). start-api.sh runs the apps/api entry; ALLOWED_ORIGINS, RUNNER_URL, RUNNER_TOKEN, ELEVENLABS_* stay in /etc/apprentice/env. A then registers the screen module.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the deploy /health is ok, /ops/deploy/status answers through 8000, POST /api/agent/sessions works from the Pages origin
- [ ] #2 check.sh updated for apps/api passes
- [ ] #3 A failed switch rolls back automatically (deploy health check)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
