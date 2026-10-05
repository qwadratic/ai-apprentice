---
id: TASK-3.8
title: 'App shell, Clipa agent face, Learn mode view'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:10'
updated_date: '2026-10-05 08:58'
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
- [x] #5 No API key or token appears in the production bundle (build output grepped)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #22 merged (0e4172a): shell, modes, status, Off the record, persona picker, debug drawer, session with token, voice (ported from the lab), Clipa presenter, A's ScreenPanel slot, Brain seam with NullBrain. Remaining for the ACs: wire the TASK-3.29 brain + TASK-3.30 LLM route + TASK-3.28 director (next task).

Docs-cleanup audit (2026-10-05): AC5 checked - release.yml's bundle key-scan (greps the published site for sk-ant-/sk_/api-key-shaped values and fails the job on a match) has passed on the 8 most recent release.yml runs (gh run list), and the live site is reachable. AC1-AC4 (mode switching keeping session state, Clipa's mapped states, the debug panel's content, the ScreenPanel/ReplayPanel slot contract) describe specific UI behaviour that needs a live browser session to verify properly per this repo's finalization guide; not exercised in this pass, left unchecked.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The app shell is merged and live (PR #36 and follow-ups #41, #44, #51, #52): Clipa face, modes as the Show / Reflect / Pass it on journey rail, conductor client.
<!-- SECTION:FINAL_SUMMARY:END -->
