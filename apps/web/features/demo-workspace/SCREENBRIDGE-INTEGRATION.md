# Canonical ScreenBridge integration

TASK-2.4 uses the accepted doc-7 contract from `@apprentice/contracts`. The workspace does not define or copy ScreenBridge fields. `screenBridgeAdapter.ts` imports canonical types and accepts canonical runtime validators through dependency injection until the foundation commit is present on this branch.

## Data and provenance

- Learn uses `ORD-2041`, `customer_07`, `14 Sample Lane, 1010 Exampletown`, `2026-10-12 14:00-16:00`. The second customer_07 order is `ORD-2057` with a different address and window.
- Other cases are customer_03, an unidentified customer and two different customer_12 orders. No runtime case contains a customer preference, rationale, rule or expected tutor decision.
- Visual order, email and ticket facts must come from processed pixels through capture/vision. Do not construct their observations from workspace state, SVG source, case ids or test files. Attachment OCR text must come from image recognition.
- The workspace exposes only opaque `data-order-revision` and `data-email-revision` markers. They carry no content. Capture binds the marker visible at frame time to the vision observation's `sourceRevision`.
- The capture registry stores the latest order and email observations independently. Each entry keeps the surface and opaque revision sampled with that processed frame; a frame tagged for one surface must not be relabelled as evidence for the other. Preview waits until both entries match the requested revisions.
- Pause, stop, session replacement and capture-generation changes invalidate registry entries from the prior generation before a new checkpoint can use them.
- Only input activity comes directly from the workspace. It contains `{surface, typing, lastInputAtMs, idleMs}` and no typed text, entity or Evidence. The host adds the canonical observation envelope on the shared session timeline.

## Checkpoint adapter

Create `createScreenBridgeCheckpointAdapter` with a trusted `VisionObservationRegistry`, the canonical validators, the session clock and B's canonical `CheckpointHandler`.

On Preview the workspace changes its email revision and paints an explicit acquiring-screen-evidence state before the adapter waits for vision. Acquisition has a 15-second bound, chosen above the measured 2.5–3.8-second capture/vision latency and the one-second polling interval. The adapter passes that bound to `waitForCurrent` and accepts only ordered same-session vision observations whose order/email `sourceRevision` exactly matches the current opaque markers. It then builds and validates an ActionCheckpoint containing ids and revisions only. Immediately before dispatch it switches the workspace to Checking and starts the separate four-second agent-reply deadline required by doc-7. After B replies, it requires matching `checkpointId` and `basedOn`, snapshots the registry again and revalidates the same checkpoint. A new observation, edit, reset, session change, off-record, reordered snapshot, acquisition timeout or late/mismatched reply cannot authorize Send.

The app shell mounts `mountDemoWorkspace`, keeps one controller and loads `workspace.css`. Configure the workspace with `acquisitionTimeoutMs: 15_000` and `replyTimeoutMs: 4_000`. The shared session epoch is a stable value created once when the session starts; every activity and checkpoint timestamp uses that same epoch. For global off-record, call `setOffRecord(true)` while the coordinator pauses screen and voice; restore the canonical adapter and call `setOffRecord(false)` only when both channels are ready. On reset the coordinator starts a new shared session/epoch with `setSession`; confirmed agent memory remains owned by B and is not touched by this component.

## Integration work outside TASK-2.4

- The capture/vision owner supplies the ordered registry, binds frame-time surface plus opaque revision markers and invalidates entries on pause or generation changes. This module does not poll or synthesize vision facts.
- B supplies the CheckpointHandler. The component keeps an explicit acknowledgement for warn/unknown before the separate human Send action. Unknown and errors are labelled not verified.
- Email recipientRef may be a contact id while order/ticket entityRef is a customer id. The adapter does not invent or equate those identities.
- The global coordinator serializes capture pause/resume, session reset and voice off-record. Workspace `setOffRecord` only stops its checks and input heartbeat.

`tests/expectations.ts` is outside the production import graph and the preview server allowlist. Real capture, tutor behavior, global off-record and persistence of confirmed memory still require integrated browser rehearsal.
