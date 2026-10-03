---
id: TASK-1
title: ScreenBridge v1 contract
status: To Do
assignee:
  - '@kigulx'
  - '@qwadratic'
created_date: '2026-10-03 20:54'
updated_date: '2026-10-03 23:06'
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

author: @kigulx
created: 2026-10-03 22:29
---
A coordinator reviewed the B draft and found mismatches in the current A foundation proposal; the foundation worker is reconciling it against packages/agent/src/contract-draft.ts. Shared approval is still pending; no contract has been published by A. Before real integration agree order_view/ticket/input_activity shapes and onCheckpoint/replyToCheckpoint, per-observation provenance for latest order+email, session/reset/off-record semantics, and measured checkpoint deadlines. Detailed handoff and target sync times: doc-6. The independent A capture/vision slices are being published without modifying B files.
---

author: @qwadratic
created: 2026-10-03 22:34
---
Stream B position for approval: backlog/docs/doc-7 (field and method table, session and off-record semantics, current order+email at the checkpoint via workspace revisions and facts, in-page transport for v1, first end-to-end run definition). @kigulx: mark each row agree or change; once both owners agree, A publishes packages/contracts and B switches its imports.
---

author: @kigulx
created: 2026-10-03 22:39
---
A review of doc-7 is published in its Stream A review section (4 Oct 00:38 Vienna). AGREE: order_view; nullable order fields; ticket summary/open|done; email shape; provenance-labelled envelope; lifecycle and bridge methods; common session/timebase; real-data run. Three CHANGE items need B confirmation: (1) idleMs must equal timestampMs minus actual lastInputAtMs, including the first idle event; (2) no DOM-derived checkpoint facts: use opaque revisions/basedOn plus current vision-derived order/email observations, preserving masks and the original brief; (3) in-page A/B bridge is accepted, but POST /screen/frames currently returns only 202, so define an async result return path (A proposes bounded session-authorized polling). Accept 4s as provisional reply-after-dispatch deadline; acquisition is separately bounded and measured. Full contract approval and TASK-1 completion remain pending these points. Existing code has not been changed by this review.
---

author: @qwadratic
created: 2026-10-03 23:03
---
Stream B accepts all three changes from A's review in doc-7 (consistent idle time; checkpoint with revisions and vision observations only, no DOM facts; polling return path for v1, route proposal in doc-7) and all clarifications. Details: doc-7, section 'Stream B acceptance'. A can publish packages/contracts; B migrates in TASK-3.23.
---

author: @qwadratic
created: 2026-10-03 23:06
---
Agreed in Hive with stream A (4 Oct ~01:25): lifecycle methods start/pause/resume/stop return Promise<void>; onStatus is authoritative (a resolved call does not mean capturing; mask-review, refused resume and off_record arrive only as ScreenStatus). This replaces the {state, reason} return in the doc-7 v1.1 note. Polling route GET /screen/sessions/{sessionId}/updates?cursor=n -> {observations, statuses, nextCursor} accepted by A, ~1 s bounded polling, no long-poll for the first run.
---
<!-- COMMENTS:END -->
