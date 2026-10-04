---
id: TASK-2.4
title: Demo workspace and Preview Send checkpoint
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-04 02:53'
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
Assigned worker: demo workspace. Own apps/web/features/demo-workspace and its colocated fixtures/tests. Implement synthetic order, email and ticket contexts; begin with email. Use B requirements from TASK-3.1: two customer_07 orders, another customer, unknown customer and spare customer_12 for a live learned fact. Input-activity heartbeat is scoped to this workspace; it does not claim global keyboard access. Start independent workspace state, synthetic cases, draft versioning, reset, checkpoint state machine and UI components now. TASK-2.1 gates final shared integration. Inject a local checkpoint callback for tests; do not create a competing ScreenBridge or expose hidden scenario answers. Publication policy updated by explicit human instruction on 4 Oct: the orchestrator may publish reviewed Stream A implementation to main if B files are preserved. Workers still develop and hand off on their assigned task branches. Shared contract changes require approval from both owners. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.4-demo-workspace.
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
Create the assigned isolated worktree from the published assignment revision. Implement synthetic cases, workspace state, draft revision invalidation and checkpoint behavior with tests, then scoped UI components. Do not edit app shell or root dependencies. Hand off the independent slice; wire the approved ScreenBridge once available.

Integrate canonical workspace with real ScreenBridge runtime on pinned PR21: current vision registry, input activity, checkpoint dispatch/reply, and a working workspace page. Preserve reviewed PR21 and B sources; use distinct file ownership for parallel agents.

Resolve PR33 review: split bounded vision acquisition (15s) from checkpoint reply deadline (4s), expose acquisition state, preserve app off-record after failed resume, reject restarted timelines under a reused session ID, and pin the mount epoch. Verify each with focused regressions before publishing the combined fix.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Publication slice prepared from worker commits 9a19f4c and aa927c6 on current main f315f54. Coordinator reproduced all 30 Node 22.22 tests and strict TypeScript checking. This PR publishes the independent synthetic workspace only; real ScreenBridge observations, correlated checkpoint replies and shell integration remain In Progress. Follow-up assigned to the existing demo worker on GPT-5.6 Sol.

Canonical doc-7 follow-up applied to the PR12 candidate: the workspace consumes only trusted ordered vision observations plus opaque order/email revisions, validates ActionCheckpoint and CheckpointReply with @apprentice/contracts, rechecks registry freshness after the reply, and rejects mismatched session, sequence, checkpointId, basedOn or capture revisions. Input activity includes session-relative lastInputAtMs and exact idleMs. Capture must store order/email observations independently with frame-time surface plus opaque revision and invalidate them on pause/generation; no DOM-facts fallback. Task remains In Progress pending runtime/capture/B integration and merged CI.

Runtime wiring recovered and merged with published Screen runtime 0acb4f4. createRuntimeWorkspace mounts capture and workspace together, forwards current vision observations and scoped input activity, correlates checkpoints, preserves app-owned off-record state, and clears workspace off-record state before first capture when recording resumes. Verified with the apps/web production build.
<!-- SECTION:NOTES:END -->
