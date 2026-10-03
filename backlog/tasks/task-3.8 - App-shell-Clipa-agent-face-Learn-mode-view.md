---
id: TASK-3.8
title: 'App shell, Clipa agent face, Learn mode view'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - ux
milestone: m-0
dependencies:
  - TASK-3.1
parent_task_id: TASK-3
priority: high
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/web/features/agent/shell holds the product shell: Learn / Review / Teach switcher, StatusBar and OffRecordButton, slots for A's ScreenPanel and ReplayPanel (placeholders with the contract props until they land), and the Learn view: agent state, live question feed (asked, answered, deferred), a deferred-gaps list, the draft map as step cards, and a debug panel with the policy decision log and latency. It binds to the typed coordinator and session state and the Fake adapters from B-mocks-contract; real wiring happens in B-integration-rehearsal. Clipa exists on origin/feat/clipa as web/clipa/clipa.js (dependency-free <clipa-buddy>, states idle|listening|thinking|speaking|warning|happy|pointing, boolean `off`); copy it into apps/web/features/agent/shell/clipa/ and wrap it as <ClipaAgent>. Mapping: off-record -> `off`; error -> `warning` plus a banner; Teach warn -> `warning`; mastered or clear -> `happy`; replay of an evidence moment -> `pointing`. Include a speech bubble with the current question and reduced-motion support (the component already stops loops).

Estimate: about 2 h of agent time. Card key: B-app-shell.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Switching Learn/Review/Teach keeps session state; Learn shows live questions, deferred gaps and the draft map from the fake pipeline
- [ ] #2 Clipa shows each mapped state (listening, speaking, thinking, idle, off, warning, happy, pointing), driven only by coordinator and session state; the bubble shows the spoken question text
- [ ] #3 The debug panel shows the decision log with reasons and the observation-to-audio latency
- [ ] #4 ScreenPanel and ReplayPanel are slot files with the contract props; swapping in A's components changes nothing outside the slot files
- [ ] #5 No API key or token appears in the production bundle (build output grepped)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
