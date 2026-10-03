---
id: TASK-1
title: ScreenBridge v1 contract
status: To Do
assignee:
  - '@kigulx'
  - '@qwadratic'
created_date: '2026-10-03 20:54'
updated_date: '2026-10-03 22:22'
labels:
  - shared
  - contract
milestone: m-0
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The only interface between stream A (screen) and stream B (agent), versioned as schemaVersion 1. Commands start({sessionId, sessionEpochMs}), pause(), resume(), stop(), resolveEvidence(evidenceId) -> {assetRef, startMs, endMs}; types ScreenObservation, ScreenStatus, ScreenEvidence, ActionCheckpoint and the reply {checkpointId, status: clear|warn|unknown, message, evidenceIds}. All timestampMs come from one sessionEpochMs. The facts schema (order table, email draft, ticket, workspace input_activity heartbeat) is fixed jointly and never extended silently. A writes the first implementation in the skeleton PR (packages/contracts); B proposes the draft and the sandbox requirements in B-mocks-contract so B can start before the skeleton lands. Sources: doc-2 part 5, doc-3 section 5, doc-4 section 7.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Types, schemaVersion constant and sample fixtures are merged on main in packages/contracts and imported by both streams (no private copies left after B-integration-rehearsal)
- [ ] #2 The facts schema for the order table (customerRef, orderId, deliveryAddress, deliveryWindow), email draft (recipientRef, subject, bodyText, attachments[{kind, ocrText?}], previewState), ticket and the workspace input_activity heartbeat is documented next to the types and approved in a comment by both @kigulx and @qwadratic
- [ ] #3 ActionCheckpoint.observationIds is specified to include the latest order observation and the latest email-draft observation
- [ ] #4 A change to any contract type goes through a small PR that both owners approve
- [ ] #5 A mock ScreenBridge implementation replays fixture observations, honours pause(), and is used in tests of both streams
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @qwadratic
created: 2026-10-03 22:22
---
Stream B's proposal is on main: packages/agent/src/contract-draft.ts (ScreenBridge v1 draft, schemaVersion 1, facts for order, email draft, ticket and the input_activity heartbeat, plus onObservation/onStatus/onCheckpoint/replyToCheckpoint) and fixtures/agent/sandbox-requirements.md (screens, data, customer_07 x2, another customer, unknown customer, customer_12 x2 for the live new-fact test, Preview -> Send, heartbeat cadence, reset). @kigulx please review and say what to change; types move to packages/contracts with your skeleton. Dependencies stream B will need in the root lockfile: zod 4, @elevenlabs/react ^1.16, @elevenlabs/client ^1.26, react.
---
<!-- COMMENTS:END -->
