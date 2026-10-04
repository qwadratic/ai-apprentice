---
id: TASK-3.35
title: >-
  Distinct layouts per mode: Learn records, Review shows knowledge, Teach
  centres the case
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 03:46'
updated_date: '2026-10-04 03:52'
labels:
  - stream-b
  - ux
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 03:45 UTC: all three views look the same with the screen capture, which is strange. Learn keeps the screen and the workspace in front. Review shows only knowledge (the mode view wide, Clipa and the session beside it); the screen and workspace roots stay mounted but hidden, as A's mount requires. Teach puts the new hire's case (workspace) first and the screen preview below it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Switching modes changes the layout as described, and nothing A mounts is unmounted on a switch
- [x] #2 Root npm run check passes; screenshots of the three modes at desktop and phone width
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #41 (ae52ad2). The shell's main area carries data-mode and shell.css lays out each mode: Learn screen and workspace in front; Review a wide knowledge view with the screen and workspace hidden but mounted; Teach the case first, the screen preview under it. Verified in Chromium at 1400x900 and 390x844 and by the web tests (166).
<!-- SECTION:FINAL_SUMMARY:END -->
