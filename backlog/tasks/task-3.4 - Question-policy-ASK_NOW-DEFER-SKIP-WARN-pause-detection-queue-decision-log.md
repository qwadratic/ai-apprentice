---
id: TASK-3.4
title: >-
  Question policy: ASK_NOW / DEFER / SKIP / WARN, pause detection, queue,
  decision log
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - policy
  - voice
milestone: m-0
dependencies:
  - TASK-3.1
parent_task_id: TASK-3
priority: high
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pure TypeScript decision logic in packages/agent/src/policy, driven by the mock stream with a fake clock. A deterministic filter runs before any model: off-record, the person or the agent is speaking (user-speaking comes from the voice adapter's vad or transcript activity, typing from the workspace input_activity heartbeat), duplicate, already answered in the map, stale observation, too little evidence. Then an injected Scorer (LLM through the runner, with a heuristic fallback by observation kind) ranks importance. Questions must target a reason, an exception, a limit or an unknown fork, never restate what the screen shows. Adds cooldown, a soft budget of 3-5 per 10 minutes, a priority queue of deferred QuestionCandidates with expiry, and 'natural pause' (no screen change, no input activity and no speech for configurable seconds). In Teach mode WARN bypasses cooldown and budget. Every decision is written to a decision log {decision, reasons[], pauseMs, evidenceIds, whyNow} that the UI can show. Question text comes from a QuestionGenerator prompt in packages/agent/src/prompts; do not hard-code customer_07 lines.

Estimate: about 2 h of agent time. Card key: B-policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On the customer_07 mock stream with a stub generator the policy emits at least 3 ASK_NOW at pauses, at least one of kind limit/guardrail, none while typing or speech is active, none repeated
- [ ] #2 Each deterministic filter has a unit test (off-record, speaking, typing, duplicate, answered, stale, no evidence); every SKIP/DEFER carries a reasons[] entry
- [ ] #3 An unexpected action creates a QuestionCandidate but no ASK_NOW until a pause; deferred candidates are listed for Review and expire when stale
- [ ] #4 A candidate is marked asked only on the 'spoken' event; cancelled or expired candidates do not count toward the budget
- [ ] #5 Scorer failure or timeout falls back to the heuristic within 1 s and the policy never blocks the voice loop
- [ ] #6 The decision log is exported as JSON and rendered as a table by a small component for the debug panel
- [ ] #7 grep finds no 'customer_07' in packages/agent/src/prompts
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
