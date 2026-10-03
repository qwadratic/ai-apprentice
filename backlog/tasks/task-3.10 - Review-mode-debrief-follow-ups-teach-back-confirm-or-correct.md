---
id: TASK-3.10
title: 'Review mode: debrief follow-ups, teach-back, confirm or correct'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - workmap
  - ux
  - voice
milestone: m-0
dependencies:
  - TASK-3.6
  - TASK-3.4
  - TASK-3.8
parent_task_id: TASK-3
priority: high
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Review logic in packages/agent/src/review and the voice flow in apps/web/features/agent/review. A gap finder reads the draft map (unknowns, proposed or conflicted guardrails, deferred candidates) and produces at least three follow-ups that were not answered during the task and are not repeats (scope: this client only or all similar? may an extra attachment be added when the text is complete? what if the client identity is uncertain?). Questions go through the same coordinator in an interviewer debrief session; answers feed the engine. Done is decided by a criterion, not a timer: no blocking unknown on a judgment step, each guardrail has reason, scope and exception or an explicit 'unknown'. Then a teach-back of about a minute is generated from the map and the expert's spoken reply is classified by a structured LLM call as confirm, correct (with the corrected detail) or unrelated; a correction creates a new mapVersion with a visible diff. A quick-confirm path lets one proposed guardrail (for example one stated live) be confirmed in a few seconds so the tutor can use it. Uses the KnowledgeStore interface (in-memory first, HTTP when B-knowledge-store lands).

Estimate: about 2 h of agent time. Card key: B-review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On the fixture session Review produces at least 3 follow-ups that were not asked live and differ from each other; a question answered in Learn is not asked again
- [ ] #2 Debrief ends only when the completion criterion holds, then the teach-back is spoken; scripted replies 'yes', 'no, ...' and an unrelated remark are classified correctly in tests; the correction creates a correction utterance, a new mapVersion and a visible diff
- [ ] #3 Quick-confirm of a single proposed guardrail marks it confirmed in a new mapVersion and works for a rule stated live
- [ ] #4 The whole flow runs with FakeVoiceAdapter in a test and manually with real voice
- [ ] #5 The confirmed version is stored and marked as the one the tutor will use
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
