---
id: TASK-3.50
title: 'Clipa for macOS: a conductor face with live screen streaming'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:01'
updated_date: '2026-10-04 08:17'
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
- [x] #1 No windows: a menu bar item and the Clipa overlay only
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 06:32 UTC: builder finished. Branch task-3.50-macos-clipa, head ccf6ccc, macos-build CI green (run 37182996880), artifact Clipa-macos. CI smoke on a macOS runner against the live API: session, cues, one frame accepted, voice live, open_web on End. Not yet run on a real Mac; no masks on macOS frames. Next: Ivan tests the artifact, then PR and merge.

4 Oct 08:16 UTC: merged as PR #64 (4e90ffa). macos-build.yml publishes every main build as the fixed release clipa-macos-latest (https://github.com/qwadratic/clipa/releases/download/clipa-macos-latest/Clipa-macos.zip); the web header links to it (PR #65, 94e9a33). Ivan ran it on a Mac at ~07:15: it launched, started a session and streamed frames; questions were missing because the VM runner was down (fixed 07:54 with the Codex engine, PR #63).
<!-- SECTION:NOTES:END -->
