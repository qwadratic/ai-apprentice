---
id: TASK-3.26
title: >-
  Simulated desktop demo: Learn, Review, Teach end to end with a scripted expert
  and novice
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:52'
updated_date: '2026-10-04 01:11'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 03:00: a demo B can run and test without people. A web page that looks like a small desktop with three app windows (Orders, Mail, Tickets) runs the customer_07 scenario. A scripted expert works through it, and the agent asks at natural pauses. The scripted expert's answers live in a data file the agent code never reads. The agent builds the Work Map, runs Review (follow-ups, then a teach-back with one correction) and Teach on new cases T1-T6 with predict-next and a stop before Send that replays the expert's moment. Autoplay mode for e2e tests and a recorded fallback video; manual mode where a person plays the expert. Clearly labelled as a simulation with synthetic data. It is the integration vehicle for policy, map and tutor; A's real workspace and bridge replace the simulated window later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Autoplay runs Learn -> Review -> Teach unattended: at least 3 questions at pauses (1 about a guardrail), at least 3 Review follow-ups, a confirmed teach-back with one correction, T1-T6 results matching fixtures/agent/expected, and a stop before Send with the expert's moment replayed
- [ ] #2 The agent learns the customer_07 rule only from the expert's answers; no rule text in agent code or prompts (grep check)
- [ ] #3 Manual mode: a person can type the expert's answers and play the novice
- [ ] #4 Published on Pages at /sim/ with a launch page card; e2e test and a recorded video
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cancelled 4 Oct 01:20 by Ivan: the simulator and the lab are not needed; the product shell (TASK-3.8) is the vehicle. Its uncommitted agent modules (policy, map, answers, questions, review, tutor, types, tests) and fixtures (fixtures/agent/sim, fixtures/agent/expected t1-t6) were salvaged to move into packages/agent.
<!-- SECTION:NOTES:END -->
