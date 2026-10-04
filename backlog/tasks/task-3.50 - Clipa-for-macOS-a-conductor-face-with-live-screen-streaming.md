---
id: TASK-3.50
title: 'Clipa for macOS: a conductor face with live screen streaming'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:01'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 06:00 UTC: the macOS app has no windows at all. It is only Clipa, living in the corner. While a stage runs it streams the screen in real time to the server, and it does everything the web does: questions at pauses through the server conductor, voice through ElevenLabs. At the end it gives a link to the web session to reflect on what was done. Demo cases: one email, one table. It turns mac/ (the frozen bonus) into a face of the Clipa Conductor (doc-12 v1.1) with Origin app://apprentice-macos. Built in CI on macos-15.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No windows: a menu bar item and the Clipa overlay only
- [ ] #2 Screen streamed to the screen module in near real time (about 2 fps, changed frames only, latest frame wins)
- [ ] #3 Conductor events and the SSE cue stream; voice through the ElevenLabs agent with [ASK] lines; presence, point and open_web rendered
- [ ] #4 CI on macos-15 is green and uploads the app
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
