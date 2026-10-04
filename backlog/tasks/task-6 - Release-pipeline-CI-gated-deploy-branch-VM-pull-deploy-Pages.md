---
id: TASK-6
title: 'Release pipeline: CI-gated deploy branch, VM pull deploy, Pages'
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:15'
updated_date: '2026-10-04 00:51'
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
Implements doc-8 with the 'Change after review' and the webhook: a green push to main publishes Pages (launch page + lab, deploy.json) and calls the VM's signed deploy webhook; the Actions run shows the VM result. DEPLOY_FREEZE stops releases; a manual run with a sha rolls back. No deploy branch and no timer.
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
