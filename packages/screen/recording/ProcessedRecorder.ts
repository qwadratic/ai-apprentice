import type { CaptureInvalidation, CaptureSnapshot } from '../capture/ScreenCapture.js';
import type { RecordingSegment } from '../evidence/index.js';

export interface ProcessedCaptureSource {
  getSnapshot(): CaptureSnapshot;
  subscribe(listener: (snapshot: CaptureSnapshot) => void): () => void;
  onInvalidate(listener: (event: CaptureInvalidation) => void): () => void;
  createProcessedStream(): MediaStream;
}

export interface RecordingAssetStore {
  save(input: { readonly segment: RecordingSegment; readonly chunks: readonly Blob[] }): Promise<void>;
  load(assetRef: string): Promise<Blob | undefined>;
  remove?(assetRef: string): Promise<void>;
}

export type RecordingFailureCode = 'unsupported-format' | 'recorder-error' | 'finalization-timeout' |
  'empty-segment' | 'storage-failed';
export interface RecordingFailure { readonly code: RecordingFailureCode; readonly cause?: unknown }

export interface RecorderRuntime {
  now(): number;
  create(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(mimeType: string): boolean;
  id(): string;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface ProcessedRecorderOptions {
  readonly store?: RecordingAssetStore;
  readonly runtime?: RecorderRuntime;
  readonly mimeTypes?: readonly string[];
  readonly timesliceMs?: number;
  readonly finalizationTimeoutMs?: number;
  readonly onSegment?: (segment: RecordingSegment) => void;
  readonly onFailure?: (failure: RecordingFailure) => void;
}

type ActiveSegment = {
  readonly id: string; readonly sessionId: string; readonly startMs: number; readonly mimeType: string;
  readonly assetRef: string; readonly stream: MediaStream; readonly recorder: MediaRecorder; readonly chunks: Blob[];
  endMs?: number; settled: boolean; failed: boolean; finishing: boolean;
};

const DEFAULT_MIME_TYPES = Object.freeze([
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4',
]);

function browserRuntime(): RecorderRuntime {
  return {
    now: () => Date.now(),
    create: (stream, options) => new MediaRecorder(stream, options),
    isTypeSupported: (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
    id: () => crypto.randomUUID(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

export class ProcessedRecorder {
  private readonly capture: ProcessedCaptureSource;
  private readonly runtime: RecorderRuntime;
  private readonly store: RecordingAssetStore;
  private readonly mimeType: string;
  private readonly timesliceMs: number;
  private readonly finalizationTimeoutMs: number;
  private readonly onSegment?: ProcessedRecorderOptions['onSegment'];
  private readonly onFailure?: ProcessedRecorderOptions['onFailure'];
  private readonly segments: RecordingSegment[] = [];
  private active: ActiveSegment | null = null;
  private finalizing: Promise<void> = Promise.resolve();
  private finalizingActive = false;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeInvalidation: (() => void) | null = null;
  private disposed = false;

  constructor(capture: ProcessedCaptureSource, options: ProcessedRecorderOptions = {}) {
    this.capture = capture;
    this.runtime = options.runtime ?? browserRuntime();
    this.store = options.store ?? new IndexedDbRecordingStore();
    this.timesliceMs = options.timesliceMs ?? 2_000;
    this.finalizationTimeoutMs = options.finalizationTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.timesliceMs) || this.timesliceMs <= 0 ||
        !Number.isFinite(this.finalizationTimeoutMs) || this.finalizationTimeoutMs <= 0) {
      throw new RangeError('Recording timeouts must be finite and positive.');
    }
    const candidates = options.mimeTypes ?? DEFAULT_MIME_TYPES;
    const supported = candidates.find((type) => this.runtime.isTypeSupported(type));
    if (!supported) throw new RecordingSetupError('unsupported-format');
    this.mimeType = supported;
    this.onSegment = options.onSegment;
    this.onFailure = options.onFailure;

    // Subscribe to invalidation first: it is the synchronous privacy gate.
    this.unsubscribeInvalidation = capture.onInvalidate((event) => this.closeActive(event.timestampMs));
    this.unsubscribeState = capture.subscribe(() => this.reconcile());
  }

  getSegments(): readonly RecordingSegment[] { return Object.freeze([...this.segments]); }

  async resolveAsset(assetRef: string): Promise<Blob | undefined> { return this.store.load(assetRef); }

  async flush(): Promise<void> { await this.finalizing; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInvalidation?.(); this.unsubscribeState?.();
    this.unsubscribeInvalidation = null; this.unsubscribeState = null;
    const snapshot = this.capture.getSnapshot();
    this.closeActive(snapshot.session ? Math.max(0, this.runtime.now() - snapshot.session.sessionEpochMs) : 0);
    await this.finalizing;
  }

  private reconcile(): void {
    if (this.disposed || this.active) return;
    const snapshot = this.capture.getSnapshot();
    if (snapshot.state !== 'capturing' || !snapshot.session || snapshot.reviewRequired) return;
    if (!this.finalizingActive) {
      try { this.open(snapshot); } catch (cause) { this.fail('recorder-error', cause); }
      return;
    }
    void this.finalizing.then(() => {
      if (this.disposed || this.active) return;
      const current = this.capture.getSnapshot();
      if (current.state !== 'capturing' || !current.session || current.reviewRequired) return;
      try { this.open(current); } catch (cause) { this.fail('recorder-error', cause); }
    });
  }

  private open(snapshot: CaptureSnapshot): void {
    const session = snapshot.session!;
    const stream = this.capture.createProcessedStream();
    // Refuse any implementation regression that leaks an audio track.
    if (stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Processed recording streams must not contain audio.');
    }
    const id = this.runtime.id();
    const assetRef = `recording:${session.sessionId}:${id}`;
    let recorder: MediaRecorder;
    try { recorder = this.runtime.create(stream, { mimeType: this.mimeType }); }
    catch (cause) { stream.getTracks().forEach((track) => track.stop()); throw cause; }
    const active: ActiveSegment = { id, sessionId: session.sessionId,
      startMs: Math.max(0, this.runtime.now() - session.sessionEpochMs), mimeType: this.mimeType,
      assetRef, stream, recorder, chunks: [], settled: false, failed: false, finishing: false };
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) active.chunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => this.failActive(active, 'recorder-error', event));
    this.active = active;
    try { recorder.start(this.timesliceMs); } catch (cause) {
      this.active = null;
      stream.getTracks().forEach((track) => track.stop());
      throw cause;
    }
  }

  /** Closes the pixel gate and recorder synchronously; persistence completes asynchronously. */
  private closeActive(endMs: number): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.endMs = Math.max(active.startMs, endMs);
    active.stream.getTracks().forEach((track) => track.stop());
    const completion = this.finalize(active);
    this.finalizingActive = true;
    this.finalizing = this.finalizing.then(() => completion, () => completion).finally(() => {
      this.finalizingActive = false; this.reconcile();
    });
    try {
      if (active.recorder.state !== 'inactive') active.recorder.stop();
      else this.failActive(active, 'recorder-error', new Error('Recorder became inactive before finalization.'));
    } catch (cause) { this.failActive(active, 'recorder-error', cause); }
  }

  private finalize(active: ActiveSegment): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.runtime.setTimer(() => {
        if (active.settled) return;
        active.settled = true; this.fail('finalization-timeout'); resolve();
      }, this.finalizationTimeoutMs);
      const finish = async () => {
        if (active.settled || active.finishing) return;
        active.finishing = true;
        if (active.failed) { active.settled = true; this.runtime.clearTimer(timer); resolve(); return; }
        if (!active.chunks.length || !active.chunks.some((chunk) => chunk.size > 0)) {
          active.settled = true; this.runtime.clearTimer(timer); this.fail('empty-segment'); resolve(); return;
        }
        if ((active.endMs ?? active.startMs) <= active.startMs) {
          active.settled = true; this.runtime.clearTimer(timer); this.fail('empty-segment'); resolve(); return;
        }
        try {
          const duration = Math.max(0, (active.endMs ?? active.startMs) - active.startMs);
          const segment: RecordingSegment = Object.freeze({ id: active.id, sessionId: active.sessionId,
            assetRef: active.assetRef, startMs: active.startMs, endMs: active.endMs ?? active.startMs,
            mediaStartMs: 0, mediaEndMs: duration, mimeType: active.mimeType });
          await this.store.save({ segment, chunks: active.chunks });
          if (active.settled) { await this.store.remove?.(active.assetRef).catch(() => undefined); return; }
          active.settled = true; this.runtime.clearTimer(timer);
          this.segments.push(segment);
          try { this.onSegment?.(segment); } catch { /* observer cannot invalidate durable media */ }
        } catch (cause) {
          if (!active.settled) { active.settled = true; this.runtime.clearTimer(timer); this.fail('storage-failed', cause); }
        } finally { resolve(); }
      };
      active.recorder.addEventListener('stop', () => { void finish(); }, { once: true });
    });
  }

  private failActive(active: ActiveSegment, code: RecordingFailureCode, cause?: unknown): void {
    if (active.settled) return;
    active.failed = true;
    if (this.active === active) this.active = null;
    active.stream.getTracks().forEach((track) => track.stop());
    this.fail(code, cause);
    try { if (active.recorder.state !== 'inactive') active.recorder.stop(); } catch { /* timeout remains authoritative */ }
  }

  private fail(code: RecordingFailureCode, cause?: unknown): void {
    try { this.onFailure?.(Object.freeze({ code, ...(cause === undefined ? {} : { cause }) })); } catch { /* observer only */ }
  }
}

export class RecordingSetupError extends Error {
  readonly code: 'unsupported-format';
  constructor(code: 'unsupported-format') { super('No supported recording format is available.'); this.code = code; this.name = 'RecordingSetupError'; }
}

type StoredAsset = { assetRef: string; sessionId: string; mimeType: string; segment: RecordingSegment; blob: Blob };

/** Durable browser default. Callers can supply an upload-backed RecordingAssetStore instead. */
export class IndexedDbRecordingStore implements RecordingAssetStore {
  private readonly databaseName: string;
  constructor(databaseName = 'ai-apprentice-recordings-v1') { this.databaseName = databaseName; }
  async save(input: { segment: RecordingSegment; chunks: readonly Blob[] }): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction('assets', 'readwrite');
      transaction.objectStore('assets').put({ assetRef: input.segment.assetRef, sessionId: input.segment.sessionId,
        mimeType: input.segment.mimeType, segment: input.segment,
        blob: new Blob([...input.chunks], { type: input.segment.mimeType }) } satisfies StoredAsset);
      await this.transaction(transaction);
    } finally { db.close(); }
  }
  async load(assetRef: string): Promise<Blob | undefined> {
    const db = await this.open();
    try {
      const value = await this.request<StoredAsset | undefined>(db.transaction('assets').objectStore('assets').get(assetRef));
      return value?.blob;
    } finally { db.close(); }
  }
  async remove(assetRef: string): Promise<void> {
    const db = await this.open();
    try { const transaction = db.transaction('assets', 'readwrite'); transaction.objectStore('assets').delete(assetRef);
      await this.transaction(transaction); } finally { db.close(); }
  }
  async listSegments(sessionId: string): Promise<readonly RecordingSegment[]> {
    const db = await this.open();
    try {
      const records = await this.request<StoredAsset[]>(db.transaction('assets').objectStore('assets').getAll());
      return Object.freeze(records.filter((item) => item.sessionId === sessionId).map((item) => Object.freeze({...item.segment}))
        .sort((a, b) => a.startMs - b.startMs));
    } finally { db.close(); }
  }
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable.')); return; }
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'assetRef' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open recording storage.'));
    });
  }
  private request<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Recording storage failed.'));
    });
  }
  private transaction(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording storage transaction aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Recording storage transaction failed.'));
    });
  }
}

export interface HttpChunkRecordingStoreOptions {
  readonly baseUrl?: string;
  readonly authHeader: () => string | Promise<string>;
  readonly fetch?: typeof fetch;
  readonly maxChunkBytes?: number;
}

/** Client for the standalone recording chunk handler in apps/api/screen/recording. */
export class HttpChunkRecordingStore implements RecordingAssetStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxChunkBytes: number;
  private readonly options: HttpChunkRecordingStoreOptions;
  constructor(options: HttpChunkRecordingStoreOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.maxChunkBytes = options.maxChunkBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxChunkBytes) || this.maxChunkBytes < 1) throw new RangeError('maxChunkBytes must be a positive integer.');
  }
  async save(input: { segment: RecordingSegment; chunks: readonly Blob[] }): Promise<void> {
    const { segment } = input;
    const assetId = this.assetId(segment.assetRef, segment.sessionId);
    const root = this.root(segment.sessionId, assetId);
    const authorization = await this.options.authHeader();
    const chunks = input.chunks.flatMap((chunk) => {
      const pieces: Blob[] = [];
      for (let offset = 0; offset < chunk.size; offset += this.maxChunkBytes) pieces.push(chunk.slice(offset, offset + this.maxChunkBytes, segment.mimeType));
      return pieces;
    });
    for (let index = 0; index < chunks.length; index++) {
      const response = await this.fetcher(`${root}/chunks`, { method: 'POST', headers: {
        authorization, 'content-type': segment.mimeType, 'x-recording-chunk-index': String(index),
      }, body: chunks[index] });
      if (response.status !== 200 && response.status !== 201) throw new Error(`Recording chunk ${index} failed (${response.status}).`);
    }
    const response = await this.fetcher(`${root}/finalize`, { method: 'POST', headers: {
      authorization, 'content-type': 'application/json',
    }, body: JSON.stringify({ chunkCount: chunks.length, mimeType: segment.mimeType, segment }) });
    if (response.status !== 200 && response.status !== 201) throw new Error(`Recording finalization failed (${response.status}).`);
    const result = await response.json() as { asset?: { assetRef?: string } };
    if (result.asset?.assetRef !== segment.assetRef) throw new Error('Recording server returned the wrong asset reference.');
  }
  async load(assetRef: string): Promise<Blob | undefined> {
    const { sessionId, assetId } = this.parts(assetRef);
    const response = await this.fetcher(`${this.root(sessionId, assetId)}/asset`, { headers: {
      authorization: await this.options.authHeader(),
    } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Recording retrieval failed (${response.status}).`);
    return response.blob();
  }
  private root(sessionId: string, assetId: string): string {
    return `${this.baseUrl}/screen/sessions/${encodeURIComponent(sessionId)}/recordings/${encodeURIComponent(assetId)}`;
  }
  private assetId(assetRef: string, sessionId: string): string {
    const parsed = this.parts(assetRef);
    if (parsed.sessionId !== sessionId) throw new Error('Recording asset session does not match.');
    return parsed.assetId;
  }
  private parts(assetRef: string): { sessionId: string; assetId: string } {
    const match = /^recording:([^:]+):([^:]+)$/.exec(assetRef);
    if (!match?.[1] || !match[2] || !/^[A-Za-z0-9_-]{1,128}$/.test(match[1]) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(match[2])) throw new Error('Invalid recording asset reference.');
    return { sessionId: match[1], assetId: match[2] };
  }
}
