import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createFileRecordingStore } from '../../../apps/api/screen/recording/store.ts';
import { createRecordingHandlers } from '../../../apps/api/screen/recording/handlers.ts';
import type { CaptureInvalidation, CaptureSnapshot } from '../capture/ScreenCapture.ts';
import type { ProcessedCaptureSource, RecorderRuntime, RecordingAssetStore } from './ProcessedRecorder.ts';

async function load() {
  const root = new URL('../../../', import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'processed-recorder-'));
  for (const path of ['packages/screen/recording/ProcessedRecorder.ts', 'packages/screen/evidence/index.ts']) {
    const output = join(directory, path.replace(/\.ts$/, '.js'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, stripTypeScriptTypes(await readFile(new URL(path, root), 'utf8'), { mode: 'strip' }));
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const module = await import(pathToFileURL(join(directory, 'packages/screen/recording/ProcessedRecorder.js')).href) as
    typeof import('./ProcessedRecorder.ts');
  return { ...module, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

class Track { enabled = true; readyState = 'live'; stopped = 0; stop() { this.readyState = 'ended'; this.stopped++; } }
class FakeRecorder extends EventTarget {
  state: RecordingState = 'inactive';
  readonly stream: MediaStream;
  constructor(stream: MediaStream) { super(); this.stream = stream; }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError');
    this.state = 'inactive';
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['masked-video']) }));
      this.dispatchEvent(new Event('stop'));
    });
  }
}

class Capture implements ProcessedCaptureSource {
  now = 1_000; track: Track | null = null; created = 0;
  snapshot: CaptureSnapshot = Object.freeze({ state: 'capturing', session: { sessionId: 'session-1', sessionEpochMs: 0 },
    generation: 1, geometry: { width: 1, height: 1, revision: 1 }, masks: [], reviewRequired: false });
  private states = new Set<(snapshot: CaptureSnapshot) => void>();
  private invalidations = new Set<(event: CaptureInvalidation) => void>();
  getSnapshot() { return this.snapshot; }
  subscribe(listener: (snapshot: CaptureSnapshot) => void) { this.states.add(listener); listener(this.snapshot); return () => this.states.delete(listener); }
  onInvalidate(listener: (event: CaptureInvalidation) => void) { this.invalidations.add(listener); return () => this.invalidations.delete(listener); }
  createProcessedStream() {
    this.created++; this.track = new Track(); const track = this.track;
    return { getAudioTracks: () => [], getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  }
  invalidate(timestampMs: number, reason: CaptureInvalidation['reason'] = 'user-paused') {
    for (const listener of this.invalidations) listener({ generation: 2, reason, timestampMs });
    assert.equal(this.track?.stopped, 1, 'privacy gate closes inside invalidation callback');
    this.snapshot = Object.freeze({ ...this.snapshot, state: 'paused', reason: 'user-paused' });
    for (const listener of this.states) listener(this.snapshot);
  }
  resume(now: number) {
    this.now = now; this.snapshot = Object.freeze({ ...this.snapshot, state: 'capturing', reason: undefined });
    for (const listener of this.states) listener(this.snapshot);
  }
}

class Store implements RecordingAssetStore {
  blobs = new Map<string, Blob>(); fail = false;
  async save(input: { segment: { assetRef: string; mimeType: string }; chunks: readonly Blob[] }) {
    if (this.fail) throw new Error('disk full');
    this.blobs.set(input.segment.assetRef, new Blob([...input.chunks], { type: input.segment.mimeType }));
  }
  async load(ref: string) { return this.blobs.get(ref); }
}

test('segments close synchronously and preserve session gaps across resume', async () => {
  const { ProcessedRecorder, cleanup } = await load();
  try {
    const capture = new Capture(); const store = new Store(); let serial = 0;
    const runtime: RecorderRuntime = { now: () => capture.now, create: (stream) => new FakeRecorder(stream) as unknown as MediaRecorder,
      isTypeSupported: (type) => type === 'video/webm', id: () => `r${++serial}`,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout };
    const recorder = new ProcessedRecorder(capture, { store, runtime, mimeTypes: ['bad', 'video/webm'] });
    capture.invalidate(2_000); await recorder.flush();
    capture.resume(5_000); await new Promise((resolve) => setTimeout(resolve, 0));
    capture.invalidate(7_000); await recorder.flush();
    assert.deepEqual(recorder.getSegments().map(({ startMs, endMs, mediaStartMs, mediaEndMs }) =>
      ({ startMs, endMs, mediaStartMs, mediaEndMs })), [
      { startMs: 1_000, endMs: 2_000, mediaStartMs: 0, mediaEndMs: 1_000 },
      { startMs: 5_000, endMs: 7_000, mediaStartMs: 0, mediaEndMs: 2_000 },
    ]);
    assert.equal((await recorder.resolveAsset(recorder.getSegments()[0]!.assetRef))?.size, 12);
    await recorder.dispose();
  } finally { await cleanup(); }
});

test('format/audio/constructor failures fail closed and stop every created track', async () => {
  const { ProcessedRecorder, RecordingSetupError, cleanup } = await load();
  try {
    const capture = new Capture();
    const base = { now: () => capture.now, id: () => 'id', setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: clearTimeout };
    assert.throws(() => new ProcessedRecorder(capture, { runtime: { ...base, isTypeSupported: () => false,
      create: () => { throw new Error('unused'); } } }), RecordingSetupError);
    const recorder = new ProcessedRecorder(capture, { runtime: { ...base, isTypeSupported: () => true,
      create: () => { throw new Error('constructor failed'); } }, onFailure: () => undefined });
    assert.equal(capture.track?.stopped, 1, 'constructor failure releases the processed track');
    await recorder.dispose();
    const audioCapture = new Capture(); const audio = new Track();
    audioCapture.createProcessedStream = () => { const video = new Track(); audioCapture.track = video;
      return { getAudioTracks: () => [audio], getVideoTracks: () => [video], getTracks: () => [video, audio] } as unknown as MediaStream; };
    const audioRecorder = new ProcessedRecorder(audioCapture, { runtime: { ...base, now: () => audioCapture.now,
      isTypeSupported: () => true, create: (stream) => new FakeRecorder(stream) as unknown as MediaRecorder } });
    assert.equal(audio.stopped, 1); assert.equal(audioCapture.track?.stopped, 1);
    await audioRecorder.dispose();
  } finally { await cleanup(); }
});

test('mask/geometry invalidations close synchronously and hanging persistence is bounded', async () => {
  const { ProcessedRecorder, cleanup } = await load();
  try {
    for (const reason of ['mask-review', 'geometry-changed'] as const) {
      const capture = new Capture(); const failures: string[] = [];
      const runtime: RecorderRuntime = { now: () => capture.now, create: (stream) => new FakeRecorder(stream) as unknown as MediaRecorder,
        isTypeSupported: () => true, id: () => reason, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout };
      const store: RecordingAssetStore = { save: async () => new Promise<void>(() => undefined), load: async () => undefined };
      const recorder = new ProcessedRecorder(capture, { store, runtime, mimeTypes: ['video/webm'], finalizationTimeoutMs: 15,
        onFailure: (failure) => failures.push(failure.code) });
      capture.invalidate(2_000, reason); await recorder.flush();
      assert.deepEqual(failures, ['finalization-timeout']); assert.deepEqual(recorder.getSegments(), []);
      await recorder.dispose();
    }
  } finally { await cleanup(); }
});

test('storage failure never publishes an incomplete segment', async () => {
  const { ProcessedRecorder, cleanup } = await load();
  try {
    const capture = new Capture(); const store = new Store(); store.fail = true; const failures: string[] = [];
    const runtime: RecorderRuntime = { now: () => capture.now, create: (stream) => new FakeRecorder(stream) as unknown as MediaRecorder,
      isTypeSupported: () => true, id: () => 'failed', setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: clearTimeout };
    const recorder = new ProcessedRecorder(capture, { store, runtime, mimeTypes: ['video/webm'], onFailure: (failure) => failures.push(failure.code) });
    capture.invalidate(2_000); await recorder.flush();
    assert.deepEqual(recorder.getSegments(), []);
    assert.deepEqual(failures, ['storage-failed']);
    await recorder.dispose();
  } finally { await cleanup(); }
});

test('HTTP client splits chunks and round-trips segment metadata through real handlers', async () => {
  const { HttpChunkRecordingStore, cleanup } = await load();
  const directory = await mkdtemp(join(tmpdir(), 'recording-client-protocol-'));
  try {
    const backend = createFileRecordingStore(directory);
    const handlers = createRecordingHandlers({ store: backend, maxChunkBytes: 3,
      authorize: (request) => request.headers.get('authorization') === 'Bearer test-token' });
    const seenIndexes: string[] = [];
    const handlerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init); const url = new URL(request.url);
      const match = url.pathname.match(/^\/screen\/sessions\/([^/]+)\/recordings\/([^/]+)\/(chunks|finalize|asset)$/);
      if (!match) return new Response(null, { status: 404 });
      if (match[3] === 'chunks') seenIndexes.push(request.headers.get('x-recording-chunk-index') ?? '');
      const handler = match[3] === 'chunks' ? handlers.chunk : match[3] === 'finalize' ? handlers.finalize : handlers.asset;
      return handler(request, { sessionId: match[1]!, assetId: match[2]! });
    };
    const client = new HttpChunkRecordingStore({ baseUrl: 'https://recording.test', authHeader: () => 'Bearer test-token',
      fetch: handlerFetch, maxChunkBytes: 3 });
    const segment = { id: 'asset-1', sessionId: 'session-1', assetRef: 'recording:session-1:asset-1',
      startMs: 100, endMs: 900, mediaStartMs: 0, mediaEndMs: 800, mimeType: 'video/webm' } as const;
    const bytes = new TextEncoder().encode('abcdefgh');
    await client.save({ segment, chunks: [new Blob([bytes], { type: segment.mimeType })] });
    assert.deepEqual(seenIndexes, ['0', '1', '2']);
    assert.deepEqual((await backend.read('session-1', 'asset-1')).asset.segment, segment);
    assert.deepEqual(new Uint8Array(await (await client.load(segment.assetRef))!.arrayBuffer()), bytes);

    const failing = new HttpChunkRecordingStore({ baseUrl: 'https://recording.test', authHeader: () => 'Bearer test-token', maxChunkBytes: 3,
      fetch: async () => Response.json({ ok: false, code: 'storage_failed' }, { status: 503 }) });
    await assert.rejects(failing.save({ segment: { ...segment, id: 'asset-2', assetRef: 'recording:session-1:asset-2' },
      chunks: [new Blob([bytes], { type: segment.mimeType })] }), /chunk 0 failed \(503\)/);
    await assert.rejects(backend.read('session-1', 'asset-2'), /asset_not_found/);
  } finally { await Promise.all([cleanup(), rm(directory, { recursive: true, force: true })]); }
});
