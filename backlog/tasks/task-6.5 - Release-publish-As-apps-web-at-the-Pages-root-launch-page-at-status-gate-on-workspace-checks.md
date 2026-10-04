---
id: TASK-6.5
title: >-
  Release: publish A's apps/web at the Pages root, launch page at /status/, gate
  on workspace checks
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
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
- [ ] #1 A green main publishes apps/web at the root and the launch page at /status/, with deploy.json at the root
- [ ] #2 A red workspace check stops the release
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
