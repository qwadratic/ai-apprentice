---
id: TASK-3
title: 'Stream B: agent, voice and knowledge'
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-03 20:54'
updated_date: '2026-10-03 21:10'
labels:
  - stream-b
milestone: m-0
dependencies: []
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent of stream B tasks (owner @qwadratic, codes with Claude Code). B owns the whole conversational loop from microphone to the application of a confirmed rule: ElevenLabs Agents voice session (web SDK, signed URL minted by our API so the key never reaches the browser), conversation policy ASK_NOW/DEFER/SKIP/WARN, session and unified off-record, Work Map reducer and storage, the app shell with the Clipa mascot as the agent face, Learn/Review/Teach modes, the tutor with tests T1-T6, the pitch and the submission deliverables. Directories: packages/agent, apps/web/features/agent (plus app shell), apps/api/agent, fixtures/agent. Demo scenario: customer_07 asks for essential order data as text in the email body. Plan: doc-4; joint plan: doc-2. The Apprentice Test (when to ask, what to ask, when understood, did the new hire learn, trust) must each map to a demo moment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real ElevenLabs voice asks questions triggered by screen observations; at least 3 live questions at natural pauses about something visible, at least 1 about a guardrail or limit; the agent stays silent while the expert types or talks
- [ ] #2 Review asks at least 3 follow-ups not answered during the task, runs a teach-back of about a minute and the expert corrects one detail; the correction creates a new mapVersion
- [ ] #3 Every confirmed step and guardrail has a screen evidence link and the expert's quote; the clickable Work Map opens the right screen moment
- [ ] #4 On an unseen case the tutor warns before Send and replays the expert's moment (T1), allows the correct counter-example (T2), does not apply the personal exception to other clients (T3), asks when the client is unknown (T4), applies the latest confirmed version after a Review correction (T5), admits unknowns and conflicts without asserting a mandatory rule (T6)
- [ ] #5 A new fact stated by the expert live is learned and applied by the tutor with no code change
- [ ] #6 Off-record stops screen and voice together, errors are visible, the UI never claims the past is erased; the end of Teach shows mastered vs to practise
- [ ] #7 The frontend is deployed at a public clickable URL and talks to the VM API; no ElevenLabs or Anthropic key is in the browser bundle or in git
- [ ] #8 Each of the five Apprentice Test questions maps to a named demo moment in docs/pitch/walkthrough.md
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
