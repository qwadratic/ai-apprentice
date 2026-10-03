---
id: TASK-6.1
title: 'release.yml: checks on main, fast-forward deploy branch, Pages build'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:15'
updated_date: '2026-10-03 23:16'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-6
priority: high
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub Actions workflow on push to main and workflow_dispatch (optional sha input for rollback): run every check job (backlog IDs, stream-b-checks, typecheck and tests of every package present, web or lab build); if all pass and the repository variable DEPLOY_FREEZE is not 1, fast-forward branch deploy to the SHA (contents: write) and deploy the site to Pages. Replaces the separate pages.yml trigger on main. Card key: B-release.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Green push moves deploy and publishes Pages; red push does neither
- [ ] #2 DEPLOY_FREEZE=1 blocks; workflow_dispatch with a sha input moves deploy to that sha
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
