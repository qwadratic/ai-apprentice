# ScreenBridge v1

**Status: field schema and lifecycle semantics accepted by both owners in doc-7.**
The final lifecycle decision keeps `start`/`resume` as `Promise<void>` commands
with state and refusal details delivered through `onStatus`. See
`../../docs/web-foundation.md` for installation, imports and hookup paths.

Every observation/status/evidence/checkpoint/reply carries literal `schemaVersion: 1`.
SessionStart supplies a nonempty sessionId and an absolute integer sessionEpochMs.
All other times are nonnegative integer milliseconds relative to that one epoch.
Validation is strict: unsupported fields/kinds/versions fail rather than silently
extending the only interface between the streams. Validators return cloned values.

| Observation kind | Required facts |
| --- | --- |
| order_view | customerRef, orderId, deliveryAddress, deliveryWindow: string or null |
| email_draft | recipientRef: string or null; subject, bodyText: string; attachments: array of {kind: image/pdf/other, ocrText?: string}; previewState: editing/preview/sent |
| ticket | customerRef: string or null; ticketId: string; orderId: string or null; status: open/done; summary: string |
| input_activity | surface: order/email/ticket; typing: boolean; lastInputAtMs, idleMs: nonnegative session-relative milliseconds |

`entityRef` is the recognized customer, matching order/ticket customerRef. Email
recipientRef may instead be a contact ID, as in B's fixture; do not equate those
identifiers. Unknown or unreadable order values are **null**, never guessed. Visual
order/email/ticket observations have `source: vision`, a processed `frameId`, and
resolvable Evidence. `sourceRevision` is the opaque capture-time workspace revision
or null for untracked external screens. Only input_activity uses `source: workspace`;
it has null frame/revision/entity and no Evidence. It describes our embedded
workspace, never global keystrokes, and contains no typed text.
`idleMs` always equals `timestampMs - lastInputAtMs`.
No questions, learned rules, reasoning or Work Map appear in screen facts.

## Ordering and lifecycle

- Capture timestamps are assigned before async work, not when vision finishes.
  Sequence starts at 1 per start/session, strictly increases and can have gaps.
  Timestamps are nondecreasing. Observation IDs must be unique within the session.
- Out-of-order completion may be dropped: a result older than an already emitted
  sequence must not move the consumer's state backwards. ObservationGate implements
  this option. A consumer should also reject another session or older sequence.
- Calling pause synchronously closes the emission gate and invalidates in-flight
  tokens. Its Promise resolves only after capture dispatch, network-send queue and
  recording writes are stopped/drained or discarded. No later observations,
  external sends or recording appends may come from pre-pause work. Cancellation
  cannot recall a request already sent. Status paused is emitted at completion.
- Resume retains session epoch and sequence, opens a new generation, and captures
  new work. Paused time stays on the shared wall timeline, leaving a gap; it is not
  compressed or replayed later. The mock discards fixture events due during pause.
- Stop closes all active work and invalidates the generation; resume after stop
  rejects. Starting a session resets ordering and active Evidence lookup, even if
  a caller reuses the same sessionId. Serialize lifecycle commands in real adapters.
- Capture loss/errors emit error with reason; consumers must show that observation
  has stopped. Voice/off-record coordination belongs entirely to B.

ObservationGate is a small helper for frame tokens. It does not stop media tracks,
write queues or model requests; real adapters must enforce those responsibilities.
The mock has none of these side effects, so pause/stop complete immediately.

## Evidence

Evidence references point only to already persisted **processed** assets. A real
adapter must make every referenced ID resolvable before publishing its observation.
Both frame and clip intervals have endMs >= startMs, matching B's fixture. The resolved object is
`{assetRef, startMs, endMs}`. assetRef is an opaque controlled URL/reference, not
an unrestricted local path. Replay converts relative timestamps using the media
owner's player convention. IDs should be globally unique in real persistence.

`resolveEvidence` rejects unavailable IDs (missing, not committed, expired, wrong
session/access denied); it must not return an empty or unrelated asset. The mock
uses EvidenceUnavailableError with code EVIDENCE_UNAVAILABLE. A published asset
remains resolvable while paused and after stop for Review. Starting another mock
session resets lookup; real cross-session archive lookup must be explicit and
access-checked by the Evidence owner. `mock://` references are labels, not files or
playable recordings, and must never be displayed as real capture.

## Checkpoint

Preview emits an ActionCheckpoint whose observationIds include the **latest order**
and **latest email draft** observation from the current session. The email must be
in preview state. `assertCurrentCheckpoint` checks those conditions, session,
referenced IDs, time, and both non-null source revisions against an already ordered
snapshot of vision observations. It contains no DOM-derived facts.
The bridge delivers onCheckpoint to B and accepts replyToCheckpoint. The mock
raiseCheckpoint helper emits from its published snapshot and rejects stale, unknown
or duplicate replies. Every reply has `basedOn` equal to the checkpoint's opaque
order/email revisions. CheckpointHandler is only an optional local function adapter.
The sandbox still owns request waiting/cancellation, timeout UI and human Send.

While waiting for B, keep Send pending. Revalidate against the current snapshot
when the reply arrives; any edit/new order/email, reset, pause or session change
invalidates the pending check. The sandbox owns generation/cancellation for that
pending request and rejects mismatching reply.checkpointId or basedOn. The provisional
agent-reply deadline is 4000 ms after dispatch; evidence acquisition has a separate
bounded timeout. Timeout/rejection/malformed reply displays an incomplete check or
an explicit unknown result. Never turn errors into clear. `unknown` is uncertainty,
not a completed successful check. `warn` explains the concern and references
Evidence; `clear` means B completed its check, not an automatic send. Human Send
must still be a separate action. The default fixture contains no tutor decision.
Freshness comes from trusted provenance and current opaque revisions, not the
historical 75-second limit or the provisional single-frame age rule.

## Mock usage

```ts
const bridge = new MockScreenBridge(10_000);
const unsubscribe = bridge.onObservation(console.log);
await bridge.start({sessionId: 'synthetic-session', sessionEpochMs: 10_000});
bridge.advanceTo(11_000); // event captured at timestampMs 1000
await bridge.pause();
bridge.advanceTo(13_000); // due events discarded
await bridge.resume();
bridge.advanceTo(14_000); // next event timestampMs 4000, not 2000
await bridge.stop();
unsubscribe();
```

`createScreenFixtures` provides only synthetic visible facts and labelled Evidence.
It includes a recognized and an unknown entity, all four fact shapes, a preview,
and a local input heartbeat. It contains no customer_07 policy, canned interview
questions or expected tutor outcomes. B keeps its scenario expectations separately.

## Integration boundary

The historical B draft and fixture predate doc-7 and are no longer compatibility
oracles. Tests exercise the accepted schema directly, including nullable facts,
provenance restrictions, the idle-time equation, revision correlation, absence of
DOM facts, pause gaps, and stale-reply rejection.

The contract does not make the current HTTP vision path checkpoint-capable. Real
integration still needs a trusted per-observation provenance registry that verifies
the latest order/email bindings when dispatching, applying a reply, and sending.
The agreed polling route belongs to the vision/API owner and is intentionally not
implemented by this skeleton.
