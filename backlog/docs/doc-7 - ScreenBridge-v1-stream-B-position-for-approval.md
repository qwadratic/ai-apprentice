---
id: doc-7
title: ScreenBridge v1 - stream B position for approval
type: specification
created_date: '2026-10-03 22:34'
---


# ScreenBridge v1: stream B position

Answers to the open items in doc-6 ("Agreements needed") and the TASK-1 comment from @kigulx. Base: `packages/agent/src/contract-draft.ts` on main and A's slices on main (`packages/screen/*`, `apps/api/screen/*`). Where A already implemented something, B follows A unless it breaks a B requirement. After both owners approve, A moves the types to `packages/contracts` and B switches its imports.

## 1. Field and method table

| Item | B draft today | A today (doc-6) | Proposal for v1 |
| --- | --- | --- | --- |
| Order observation kind | `order_view` | `order` | `order_view` (matches `email_draft`; fixtures already use it) |
| Order fields | all strings | nullable | `customerRef`, `orderId`, `deliveryAddress`, `deliveryWindow` are all `string \| null`. Unknown stays `null`, never guessed |
| Ticket fields | `status: open\|done`, `note` | `status`, `summary` | `status: open\|done`, `summary` (A's name; the plan calls it the work summary). B renames `note` |
| Email fields | `recipientRef\|null, subject, bodyText, attachments[{kind, ocrText?}], previewState` | not listed | keep B's; `subject` and `bodyText` may be `""`, never `null` |
| Envelope | `schemaVersion, id, sessionId, sequence, timestampMs, frameId, kind, facts, entityRef, evidenceIds` | `frameId` nullable | add `source: 'vision' \| 'workspace'`; `frameId: string \| null`, `null` only when `source = 'workspace'`; add `sourceRevision: string \| null` (see 3) |
| `input_activity` | `{surface, typing, idleMs}` | other fields | `{surface: 'order'\|'email'\|'ticket', typing, idleMs, lastInputAtMs}` with `source = 'workspace'` (DOM events in our sandbox, not vision). Cadence: every 2 s while typing, one event when typing stops (`typing:false, idleMs:0`), then every 2 s up to 10 s idle |
| Commands | `start, pause, resume, stop, resolveEvidence` | same | same; all return Promises |
| Subscriptions | `onObservation, onStatus, onCheckpoint` | `onObservation, onStatus` | keep `onCheckpoint` and `replyToCheckpoint` on the bridge: doc-2 says the checkpoint is part of the same bridge |

## 2. Session, pause and off-record

- **One session id for everything.** B creates `sessionId` (UUID) and `sessionEpochMs = Date.now()` when Learn or Teach starts and passes both to `start()`. The same id is used for screen, voice and the server session log (TASK-3.22).
- **Timestamps are wall-clock offsets:** `timestampMs = now - sessionEpochMs`, also across pauses (this is what A's capture and queue already do). Paused time is a gap, not removed. B changes its fake bridge to match. Clip-time mapping across pauses stays inside A's recording (TASK-2.5).
- **Off the record is B's button.** B calls `bridge.pause()` and stops the voice channel at the same time. A answers with `ScreenStatus {state: 'paused', reason: 'off_record'}` only after frame sending stopped, the queue is dropped and in-flight vision is cancelled; late results are discarded (A's generation counter). B shows "off the record" only after both channels confirm. `resume()` keeps the session and epoch. Nothing already sent is recalled, and the UI never says so.
- **Stop and reset.** `stop()` ends the session. A scenario reset is `stop()` followed by a new session with a new id; no observation from the old session is accepted afterwards.
- **Errors are visible.** `ScreenStatus {state: 'error', reason}` on capture loss or provider failure; the agent then says it cannot see the screen instead of pretending.

## 3. Current order and email at the checkpoint

- The demo workspace knows its own state exactly, so the Preview -> Send checkpoint does not depend on vision latency. `ActionCheckpoint` gets two extra fields: `revisions: {order: string, email: string}` (opaque, from the workspace, changing on every edit) and `facts: {order: OrderFacts, email: EmailDraftFacts}` (the workspace's own structured snapshot at Preview). `observationIds` still lists the latest vision observations of both, for evidence links and replay.
- Vision observations of the sandbox carry the `sourceRevision` the workspace had when the frame was captured (A's trusted provenance adapter). Vision observations of any other screen have `sourceRevision: null` and are history only, never checkpoint input.
- `CheckpointReply` gets `basedOn: {order: string, email: string}` echoing the revisions it judged. The workspace applies the reply only if both revisions are still current, and checks again on Send. If anything changed, it raises a new checkpoint or shows "not verified".
- **Deadline:** the workspace waits up to 4000 ms for a reply (provisional, to be replaced by the measured p95 from the 60-second run plus a margin). No reply or `unknown` is shown as "not verified", never as clear. The human always decides Send.

## 4. Transport for the first run

Capture and the agent run in the same browser page (A's app with B's shell), so the bridge is an in-page object: A's implementation calls the vision API and publishes observations to B's subscribers; checkpoints and replies are in-page calls. Server-to-browser streaming is not needed for v1.

## 5. First end-to-end run (gate 01:30 in doc-6)

Expert shares the demo workspace window, opens customer_07's order, types the delivery data into the email: real masked frame -> runner vision -> `ScreenObservation` with frame Evidence -> B's coordinator -> contextual update to the voice agent -> at a pause the agent asks one question -> the expert's answer is in the transcript and the session log. Recorded: capture-to-observation and Preview-to-reply latency, the run SHA, the session id. Mock-only output counts as a partial pass.

## B follow-ups after approval

Rename ticket `note` -> `summary`; add `source`, `sourceRevision`, nullable fields and the checkpoint `revisions`/`facts`/`basedOn` fields; switch the fake bridge to wall-clock timestamps; use the same `sessionId` for the voice session and the server log.
