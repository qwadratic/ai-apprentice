---
id: TASK-3.46
title: Web shell as a Clipa Conductor client
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 05:00'
updated_date: '2026-10-04 05:40'
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
- [x] #1 The shell sends the event stream and renders every cue type
- [x] #2 Learn on any shared screen: ask cues are spoken at pauses and their regions are highlighted
- [x] #3 Review: the board shows the map; voice edits appear as new versions; the teach-back is confirmed by voice
- [x] #4 A ?join= link from macOS joins the same conductor
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #52 (d2f979a) and PR #53 (192375f). The web shell is a conductor client.
- Events: hello, mode and session, share, activity, talking and transcript, ui, cue_done, off_record.
- Cue stream: a fetch-streamed SSE with reconnect after the last seq.
- Rendering: ask, warn, say, teachback and spoken guide lines go to the voice as [ASK]. Region boxes are drawn over the screen preview. The map shows on WorkMapBoard through fromGenericMap. Guides drive the rail.
- Joining: a ?join= link from macOS joins the same conductor. ?conductor=off falls back to the in-browser brain.
- One session for the whole journey.
- #53: the web welcome line follows Start, then share; lines use Show, Reflect and Pass it on; the Start button carries data-clipa-target.
Tests: 51 new web tests plus 1 conductor test; root npm run check and CI are green. Per Ivan's rule there was no agent browser run, so the flow needs a check by hand.
Known gaps:
- The Pass it on summary still comes from the in-browser brain.
- With one session id, a second /finish may store no log for later stages (debug only).
<!-- SECTION:FINAL_SUMMARY:END -->
