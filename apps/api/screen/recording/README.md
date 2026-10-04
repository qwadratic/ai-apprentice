# Recording upload API

This directory exports a standalone, framework-neutral recording upload module from `index.ts`:

```ts
createFileRecordingStore(root, {maxAssetBytes?})
createRecordingHandlers({store, authorize, maxChunkBytes?})
mountRecording(app, {register, store, authorize, maxChunkBytes?})
```

`authorize(request, sessionId)` is injected by the production composition layer and may return a boolean or a promise. It must authenticate the request and authorize the exact session from the route. The recording module does not interpret session tokens itself.

`mountRecording` expects this registration adapter:

```ts
register(app, {method, path, handle})
```

The routes are:

```text
POST /screen/sessions/:sessionId/recordings/:assetId/chunks
POST /screen/sessions/:sessionId/recordings/:assetId/finalize
GET  /screen/sessions/:sessionId/recordings/:assetId/asset
```

Chunk requests contain raw recording bytes, a supported recording `Content-Type`, and an `X-Recording-Chunk-Index` header. Finalization requests contain JSON `{chunkCount, mimeType, segment?}`. When supplied, `segment` is a complete `RecordingSegment`: its session, asset ID/reference, MIME type, finite non-negative intervals, and duration coverage are validated against the route and upload. The segment is stored in the same atomic final manifest and returned in the finalize response. A finalized asset uses the reference `recording:${sessionId}:${assetId}`.

The default maximum chunk size is 4 MB and the default maximum finalized asset size is 256 MB. Chunks must arrive in order. Repeating the same chunk is idempotent; changing an already accepted chunk is a conflict. A recording becomes readable only after the complete binary and its final manifest have been published atomically. Pending chunks and interrupted finalization are never returned by the asset route.

The file store serializes operations only within one Node.js process. Do not mount multiple application processes against the same storage root without replacing it with a store that provides cross-process coordination or object-storage semantics.

No server-side asset index is defined here. The host composition is responsible for persisting or indexing finalized segments when it needs to restore all recordings for a session; the browser store likewise owns its local segment index. This internal upload metadata does not change the shared ScreenBridge contract.

## Production integration

The production composition layer must mount the chunk route with raw binary request handling. The existing `createApi` / `registerWebRoute` path serializes `req.body` as JSON and therefore cannot carry recording chunks unchanged. Browser CORS configuration must also allow `Content-Type`, `Authorization`, and `X-Recording-Chunk-Index`. These requirements belong in the API mount/configuration layer; this standalone module deliberately does not modify it.

`recording.test.ts` starts an isolated loopback HTTP adapter and proves chunk upload, finalization, authorization, and byte-for-byte retrieval. It does not exercise the production `createApi` / `registerWebRoute` adapter, prove browser CORS behavior, or establish that its short synthetic WebM-like bytes are browser-decodable media. Browser recording tests must provide the actual encoded-media proof.
