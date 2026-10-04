---
id: TASK-3.40
title: Capture user feedback during product use as session events
status: To Do
assignee: []
created_date: '2026-10-04 04:15'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: low
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan's idea from the 03:55 UTC live session: feedback that a user gives while using the product (spoken or typed) should be recorded as a session event with its time and mode, and go to the team as playtest input. Keep it inside the session store; it must never be posted publicly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A feedback action in the shell records a typed note or a marked spoken turn as a session event
- [ ] #2 Feedback events can be listed per session for the team
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
