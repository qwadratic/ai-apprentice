# TASK-2.3 independent vision and Evidence slice

This slice uses dependency-free ES modules and Node 24 built-ins. It does not choose
the shared server framework, create a runner, add root dependencies, or define the
external ScreenBridge/facts contract. The test schema in `screen.test.mjs` is only a
local synthetic test shape. TASK-1 and TASK-2.1 remain integration dependencies.

## Entry points

- `createRunnerClient({ env, transport })`: server-only doc-5 client. Reads
  `RUNNER_URL` and `RUNNER_TOKEN`; POSTs `images`, `prompt`, `system`, `schema`, and
  optional `model` to `/v1/vision`. Returns `{json, ms}` only for a structured success.
  Missing configuration, auth, limits, timeout, unavailable transport and malformed
  output are typed errors. Response bodies and provider exception messages are never
  included in errors. Redirects are rejected to keep bearer credentials on the runner.
- `createFileEvidenceStore({mediaDir, metadata})`: pass the shared `MEDIA_DIR` and a
  metadata repository exposing async `put(record)`, `get(id)`, `remove(id)`. The
  shared backend must implement these with its existing SQLite design. This module
  creates no tables or parallel metadata database. Media writes use temporary files
  and atomic rename before committing metadata; metadata failure triggers cleanup.
  `resolve(id)` checks metadata and media availability. `read(id)` serves bytes.
- `createMemoryEvidenceStore()`: bounded nonpersistent adapter for synthetic tests.
- `createScreenService({runner, schema, validate, makeObservation, evidence,
  publish, prompt, onEvent, queueOptions})`: composition root. Import `schema`, the
  strict synchronous `validate` function, and the synchronous `makeObservation`
  factory from the approved TASK-1 implementation. Validator returns a validated
  object or throws; falsy and Promise results fail closed. Factory receives
  `{sessionId, frameId, timestampMs, sequence, evidence}` and must produce and
  validate the canonical ScreenObservation, including its approved facts and
  `evidenceIds`. `publish` must synchronously publish to the current bridge; it must
  not return a deferred network send. The composition root owns UI/status mapping.
- `mount(app, {register, service, authorize})`: framework-neutral registration;
  `register(app, {method,path,handle})` adapts a Web `Request` and route `{id}` to
  the host framework and sends the returned Web `Response`. No implicit Express,
  Fastify, CORS, public server or browser token is introduced.

## Proposed internal routes (pending framework/recording integration)

- `POST /screen/frames`: JSON `{sessionId,frameId,timestampMs,processed:true,
  mediaType,data}` where `data` is standard padded base64 of a processed PNG/JPEG/WebP.
  Returns 202 for accepted scheduling, 200 for duplicate/sampled frames, 400 for
  invalid input, 409 for inactive/stale/out-of-order frames. Acceptance is not a
  successful recognition; observations/errors arrive through the service callbacks.
- `GET /screen/evidence/:id`: verifies availability and returns the internal record.
- `GET /screen/evidence/:id/asset`: returns stored media, with no-store and nosniff.

`authorize(request, null)` authenticates before reading any body or metadata.
`authorize(request, sessionId)` then authorizes access to that specific session.
The shared API supplies its actual user/session authentication and exact-origin
CORS policy. Missing authorization callbacks prevent mounting. Never expose
`RUNNER_TOKEN` or the infrastructure test `API_TOKEN` to the browser.

The internal storage record contains `id`, `kind:'frame'`, `sessionId`, `frameId`,
`assetRef`, `startMs`, `endMs`, `mediaType`, `byteLength`. It is an adapter record,
not a second ScreenBridge. Its `assetRef` currently uses the proposed asset route;
recording and the orchestrator must agree the final resolver/mapping before integration.
No clip recording is implemented here. Frame records use equal start/end times.

## Lifecycle, bounds and freshness

Call `start({sessionId,sessionEpochMs})` from the bridge lifecycle, then offer
processed frames using session-relative `timestampMs`. Capture owns unique
`frameId`s and monotonic capture times. The service copies input bytes before
scheduling so caller mutation cannot change model input or stored Evidence.

Default sampling is 1500 ms; exact processed-byte SHA-256 deduplication is server-side.
There is one active request and one latest pending frame by default; concurrency
may be configured to two to match the runner. An older accepted response can publish
while newer frames are pending. Results older than the last *published* capture
ordinal never publish. A new capture alone does not invalidate a slow response.

Pause, stop, resume and every start invalidate generations and clear pending work.
Active calls receive AbortSignal. A physical request holds its slot until its
transport/storage promise settles, even if an injected transport ignores abort;
thus repeated pause/resume cannot bypass the request limit. Such a broken transport
may stall progress; timeout is reported without silently admitting unlimited work.
The real fetch adapter honors abort. No automatic model retry loop is implemented;
a failed frame can be retried on a subsequent capture after sampling, including
unchanged pixels once the failed request settles.

**Provisional, configurable timing:** client timeout 65000 ms and capture-to-result
age limit 75000 ms, accommodating doc-5's 60 s runner timeout. The queue rejects a
configured age limit shorter than its request timeout. The orchestrator must confirm
the production freshness criterion using real latency measurements. Queued frames
are checked again before dispatch; results again after model, storage and resolver.

### History is separate from current checkpoint eligibility

The 75 s limit permits historical observations to finish. It is **not** proof that
an observation describes the draft currently being sent. Internal methods
`setSourceRevision(revision)` and `offer(frame, {sourceRevision})` connect the
scheduler to an authoritative draft/source revision without adding fields to
ScreenBridge or to model JSON. Use a new opaque revision for every relevant change
to draft text, recipients, attachments, selected customer/order or source geometry.
Attach the revision that was current **at capture**, not the revision at upload.
Setting the revision to `null` explicitly marks the source as untracked.

Before using a frame for Preview/Send, the checkpoint owner must call
`canUseForCheckpoint({sessionId,frameId,sourceRevision})`. It fails closed unless
the latest published frame has matching capture provenance, the source-generation
and lifecycle-generation still match, capture is active, and the frame satisfies
the separate `maxCheckpointAgeMs` (provisional default 2500 ms). Revision changes
invalidate eligibility immediately, even if the old response later publishes to
history within 75 s. An intermediate edit invalidates old work even when a previous
revision label is reused. Unknown provenance never gives eligibility. Pause/resume
and session starts clear provenance and require the source owner to resynchronize it.
The internal `published` diagnostic event also exposes `checkpointEligible`.

This guard establishes source freshness only; it is not the agent's `clear` result
and does not authorize Send. The checkpoint owner must recheck it when applying an
agent reply, and verify the draft revision again at Send. A changed source requires
a new checkpoint or an explicit incomplete/unknown state. The proposed HTTP upload
handler does not trust a browser-supplied revision and therefore produces history-only
frames until an authoritative capture/checkpoint provenance adapter is wired.

Integration proposal for TASK-1/TASK-2.4: map checkpoint observation IDs to internal
session/frame/source-revision provenance (or approve a versioned contract field),
invalidate checkpoint replies on source/lifecycle changes, and resynchronize revision
updates with capture. Neither this module nor its tests extend the shared contract.
The orchestrator must confirm the checkpoint age limit after real latency tests;
a slow API may produce useful history while the checkpoint remains incomplete.

Events contain only `type`, safe `code`/discard `reason`, session/frame/time identifiers,
sequence and capture-to-publication `latencyMs`. No model payload, image, prompt,
credentials or provider messages are logged. The host UI must surface typed errors
and dropped/stale results instead of turning them into successful recognition.

## Processed media trust and retention

Only explicitly processed frames are accepted. MIME signature and byte limits are
checked; the marker does **not** prove redaction or image decodability. Actual masking
and processed-preview equivalence must be verified by the capture owner in a browser.
This module does not receive or save a parallel raw frame. Disk files use UUID names
and mode 0600; metadata is published only after the media write completes. Failed
publication, pause during persistence, crash or partial cleanup can leave unreferenced
processed files. The shared backend owns retention, quota and orphan reconciliation.
MEDIA_DIR must be a trusted directory writable only by the backend service account.

## Verification

From the repository root with Node 24 available:

```sh
node --test packages/screen/vision/queue.test.mjs apps/api/screen/runner-client.test.mjs apps/api/screen/screen.test.mjs
```

Tests use deferred fake model responses, a fake clock, a test-only schema, an opaque
synthetic PNG, bounded memory and temporary disk directories. They verify queue
bounds, ordering, slow/expired responses, pause/session cancellation, timeout,
resolvable Evidence before publication, unknown-customer preservation, safe failures,
doc-5 transport shapes, HTTP authorization and persistence failures. File-store
recreation tests reuse an injected metadata repository; they do not verify SQLite or
VM reboot persistence. Mock latency tests verify calculation, not provider performance.

Real runner/OCR/schema accuracy, p50/p95 latency, sustained 1 frame per 2 s, browser
capture, privacy equivalence, recording/replay navigation, approved facts imports,
host framework mounting, SQLite adapter, CORS and actual session authentication
remain integration checks. No real provider call or credentials were used.
