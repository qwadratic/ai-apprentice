---
id: TASK-6.1
title: 'release.yml: checks on main, publish Pages with deploy.json'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:15'
updated_date: '2026-10-03 23:28'
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
- [x] #1 Green push to main publishes the site with deploy.json {sha, at, run}; red checks publish nothing
- [ ] #2 DEPLOY_FREEZE=1 blocks; a manual run with a sha (and confirm during a freeze) publishes that older commit; re-runs never publish a stale commit
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Changed per doc-8 'Change after review': no deploy branch (GITHUB_TOKEN cannot move a branch onto workflow changes); publish deploy.json {sha, at, run} with the site.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #11. First real run 37161824872 published the lab and deploy.json for 0185f64 at 23:27 UTC. Checks (stream-b-checks with type-checks of all three B packages, backlog-check) gate the publish; no deploy branch, no contents: write. Freeze and rollback paths are lint-checked, not yet exercised on GitHub.
<!-- SECTION:FINAL_SUMMARY:END -->
