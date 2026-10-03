---
id: TASK-3.5
title: Session lifecycle and unified off-record across screen and voice
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - session
  - voice
  - ux
milestone: m-0
dependencies:
  - TASK-3.1
  - TASK-3.3
parent_task_id: TASK-3
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SessionController in packages/agent/src/session creates sessionId and sessionEpochMs, starts ScreenBridge and the voice session, and aggregates their status. One Off the record button stops microphone transmission (mute if the spike confirmed a reliable mute, otherwise end the ElevenLabs session and re-send a context summary on resume), calls screen pause(), clears unsent voice commands, queued questions and pending contextual updates, and shows 'paused' only after both channels confirm; on timeout it shows which channel failed. Capture loss, network loss, microphone denied and ElevenLabs errors are visible and the policy returns SKIP while the screen is not capturing, so the agent never pretends to watch. Resume keeps the same timeline and records the gap as an interval without content. The UI states that off-record does not recall already transmitted data and that screen masks do not cover speech.

Estimate: about 1.5 h of agent time. Card key: B-session-offrecord.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With fakes: after confirmed pause, 0 outbound observations, contextual updates or voice commands for 5 s; an observation arriving late after pause is discarded; no transcript is stored during the gap
- [ ] #2 Pause is displayed as set only after both channels confirmed; if one channel does not confirm, the UI shows a visible error naming it and does not claim off-record
- [ ] #3 Resume continues timestamps from the same sessionEpochMs and the off-record gap is stored as {startMs, endMs} with no content
- [ ] #4 With the real adapter: after confirmed pause no user_transcript event arrives and the agent does not speak
- [ ] #5 Screen state error/stopped or network lost produces a visible banner and policy SKIP with reason
- [ ] #6 OffRecordButton and StatusBar components are exported from apps/web/features/agent/session with the honest tooltip text
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
