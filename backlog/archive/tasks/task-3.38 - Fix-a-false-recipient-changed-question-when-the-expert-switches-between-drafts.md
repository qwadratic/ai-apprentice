---
id: TASK-3.38
title: >-
  Fix a false 'recipient changed' question when the expert switches between
  drafts
status: To Do
assignee: []
created_date: '2026-10-04 04:15'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Ivan's live session on 4 Oct, 03:55 UTC. The expert switched between two drafts for two different customers, and vision also flapped between an unknown recipient and a named one. The policy then asked 'You changed the recipient...', but nothing had changed. Cause: packages/agent/src/policy/policy.ts:193 compares the recipient with the previous email observation, whatever draft that observation came from. Fix: count a change only within the same draft, and only after a stable reading (the same value on 2 frames in a row). A change from unknown to a named recipient is not a change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Switching between two drafts asks nothing
- [ ] #2 Unknown to named, or one frame of flapping, asks nothing
- [ ] #3 A real edit of the recipient in one draft still asks
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: applies only to the fallback in-browser brain; the conductor path does not use that rule.
<!-- SECTION:NOTES:END -->
