---
id: TASK-4.6
title: Deploy builds @apprentice/contracts before the apps/api type check
status: In Progress
assignee:
  - '@apprentice-devops'
created_date: '2026-10-04 02:06'
labels:
  - shared
  - infra
dependencies: []
parent_task_id: TASK-4
priority: high
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
At A's PR #21 head (1a6a028) apps/api imports @apprentice/contracts, whose build output lives in the gitignored packages/contracts/dist. checkout() in infra/deploy/deploy.sh runs git clean, which removes that dist; build_api then runs npm run build in apps/api (tsc --noEmit), which fails with TS2307, so every deploy of #21 rolls back before any restart. start-api.sh already rebuilds a missing dist when the service starts (PR #25), but the build step runs earlier. Fix: build_api builds @apprentice/contracts after the install and before the apps/api build (npm workspace, or pnpm --filter). B adapts on its side; A's apps/api/package.json stays untouched (decision-4). deploy.sh is applied by sudo infra/install.sh, not by a deploy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 From a clean tree without packages/contracts/dist, build_api on main merged with PR #21 installs, builds @apprentice/contracts and passes the apps/api type check
- [ ] #2 infra/check.sh passes on the VM
- [ ] #3 After the merge, sudo infra/install.sh is run on the VM and /ops/deploy/status answers with the deployed sha
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
