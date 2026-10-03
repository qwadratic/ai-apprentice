---
id: TASK-6
title: 'Release pipeline: CI-gated deploy branch, VM pull deploy, Pages'
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:15'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
priority: high
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements doc-8: every merged PR reaches the demo automatically, no person or agent logs into the VM for app code. Stream A's part (server entry in apps/api mounting both routers, root tsconfig.base.json, converting A's .mjs) is tracked under TASK-2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A push to main with green checks moves branch deploy and publishes the web build to Pages; a red check moves nothing
- [ ] #2 The VM deploys origin/deploy within about 2 minutes, /health shows the SHA, a failed deploy rolls back and is skipped next time
- [ ] #3 DEPLOY_FREEZE=1 stops releases; a manual run with a SHA rolls back
- [ ] #4 Release and deploy results are posted to Hive without secrets
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
