---
id: TASK-2.2
title: Browser capture manual masks and ScreenPanel
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:15'
updated_date: '2026-10-03 22:29'
labels:
  - stream-a
  - screen
milestone: m-0
dependencies:
  - TASK-2.1
parent_task_id: TASK-2
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Assigned worker: capture/privacy. Own packages/screen/capture, packages/screen/privacy and apps/web/features/screen/ScreenPanel plus scoped tests. Provide a single processed frame/stream interface for vision and recording. Start independent capture/privacy implementation now from the published assignment revision. TASK-2.1 is an integration dependency, not a blocker for local canvas, mask and lifecycle logic. Use injected callbacks at the boundary; do not invent or duplicate the shared ScreenBridge. Do not implement recording/Replay here; that is a later separate subtask. Publication policy updated by explicit human instruction on 4 Oct: the orchestrator may publish reviewed Stream A implementation to main if B files are preserved. Workers still develop and hand off on their assigned task branches. Shared contract changes require approval from both owners. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.2-capture-privacy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The user selects a screen/window; preview and outgoing frames use the same processed canvas.
- [ ] #2 Manual masks remove a synthetic email from outgoing pixels; geometry changes pause delivery until masks are checked.
- [ ] #3 Pause, resume, stop, permission refusal and source termination are handled; pause clears queued work and invalidates previous-generation results.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create the assigned isolated worktree from the published assignment revision. Implement processed canvas, masks and lifecycle with injected downstream callbacks and focused tests. Do not edit root manifests or shared contracts. Hand off the independently tested slice, then connect it to the approved foundation revision.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Coordinator publication handoff: independently reviewed source commits 5b92f05 and d559334 selected for main under new human authorization (A code may land if B files are preserved). 15 capture tests passed on Node22.22; combined A checks 50/50 and B regression checks 30/30 passed. No B paths overwritten. Integration, real browser picker and OS permission checks remain open; status stays In Progress. API and recording handoff details: doc-6 and packages/screen/capture/README.md.
<!-- SECTION:NOTES:END -->
