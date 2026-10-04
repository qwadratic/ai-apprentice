---
id: TASK-3.42
title: 'VM end-to-end rerun of Learn, Review and Teach after the shell fixes'
status: To Do
assignee: []
created_date: '2026-10-04 04:15'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The devops session on the VM is holding its rerun until stream B posts the head of the shell fix branch (task-3.31-fixes). The prepared run: headed Chrome under Xvfb with --auto-select-desktop-capture-source='Entire screen' (never the fake-UI flag); a mic wav with about 5 s of speech and 10 s of silence; Start and End clicked explicitly in each mode; the practice edit, then a 20 s pause. The first run (27e1562) found: 0 [ASK] in Learn; mode flapping when Review was clicked while Learn ran (46 MODE events in 53 s); Teach Preview & check answering 'No agent is connected'; observations stopping after vision_incomplete x4. SIGNED_URL_REQUIRE_SESSION=1 is confirmed on the VM.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The rerun reports counts per mode with no mode flapping
- [ ] #2 Learn asks at least 3 questions at pauses
- [ ] #3 Review ends with a confirmed teach-back
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: cancelled: no agent browser runs (Ivan, 4 Oct 04:20 UTC); the team checks by hand.
<!-- SECTION:NOTES:END -->
