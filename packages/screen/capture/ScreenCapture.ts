import { paintMasks, validateMasks } from '../privacy/masks.js';
import type { Geometry, PrivacyMask } from '../privacy/masks.js';

/** Internal capture port. It deliberately does not define ScreenBridge. */
export interface CaptureSession {
  readonly sessionId: string;
  readonly sessionEpochMs: number;
}
export type CaptureState = 'idle' | 'selecting' | 'paused' | 'capturing' | 'stopped' | 'error';
export type CaptureReason = 'mask-review' | 'geometry-changed' | 'user-paused' |
  'source-ended' | 'source-muted' | 'permission-denied' | 'capture-failed' |
  'unsupported' | 'frame-failed' | 'consumer-failed' | 'stopped';
export interface CaptureSnapshot {
  readonly state: CaptureState;
  readonly reason?: CaptureReason;
  readonly session: CaptureSession | null;
  readonly generation: number;
  readonly geometry: Geometry | null;
  readonly masks: readonly PrivacyMask[];
  readonly reviewRequired: boolean;
}
export type CaptureSurface = 'order' | 'email' | 'ticket' | null;
export interface CaptureProvenance {
  readonly surface: CaptureSurface;
  readonly sourceRevision: string | null;
}
export interface ProcessedFrame {
  readonly sessionId: string;
  readonly frameId: string;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly generation: number;
  readonly geometry: Geometry;
  readonly provenance: CaptureProvenance;
  readonly image: Blob;
}
export interface FrameLease {
  readonly signal: AbortSignal;
  /** Recheck immediately before applying a vision result or saving Evidence. */
  isCurrent(): boolean;
}
export interface CaptureInvalidation {
  readonly generation: number;
  readonly reason: CaptureReason;
  readonly timestampMs: number;
}
export interface DisplayCaptureOptions { readonly video: true; readonly audio: false; }

type ManualCanvasTrack = MediaStreamTrack & { requestFrame(): void };
type CaptureCanvas = HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };

export interface CaptureRuntime {
  getDisplayMedia(options: DisplayCaptureOptions): Promise<MediaStream>;
  createVideo(): HTMLVideoElement;
  createCanvas(): HTMLCanvasElement;
  now(): number;
  schedule(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}
export interface CaptureOptions {
  readonly runtime?: CaptureRuntime;
  readonly frameIntervalMs?: number;
  readonly renderIntervalMs?: number;
  /** Read synchronously after processed pixels are painted and before PNG encoding starts. */
  readonly snapshotProvenance?: () => CaptureProvenance;
  readonly onFrame?: (frame: ProcessedFrame, lease: FrameLease) => void | Promise<void>;
}

const EMPTY_PROVENANCE: CaptureProvenance = Object.freeze({ surface: null, sourceRevision: null });

export function browserCaptureRuntime(): CaptureRuntime {
  return {
    getDisplayMedia(options) {
      const devices = navigator.mediaDevices as (MediaDevices & {
        getDisplayMedia?: (options: DisplayCaptureOptions) => Promise<MediaStream>;
      }) | undefined;
      if (!devices?.getDisplayMedia) {
        throw new DOMException('Screen capture is unavailable.', 'NotSupportedError');
      }
      return devices.getDisplayMedia(options);
    },
    createCanvas: () => document.createElement('canvas'),
    createVideo: () => document.createElement('video'),
    now: () => Date.now(),
    schedule: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

export class ScreenCapture {
  readonly canvas: HTMLCanvasElement;
  private readonly runtime: CaptureRuntime;
  private readonly context: CanvasRenderingContext2D;
  private readonly video: HTMLVideoElement;
  private readonly frameIntervalMs: number;
  private readonly renderIntervalMs: number;
  private readonly snapshotProvenanceProvider?: CaptureOptions['snapshotProvenance'];
  private readonly onFrame?: CaptureOptions['onFrame'];
  private state: CaptureState = 'idle';
  private reason?: CaptureReason;
  private session: CaptureSession | null = null;
  private geometry: Geometry | null = null;
  private masks: readonly PrivacyMask[] = Object.freeze([]);
  private reviewRequired = true;
  private generation = 0;
  private geometryRevision = 0;
  private operation = 0;
  private sequence = 0;
  private source: MediaStream | null = null;
  private sourceTrack: MediaStreamTrack | null = null;
  private animation: number | null = null;
  private lastRenderMs = -Infinity;
  private lastFrameMs = -Infinity;
  private pendingFrame: object | null = null;
  private abort = new AbortController();
  private processedStreams = new Set<MediaStream>();
  private listeners = new Set<(snapshot: CaptureSnapshot) => void>();
  private invalidations = new Set<(event: CaptureInvalidation) => void>();
  private disposed = false;

  constructor(options: CaptureOptions = {}) {
    this.runtime = options.runtime ?? browserCaptureRuntime();
    this.frameIntervalMs = options.frameIntervalMs ?? 1500;
    this.renderIntervalMs = options.renderIntervalMs ?? 1000 / 15;
    if (![this.frameIntervalMs, this.renderIntervalMs].every((n) => Number.isFinite(n) && n > 0)) {
      throw new RangeError('Capture intervals must be finite and positive.');
    }
    this.snapshotProvenanceProvider = options.snapshotProvenance;
    this.onFrame = options.onFrame;
    this.canvas = this.runtime.createCanvas();
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('A 2D canvas is required.');
    this.context = context;
    this.video = this.runtime.createVideo();
    this.video.muted = true;
    this.video.playsInline = true;
    this.blank();
  }

  getSnapshot(): CaptureSnapshot {
    return Object.freeze({
      state: this.state, reason: this.reason, session: this.session,
      geometry: this.geometry, masks: this.masks,
      generation: this.generation, reviewRequired: this.reviewRequired,
    });
  }

  subscribe(listener: (snapshot: CaptureSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => { this.listeners.delete(listener); };
  }

  /** Recording must pause synchronously here, before any review preview is painted. */
  onInvalidate(listener: (event: CaptureInvalidation) => void): () => void {
    this.invalidations.add(listener);
    return () => { this.invalidations.delete(listener); };
  }

  async start(session: CaptureSession): Promise<void> {
    if (this.disposed) throw new Error('Capture has been disposed.');
    if (!session.sessionId || !Number.isFinite(session.sessionEpochMs)) {
      throw new RangeError('A session ID and finite epoch are required.');
    }
    if (this.state === 'selecting' || this.source) throw new Error('Stop capture before selecting another source.');
    const operation = ++this.operation;
    this.session = Object.freeze({ sessionId: session.sessionId, sessionEpochMs: session.sessionEpochMs });
    this.sequence = 0;
    this.masks = Object.freeze([]);
    this.geometry = null;
    this.reviewRequired = true;
    this.invalidate('mask-review');
    this.setState('selecting');
    let stream: MediaStream | null = null;
    try {
      // Call directly in the start-button gesture: do not await before opening the picker.
      stream = await this.runtime.getDisplayMedia({ video: true, audio: false });
      if (operation !== this.operation) { this.stopTracks(stream); return; }
      // Defensively discard unexpected audio even if a browser ignores the request.
      stream.getAudioTracks().forEach((track) => track.stop());
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('No live screen track.');
      this.source = stream;
      this.sourceTrack = track;
      track.addEventListener('ended', this.sourceEnded);
      track.addEventListener('mute', this.sourceMuted);
      track.addEventListener('unmute', this.sourceUnmuted);
      this.video.addEventListener('resize', this.sourceResized);
      this.video.srcObject = stream;
      await this.video.play();
      if (operation !== this.operation) return;
      if (this.sourceTrack?.readyState === 'ended') { this.stop('source-ended'); return; }
      this.setState('paused', track.muted ? 'source-muted' : 'mask-review');
      this.tick();
    } catch (error) {
      if (operation !== this.operation) { if (stream) this.stopTracks(stream); return; }
      if (stream) this.stopTracks(stream);
      const name = error instanceof Error ? error.name : '';
      this.fail(name === 'NotAllowedError' ? 'permission-denied' :
        name === 'NotSupportedError' ? 'unsupported' : 'capture-failed');
    }
  }

  pause(reason: CaptureReason = 'user-paused'): void {
    if (this.state === 'selecting') { this.stop(reason); return; }
    if (!this.source || (this.state !== 'capturing' && this.state !== 'paused')) return;
    this.invalidate(reason);
    this.setState('paused', reason);
  }

  resume(): boolean {
    if (this.state !== 'paused' || !this.sourceTrack || this.sourceTrack.readyState === 'ended') return false;
    // Synchronously inspect dimensions; a resize event/rAF may not have run yet.
    this.checkGeometry();
    if (!this.geometry || this.reviewRequired || this.sourceTrack.muted || this.video.readyState < 2) return false;
    this.lastRenderMs = -Infinity;
    this.lastFrameMs = -Infinity;
    this.setState('capturing');
    this.setOutputEnabled(true);
    return true;
  }

  setMasks(masks: readonly PrivacyMask[]): void {
    if (!this.source || !this.geometry) throw new Error('Choose a source before editing masks.');
    const validated = validateMasks(masks);
    this.reviewRequired = true;
    this.pause('mask-review');
    this.masks = validated;
    this.paint();
    this.notify();
  }

  beginMaskReview(): void {
    if (!this.source || !this.geometry) return;
    this.reviewRequired = true;
    this.pause('mask-review');
    this.paint();
  }

  confirmMasks(geometryRevision: number): boolean {
    this.checkGeometry();
    if (this.state !== 'paused' || !this.geometry || this.geometry.revision !== geometryRevision ||
        !this.sourceTrack || this.sourceTrack.muted || this.sourceTrack.readyState === 'ended' ||
        this.video.readyState < 2) return false;
    this.reviewRequired = false;
    this.notify();
    return true;
  }

  /** Only processed pixels are exposed. No automatic-capture fallback is allowed. */
  createProcessedStream(): MediaStream {
    this.checkGeometry();
    if (this.state !== 'capturing' || this.reviewRequired) throw new Error('Confirm masks and resume before creating a stream.');
    const canvas = this.canvas as CaptureCanvas;
    if (!canvas.captureStream) throw new Error('Processed canvas streams are unsupported.');
    this.paint();
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as ManualCanvasTrack | undefined;
    if (!track || typeof track.requestFrame !== 'function') {
      this.stopTracks(stream);
      throw new Error('Manual canvas frame capture is required.');
    }
    this.processedStreams.add(stream);
    track.addEventListener('ended', () => { this.processedStreams.delete(stream); });
    track.requestFrame();
    return stream;
  }

  stop(reason: CaptureReason = 'stopped'): void {
    ++this.operation;
    this.invalidate(reason);
    this.releaseSource();
    this.geometry = null;
    this.reviewRequired = true;
    this.blank();
    this.setState('stopped', reason);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.listeners.clear();
    this.invalidations.clear();
  }

  private sourceEnded = (): void => { this.stop('source-ended'); };
  private sourceMuted = (): void => { this.pause('source-muted'); };
  private sourceUnmuted = (): void => {
    try { this.checkGeometry(); this.refreshAvailability(); } catch { this.fail('frame-failed'); }
  };
  private sourceResized = (): void => {
    try { this.checkGeometry(); } catch { this.fail('frame-failed'); }
  };

  private timestamp(): number { return Math.max(0, this.runtime.now() - (this.session?.sessionEpochMs ?? this.runtime.now())); }

  private invalidate(reason: CaptureReason): void {
    ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    this.pendingFrame = null;
    this.setOutputEnabled(false);
    const event = Object.freeze({ generation: this.generation, reason, timestampMs: this.timestamp() });
    for (const listener of this.invalidations) {
      // Disable output and abort first. Observers must never reopen the privacy gate.
      try { listener(event); } catch { /* Keep the gate closed even if an observer fails. */ }
    }
  }

  private checkGeometry(): boolean {
    if (!this.source) return false;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) {
      if (this.state === 'capturing') this.pause('source-muted');
      return false;
    }
    if (this.geometry?.width === width && this.geometry.height === height) return false;
    this.reviewRequired = true;
    const reason = this.geometry ? 'geometry-changed' : 'mask-review';
    this.invalidate(reason);
    this.geometry = Object.freeze({ width, height, revision: ++this.geometryRevision });
    this.canvas.width = width;
    this.canvas.height = height;
    this.setState('paused', reason);
    this.paint();
    return true;
  }

  private refreshAvailability(): void {
    if (this.state === 'paused' && this.reason === 'source-muted' &&
        this.sourceTrack && !this.sourceTrack.muted && this.video.readyState >= 2 &&
        this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      // Recover controls, but keep the output paused until an explicit resume.
      this.setState('paused', this.reviewRequired ? 'mask-review' : 'user-paused');
    }
  }

  private paint(): void {
    if (!this.geometry || this.video.readyState < 2 || this.sourceTrack?.muted) return;
    const { width, height } = this.geometry;
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'source-over';
    this.context.drawImage(this.video, 0, 0, width, height);
    paintMasks(this.context, this.masks, width, height);
  }

  private blank(): void {
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private tick = (): void => {
    this.animation = null;
    if (!this.source) return;
    try {
      this.checkGeometry();
      this.refreshAvailability();
      if (this.state === 'capturing' && (this.video.readyState < 2 || this.sourceTrack?.muted)) {
        this.pause('source-muted');
      }
      const now = this.runtime.now();
      if (this.state === 'capturing' && now - this.lastRenderMs >= this.renderIntervalMs) {
        this.paint();
        this.lastRenderMs = now;
        for (const stream of this.processedStreams) {
          const track = stream.getVideoTracks()[0] as ManualCanvasTrack;
          if (track.readyState === 'live' && track.enabled) track.requestFrame();
        }
        if (this.onFrame && !this.pendingFrame && now - this.lastFrameMs >= this.frameIntervalMs) {
          this.lastFrameMs = now;
          this.deliverFrame();
        }
      }
    } catch { this.fail('frame-failed'); }
    if (this.source) this.animation = this.runtime.schedule(this.tick);
  };

  private deliverFrame(): void {
    const generation = this.generation;
    const signal = this.abort.signal;
    const geometry = this.geometry!;
    const sessionId = this.session!.sessionId;
    const sequence = ++this.sequence;
    const timestampMs = this.timestamp();
    // Keep capture context attached to the exact processed canvas snapshot. The
    // provider object is never retained across the asynchronous encoder callback.
    const provenance = this.snapshotProvenance();
    const token = {};
    this.pendingFrame = token;
    const isCurrent = () => !signal.aborted && this.state === 'capturing' &&
      this.generation === generation && this.geometry?.revision === geometry.revision &&
      this.video.videoWidth === geometry.width && this.video.videoHeight === geometry.height &&
      this.video.readyState >= 2 && !this.sourceTrack?.muted;
    // toBlob snapshots the processed canvas; consumers never retain a live raw source.
    this.canvas.toBlob((image) => {
      if (!isCurrent()) return;
      if (!image) { this.fail('frame-failed'); return; }
      const frame = Object.freeze({ sessionId, frameId: `${sessionId}:generation:${generation}:frame:${sequence}`,
        sequence, timestampMs, generation, geometry, provenance, image });
      Promise.resolve().then(() => {
        if (isCurrent()) return this.onFrame?.(frame, Object.freeze({ signal, isCurrent }));
      }).catch(() => {
        if (isCurrent()) this.fail('consumer-failed');
      }).finally(() => {
        if (this.pendingFrame === token) this.pendingFrame = null;
      });
    }, 'image/png');
  }

  private snapshotProvenance(): CaptureProvenance {
    const source = this.snapshotProvenanceProvider?.();
    if (source === undefined) return EMPTY_PROVENANCE;
    if (!source) throw new TypeError('Invalid capture provenance.');
    const { surface, sourceRevision } = source;
    if (!['order', 'email', 'ticket', null].includes(surface) ||
        (sourceRevision !== null &&
          (typeof sourceRevision !== 'string' || !sourceRevision || sourceRevision.length > 200))) {
      throw new TypeError('Invalid capture provenance.');
    }
    return Object.freeze({ surface, sourceRevision });
  }

  private setOutputEnabled(enabled: boolean): void {
    for (const stream of this.processedStreams) {
      stream.getVideoTracks().forEach((track) => { track.enabled = enabled; });
    }
  }

  private stopTracks(stream: MediaStream): void { stream.getTracks().forEach((track) => track.stop()); }

  private releaseSource(): void {
    if (this.animation !== null) this.runtime.cancel(this.animation);
    this.animation = null;
    this.sourceTrack?.removeEventListener('ended', this.sourceEnded);
    this.sourceTrack?.removeEventListener('mute', this.sourceMuted);
    this.sourceTrack?.removeEventListener('unmute', this.sourceUnmuted);
    this.video.removeEventListener('resize', this.sourceResized);
    if (this.source) this.stopTracks(this.source);
    for (const stream of this.processedStreams) this.stopTracks(stream);
    this.processedStreams.clear();
    this.source = null;
    this.sourceTrack = null;
    this.video.pause();
    this.video.srcObject = null;
  }

  private fail(reason: CaptureReason): void {
    ++this.operation;
    this.invalidate(reason);
    this.releaseSource();
    this.geometry = null;
    this.reviewRequired = true;
    this.blank();
    this.setState('error', reason);
  }

  private setState(state: CaptureState, reason?: CaptureReason): void {
    this.state = state;
    this.reason = reason;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* A broken view cannot reopen or stall capture. */ }
    }
  }
}
