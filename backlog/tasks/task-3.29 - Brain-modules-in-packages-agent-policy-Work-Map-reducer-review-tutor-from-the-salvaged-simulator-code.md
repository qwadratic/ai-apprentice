---
id: TASK-3.29
title: >-
  Brain modules in packages/agent: policy, Work Map reducer, review, tutor (from
  the salvaged simulator code)
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the simulator's pure agent modules (policy with natural-pause gating and budget, question topics, answer extraction behind an interface, map reducer with versions, review follow-ups and teach-back, tutor checkpoint with T1-T6) into packages/agent/src/{policy,knowledge,tutor}, typed against @apprentice/contracts, with node tests and fixtures/agent/expected t1-t6 read only by tests. Covers the core of TASK-3.4, 3.6 and 3.12 for the shell; LLM-backed scoring and extraction come later behind the same interfaces.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/agent exports policy, map, review and tutor modules typed on @apprentice/contracts; root npm run check green
- [ ] #2 T1-T6 pass against fixtures/agent/expected; no customer_07 rule text in packages/agent/src (test)
- [ ] #3 Policy never asks while typing or speaking, asks only at natural pauses, respects the budget, logs every decision
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
