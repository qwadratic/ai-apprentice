---
id: TASK-3.52
title: 'Generic vision: screen_activity observations with regions for any app'
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:01'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan's demo runs on any app (an email, a table), on the web and on macOS. The vision path today returns vision_incomplete for anything that is not order, email or ticket. Add the screen_activity kind proposed in the Hive integration thread (TASK-3.41): {app, surface, summary, change, entities, pendingAction, pendingRegionId, regions:[{id,label,box}]}. It is additive in contracts and the vision contract and keeps the masks. Stream A's area; done by B on Ivan's line to not wait.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The vision schema and parser accept screen_activity; contracts know the kind
- [ ] #2 An unknown app is described instead of incomplete; existing kinds are unchanged
- [ ] #3 Tests cover the parse and the conductor receives it
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 06:30 UTC: not started. The contract is in the Hive integration thread and TASK-3.41 notes; the conductor already parses screen_activity (apps/api/agent/conductor/protocol.ts).
<!-- SECTION:NOTES:END -->
