---
id: TASK-3.37
title: >-
  Generic mode in the shell: any screen, questions that point at regions,
  generic map and tutor
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 04:06'
updated_date: '2026-10-04 04:15'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Shell side of the generic mode: render screen_activity observations, send a [screen] line only on change, ask at pauses through generic_question and highlight the regions on the screen preview, follow the expert's language, build the Review map through map_synthesis, and warn in Teach through guardrail_check. Depends on stream A's screen_activity observation kind.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Learn asks at least 3 narrow questions on an arbitrary shared screen, each at a pause, with the regions highlighted
- [ ] #2 Review builds the map from the session and ends with a confirmed teach-back
- [ ] #3 Teach warns before a pending action covered by a confirmed guardrail; honest wording: warn, never block
- [ ] #4 Verified in a real browser with a synthetic screen_activity source
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 04:20 UTC, handoff. Branch task-3.37-generic-shell at f9d7481 (WIP on top of task-3.31-fixes b8559bc), pushed. It compiles and the existing tests pass. The new code has no tests and no browser run.
Written:
- brain/generic.ts: local screen_activity type and guard; [screen] line sent only on change (all kinds); language detection; Learn pause rule (2.5 s quiet, at most 4 per 10 min, at least 45 s apart) with generic_question and a template fallback; Teach guardrail_check that speaks a warn; Review map_synthesis, then gaps one by one, then map_synthesis, teach-back and reply_classification confirm/correct.
- AgentBrain routes screen_activity there (genericState(), takeDirty()).
- The controller posts the tasks with the session token, aborts on off-record and session end, sets region highlights, and stores the generic map and observations in shell state.
Not done:
1. GenericSampleSource (a synthetic mail-client script emitting screen_activity, evidence as data: SVG, sample-kind selector in SessionControls).
2. ScreenSlot highlight boxes over A's preview video, with data-clipa-surface=screen and data-clipa-hint=<regionId>, and Clipa pointing at the first one.
3. Unit tests for GenericMind with a fake post.
4. Browser run of Learn, Review and Teach with the generic sample and #43 deployed.
5. Replace the local type once stream A adds screen_activity (TASK-3.41).
Note: typing in another app (a mail client) cannot be seen from our page, so pauses must come from voice silence and screen changes.
Container tips: Chromium needs --disable-http2 --disable-quic, and API calls went through curl (coordinator scratchpad net.mjs).
<!-- SECTION:NOTES:END -->
