---
id: TASK-2.5
title: Processed recording Evidence timeline and ReplayPanel
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 21:16'
updated_date: '2026-10-04 03:30'
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
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented processed-only segmented MediaRecorder, IndexedDB media plus timecode persistence, session-to-media timeline, ReplayPanel, and isolated authenticated recording chunk storage. Final npm run check with PLAYWRIGHT_MODULE and Chrome passed: 492 tests, zero failures or skips, typecheck and production build passed. Browser source is synthetic canvas; actual MediaRecorder, decoding, masking, pause gap, IndexedDB restoration, and ReplayPanel seek are exercised. HTTP tests use a standalone loopback adapter and the real client/handlers/file-store protocol, not createApi/registerWebRoute. Production raw-body route composition, CORS X-Recording-Chunk-Index, and host session index remain with the main integration owner; B owns ReplaySlot wiring. AC3 stays open until production upload composition is verified. No B shell, occupied capture/bridge/panel, shared contracts, root manifests, or lockfile edits. Task remains In Progress until merge.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added processed-only recording and replay with persisted segment timestamps, privacy-boundary finalization, explicit storage/media failures, authenticated chunk persistence, and exact session-time evidence mapping. Verified with 492 passing tests including real Chrome encoded-pixel and record-to-replay tests, typecheck, build, and client/server protocol tests. Production upload composition and B-owned shell mounting are explicit integration handoffs, so AC3 and terminal status remain open.
<!-- SECTION:FINAL_SUMMARY:END -->
