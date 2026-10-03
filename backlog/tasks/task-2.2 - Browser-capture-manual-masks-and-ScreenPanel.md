---
id: TASK-2.2
title: Browser capture manual masks and ScreenPanel
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:15'
updated_date: '2026-10-03 21:16'
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
Assigned worker: capture/privacy. Own packages/screen/capture, packages/screen/privacy and apps/web/features/screen/ScreenPanel plus scoped tests. Provide a single processed frame/stream interface for vision and recording. Preparation is active; production implementation waits for the TASK-2.1 branch revision and TASK-1 contract approval. Do not implement recording/Replay here; that is a later separate subtask. Publication policy: only Backlog changes go to main; implementation remains on task branches. The orchestrator publishes through the Codex GitHub integration. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.2-capture-privacy.
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
Read the current specification and assigned scope; prepare isolated worktree and integration plan. Implement only after the orchestrator supplies the approved foundation/contract revision. Record tests and a branch handoff; do not merge code to main.
<!-- SECTION:PLAN:END -->
