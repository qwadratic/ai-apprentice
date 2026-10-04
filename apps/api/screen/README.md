# TASK-2.3 vision and Evidence transport

This package turns processed screen frames into validated canonical
`ScreenObservation` objects. It imports the shared types and validators from
`@apprentice/contracts`; it does not define a second ScreenBridge contract. The
package is framework-neutral and leaves route registration, SQLite metadata and
media retention to the shared API backend.

## Server composition

Use `createScreenService` with the canonical `parseScreenObservation`, an
`EvidenceMetadataRepository` backed by the shared SQLite database, and either a
file or compatible processed-media store. `createRunnerClient` reads
`RUNNER_URL` and `RUNNER_TOKEN` on the server and calls `POST /v1/vision`.
Neither value belongs in browser configuration, fixtures, responses or logs.

The runner must return the strict `VISION_RESULT_SCHEMA`. `parseVisionResult`
rejects extra fields, unsupported fact shapes and incomplete results. A frame of
a known workspace surface is read with `WORKSPACE_VISION_SCHEMA` (order, email,
ticket or incomplete), unchanged since before generic vision. A frame with no
surface (a shared screen of any app) may also return `screen_activity`:
`{app, surface, summary, change, entities, pendingAction, pendingRegionId,
regions: [{id, label, box: [x, y, w, h]}]}`, boxes normalised 0..1 to the frame,
at most 6 regions and 8 entities; masked areas are never read. Such an
observation has `entityRef` and `sourceRevision` null, so it never satisfies a
checkpoint. `VISION_GENERIC=off` reads surface-less frames as before. The
observation factory validates its output again with the canonical parser. It
copies only visible facts; unknown identities stay `null`, and customer/order
references remain separate fields.

`createFileEvidenceStore` writes only frames marked `processed: true`, verifies
PNG/JPEG/WebP signatures and byte limits, atomically installs media before
metadata, and verifies both before resolving an Evidence reference. Inject the
shared backend's metadata repository; this package intentionally creates no
database or deployment. `createMemoryEvidenceStore` exists for tests only.

## Generic screens (TASK-3.52)

Only a frame with no workspace surface takes the generic path; its shape and
limits are above. The generic prompt and system add these rules to the
visible-only rules of the workspace path, which stay unchanged:

- `app` comes only from visible branding, otherwise `null`. Nothing is inferred
  from the DOM, another tab or hidden application state. An unrecognised but
  readable app still produces an observation; only an unreadable frame is
  incomplete.
- Masked, blurred or unreadable content is never guessed, and screen text is
  untrusted content, never instructions.
- A box is `[x, y, width, height]` normalised to the processed frame, with
  `x + width <= 1` and `y + height <= 1`. `parseVisionResult` cuts a box that
  runs past the right or bottom edge at the edge before the canonical parser
  sees it, because that parser (also applied by the browser to polled
  observations) rejects it. NaN, negative values and values above 1 still
  reject the frame.
- The model sees one frame, so `change` is null unless the pixels show direct
  evidence of a change; the conductor also treats a changed summary or surface
  as a change.

Visible `entities` are descriptive strings, not customer identities. The
conductor keeps app, surface, summary, change, pendingAction and regions;
`entities` and `pendingRegionId` stay in the canonical observation but are not
separate question inputs, so the summary should carry the question-relevant
visible facts and each relevant region needs a label.

`vision-generic.test.ts`, `vision-contract.test.ts` and
`screen-activity.test.ts` cover the generic path. The last one runs one
processed frame per app (Gmail, Sheets, Maps and an unknown app) through the
hub, evidence store and conductor to a question at a pause, with evidence and
region cues, no question while the expert types and no observation after
off-record. Only the provider response and the image are synthetic, so this
does not certify live vision accuracy. For a manual rehearsal, share a real
Gmail, Sheets or Maps window with the normal masking controls, do visible work
and pause; check the observation's app, summary, evidence and region cue. Then
try an unrecognised readable app and a masked or unreadable frame, and check
that off-record stops observation delivery. Never claim to block Gmail Send or
Google Sheets autosave.

## Session HTTP contract

All routes require an exact configured Origin. Except for session start, routes
also require the opaque session bearer returned by start. The API stores only a
SHA-256 hash of that token.

### Start

`POST /screen/sessions/{sessionId}/start`

```json
{"sessionEpochMs": 100000, "clientGeneration": 1}
```

The response is `201`:

```json
{
  "sessionId": "session-id",
  "generation": 1,
  "sessionToken": "opaque-ephemeral-token",
  "nextCursor": 1,
  "status": {"schemaVersion": 1, "sessionId": "session-id", "state": "capturing"}
}
```

### Submit a processed frame

`POST /screen/sessions/{sessionId}/frames` with `Authorization: Bearer ...`:

```json
{
  "generation": 1,
  "frameId": "frame-id",
  "timestampMs": 1500,
  "processed": true,
  "mediaType": "image/png",
  "data": "padded-base64",
  "provenance": {
    "surface": "order",
    "sourceRevision": "opaque-order-revision",
    "captureGeneration": 7
  }
}
```

`surface`, `sourceRevision` and `captureGeneration` are opaque capture context,
not DOM-derived facts. Capture should alternate `order` and `email` surfaces for
a combined workspace. The service adds a surface-specific instruction and uses
the surface in its deduplication key, so identical processed pixels may be
analyzed once for each surface. A result gets `sourceRevision` only when its
vision-derived kind matches the requested surface. A mismatch may remain useful
as history but cannot satisfy a checkpoint.

The response is `202` for accepted work, `200` for duplicate or sampled frames,
`400` for malformed frames, and `409` for inactive, stale, out-of-order or old
generation work. Acceptance means queued for recognition; it is not an
observation.

### Poll results

`GET /screen/sessions/{sessionId}/updates?cursor=N&generation=G`

```json
{
  "sessionId": "session-id",
  "generation": 1,
  "observations": [],
  "statuses": [],
  "nextCursor": 1
}
```

The event log is bounded to 128 entries and each response returns at most 50. A
client must advance to the returned cursor. A cursor older than retained history
returns `409 cursor_expired` with `minCursor` and `nextCursor`; a generation
mismatch returns `409 generation_mismatch` with the current generation and
cursor. The client must resynchronize instead of silently treating either case
as an empty result.

### Lifecycle

`POST /screen/sessions/{sessionId}/lifecycle`:

```json
{"generation": 1, "command": "pause", "reason": "off_record"}
```

Pause, resume and stop cancel active work, clear pending work, increment the
server generation and reset the event log. The first new event is the lifecycle
status, so the response has `nextCursor: 1`:

```json
{
  "sessionId": "session-id",
  "generation": 2,
  "nextCursor": 1,
  "status": {
    "schemaVersion": 1,
    "sessionId": "session-id",
    "state": "paused",
    "reason": "off_record"
  }
}
```

Subsequent frames, polls and lifecycle requests must use generation 2. A delayed
model response from generation 1 cannot publish after this transition.

### Evidence

- `GET /screen/sessions/{sessionId}/evidence/{id}` resolves metadata.
- `GET /screen/sessions/{sessionId}/evidence/{id}/asset` serves processed bytes
  with `no-store` and `nosniff` headers.

Every observation contains an Evidence ID only after save and resolve succeed.
Its `assetRef` uses the scoped asset route above. Authorization checks the
session before returning metadata or bytes.

## Queue, freshness and checkpoints

Defaults are one active request, one replaceable pending frame, a 1500 ms sample
interval, a 65 second request timeout, and a 75 second maximum capture-to-result
age. Concurrency may be raised to two. The pending slot keeps the newest accepted
frame, exact processed pixels are deduplicated per requested surface, and older
responses cannot overwrite a newer published result. A timed-out physical call
keeps its concurrency slot until its transport settles, preventing repeated
pause/resume from bypassing the limit.

The 75 second limit permits useful historical observations. It does not make an
observation current enough for Preview or Send. `ObservationProvenanceRegistry`
retains the latest vision-derived `order_view` and `email_draft` bindings. A
checkpoint is usable only when both observation IDs are present, both opaque
revisions match the checkpoint, and both records belong to the current server
and capture generations. Without trustworthy surface context, observations have
`sourceRevision: null` and remain history-only. If either surface has not produced
a matching valid result, the checkpoint stays incomplete.

Provider, validation, timeout, limit and storage failures become safe error
statuses. They never become successful observations. Diagnostics expose safe
codes and processing/capture latency only; they exclude images, model payloads,
prompts, credentials and provider exception text.

## Verification

With Node 22 or newer and the canonical contracts available:

```sh
node --test packages/screen/vision/queue.test.ts \
  apps/api/screen/runner-client.test.ts \
  apps/api/screen/screen.test.ts
```

The tests use synthetic processed media and mock runner responses. They cover
bounded scheduling, per-surface deduplication, out-of-order completion,
pause/session invalidation, cursor expiry, exact lifecycle generations,
session-scoped authorization, strict model validation, unknown identity,
resolvable Evidence before publication and safe runner errors.

The reported infrastructure benchmark for `/v1/vision` is approximately 3.77 s
p95. This package has not repeated a real provider call. Real runner accuracy and
latency, browser masking equivalence, SQLite persistence, retention and host
framework wiring remain integration checks and must be reported separately from
the mock suite.
