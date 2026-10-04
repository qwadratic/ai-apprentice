---
id: TASK-3.41
title: >-
  Agree the screen_activity observation kind with stream A (generic vision for
  any screen)
status: To Do
assignee: []
created_date: '2026-10-04 04:15'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Blocker for the v2 demo (doc-10): vision returns vision_incomplete/unsupported_surface for anything that is not order/email/ticket. B proposed the contract in the Hive integration thread at 04:04 UTC. The new kind is screen_activity, with facts {app, surface, summary, change, entities, pendingAction, pendingRegionId, regions:[{id,label,box:[x,y,w,h] normalised 0..1}]}. Stream A had not answered by 04:15. Open decision for Ivan: if A cannot take it, B builds it additively in a PR in A's paths for A to review. The existing kinds stay untouched. B side: TASK-3.37 (shell), TASK-3.36 (API, merged in #43).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Stream A accepts or counter-proposes the contract
- [ ] #2 Vision returns screen_activity with regions on an arbitrary app (for example a mail client)
- [ ] #3 The shell renders it (TASK-3.37)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
