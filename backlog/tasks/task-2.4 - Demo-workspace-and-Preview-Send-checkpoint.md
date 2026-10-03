---
id: TASK-2.4
title: Demo workspace and Preview Send checkpoint
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-03 21:16'
labels:
  - stream-a
  - workspace
  - demo
milestone: m-0
dependencies:
  - TASK-2.1
parent_task_id: TASK-2
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Assigned worker: demo workspace. Own apps/web/features/demo-workspace and its colocated fixtures/tests. Implement synthetic order, email and ticket contexts; begin with email. Use B requirements from TASK-3.1: two customer_07 orders, another customer, unknown customer and spare customer_12 for a live learned fact. Input-activity heartbeat is scoped to this workspace; it does not claim global keyboard access. Preparation is active; implementation waits for foundation and the agreed checkpoint/facts interfaces. Publication policy: only Backlog changes go to main; implementation remains on task branches. The orchestrator publishes through the Codex GitHub integration. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.4-demo-workspace.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An editable order-to-email-to-ticket workflow and reset work with synthetic data; workspace reset does not silently erase agent knowledge.
- [ ] #2 Preview checks the current draft with latest order/email observation references; edits invalidate the result and stale replies cannot authorize a new draft.
- [ ] #3 Pending, clear, warn, unknown and failed checks are distinct; Send is human-controlled and only simulates sending.
- [ ] #4 Input-activity heartbeat works while typing; no hidden personal rule, expected answer or alternative domain-state feed is supplied to the agent.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read the current specification and assigned scope; prepare isolated worktree and integration plan. Implement only after the orchestrator supplies the approved foundation/contract revision. Record tests and a branch handoff; do not merge code to main.
<!-- SECTION:PLAN:END -->
