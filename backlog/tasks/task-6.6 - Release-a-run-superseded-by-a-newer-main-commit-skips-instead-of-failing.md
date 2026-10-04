---
id: TASK-6.6
title: 'Release: a run superseded by a newer main commit skips instead of failing'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 02:12'
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
- [ ] #1 On run_attempt 1, a run whose sha is superseded mid-run ends green with a notice, and deploy-vm does not request a deploy
- [ ] #2 A re-run of an older run still fails and never publishes or deploys the older sha
- [ ] #3 actionlint is clean
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
