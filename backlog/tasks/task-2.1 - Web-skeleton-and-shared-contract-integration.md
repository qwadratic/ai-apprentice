---
id: TASK-2.1
title: Web skeleton and shared contract integration
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:15'
updated_date: '2026-10-03 21:16'
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
Owner: Stream A orchestrator. The three worker chats cannot implement compatible modules until they have one web skeleton and package boundary. Own root workspace configuration and lockfile, minimal web/API bootstrap, and packages/contracts implementing the jointly reviewed TASK-1 draft from TASK-3.1. Coordinate app-shell entry points with B and backend mounting with TASK-4. Do not implement the voice or product shell. Publication policy: only Backlog changes go to main; implementation remains on task branches. The orchestrator publishes through the Codex GitHub integration. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.1-web-foundation.
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
Inspect current A/B requirements and the TASK-3.1 contract proposal. Agree root setup and app/API entry points with B. Prepare the smallest web skeleton and shared contract on task-2.1-web-foundation, verify package checks, then publish an exact foundation commit for dependent branches. Main receives Backlog only.
<!-- SECTION:PLAN:END -->
