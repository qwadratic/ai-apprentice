# Processed screen capture (TASK-2.2)

This module is independent of the repository skeleton and ScreenBridge. It owns browser display capture, opaque manual masks, a processed preview canvas, and cancellable frame delivery. It does not implement vision, server storage, recording, replay, audio, or business observations.

## Public internal port

Create `ScreenCapture` in a browser with an `onFrame(frame, lease)` callback. Call `start({ sessionId, sessionEpochMs })` directly from a user gesture. The session owner supplies the common epoch. A browser picker selects the screen/window; capture requests `{ video: true, audio: false }`. Any unexpected audio tracks are stopped. The raw stream/video stays private.

The first image is a **local processed preview only**. No downstream frames or stream are available until the user reviews masks, calls `confirmMasks(snapshot.geometry.revision)`, and calls `resume()`. This also supports explicitly confirming an empty mask list. The preview can display sensitive unmasked content locally during review; it is not sent downstream. `canvas` is for mounting the preview; consumers must not mutate it or create their own automatic streams.

- `getSnapshot()` and `subscribe(listener)` expose internal capture state, masks, geometry revision, review requirement, and generation. These are not ScreenBridge types.
- `setMasks(rectangles)` validates and copies normalized source rectangles, pauses delivery, invalidates work, paints opaque black masks, and requires confirmation again. Edges round outwards. CSS-scaled previews do not affect source coordinates.
- `beginMaskReview()` pauses before editing and refreshes the local preview. `pause()` freezes normal preview/delivery and invalidates work. `resume()` returns false when masks need review or the source is unavailable. `stop()` releases tracks, cancels the render loop, and blacks out the preview. `dispose()` also removes subscriptions.
- Each immutable PNG `ProcessedFrame` has `sessionId`, unique `frameId`, `sequence`, `timestampMs`, `generation`, `geometry`, `provenance`, and `image: Blob`. Times are milliseconds since the supplied common epoch and keep session gaps across pauses. `provenance` is a frozen copy of `{ surface, sourceRevision }`, read synchronously after the processed pixels are painted and before `toBlob` starts. Capture never retains the provider's object. The standalone default is `{ surface: null, sourceRevision: null }`.
- There is at most one encode/downstream job in the current generation and **no pending-frame queue**. While a callback is busy, frames are dropped. Pause/stop/resize/mask edits/mute abort the current lease and clear the occupied slot. Old encoder callbacks and promise completions cannot deliver or clear a new generation's slot.

The host may supply `snapshotProvenance()` in `CaptureOptions`. It must synchronously return only `surface: 'order' | 'email' | 'ticket' | null` and an opaque non-empty `sourceRevision` of at most 200 characters, or `null`. Invalid data or provider exceptions fail closed before a frame is emitted. The captured association describes the host context at canvas snapshot time; it does not prove that display-video pixels already contain a particular DOM revision.

### Required vision cancellation integration

Pass `lease.signal` through vision HTTP calls and any local queue. Before committing a result, check `lease.isCurrent()` after every awaited operation and immediately before publishing an observation or Evidence. A consumer that ignores this lease can still apply its own stale result; the capture module cannot undo external side effects. Already transmitted data is not recalled by a pause.

`onInvalidate(listener)` fires synchronously after the generation advances, the lease aborts, and processed tracks are disabled. It supplies `{ generation, reason, timestampMs }`; unsubscribe on disposal. Use it to clear vision queues and pause downstream recording before any local review image is painted. Source `mute` pauses; `unmute` restores manual resume controls without automatically reopening delivery; `ended` stops. Processing/consumer errors close the gate and release capture. Picker denial/cancellation is shown as `permission-denied` and can be retried. Stop while a picker is outstanding disposes its eventual stream instead of starting it.

When a workspace reset or other context boundary invalidates earlier observations, the host must call `pause('user-paused')` first. Its `onInvalidate` handler aborts frame uploads and clears the old observation registry, then the host installs the new provenance provider state and explicitly calls `resume()`. An ordinary revision change may update the provider synchronously for the next painted frame; a frame already being encoded keeps its copied revision, and a pause drops it entirely. Never read current DOM state later in the upload callback.

### Geometry and mask limitations

Source dimensions are checked on every render tick, on the video `resize` event, and synchronously before confirmation/resume/stream creation. An encoding checks dimensions again before delivery. Changed dimensions disable output and require confirmation of the **new geometry revision**. Normalized masks are retained as review suggestions, not automatically trusted. The local review preview refreshes on geometry change or explicit mask editing; ordinary pause freezes it.

A fixed rectangle does not track text that moves, scrolling, or same-size content changes. The panel says so explicitly. Source switching must use stop/start and fresh mask review; do not add a silent source-switch path in the bridge adapter.

### Future recording port (TASK-2.5)

`createProcessedStream()` is allowed only after confirmation/resume and returns a **video-only canvas stream** using `captureStream(0)` and explicit `requestFrame()` after masked painting. It refuses unsupported manual capture instead of falling back to automatic or raw-source capture. Pause/mask edits/resize disable its tracks and stop requesting new frames; stop releases them. Buffered media frames from before a pause may still finish decoding; no new canvas frame is requested during pause.

Disabling a track is not a MediaRecorder pause. TASK-2.5 must subscribe to invalidation and state, pause/resume/finalize its recorder, map session time to segment time across gaps, test browser MIME support, and handle upload/finalization failures. It must never record the private display stream or create a second raw-screen recorder. Evidence server storage and asset resolution remain with vision/API. Recording and Replay are not claimed complete here.

## ScreenPanel integration

`apps/web/features/screen` exports `mountScreenPanel(root, { capture, session, controller })`. It mounts the **same processed canvas**, offers pointer-drawn masks and accessible percentage inputs, mask removal, confirm/share, pause/resume, stop, and status/error messages. Pass the canonical Promise-based bridge as `controller` so every lifecycle button reaches transport as well as capture; omission preserves the standalone capture harness. Controller invocation remains synchronous inside the click handler so `getDisplayMedia` keeps browser user activation. Cleanup stops local capture synchronously before asking an external controller to stop transport; local tracks and frame delivery close even when that controller throws, rejects, or never settles. It then removes DOM/listeners. Mount it inside the host React component's effect and call the returned cleanup on unmount; construct capture in the same effect, dispose it there, and use the host session owner's epoch. The adapter adds no React or root dependencies.

The orchestrator must wire this internal port to the approved contract, map status reasons, and connect lifecycle commands; no external ScreenBridge copy is included. An independent status of `selecting` or initial `paused` may need host presentation separate from the agreed bridge's state enum.

## Verification

Requires Node 24+ for the dependency-free test runner's TypeScript stripping. From the repository root:

```sh
node --test packages/screen/capture/tests/capture.test.ts
```

The tests exercise mask validation/pixels, pause gates, abort/lease invalidation, a busy consumer, stale encoders/promises, resize races, mute, denial, picker/play cancellation, source ending, unsupported manual streams, error cleanup, and unique identities after restart. The canvas model is for deterministic race/pixel tests; it does not prove native browser capture.

Run the optional browser test with an existing Playwright installation/browser, without changing root dependencies:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright PLAYWRIGHT_CHANNEL=chrome \
  node --test packages/screen/capture/tests/browser.test.ts
```

It uses a synthetic canvas as a test display source in real Chrome. It decodes real processed PNGs and a video frame from the processed stream, verifies that the synthetic email's entire region is black, compares PNG to preview pixels exactly, exercises numeric/pointer masks, pause/resume, resize review, source end, and unmount. The underlying display video may round RGB values during conversion; only unmasked reference colors permit a two-level tolerance. Mask coverage remains exact black in the PNG. Set `CAPTURE_SCREENSHOT_PATH` to save a local test screenshot.

Type checking with an available TypeScript compiler:

```sh
tsc --noEmit --strict --target ES2020 --module ES2020 --moduleResolution node \
  --lib ES2020,DOM packages/screen/capture/ScreenCapture.ts \
  packages/screen/privacy/masks.ts apps/web/features/screen/ScreenPanel/index.ts
```

Still required: real browser picker/OS permission and end-sharing smoke tests over HTTPS/localhost; browser compatibility on the target demo machine; approved ScreenBridge/vision integration; recording/Evidence/Replay tests in TASK-2.5; root package/CI checks after skeleton integration.

Browser API references: [display capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [canvas streams](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), [manual frame requests](https://developer.mozilla.org/en-US/docs/Web/API/CanvasCaptureMediaStreamTrack/requestFrame). Display capture requires a secure context and a user gesture; manual canvas frame requests must be supported on the target browser.
