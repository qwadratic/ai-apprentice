---
id: TASK-3.43
title: Real screen recordings as regression fixtures for the vision classifier
status: To Do
assignee: []
created_date: '2026-10-04 04:17'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 04:22 UTC: the classifier is the important part, because it turns the screen stream into a stream of actions (ScreenObservations). Test it on real recorded screen sessions, not on synthetic generators or simulators, to save resources. Collect real recordings (redacted frames plus the expected actions), replay them through the vision path, and compare the observations with the expected ones as a regression suite. Vision itself is stream A's code (apps/api/screen). This task is the B-side harness and the fixture set; agree the format with stream A in the integration thread. Fixtures hold synthetic or consented data only and never personal data, because the repo is public.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 At least 3 real recorded sessions are stored as fixtures (redacted frames plus expected actions)
- [ ] #2 One command replays them through the classifier and reports matches and mismatches per frame
- [ ] #3 The suite covers both the generic screen_activity kind and the customer_07 kinds
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
