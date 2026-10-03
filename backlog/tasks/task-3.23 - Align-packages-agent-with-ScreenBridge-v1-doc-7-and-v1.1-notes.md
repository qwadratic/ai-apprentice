---
id: TASK-3.23
title: Align packages/agent with ScreenBridge v1 (doc-7 and v1.1 notes)
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 22:55'
updated_date: '2026-10-03 23:10'
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
- [x] #1 contract-draft.ts: order_view facts nullable; ticket summary (not note); envelope source vision|workspace, frameId null only for workspace, sourceRevision; input_activity has lastInputAtMs with idleMs = timestampMs - lastInputAtMs; ActionCheckpoint has revisions only (no DOM facts, per doc-7 B acceptance); CheckpointReply has basedOn
- [x] #2 Fake bridge: wall-clock timestamps from sessionEpochMs, events from a paused interval are dropped, start goes through a mask-review pause
- [x] #3 schema.ts: Work Map identity independent of sessionId (workMapId) with getLatestConfirmedMap; speaker roles expert, agent, novice; [ASK] marker turns attributed to the agent
- [x] #4 Fixtures updated (input_activity frameId null, source workspace); all tests green in stream-b-checks
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #7 (54/54 tests, stream-b-checks green). Contract draft, fake bridge, schema and fixture follow doc-7 including A's review. Follow-ups moved to TASK-3.24: lifecycle methods return Promise<void> with onStatus authoritative (agreed in Hive after this work), session-unique checkpoint ids, keep off_record on repeated pause, test title, strict tsc type-check.
<!-- SECTION:FINAL_SUMMARY:END -->
