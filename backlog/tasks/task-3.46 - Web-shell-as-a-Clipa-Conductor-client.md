---
id: TASK-3.46
title: Web shell as a Clipa Conductor client
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 05:00'
updated_date: '2026-10-04 05:02'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The server conductor (doc-12 v1.1, PR #49) decides what Clipa says and does. The web shell becomes one of its faces: it sends events (hello as web, mode and session, share, activity, talking and final transcript turns from the ElevenLabs SDK, ui actions, cue_done, off_record) and renders the SSE cues. The cues: guide lines with UI targets, ask (spoken via [ASK]) with region boxes over the screen preview, point, context, map (the briefing board, WorkMapBoard), teachback, say, warn, cancel and quiet. On load, a ?join=CODE link from the macOS app links the web session to the Mac's conductor and drops the code from the URL. Reuse the UI parts of PR #37 (progress strip, target resolver) and of task-3.37-generic-shell (region highlights). Retire the in-browser policy for the generic path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The shell sends the event stream and renders every cue type
- [ ] #2 Learn on any shared screen: ask cues are spoken at pauses and their regions are highlighted
- [ ] #3 Review: the board shows the map; voice edits appear as new versions; the teach-back is confirmed by voice
- [ ] #4 A ?join= link from macOS joins the same conductor
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
