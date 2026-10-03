---
id: TASK-2.3
title: Vision observations and screen Evidence API
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-03 22:29'
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
Assigned worker: vision/API. Own packages/screen/vision and apps/api/screen with scoped tests. Only processed frames may become visible-fact observations. Export mount(app) for the shared backend; use the TASK-4.2 runner through RUNNER_URL. Own server-side Evidence storage/resolution; coordinate the client interface with capture/recording. Start independent queue, cancellation, deduplication, runner-client and storage logic now with local fakes. TASK-2.1 gates shared integration; TASK-4.2 gates real provider verification. Do not invent a competing ScreenBridge or runner service. Publication policy updated by explicit human instruction on 4 Oct: the orchestrator may publish reviewed Stream A implementation to main if B files are preserved. Workers still develop and hand off on their assigned task branches. Shared contract changes require approval from both owners. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.3-vision-evidence.
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
Create the assigned isolated worktree from the published assignment revision. Implement bounded queue, invalidation, runner client and Evidence storage behind injected interfaces with deterministic fake-based tests. Read doc-5 for runner shapes. Hand off this independent slice; complete shared-schema and real-runner integration only after those dependencies are ready.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Coordinator publication handoff: independently reviewed implementation 3e7297c selected for main under new human authorization; only apps/api/screen and packages/screen/vision are added. 35 vision/API tests passed on Node22.22; combined A checks 50/50 and B regression checks 30/30 passed. Real runner, SQLite metadata, auth/mounting and trusted revision adapter remain open. The latest-frame guard alone cannot validate the required order+email observation pair; add per-observation provenance during integration. See doc-6 and apps/api/screen/README.md. Status remains In Progress.
<!-- SECTION:NOTES:END -->
