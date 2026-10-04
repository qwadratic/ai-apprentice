---
id: TASK-3.16
title: >-
  Rehearsal: timed full runs, live new-fact test, recorded fallback, minutes
  budget
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - demo
  - voice
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Runs the whole Capture -> Review -> Teach path on the deployed URL as the pitch will, with Ivan's and the teammate's real voices. Counts the live questions from the stored question log, runs the live new-fact scenario (the expert states a rule for customer_12 that exists nowhere in code, quick-confirms it, the new hire opens that case and the tutor applies it with no commit in between), and prepares a labelled fallback: the last confirmed map plus session log exported as JSON and loaded read-only on a /recorded route clearly marked 'recorded', plus a screen recording of a successful live run on the laptop. Budgets the ElevenLabs minutes (275 on Creator) across rehearsals and notes the remaining minutes before and after.

Estimate: about 2 h of agent time. Card key: B-rehearsal-live.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Three consecutive timed runs of the full demo path complete on the deployed URL; failures are logged with causes
- [ ] #2 The stored question log of a real run shows at least 3 live questions, each at a pause and about something on screen, at least 1 about a guardrail or limit
- [ ] #3 The live new-fact test passes: a rule spoken during Learn is applied by the tutor on a new case with no commit between them
- [ ] #4 A recorded fallback can be opened from the UI at /recorded and is labelled 'recorded'; a screen recording of a live run exists on the laptop
- [ ] #5 Remaining ElevenLabs minutes are noted before and after rehearsals, and at least 60 minutes are reserved for judges and the pitch
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
