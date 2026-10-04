---
id: TASK-2.5
title: Processed recording Evidence timeline and ReplayPanel
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-04 03:43'
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
Follow-up for capture/privacy after its capture handoff. Own packages/screen/recording, packages/screen/evidence and apps/web/features/screen/ReplayPanel with scoped tests. Use the processed stream from TASK-2.2 and server persistence from TASK-2.3/TASK-4.1. Do not add microphone or system audio. Publication policy updated by explicit human instruction on 4 Oct: the orchestrator may publish reviewed Stream A implementation to main if B files are preserved. Workers still develop and hand off on their assigned task branches. Shared contract changes require approval from both owners. The orchestrator publishes using the repository-local Kigulx authentication authorized by the user; the connector previously rejected writes. Workers do not push or merge. Branch availability is not completion: Done still requires a future merge. Dependencies may be consumed from an explicitly approved branch revision before that merge. Reserved implementation branch: task-2.5-recording-replay.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Recorded pixels retain masks; no raw parallel screen recording or paused interval is stored.
- [x] #2 Session-relative timestamps map correctly to recording segments across pause/resume and resolveEvidence opens the correct moment.
- [ ] #3 Supported media formats, chunked upload, recorder finalization, unavailable assets and storage failures are handled explicitly.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Attach a processed-only segmented recorder through existing capture lifecycle hooks, with explicit format, finalization, and chunk storage failures. 2. Implement a pure session-relative segment timeline and a mountable ReplayPanel with evidence selection and unavailable states. 3. Verify actual browser video pixels and pause/mask/resize boundaries, timeline mapping, and storage lifecycle. 4. Publish one reviewed TASK-2.5 PR with exact imports and integration instructions for the B-owned shell; no shared contract or occupied runtime edits.

5. Include the integration owner-reviewed API composition: authenticated recording routes, raw chunk streaming, CORS chunk header and actual createApi binary roundtrip verification in the same task PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented processed-only segmented recorder, durable IndexedDB media/timecodes, Evidence timeline, ReplayPanel, authenticated file-backed chunk store and production API composition. Base feature head 7c33530 passed npm run check with Chrome: 492 tests, zero failures/skips, typecheck/build passed; GitHub Node22/24 and Backlog CI passed. Integrated owner-reviewed composition commits43b9deb and9e29a1c. createRecordingModule mounts MEDIA_DIR/recordings with real agent authorization and Origin checks; chunk routes stream raw bytes and CORS permits X-Recording-Chunk-Index. Actual createApi/createAgent test issues two sessions, uploads two non-UTF8 chunks, finalizes, and verifies exact concatenation; checks unauthorized/cross-session/foreign and missing Origin/413/ordinary JSON handling. Browser tests use a synthetic display source with real MediaRecorder, video decoding, masks, pause gap, IndexedDB restoration and ReplayPanel. Deployed browser-origin verification, host server session index and B ReplaySlot wiring remain integration handoffs, so AC3 stays open. Publication authorized and PR40 open; merge-owner B. No B shell, occupied capture/bridge/panel, shared contracts, root manifests or lockfile edits. Task remains In Progress until merge.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added processed-only recording/replay with persisted timestamps, privacy-boundary finalization, bounded media/storage errors and authenticated chunk persistence mounted in the real API composition. Base feature verified with 492 tests including Chrome record-to-replay; API composition adds real-session multi-chunk binary roundtrip and denial-path coverage. Deployed browser-origin verification and B shell mounting remain explicit handoffs; AC3 and terminal status remain open.
<!-- SECTION:FINAL_SUMMARY:END -->
