---
id: TASK-3.6
title: 'Work Map engine: reducer, live rule extraction, validator, versions'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - workmap
  - policy
milestone: m-0
dependencies:
  - TASK-3.1
parent_task_id: TASK-3
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements doc-4 section 4 in packages/agent/src/knowledge on top of the schema from B-mocks-contract. A pure reducer folds ScreenObservations, expert utterances, answers linked to QuestionCandidates and confirmations or corrections into a draft map; confirmation or correction creates an immutable mapVersion. Answers go through an LLM structured call (via an LlmClient interface served by the runner on the VM; recorded responses for CI) that returns rationale, a proposed guardrail with condition, requiredAction, exceptions, entityScope, unknowns and the quote span. Scope defaults to the named customer, never universal without the expert saying so; unknowns are kept; contradictions become status conflicted plus a gap for Review. A validator refuses to confirm a step or guardrail without at least one screen evidence id and one expert quote. The map is derived, not hand-written; recorded outputs only make CI deterministic.

Estimate: about 2.5 h of agent time. Card key: B-knowledge-engine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reducer is pure and unit-tested on the Learn fixture plus scripted answers; output contains steps with evidenceIds and guardrails with quote and entityScope customer_07
- [ ] #2 validateMap fails when a step or guardrail has no screen evidence or no expert quote, and the UI cannot confirm it
- [ ] #3 A contradicting answer produces a conflicted guardrail and a Review gap, never a silent overwrite; an unexplained decision stays in unknowns
- [ ] #4 Live-learning test: an utterance introducing a new rule for a different customer id (customer_12) produces a proposed guardrail scoped to that id with no code or prompt change (prompts contain no customer ids)
- [ ] #5 confirm/correct returns a new mapVersion; older versions stay readable and diffable
- [ ] #6 A live script (npm run learn:live) runs extraction against the real runner and prints the structured result
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
