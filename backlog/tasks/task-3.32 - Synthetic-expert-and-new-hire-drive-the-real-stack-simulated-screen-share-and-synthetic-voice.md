---
id: TASK-3.32
title: >-
  Synthetic expert and new hire drive the real stack: simulated screen share and
  synthetic voice
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 02:23'
labels:
  - stream-b
  - demo
  - test
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 02:20 UTC: two synthetic people, one per side: an expert for Learn and Review, a new hire for Teach. They exercise the full chain the way a person would. The screen-share stream is simulated too: a simulated desktop (the salvaged simulator's taskbar and windows) hosts stream A's demo workspace, and a scripted persona acts in it like a person (cursor, typing, pauses). The page shares itself through getDisplayMedia (preferCurrentTab), so A's capture, masks and vision see real pixels. The persona's spoken answers are pre-rendered ElevenLabs TTS clips, played into a synthetic microphone (a WebAudio MediaStream behind a getUserMedia shim used only in sim mode), so the voice agent hears them through its normal STT. Answers are cued by the agent's questions, never pre-timed. Clearly labelled as a simulation in the UI. B-side only (decision-4): A's workspace and capture are used as they are.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In sim mode the expert persona completes the customer_07 Learn task in the workspace while the real pipeline runs: capture, vision, brain, ElevenLabs. It answers ≥3 agent questions with its own voice clips at the moment the agent asks
- [ ] #2 The new-hire persona runs the T1 case in Teach: it predicts, tries to Send the image only, gets the WARN and fixes the email
- [ ] #3 The synthetic mic and getDisplayMedia shims are installed only when ?sim= is set; normal mode is untouched; the UI labels the persona as synthetic
- [ ] #4 A headless Playwright run (Chromium with fake-UI and tab-capture auto-accept flags) drives one Learn run end to end and records a video
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
