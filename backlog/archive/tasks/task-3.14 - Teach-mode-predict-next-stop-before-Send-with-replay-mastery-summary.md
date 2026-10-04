---
id: TASK-3.14
title: 'Teach mode: predict-next, stop before Send with replay, mastery summary'
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - tutor
  - ux
  - voice
milestone: m-0
dependencies:
  - TASK-3.8
  - TASK-3.11
parent_task_id: TASK-3
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Teach view in apps/web/features/agent/teach. Starts a new case (asks A's workspace to reset) that the expert never showed and connects the new hire's screen through ScreenBridge. The tutor (Clipa speaking) explains the step in the expert's words and asks the new hire to predict the next decision before showing it; the answer is scored against the map as right, partial or wrong. On Preview the ActionCheckpoint goes to the tutor engine; warn or unknown is spoken and shown with the reason, the expert's quote and an automatic replay of the expert's screen moment in ReplayPanel, and the new hire fixes the draft and sends. If the check fails or times out the UI says 'not verified', never success. At the end a mastery summary lists what was mastered and what to practise (predictions, warnings received, repeated mistakes, each linked to its rule). The UI notes honestly that this is the built-in Preview checkpoint, not a click blocker for arbitrary apps.

Estimate: about 2 h of agent time. Card key: B-teach-ux.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scripted run with FakeVoiceAdapter and a fake workspace: prediction question, wrong prediction, warn at Preview with quote and replay, fix, clear, Send, then the mastery summary with at least one mastered and one to-practise item
- [ ] #2 The replay opens the evidence moment of the guardrail that fired (same evidenceId as in the Work Map)
- [ ] #3 A checkpoint error shows 'not verified' and Send stays marked unchecked
- [ ] #4 Real voice: Clipa warns before Send on the T1 case and the new hire can answer by voice
- [ ] #5 The tutor never mentions the personal exception on the T3 case in the transcript
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: superseded by the conductor's Teach flow; the mastery summary moved to TASK-3.49.
<!-- SECTION:NOTES:END -->
