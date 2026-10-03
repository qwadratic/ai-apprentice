---
id: TASK-3.1
title: 'Standalone agent package: mock screen stream, fake voice, draft contract'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - contract
  - voice
  - demo
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Makes stream B independent of A. Creates packages/agent as a self-contained package (own package.json, no runtime dependencies, tests on node:test with Node 22 native TypeScript stripping: no enums, parameter properties or path aliases, imports with explicit .ts extensions, hand-written validators instead of zod until A's skeleton lands) and fixtures/agent with a reproducible mock ScreenObservation stream of the customer_07 learn session (order opened, essential data visible, email draft opened, template screenshot replaced by typed text, input_activity heartbeats while typing, Preview) with evidence ids and timestamps from one sessionEpochMs. Adds FakeScreenBridge (start/pause/resume/stop/resolveEvidence, deterministic fake clock), a VoiceAdapter interface with a scripted FakeVoiceAdapter (transcripts, user-speaking, speaking/listening, 'spoken' event), and the B-internal schema in packages/agent/src/schema (WorkStep, Guardrail, Utterance, MapVersion, QuestionCandidate, CoachCommand, CoordinatorState, SessionState, and a KnowledgeStore interface with an in-memory implementation) so later cards can run in parallel. Also writes the draft ScreenBridge v1 types and facts schema in packages/agent/src/contract-draft.ts plus fixtures/agent/sandbox-requirements.md for A. Conflict rule: until A's skeleton lands do not touch the root package.json, workspaces or lockfile. Post the wanted dependencies (zod 4, @elevenlabs/react ^1.16, @elevenlabs/client ^1.26, react) to A as a comment on TASK-1.

Estimate: about 2 h of agent time. Card key: B-mocks-contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `node --test` in packages/agent passes with no network, no keys and no root install (Node 22.22)
- [ ] #2 Replaying the fixture through FakeScreenBridge emits ordered ScreenObservations whose timestampMs are relative to sessionEpochMs; after pause() no observation is emitted; after resume() the timeline continues without a jump
- [ ] #3 FakeVoiceAdapter can be driven by a script and emits transcript, user-speaking, mode and 'spoken' events through the same interface the real adapter will implement
- [ ] #4 contract-draft.ts covers ScreenObservation, ScreenStatus, ScreenEvidence, ActionCheckpoint (observationIds must include the latest order and email observations) and the checkpoint reply with schemaVersion 1; the facts schema covers order (customerRef, orderId, deliveryAddress, deliveryWindow), email draft (recipientRef, subject, bodyText, attachments[{kind, ocrText?}], previewState), ticket and the input_activity heartbeat
- [ ] #5 schema.ts and the in-memory KnowledgeStore exist with validators and unit tests, so B-tutor, B-knowledge-engine, B-policy and B-app-shell can start from them without further coordination
- [ ] #6 fixtures/agent/sandbox-requirements.md lists screens, fields, two customer_07 orders, another customer, an unknown customer, a spare customer_12 case for the live new-fact test, the Preview -> Send flow, the input_activity heartbeat and reset; it is linked from TASK-1 and TASK-2 for @kigulx; no file outside packages/agent and fixtures/agent is changed
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
