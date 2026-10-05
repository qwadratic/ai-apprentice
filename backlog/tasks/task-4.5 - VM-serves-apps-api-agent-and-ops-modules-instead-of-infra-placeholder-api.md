---
id: TASK-4.5
title: VM serves apps/api (agent and ops modules) instead of infra/placeholder-api
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
updated_date: '2026-10-05 08:58'
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
- [x] #1 After the deploy /health is ok, /ops/deploy/status answers through 8000, POST /api/agent/sessions works from the Pages origin
- [ ] #2 check.sh updated for apps/api passes
- [x] #3 A failed switch rolls back automatically (deploy health check)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Docs-cleanup audit (2026-10-05): AC2 stays unchecked per this task's own final summary (the updated check.sh run on the VM is with the devops agent, no pass recorded here).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
PR #24 merged (3e235fe); live since release 71bc9bf: /health {ok, modules [ops, agent]}, /ops/vm-health runner up, signed webhook deploy through apps/api ok; POST /api/agent/sessions 201 from the Pages origin, 403 foreign. AC2 (updated check.sh passing on the VM) is with the devops agent.
<!-- SECTION:FINAL_SUMMARY:END -->
