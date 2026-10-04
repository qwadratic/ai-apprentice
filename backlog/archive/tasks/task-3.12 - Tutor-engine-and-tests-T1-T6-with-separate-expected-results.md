---
id: TASK-3.12
title: Tutor engine and tests T1-T6 with separate expected results
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - tutor
  - policy
milestone: m-0
dependencies:
  - TASK-3.1
parent_task_id: TASK-3
priority: high
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
packages/agent/src/tutor implements checkpoint(ActionCheckpoint, observations, mapVersion) -> {checkpointId, status clear|warn|unknown, message, evidenceIds}. It uses only the latest confirmed mapVersion, selects guardrails by entityScope from the observation's entityRef (null or unrecognised client gives unknown and a question, never a guess), evaluates conditions on structured facts first and a small LLM judge (Haiku-class model chosen by env) for fuzzy cases, and writes a message with the action, the reason in the expert's quote and evidence ids. Unexplained or conflicted rules yield an honest 'not sure'. It runs on hand-written fixture maps using the shared schema, so it does not wait for the engine. Fixtures: fixtures/agent/teach/t1..t6 inputs and fixtures/agent/expected/t1..t6 expected results kept apart; expected files are read only by the test harness. T1 customer_07 other order image only: warn before Send. T2 text plus image: clear. T3 other client: clear. T4 unknown client: unknown. T5 expert corrected the rule in Review: latest version applies. T6 no reason or conflict: unknown.

Estimate: about 2.5 h of agent time. Card key: B-tutor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `npm run test:tutor` runs T1-T6 against recorded or live LLM output and prints a pass/fail table; expected results are not imported by tutor code
- [ ] #2 T1 returns warn with the expert's quote and evidence id; T2 and T3 return clear; T4 returns unknown with an identity question; T6 returns unknown without 'must' wording
- [ ] #3 T5: after a correction creates version 2 the same input gives the reply defined by version 2 and cites mapVersion 2
- [ ] #4 The tutor code and prompt contain no customer ids or pre-written exception (grep test)
- [ ] #5 The reply arrives within 3 s on the messages backend with an API key; on the subscription backend the UI gets an explicit 'checking' state, never a silent clear
- [ ] #6 Timeout or runner error returns status unknown with reason 'not verified', never clear
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: superseded: the customer_07 T1-T6 tutor engine is the fallback only; Teach uses guardrail_check on learned rules.
<!-- SECTION:NOTES:END -->
