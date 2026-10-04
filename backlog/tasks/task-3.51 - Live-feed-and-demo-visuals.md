---
id: TASK-3.51
title: Live feed and demo visuals
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:01'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 06:00 UTC: the feed on the right shows far too many steps and stays static. It has to change all the time, live. Work on the visual side of the demo so it looks right: newest first, a few items, items arrive with motion, older ones fold away, no debug-looking text in the main view, good empty states for each stage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The right-hand feed is a live ticker: at most about 5 visible items, newest on top, animated arrival, older items folded
- [ ] #2 Show, Reflect and Pass it on each have a clean main view without debug text
- [ ] #3 Root npm run check passes
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
