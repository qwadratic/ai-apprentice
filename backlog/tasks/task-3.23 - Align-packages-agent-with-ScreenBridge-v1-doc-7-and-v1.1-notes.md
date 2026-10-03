---
id: TASK-3.23
title: Align packages/agent with ScreenBridge v1 (doc-7 and v1.1 notes)
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 22:55'
updated_date: '2026-10-03 22:55'
labels:
  - stream-b
  - contract
milestone: m-0
dependencies:
  - TASK-3.1
parent_task_id: TASK-3
priority: high
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bring B's package in line with doc-7 and its v1.1 notes so the policy, Work Map, tutor and app shell cards build on the agreed shapes. Card key: B-align-v1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 contract-draft.ts: order_view facts nullable; ticket summary (not note); envelope source vision|workspace, frameId null only for workspace, sourceRevision; input_activity has lastInputAtMs; ActionCheckpoint has revisions and facts; CheckpointReply has basedOn; start/resume resolve to {state, reason} and a refused resume is not an error
- [ ] #2 Fake bridge: wall-clock timestamps from sessionEpochMs, events from a paused interval are dropped, start goes through a mask-review pause in the fake too
- [ ] #3 schema.ts: Work Map identity independent of sessionId (workMapId or scenario) with getLatestConfirmedMap; speaker roles expert, agent, novice; a helper that attributes [ASK] marker turns to the agent
- [ ] #4 Fixtures updated (input_activity frameId null, source workspace); all tests green in stream-b-checks
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
