---
id: TASK-1
title: ScreenBridge v1 contract
status: To Do
assignee:
  - '@kigulx'
  - '@qwadratic'
created_date: '2026-10-03 20:54'
labels:
  - shared
  - contract
milestone: m-0
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The only interface between stream A (screen) and stream B (agent): commands start/pause/resume/stop/resolveEvidence and the types ScreenObservation, ScreenStatus, ScreenEvidence, ActionCheckpoint and the checkpoint reply, all timestamps from one sessionEpochMs, schemaVersion 1. See doc-2 part 5, doc-3 section 5, doc-4 section 7.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Types and fixtures merged on main and used by both streams
- [ ] #2 facts schema for the email, order table and ticket screens agreed by both
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
