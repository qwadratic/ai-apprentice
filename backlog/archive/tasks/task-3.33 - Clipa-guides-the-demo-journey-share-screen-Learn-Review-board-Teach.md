---
id: TASK-3.33
title: 'Clipa guides the demo journey: share screen, Learn, Review board, Teach'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 02:44'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - ux
  - demo
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 02:45 UTC: Clipa moves in the web app too. It invites the user to share the screen (or the phone camera when screen sharing is unavailable) and walks both people (the expert, then the new hire) through every step of the demo journey in doc-10. A journey engine (apps/web/features/agent/clipa/journey) is a small state machine over app events. Each step has a target element (data-clipa-target), one short line, and an exit condition. It drives the merged Clipa motion director (createClipaDirector) and never moves while the person types. A progress strip shows the journey (Share → Learn → Review → Teach → Summary). The same engine drives the synthetic personas (TASK-3.32) through the steps.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A first-time user on the Pages app is guided from opening to a shared screen without reading any instructions: Clipa flies to Share screen, explains in one line, and waits for the click
- [ ] #2 When getDisplayMedia is unavailable (phones), Clipa offers the camera path and explains it, or says plainly that the device cannot share
- [ ] #3 Each doc-10 step has a target, a line and an exit event. The journey advances on real app events, never on timers alone, and is resumable after reload
- [ ] #4 Typing, talking and off-record silence Clipa. Reduced motion is respected
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 05:15 UTC: PR #37 closed unmerged as superseded. The journey logic moved to the server conductor (PR #49, doc-12 v1.1). Its UI parts (progress strip, target resolver) are reused by TASK-3.47 (journey rail). The branch task-3.33-clipa-journey stays.

Archived 4 Oct 06:30 UTC in the backlog clean-up: PR #37 closed as superseded by the server conductor; its UI parts went into TASK-3.47.
<!-- SECTION:NOTES:END -->
