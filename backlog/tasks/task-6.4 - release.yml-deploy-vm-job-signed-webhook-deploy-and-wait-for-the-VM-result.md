---
id: TASK-6.4
title: 'release.yml deploy-vm job: signed webhook deploy and wait for the VM result'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:09'
updated_date: '2026-10-04 00:44'
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
- [x] #1 deploy-vm runs after pages-deploy and is skipped when the secret is missing
- [x] #2 The job is green only when /ops/deploy/status reports ok for this sha; failed or rolled_back turns it red
- [x] #3 The secret never appears in a command line or log
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
PR #18 merged (e79b08b). First webhook deploy green end to end: release run 37165786927, deploy-vm job green, /ops/deploy/status ok (source request) for e79b08b, /health runner up. VM side: PR #13. Review findings on the job (re-run rollback, non-JSON poll, silent skip) fixed before merge.
<!-- SECTION:FINAL_SUMMARY:END -->
