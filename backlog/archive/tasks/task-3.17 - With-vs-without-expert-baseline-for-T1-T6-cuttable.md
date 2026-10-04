---
id: TASK-3.17
title: With vs without expert baseline for T1-T6 (cuttable)
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - tutor
  - demo
milestone: m-1
dependencies:
  - TASK-4.2
parent_task_id: TASK-3
priority: low
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Proves the tutor learned from the expert and not from general knowledge. Runs T1-T6 twice with the same screen data and the same model: once with an empty map and once with the confirmed map, and stores the comparison in fixtures/agent/results/baseline.json. T2 and T3 serve as the allow counter-tests, showing the tutor does not stop everything. Shows a small 'with vs without the expert' table at the end of Teach and as a visual for the tech video. Stretch if time remains: export the confirmed Work Map as agent-followable instructions.

Estimate: about 1.5 h of agent time. Card key: B-baseline-eval.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One command produces baseline.json with per-case status and message for both conditions and the same inputs
- [ ] #2 Without the map T1 is not warned for the customer-specific reason (no expert quote), with the map it is; T2 and T3 stay clear in both
- [ ] #3 The table is visible in the Teach summary and a screenshot is saved for the video
- [ ] #4 The run records which backend (messages or agent-sdk) was used
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: cut (marked cuttable); no time before submission.
<!-- SECTION:NOTES:END -->
