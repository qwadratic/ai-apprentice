---
id: TASK-2.1
title: Web skeleton and shared contract integration
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:15'
updated_date: '2026-10-04 02:28'
labels:
  - stream-a
  - infra
  - contract
milestone: m-0
dependencies: []
parent_task_id: TASK-2
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner: Stream A orchestrator. The three worker chats cannot implement compatible modules until they have one web skeleton and package boundary. Own root workspace configuration and lockfile, minimal web/API bootstrap, and packages/contracts implementing the jointly reviewed TASK-1 draft from TASK-3.1. Coordinate app-shell entry points with B and backend mounting with TASK-4. Do not implement the voice or product shell. Publication policy updated by explicit human instruction on 4 Oct: the orchestrator may publish reviewed Stream A implementation to main if B files are preserved. Workers still develop and hand off on their assigned task branches. Shared contract changes require approval from both owners. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.1-web-foundation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A documented development setup can run the web/API skeleton and package checks.
- [ ] #2 packages/contracts contains the agreed ScreenBridge version, validators, fixtures and pausable mock; TASK-1 review is recorded separately.
- [ ] #3 A verified foundation branch commit and exact worker file boundaries are published in this task; code is not merged into main.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Publish the accepted doc-7 contracts and compatible web/API scaffold as a small PR on current main. Reconcile existing B workspaces without changing their sources. Follow with the agreed TS7 root configuration, real screen/agent route composition and shell integration; publish exact SHAs for dependent workers.

Integrate verified capture provenance and vision polling commits locally; implement runtime ScreenBridge and screen API composition in isolated files; exercise real runner through a local screen test page before proposing publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Publication branch codex/task-2.1-foundation-pr is based on main f315f54 and carries source code commits 35b5528 + fda1da99b83eb96851930c1aa7121192210379cd. Coordinator fixed the current-main lockfile, separated independently checked B lab compiler context, and used direct Node22 TypeScript runtime for API to avoid source overwrite on emission. Reproduced Node22.22 typechecks, 78 tests (55 B, 20 contracts, 3 API), and web/API/contracts build. Root TS7 consolidation and real integration remain In Progress; public lab is not replaced.

Local runtime integration on main 9d95185 consumes capture 8614db6 + bc7d5b3 + 9c50cc7 + bb5cf68, vision a0c195d, and B API 5270c67 (now merged upstream). Implemented B-authorized screen composition with SQLite/file Evidence; local HTTP health reports agent+screen, session and screen start return 201, pause/stop 200. Synthetic missing-runner error-path returns upload202, observations0, runner_unconfigured. B confirmed all-route B auth; real runner cannot be reached locally because VM agent/SSH tunnel is unavailable. Real smoke requires reviewed publication/deploy plus TASK-4.5 API switch. Runtime privacy/lifecycle corrections and full check are still underway; task remains In Progress.

Runtime review resolved lifecycle generation/cursor mismatches, serialized intrinsic backend pause, gated uploads until resume acknowledgement, stale-operation epochs, app-owned off-record latch, and post-stop Evidence. Bridge actual hub/handler/service integration test passes with explicit mock VisionRunner; API tests 18/18. Root npm run check on Node22 passed including production screen-test and fixture pages; one optional browser test skipped. Live vision and OS picker remain unverified, no publication or deployment performed.

Merged origin/main 01e326d locally preserving B production code. Human explicitly approved adapting the one legacy B screen authorization regression test; assertions401/403/202 preserved through actual screen module/hub. Updated test page for current B session response and browser start-click epoch, plus release VITE_API_BASE. Final root check on Node22: 150 passed, 1 optional browser test skipped; strict typechecks and production build passed. Local HTTP smoke on updated B API: session201, screen201, authenticated originless poll200, stop200, test page200. Awaiting human publication permission and existing B exact-head review/deploy; real vision/OS picker/voice sequence not claimed complete.

PR21 review fixes: expire abandoned screen sessions in every state using idle TTL; deterministic capacity, paused-session and active-preservation tests pass 12/12. Persisted Evidence now uses B session authorization after API restart; restart/foreign-origin/cross-session tests pass 3/3 and API typecheck passes. Removed redundant API package build edit because TASK-4.6 fixes deployed contracts build.
<!-- SECTION:NOTES:END -->
