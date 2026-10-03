---
id: TASK-2.3
title: Vision observations and screen Evidence API
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-03 21:16'
labels:
  - stream-a
  - vision
  - screen
milestone: m-0
dependencies:
  - TASK-2.1
parent_task_id: TASK-2
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Assigned worker: vision/API. Own packages/screen/vision and apps/api/screen with scoped tests. Only processed frames may become visible-fact observations. Export mount(app) for the shared backend; use the TASK-4.2 runner through RUNNER_URL. Own server-side Evidence storage/resolution; coordinate the client interface with capture/recording. Preparation is active; implementation waits for the foundation/contract, and real provider verification also waits for TASK-4.2. Publication policy: only Backlog changes go to main; implementation remains on task branches. The orchestrator publishes through the Codex GitHub integration. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.3-vision-evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Schema-valid observations describe visible facts only, distinguish customer from order and preserve unknown identities.
- [ ] #2 Sampling/deduplication and bounded requests discard invalidated, stale and out-of-order results including across pause and session changes.
- [ ] #3 Evidence is resolvable before its observation is published; only processed media are stored, credentials and payloads are not logged.
- [ ] #4 Runner integration, error handling and capture-to-observation latency are verified and reported separately from mock tests.
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
