---
id: TASK-2.1
title: Web skeleton and shared contract integration
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:15'
updated_date: '2026-10-03 23:54'
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
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Publication branch codex/task-2.1-foundation-pr is based on main f315f54 and carries source code commits 35b5528 + fda1da99b83eb96851930c1aa7121192210379cd. Coordinator fixed the current-main lockfile, separated independently checked B lab compiler context, and used direct Node22 TypeScript runtime for API to avoid source overwrite on emission. Reproduced Node22.22 typechecks, 78 tests (55 B, 20 contracts, 3 API), and web/API/contracts build. Root TS7 consolidation and real integration remain In Progress; public lab is not replaced.
<!-- SECTION:NOTES:END -->
