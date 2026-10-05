---
id: TASK-6
title: 'Release pipeline: CI-gated deploy branch, VM pull deploy, Pages'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:15'
updated_date: '2026-10-05 09:07'
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All six subtasks (6.1-6.6) are Done, and the pipeline runs end to end: release.yml builds Pages and calls the VM's signed deploy webhook on push to main, with a freeze flag and a stale-run guard. Verified live on 2026-10-05: GET /ops/deploy/status shows the last deploy as state ok for the current HEAD sha, and the 8 most recent release.yml runs (gh run list) all succeeded. The mechanism differs from the task description (no deploy branch, no VM poll of a deploy.json via a timer; a direct signed webhook instead, per TASK-6.1's own implementation notes citing doc-8). release.yml's own comment says the stream-b-checks, backlog-check and workspace-checks gates are off for the submission day and run by hand, so AC1's red-checks-publish-nothing does not hold today. Status corrected from To Do to Done to match the code (issue #103); AC boxes left as recorded pending a pass that restores the check gating and re-verifies against it.

Correction after a rebase onto origin/release in this same pass: PR #107 (just merged) restores the check gating and switches the trigger from main to release - release.yml's pages-build job now needs checks-stream-b, checks-backlog and checks-workspace (verified by reading the updated workflow), so the red-checks-publish-nothing behaviour this note said was off for the submission day is back. The deploy-branch/VM-poll wording mismatch noted above still stands; only the checks-disabled part was time-bound and is now resolved.
<!-- SECTION:FINAL_SUMMARY:END -->
