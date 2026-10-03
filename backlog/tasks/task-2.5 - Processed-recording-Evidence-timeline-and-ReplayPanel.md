---
id: TASK-2.5
title: Processed recording Evidence timeline and ReplayPanel
status: To Do
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-03 21:37'
labels:
  - stream-a
  - screen
milestone: m-0
dependencies:
  - TASK-2.2
  - TASK-2.3
parent_task_id: TASK-2
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up for capture/privacy after its capture handoff. Own packages/screen/recording, packages/screen/evidence and apps/web/features/screen/ReplayPanel with scoped tests. Use the processed stream from TASK-2.2 and server persistence from TASK-2.3/TASK-4.1. Do not add microphone or system audio. Publication policy: only Backlog changes go to main; implementation remains on task branches. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.5-recording-replay.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Recorded pixels retain masks; no raw parallel screen recording or paused interval is stored.
- [ ] #2 Session-relative timestamps map correctly to recording segments across pause/resume and resolveEvidence opens the correct moment.
- [ ] #3 Supported media formats, chunked upload, recorder finalization, unavailable assets and storage failures are handled explicitly.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
