# Processed screen recording

`ProcessedRecorder` records only `ScreenCapture.createProcessedStream()`. It rejects audio tracks and closes the active processed track synchronously from `onInvalidate`, before mask review or resized pixels can be painted. Every capture interval becomes a separately finalized `RecordingSegment`; paused intervals are gaps in session time and do not exist in the media.

```ts
const recorder = new ProcessedRecorder(capture, {
  onSegment(segment) {
    refreshReplayControls(); // exposed only after the asset store completes
  },
  onFailure(failure) {
    showRecordingFailure(failure.code);
  },
});

const panel = mountReplayPanel(element, {
  resolveEvidence,
  recordingSegments: () => recorder.getSegments(),
  sessionId,
  resolveRecordingAsset: async (segment) => {
    const blob = await recorder.resolveAsset(segment.assetRef);
    if (!blob) throw new Error('Recording is unavailable.');
    return blob;
  },
});
```

The default asset store is IndexedDB and survives page reloads. It stores the ready segment metadata with the media; use `listSegments(sessionId)` to restore the replay timeline in a new page instance. Pass a `RecordingAssetStore` to use another durable destination. `HttpChunkRecordingStore` implements the standalone `/screen/sessions/:sessionId/recordings/:assetId` chunk/finalize/asset protocol; it splits MediaRecorder output into bounded pieces and accepts an application-owned auth-header provider. A store's `save` method must resolve only after the complete segment is durable. A failed or timed-out save publishes no segment.

Call `flush()` before exporting a timeline, and `dispose()` when capture is unmounted. Unsupported formats fail during construction. Recorder errors, empty output, storage errors, and a bounded finalization timeout are reported explicitly through `onFailure`.
