---
id: TASK-6.2
title: 'VM: deploy the SHA from deploy.json with the timer on'
status: Done
assignee: []
created_date: '2026-10-03 23:15'
updated_date: '2026-10-04 00:51'
labels:
  - shared
  - infra
milestone: m-0
dependencies:
  - TASK-6.1
parent_task_id: TASK-6
priority: high
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After PR #5 merges: run sudo infra/install.sh once, set DEPLOY_REF=deploy in /etc/apprentice/env, enable apprentice-deploy.timer, and confirm deploy.sh logs 'infra changed, run sudo infra/install.sh' instead of applying infra changes. Optional: post the deployed SHA to the Hive project channel. Card key: D-pull-deploy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Timer enabled; a test commit through release.yml is live on the VM within about 2 minutes; /health shows its SHA
- [x] #2 A deliberately failing deploy rolls back and is skipped on the next tick
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Per doc-8 'Change after review': the VM reads https://qwadratic.github.io/ai-apprentice/deploy.json, verifies the SHA is an ancestor of origin/main, deploys it; service code runs from the deployed checkout.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Pages deploy.json pull deploy worked (deployed_sha matched) and rollback plus skip were verified by the VM agent. Superseded by the signed webhook (PR #13, TASK-6.4); the timer is now disabled by design.
<!-- SECTION:FINAL_SUMMARY:END -->
