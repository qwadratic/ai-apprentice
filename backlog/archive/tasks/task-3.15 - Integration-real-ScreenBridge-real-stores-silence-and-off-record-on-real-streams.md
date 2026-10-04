---
id: TASK-3.15
title: >-
  Integration: real ScreenBridge, real stores, silence and off-record on real
  streams
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - demo
  - session
  - voice
milestone: m-0
dependencies:
  - TASK-1
  - TASK-2
  - TASK-3.7
  - TASK-3.9
  - TASK-3.13
  - TASK-4.2
parent_task_id: TASK-3
priority: high
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replaces mocks by A's real ScreenBridge and the contract in packages/contracts (delete contract-draft and migrate imports), binds the shell to the real coordinator, session controller, KnowledgeStore HTTP API on the VM and the real voice adapters, and verifies on the deployed stack with real voice. Measures and fixes: zero unprompted agent speech during a 2 minute typing and talking test, latency from observation to question, off-record across screen and voice on real streams (server log check that no frame or voice reaches the server after a confirmed pause), and failure modes (VM down, ElevenLabs error, capture lost) shown visibly. Never present mocks as live.

Estimate: about 2 h of agent time. Card key: B-integration-rehearsal.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/agent depends on packages/contracts only; the fake bridge is used only in tests
- [ ] #2 The shell, session controller, store API on the VM and both voice agents run on the deployed URL with the real ScreenBridge
- [ ] #3 In a 2 minute run with the expert typing and talking the agent produces no utterance
- [ ] #4 Off-record: after confirmed pause no frame and no voice reaches the server (server log check); status errors are visible when the network is cut and when the VM or ElevenLabs fails
- [ ] #5 Map versions and evidence still resolve after a VM service restart
- [ ] #6 Latency from observation to first question audio is recorded
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Archived 4 Oct 06:30 UTC in the backlog clean-up: superseded: the real ScreenBridge, stores and off-record run in production.
<!-- SECTION:NOTES:END -->
