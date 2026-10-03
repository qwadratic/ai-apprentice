---
id: TASK-2
title: 'Stream A: screen and workspace'
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-03 20:54'
updated_date: '2026-10-03 21:37'
labels:
  - stream-a
milestone: m-0
dependencies: []
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent of stream A tasks (owner @kigulx, codes with Codex); A creates its own children. Scope per doc-3: repo skeleton and root lockfile; browser capture via getDisplayMedia with manual masks applied before any frame is sent or recorded; recording of the processed canvas stream only (chunked upload, see D-vm-backend); pause that stops sending and drops queued frames; a vision adapter that describes only what is visible (frame every 1-2 s, dedup, bounded queue, stale results dropped) and calls the Claude runner at RUNNER_URL (infra/claude-runner, doc-5); Evidence storage plus ReplayPanel; ScreenPanel; demo workspace with order table, email editor with Preview -> Send checkpoint, ticket, input_activity heartbeat, two orders for customer_07, another customer, an unknown customer, a spare customer_12 case, and scenario reset. A exposes everything to B only through ScreenBridge v1 and exports a mount(app) for apps/api/screen.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A real screen frame becomes a ScreenObservation with a source frame and an evidence reference
- [ ] #2 The processed preview equals what is sent and recorded; a masked email is absent from both
- [ ] #3 After pause nothing is sent, the queue is dropped and a late vision result is discarded
- [ ] #4 ReplayPanel opens the right moment for an evidenceId
- [ ] #5 Preview -> Send checkpoint works in the demo workspace; an agent failure is shown as not verified, never as success; scenario reset works
- [ ] #6 The workspace emits input_activity heartbeats while the user types
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Stream A assignments: TASK-2.1 foundation (orchestrator), TASK-2.2 capture/privacy, TASK-2.3 vision/API, TASK-2.4 workspace, TASK-2.5 later recording/replay. Independent worker slices may start before the shared foundation is ready; production integration still requires the jointly approved ScreenBridge. Only Backlog is published to main; all implementation stays on task branches.
<!-- SECTION:NOTES:END -->
