---
id: TASK-3.29
title: >-
  Brain modules in packages/agent: policy, Work Map reducer, review, tutor (from
  the salvaged simulator code)
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:12'
updated_date: '2026-10-04 02:59'
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
- [x] #1 packages/agent exports policy, map, review and tutor modules typed on @apprentice/contracts; root npm run check green
- [x] #2 T1-T6 pass against fixtures/agent/expected; no customer_07 rule text in packages/agent/src (test)
- [x] #3 Policy never asks while typing or speaking, asks only at natural pauses, respects the budget, logs every decision
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #26 (d3eb3b5). packages/agent now has: ConversationPolicy (ASK_NOW/DEFER/SKIP/WARN/PREDICT, quiet on typing, talking and off-record, budget, logged decisions); a versioned Work Map reducer; Review with a teach-back confirmation gate (lastStatedDigest via stateTeachBack, so a confirmation counts only for the stated text, and Teach applies only confirmed versions); the tutor checkpoint (T1-T6) and predict-next; LLM-backed extraction, reply classification and entity resolution over /api/agent/llm/:task, with a queue and fail-safe heuristic fallback (whitelists plus a veto on hedges, negation, questions and qualifiers). Verified by 190 package tests (gate, failsafe tables, full Learn-Review-Teach flow against fixtures/agent/expected, no-rule-text test), root npm run check on Node 22.22.0 and 24, and seven Opus review rounds, ending PASS with notes at 410b760 (unstated changes such as extra steps can still confirm; the host must call stateTeachBack only when it really speaks the teach-back).
<!-- SECTION:FINAL_SUMMARY:END -->
