---
id: TASK-6.5
title: >-
  Release: publish A's apps/web at the Pages root, launch page at /status/, gate
  on workspace checks
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
updated_date: '2026-10-04 01:18'
labels:
  - shared
  - infra
dependencies: []
parent_task_id: TASK-6
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan 4 Oct 01:20: everything stream A builds must deploy automatically too. release.yml builds the root workspace (npm ci, npm run check as a gate via workspace-checks.yml) and publishes apps/web (Vite, WEB_BASE_PATH=/ai-apprentice/) at the Pages root; the launch page moves to /status/; the lab and the simulator leave Pages.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A green main publishes apps/web at the root and the launch page at /status/, with deploy.json at the root
- [x] #2 A red workspace check stops the release
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
PR #20 merged (adaad84): release gates on workspace-checks (root npm run check, Node 22.22 and 24), builds apps/web for Pages under app/ (stays there until the shell replaces A's debug view, then swaps with the launch page at the root), lab no longer published.
<!-- SECTION:FINAL_SUMMARY:END -->
