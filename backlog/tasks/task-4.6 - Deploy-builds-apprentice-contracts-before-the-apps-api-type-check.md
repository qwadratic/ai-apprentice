---
id: TASK-4.6
title: Deploy builds @apprentice/contracts before the apps/api type check
status: Done
assignee:
  - '@apprentice-devops'
created_date: '2026-10-04 02:06'
updated_date: '2026-10-04 02:14'
labels:
  - shared
  - infra
milestone: m-0
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
- [x] #1 From a clean tree without packages/contracts/dist, build_api on main merged with PR #21 installs, builds @apprentice/contracts and passes the apps/api type check
- [x] #2 infra/check.sh passes on the VM
- [x] #3 After the merge, sudo infra/install.sh is run on the VM and /ops/deploy/status answers with the deployed sha
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. build_api in infra/deploy/deploy.sh: after the root install and before the apps/api build, build @apprentice/contracts when packages/contracts/package.json has a build script (npm run build --workspace, or pnpm --filter on the pnpm branch); a failure fails the step, so the deploy rolls back.
2. infra/README.md: the rebuild list under 'How a commit reaches the VM' names the contracts build.
3. Test on a scratch clone of main merged with PR #21 head (1a6a028) from a clean tree without packages/contracts/dist: build_api from the old deploy.sh fails with TS2307 (baseline), from the new one it passes.
4. bash -n on deploy.sh; infra/check.sh on the VM.
5. PR, head in Hive; after the merge: sudo infra/install.sh from a clone at the merged sha, then /ops/deploy/status.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Test (scratch clone of main 4e9f52d merged with PR #21 head 1a6a028; clean tree after checkout()'s git clean, packages/contracts/dist absent; build_api extracted from each deploy.sh): old deploy.sh -> npm ci, apps/api tsc --noEmit fails with TS2307 "Cannot find module '@apprentice/contracts'" (9 errors), build_api exit 1; new deploy.sh -> npm ci, contracts tsc -p tsconfig.build.json, apps/api type check passes, build_api exit 0, dist/index.js built. bash -n ok. infra/check.sh on the VM (live 0e4172a/c6806da, unchanged by this branch): 28 passed, 0 failed. The PR #21 merge with main is clean and keeps opsModule first in apps/api/src/modules.ts.

After merge (482deb7): the release deployed 482deb7 without restarts and asked for install.sh; sudo infra/install.sh from a clean clone at 482deb7 exited 0 (build-only ran npm ci, the new contracts build and the apps/api type check; runner, api and ops restarted), /opt/apprentice/bin/apprentice-deploy equals the repo's deploy.sh, deploy timer still disabled. /ops/deploy/status: deployed_sha 482deb71a7c1, last ok. infra/check.sh: 28 passed, 0 failed. CI on the branch head: unique-task-ids pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
build_api in infra/deploy/deploy.sh now builds @apprentice/contracts after the root install and before the apps/api type check, because checkout()'s git clean removes the gitignored packages/contracts/dist and A's screen module (PR #21) makes apps/api import it; without this every #21 deploy rolled back on TS2307. Verified on a clean scratch clone of main merged with #21 head 1a6a028 (old script: exit 1 with 9 x TS2307; new: exit 0, dist built), installed on the VM with sudo infra/install.sh at 482deb7, /ops/deploy/status ok at 482deb7, infra/check.sh 28/0. README lists the contracts build.
<!-- SECTION:FINAL_SUMMARY:END -->
