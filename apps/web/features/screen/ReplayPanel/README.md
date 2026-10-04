# ReplayPanel

Mount the DOM adapter in the app shell and dispose it from the React effect cleanup. The bridge contract stays unchanged; the recorder supplies only finalized `RecordingSegment` objects.

From an integration file in `apps/web/features/screen`, the complete imports and adapter are:

```ts
import type {ScreenBridge} from '@apprentice/contracts';
import {ProcessedRecorder} from '../../../../packages/screen/recording/index.js';
import type {ScreenCapture} from '../../../../packages/screen/capture/ScreenCapture.js';
import {mountReplayPanel, type ReplayPanelHandle} from './ReplayPanel/index.js';

export function mountRecordedReplay(
  element: HTMLElement,
  bridge: ScreenBridge,
  capture: ScreenCapture,
  sessionId: string,
): {recorder: ProcessedRecorder; replay: ReplayPanelHandle} {
  const recorder = new ProcessedRecorder(capture);
  const replay = mountReplayPanel(element, {
    resolveEvidence: (id) => bridge.resolveEvidence(id),
    recordingSegments: () => recorder.getSegments(),
    resolveRecordingAsset: async (segment) => {
      const blob = await recorder.resolveAsset(segment.assetRef);
      if (!blob) throw new Error('Recording asset is unavailable.');
      return blob;
    },
    sessionId,
  });
  return {recorder, replay};
}
```

Open with `await replay.openEvidence(evidenceId, observation.timestampMs)`. React effect cleanup should call `replay.dispose()` and `await recorder.dispose()`.

An exact timestamp covered by a recording segment opens its local media offset. A timestamp in a pause gap does not jump to other footage; the resolved processed frame is shown instead. The panel reports resolver, image, video, timeout and inaccurate-seek failures, suppresses stale asynchronous results when selections change, aborts the active resolver on replacement/unmount, and releases media on cleanup. The load/seek deadline is 10 seconds by default (`loadTimeoutMs` overrides it); a completed seek is accepted only within 150 ms of the requested media offset (`seekToleranceMs` overrides it).

`browser.test.ts` is the automated browser integration exercise. It mounts the real adapter, opens generated video at an exact non-zero offset, exercises the frame fallback, stale selection suppression, stalled resolution and asset failure, and verifies cleanup.
