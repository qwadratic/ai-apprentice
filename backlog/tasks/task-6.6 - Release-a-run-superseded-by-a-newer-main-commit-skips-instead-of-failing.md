---
id: TASK-6.6
title: 'Release: a run superseded by a newer main commit skips instead of failing'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 02:12'
updated_date: '2026-10-04 02:20'
labels:
  - stream-b
  - infra
dependencies: []
parent_task_id: TASK-6
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When main moves while a release run is in progress, pages-build and deploy-vm fail with 'no longer the head of main', so main shows a red release although the newer run (queued in the release concurrency group) publishes and deploys the newer commit. On the first attempt a superseded run should finish green with a notice and not deploy the older sha to the VM; re-runs (run_attempt > 1) keep failing as now.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On run_attempt 1, a run whose sha is superseded mid-run ends green with a notice; Pages and the VM get its sha together, and the newer run, queued in the release concurrency group, moves both next
- [x] #2 A re-run (run_attempt > 1) of an older run still fails and never publishes or deploys the older sha
- [x] #3 actionlint is clean
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #30 (31ceff5). release.yml has one guard script in the workflow env (RELEASE_GUARD). It runs in pages-build, pages-deploy (new: checkout plus guard before deploy-pages, which takes the run's artifact from any attempt) and deploy-vm. It checks the freeze (overridable only by dispatch with confirm), that the sha is still an ancestor of main, and the head of main ignoring backlog. On attempt 1 a superseded run passes with a notice, Pages and the VM get its sha together, and the queued newer run moves both. Re-runs of a superseded run fail in every publishing job. Verified: 9 scenarios in a scratch repo run as bash -euo pipefail -c, actionlint, and an Opus review (FAIL at 070a73b on the pages-deploy re-run path, PASS at e0cccb2).
<!-- SECTION:FINAL_SUMMARY:END -->
