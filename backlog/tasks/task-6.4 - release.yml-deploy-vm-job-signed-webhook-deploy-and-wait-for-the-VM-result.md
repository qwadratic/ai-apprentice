---
id: TASK-6.4
title: 'release.yml deploy-vm job: signed webhook deploy and wait for the VM result'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:09'
labels:
  - shared
  - infra
dependencies: []
parent_task_id: TASK-6
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Option 2 chosen by Ivan: GitHub Actions calls the VM's deploy webhook (PR #13, infra/ops) after Pages is published, signs {sha, ts} with DEPLOY_WEBHOOK_SECRET, then polls GET /ops/deploy/status until the VM reports ok, failed or rolled_back, so every backend deploy is visible in Actions. Replaces the minute timer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 deploy-vm runs after pages-deploy and is skipped when the secret is missing
- [ ] #2 The job is green only when /ops/deploy/status reports ok for this sha; failed or rolled_back turns it red
- [ ] #3 The secret never appears in a command line or log
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
