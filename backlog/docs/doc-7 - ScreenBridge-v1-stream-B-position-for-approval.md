---
id: doc-7
title: ScreenBridge v1 - stream B position for approval
type: specification
created_date: '2026-10-03 22:34'
updated_date: '2026-10-03 22:39'
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


## Stream A review for agreement — 4 Oct 2026, 00:38 Vienna

Reviewer: @kigulx, through the authorized A coordinator. Reviewed B's proposal at b44c2bb against the original stream A brief (doc-3), the published capture/vision slices at 43e265f, and current foundation/demo worktrees. This records A's position; it does not invent B's acceptance of the amendments below or mark TASK-1 complete. The original B proposal above is preserved.

### Decision on each field/method row

| Item | A decision | Exact position |
| --- | --- | --- |
| Order observation kind | AGREE | `order_view`. |
| Order fields | AGREE | `customerRef`, `orderId`, `deliveryAddress`, `deliveryWindow`: `string \| null`; unreadable or masked values are unknown, not guessed. The current A/B drafts need validator/fixture migration; this is agreement on the target, not a claim it is implemented. |
| Ticket fields | AGREE | `status: open \| done`, `summary`. Both current drafts now use `note`; rename together when publishing the agreed contract. No permanent dual fields. |
| Email fields | AGREE | Keep B's shape. Empty subject/body means visibly empty, not unreadable or masked. Do not fill an unreadable value from DOM/fixtures; when this shape cannot faithfully represent the observation, report incomplete recognition instead of fabricated facts. |
| Envelope | AGREE with provenance constraint | `source: vision \| workspace`, nullable `frameId` and `sourceRevision`. `workspace` is restricted to `input_activity` in v1, with `frameId: null`, `sourceRevision: null`, `entityRef: null`, `evidenceIds: []`. Visual order/email/ticket facts have `source: vision`, a real processed `frameId` and resolvable Evidence. A attaches the opaque capture-time revision; the model cannot assert it. Untracked external screens have null revision and are history-only. |
| input_activity | CHANGE: consistent idle time | Add `lastInputAtMs` as the session-relative timestamp of the last actual input. Always compute `idleMs = timestampMs - lastInputAtMs`; do not reset it to zero when emitting the first `typing:false` event. With the current 2-second inactivity detector, that event has about 2000 ms idle. Emit immediately on real input, then at most every 2 seconds; stop after the first idle heartbeat at/after 10000 ms. No heartbeat before any input in the current session; no fabricated initial last-input time. Off-record/reset/dispose cancel timers and queued callbacks. |
| Commands | AGREE | Existing Promise-returning lifecycle and resolver methods. |
| Subscriptions | AGREE | Keep `onCheckpoint` and `replyToCheckpoint` in ScreenBridge alongside observation/status subscriptions. |

### Decision on sections 2–5

**2. Session/pause/off-record — AGREE**, with these explicit clarifications:

- B owns the single id and epoch. Session-relative wall-clock offsets retain paused gaps. Resume never replays missed observations or queued input from the paused interval. The fake bridge must also discard events that would have occurred in that interval, rather than drain them after resume.
- Pause resolves after local output is closed, pending work invalidated, cancellation requested, and recording paused when attached. An already-transmitted HTTP request cannot be recalled; a provider may still finish it, but its late result must not be delivered or used. Do not wait indefinitely for a provider to acknowledge cancellation before disabling output.
- B displays full off-record only after screen and voice confirm. `off_record` describes this user action, not permission loss or mask editing. Resume must also respect A's mask-review/geometry gate.
- Reset stops the old session, starts a fresh shared id/epoch, and invalidates all old checkpoints and provenance. It preserves the confirmed Work Map; clearing learned memory is a separate action.
- Permission/capture loss and provider failure stay visible. Recoverable provider errors must not be mistaken for successful observations or automatically authorize Send.

**3. Current checkpoint — CHANGE REQUIRED.** Accept opaque `revisions: {order, email}` and reply `basedOn: {order, email}`. Do **not** add DOM-derived `facts` to ActionCheckpoint. The original brief requires processed frame -> vision -> visible observations; reading the workspace snapshot (including attachment source text) bypasses that route and can reveal content intentionally hidden by masks. Revisions contain opaque identity/version tokens, never content or encoded personal data.

A's replacement for the first bullet of section 3:

> Preview emits a checkpoint only when it can identify current, vision-derived order and email observations. ActionCheckpoint contains the existing envelope, `observationIds`, and opaque `revisions: {order: string, email: string}`; it contains no DOM-derived order/email facts. B obtains facts from the referenced ScreenObservations. A's provenance registry binds each observation to session, capture/lifecycle/privacy generation, source revision and processed Evidence. Both observations must match the current relevant revisions. A previous order observation can be reused only when the order and its provenance remain valid; after an order/privacy/session change a new observation is required. Missing or unmatched visual facts leave the check incomplete/unknown, never clear.

- Accept `CheckpointReply.basedOn`. Revision echo alone is insufficient: verify checkpointId, active session/generation, both observation bindings, and current revisions at reply application and again on Send. Invalidate on edits, off-record, reset, capture/mask geometry changes and disconnect. The current single-last-frame vision guard is not enough for the required order+email pair.
- Accept 4000 ms as a **provisional agent-reply deadline after dispatch**, not proof that vision can finish in 4 seconds. Show acquiring-screen-evidence before dispatch with its own bounded timeout/cancellation. Measure acquisition and agent reply separately and report total Preview-to-reply p50/p95. An acquisition timeout, missing facts or late reply must never appear as a successful check. The 75-second historical limit is not checkpoint freshness.
- Preserve the explicit human Send action. A's current workspace requires acknowledgement for warn/unknown; no automatic Send. Confirm the desired acknowledgement UI during shell integration. Missing required evidence or a technical failure remains visibly unverified.

**4. Transport — AGREE on the in-page A/B bridge; CHANGE REQUIRED on the API return path.** No WebSocket/SSE is required for the first run, but an asynchronous server response still needs a delivery path. The current `POST /screen/frames` returns acceptance (202), not a ScreenObservation; the service's `publish` callback is server-side and cannot call a browser subscriber directly. A proposes a session-authorized, bounded observation/status polling route keyed by a cursor as the minimal MVP return path. The browser adapter feeds those results into the in-page bridge, ignores old session/generation results and stops polling on pause/stop. The API/bridge owners must pin the exact route and response shape before implementation. A request/response endpoint that waits for a completed result would also work but is not the published 202 handler. Do not claim the present transport is wired.

**5. First end-to-end run — AGREE.** Use real processed pixels, real runner output, resolvable Evidence and real voice/transcript/session logging. Mock-only output is partial. Record SHA, session id, failures and measured timings. Existing isolated tests do not establish this gate.

### Confirmation and implementation order

1. B accepts or counters these three changes in TASK-1: consistent idle timestamps; vision-derived checkpoint facts with opaque revisions; explicit async API return path. Also confirm the clarifications above. A approves the otherwise agreed target rows here.
2. A's foundation owner publishes one canonical `packages/contracts` proposal/PR with the reconciled fields and lifecycle semantics. B migrates imports and fixtures in coordination; freeze a single exact revision. Do not call the whole contract approved before the open items are resolved. Since v1 is still an unreleased draft, update it atomically rather than maintaining incompatible private v1 copies.
3. A integration work connects trusted capture-time provenance, the order/email registry, result delivery and lifecycle; B connects its shell/session and reply handler. TASK-2.5 consumes only processed media and uses the same timebase.
4. Verify both streams against the canonical types plus pause/reset/stale-reply tests, then perform the real-data gate. Keep TASK-1 open until its actual acceptance criteria are met.
