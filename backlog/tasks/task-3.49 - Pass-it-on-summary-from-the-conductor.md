---
id: TASK-3.49
title: Pass it on summary from the conductor
status: To Do
assignee: []
created_date: '2026-10-04 05:40'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Pass it on summary (what the new hire handled, what to practise) still comes from the in-browser brain. The conductor should send a summary cue at the end of Teach: the warnings given, how the new hire resolved them and the rules they never met. The web renders that cue.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The conductor sends a summary at the end of Teach
- [ ] #2 The web renders it in Pass it on
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
