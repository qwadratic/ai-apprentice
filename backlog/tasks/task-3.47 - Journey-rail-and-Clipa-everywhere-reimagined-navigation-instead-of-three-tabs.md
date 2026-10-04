---
id: TASK-3.47
title: 'Journey rail and Clipa everywhere: reimagined navigation instead of three tabs'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 05:02'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 05:05 UTC: Clipa must go through every part of the app, and the Learn/Review/Teach tabs should be reimagined, not copied literally from the brief. Replace the tab bar with a journey rail: three stages joined by a teal wire, the same material as Clipa and the logo. The stages are Show (the expert works, Clipa watches and asks at pauses), Reflect (the map: talk to Clipa to fix it) and Pass it on (a new hire practises; Clipa steps in before a mistake). Clipa sits on the wire at the current stage and moves along it. She is a persistent layer above every stage, not a card in one column, and flies to what she talks about. Each stage reshapes the canvas around its main object: the shared screen, the board, the case. A bigger logo.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The tab bar is replaced by the journey rail with stage states (next, active, done)
- [ ] #2 Clipa is one persistent layer across all stages and moves along the rail
- [ ] #3 Each stage has its own canvas layout; phone width works
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
