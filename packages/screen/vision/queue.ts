export interface VisionFrame {
  readonly sessionId: string;
  readonly frameId: string;
  readonly timestampMs: number;
  readonly processed: true;
}

export interface VisionEvidenceRef { readonly id: string; readonly assetRef: string }
export interface VisionEvidenceStore<TFrame extends VisionFrame, TEvidence extends VisionEvidenceRef> {
  save(frame: TFrame, options: { signal: AbortSignal }): Promise<TEvidence>;
  resolve(id: string, options: { signal: AbortSignal }): Promise<TEvidence>;
}
export interface VisionPublicationContext<TEvidence extends VisionEvidenceRef> {
  readonly queueGeneration: number;
  readonly captureGeneration: number | null;
  readonly sourceRevision: string | null;
  readonly surface: VisionSurface | null;
  readonly capturedAtEpochMs: number;
  readonly receivedAtEpochMs: number;
  readonly evidence: TEvidence;
}
export type VisionErrorCode = 'timeout' | 'invalid_model_output' | 'evidence_unavailable' | 'storage_error' |
  'runner_unconfigured' | 'runner_auth' | 'runner_limit' | 'runner_timeout' | 'runner_unavailable' |
  'runner_invalid_response' | 'vision_incomplete' | 'vision_failed';
export type VisionQueueEvent =
  | { readonly type: 'published'; readonly sessionId: string; readonly frameId: string; readonly timestampMs: number;
      readonly sequence: number; readonly processingLatencyMs: number; readonly captureToObservationMs: number | null }
  | { readonly type: 'discarded'; readonly sessionId: string; readonly frameId: string; readonly timestampMs: number;
      readonly reason: DiscardReason }
  | { readonly type: 'error'; readonly sessionId: string; readonly frameId: string; readonly timestampMs: number;
      readonly code: VisionErrorCode };
export interface VisionObservationContext<TEvidence extends VisionEvidenceRef> {
  readonly sessionId: string;
  readonly frameId: string;
  readonly timestampMs: number;
  readonly sequence: number;
  readonly sourceRevision: string | null;
  readonly surface: VisionSurface | null;
  readonly evidence: TEvidence;
}
export interface VisionOfferContext {
  readonly sourceRevision?: string | null;
  readonly captureGeneration?: number | null;
  readonly surface?: VisionSurface | null;
}
export type VisionSurface = 'order' | 'email' | 'ticket';
export interface VisionQueueOptions<TFrame extends VisionFrame, TResult extends object,
  TObservation extends object, TEvidence extends VisionEvidenceRef, TTimer = ReturnType<typeof setTimeout>> {
  readonly analyze: (frame: TFrame, options: { signal: AbortSignal; surface: VisionSurface | null }) => Promise<unknown>;
  readonly validate: (value: unknown) => TResult;
  readonly makeObservation: (value: TResult, context: VisionObservationContext<TEvidence>) => TObservation;
  readonly evidence: VisionEvidenceStore<TFrame, TEvidence>;
  readonly publish: (observation: TObservation, context: VisionPublicationContext<TEvidence>) => void;
  readonly fingerprint: (frame: TFrame) => string;
  readonly onEvent?: (event: VisionQueueEvent) => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => TTimer;
  readonly cancelTimer?: (timer: TTimer) => void;
  readonly sampleIntervalMs?: number;
  readonly maxConcurrent?: number;
  readonly maxResultAgeMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxClockSkewMs?: number;
}
interface QueueSession { readonly sessionId: string; readonly sessionEpochMs: number }
interface QueueJob<TFrame extends VisionFrame> {
  readonly frame: TFrame; readonly ordinal: number; readonly generation: number;
  readonly capturedAt: number; readonly receivedAt: number;
  readonly fingerprint: string;
  readonly sourceRevision: string | null; readonly captureGeneration: number | null;
  readonly surface: VisionSurface | null;
  controller?: AbortController; timedOut?: boolean; publicationStarted?: boolean;
}
type QueueState = 'capturing' | 'paused' | 'stopped';
type DiscardReason = 'invalidated' | 'timeout' | 'cancelled' | 'stale' | 'out_of_order';

export class VisionQueue<TFrame extends VisionFrame, TResult extends object,
  TObservation extends object, TEvidence extends VisionEvidenceRef, TTimer = ReturnType<typeof setTimeout>> {
  readonly #analyze: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>['analyze'];
  readonly #validate: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>['validate'];
  readonly #makeObservation: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>['makeObservation'];
  readonly #evidence: VisionEvidenceStore<TFrame, TEvidence>;
  readonly #publish: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>['publish'];
  readonly #fingerprint: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>['fingerprint'];
  readonly #onEvent: (event: VisionQueueEvent) => void;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => TTimer;
  readonly #cancelTimer: (timer: TTimer) => void;
  readonly #sampleIntervalMs: number; readonly #maxConcurrent: number;
  readonly #maxResultAgeMs: number; readonly #requestTimeoutMs: number; readonly #maxClockSkewMs: number;
  readonly #active = new Set<QueueJob<TFrame>>();
  #generation = 0; #state: QueueState = 'stopped'; #pending: QueueJob<TFrame> | null = null;
  #session: QueueSession | null = null; #ordinal = 0; #lastPublishedOrdinal = 0;
  #lastTimestampMs = -1; #sequence = 0; #lastAcceptedAt = -Infinity;
  readonly #lastFingerprints = new Map<string, string>();

  constructor(options: VisionQueueOptions<TFrame, TResult, TObservation, TEvidence, TTimer>) {
    const {sampleIntervalMs = 1500, maxConcurrent = 1, maxResultAgeMs = 75_000,
      requestTimeoutMs = 65_000, maxClockSkewMs = 5000} = options;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
      !Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0 ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 ||
      !Number.isFinite(maxResultAgeMs) || maxResultAgeMs < requestTimeoutMs ||
      !Number.isFinite(maxClockSkewMs) || maxClockSkewMs < 0) throw new TypeError('Invalid queue limits');
    this.#analyze = options.analyze; this.#validate = options.validate;
    this.#makeObservation = options.makeObservation; this.#evidence = options.evidence;
    this.#publish = options.publish; this.#fingerprint = options.fingerprint;
    this.#onEvent = options.onEvent ?? (() => undefined); this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.#cancelTimer = options.cancelTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.#sampleIntervalMs = sampleIntervalMs; this.#maxConcurrent = maxConcurrent;
    this.#maxResultAgeMs = maxResultAgeMs; this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxClockSkewMs = maxClockSkewMs;
  }

  #emit(event: VisionQueueEvent): void { try { this.#onEvent(event); } catch { /* diagnostics cannot interrupt work */ } }
  #invalidate(): void {
    this.#generation++; this.#pending = null; this.#lastFingerprints.clear(); this.#lastAcceptedAt = -Infinity;
    for (const job of this.#active) job.controller?.abort();
  }
  start(session: QueueSession): void {
    if (!session.sessionId || !Number.isSafeInteger(session.sessionEpochMs) || session.sessionEpochMs < 0) throw new TypeError('Invalid session');
    this.#invalidate(); this.#session = Object.freeze({...session}); this.#ordinal = 0; this.#lastPublishedOrdinal = 0;
    this.#lastTimestampMs = -1; this.#sequence = 0; this.#state = 'capturing';
  }
  pause(): void { this.#state = 'paused'; this.#invalidate(); }
  stop(): void { this.#state = 'stopped'; this.#invalidate(); }
  resume(): void {
    if (this.#state !== 'paused' || !this.#session) throw new Error('Resume requires a paused session');
    this.#invalidate(); this.#state = 'capturing';
  }
  snapshot(): {state: QueueState; sessionId: string | null; generation: number; active: number; queued: 0 | 1; sequence: number} {
    return {state: this.#state, sessionId: this.#session?.sessionId ?? null, generation: this.#generation,
      active: this.#active.size, queued: this.#pending ? 1 : 0, sequence: this.#sequence};
  }
  offer(frame: TFrame, context: VisionOfferContext = {}): 'accepted' | 'inactive' | 'invalid' | 'stale' | 'out_of_order' | 'sampled_out' | 'duplicate' {
    if (this.#state !== 'capturing' || !this.#session || frame.sessionId !== this.#session.sessionId) return 'inactive';
    const sourceRevision = context.sourceRevision ?? null; const captureGeneration = context.captureGeneration ?? null;
    const surface = context.surface ?? null;
    const captureAge = this.#now() - (this.#session.sessionEpochMs + frame.timestampMs);
    if (frame.processed !== true || !frame.frameId || !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 ||
      captureAge < -this.#maxClockSkewMs || (sourceRevision !== null && (!sourceRevision || sourceRevision.length > 200)) ||
      (captureGeneration !== null && (!Number.isSafeInteger(captureGeneration) || captureGeneration < 0)) ||
      (surface !== null && !['order', 'email', 'ticket'].includes(surface))) return 'invalid';
    if (captureAge > this.#maxResultAgeMs) return 'stale';
    if (frame.timestampMs <= this.#lastTimestampMs) return 'out_of_order';
    this.#lastTimestampMs = frame.timestampMs;
    if (this.#now() - this.#lastAcceptedAt < this.#sampleIntervalMs) return 'sampled_out';
    const frameDigest = this.#fingerprint(frame); if (!frameDigest) return 'invalid';
    const surfaceKey = surface ?? 'auto';
    if (frameDigest === this.#lastFingerprints.get(surfaceKey)) return 'duplicate';
    const displaced = this.#pending;
    if (displaced) {
      const displacedSurfaceKey = displaced.surface ?? 'auto';
      if (this.#lastFingerprints.get(displacedSurfaceKey) === displaced.fingerprint) {
        this.#lastFingerprints.delete(displacedSurfaceKey);
      }
    }
    const receivedAt = this.#now(); this.#lastFingerprints.set(surfaceKey, frameDigest); this.#lastAcceptedAt = receivedAt;
    this.#pending = {frame, ordinal: ++this.#ordinal, generation: this.#generation,
      capturedAt: this.#session.sessionEpochMs + frame.timestampMs, receivedAt, fingerprint: frameDigest,
      sourceRevision, captureGeneration, surface};
    this.#pump(); return 'accepted';
  }
  #discardReason(job: QueueJob<TFrame>): DiscardReason | null {
    if (job.generation !== this.#generation || this.#state !== 'capturing') return 'invalidated';
    if (job.controller?.signal.aborted) return job.timedOut ? 'timeout' : 'cancelled';
    if (this.#now() - job.capturedAt > this.#maxResultAgeMs) return 'stale';
    if (job.ordinal <= this.#lastPublishedOrdinal) return 'out_of_order';
    return null;
  }
  #pump(): void {
    if (this.#state !== 'capturing' || !this.#pending || this.#active.size >= this.#maxConcurrent) return;
    const job = this.#pending; this.#pending = null; job.controller = new AbortController();
    const reason = this.#discardReason(job); if (reason) { this.#emitDiscard(job, reason); return; }
    this.#active.add(job); void this.#run(job);
  }
  #emitDiscard(job: QueueJob<TFrame>, reason: DiscardReason): void {
    this.#emit({type: 'discarded', reason, sessionId: job.frame.sessionId, frameId: job.frame.frameId, timestampMs: job.frame.timestampMs});
  }
  async #run(job: QueueJob<TFrame>): Promise<void> {
    const controller = job.controller; if (!controller) return;
    const ids = {sessionId: job.frame.sessionId, frameId: job.frame.frameId, timestampMs: job.frame.timestampMs};
    const timer = this.#schedule(() => {
      if (job.generation !== this.#generation) return;
      job.timedOut = true; controller.abort(); this.#emit({type: 'error', code: 'timeout', ...ids});
    }, this.#requestTimeoutMs);
    const assertCurrent = (): void => { const reason = this.#discardReason(job); if (reason) throw new DiscardedResult(reason); };
    try {
      const answer = await this.#analyze(job.frame, {signal: controller.signal, surface: job.surface}); assertCurrent();
      const validated = this.#validate(answer);
      if (!validated || typeof validated !== 'object' || isPromiseLike(validated)) throw new CodedError('invalid_model_output');
      assertCurrent(); const stored = await this.#evidence.save(job.frame, {signal: controller.signal}); assertCurrent();
      const resolved = await this.#evidence.resolve(stored.id, {signal: controller.signal});
      if (resolved.id !== stored.id || !resolved.assetRef) throw new CodedError('evidence_unavailable');
      assertCurrent(); const sequence = this.#sequence + 1;
      const observation = this.#makeObservation(validated, {...ids, sequence, sourceRevision: job.sourceRevision,
        surface: job.surface, evidence: resolved});
      if (!observation || typeof observation !== 'object' || isPromiseLike(observation)) throw new CodedError('invalid_model_output');
      assertCurrent(); this.#sequence = sequence; this.#lastPublishedOrdinal = job.ordinal; job.publicationStarted = true;
      this.#publish(observation, {queueGeneration: job.generation, captureGeneration: job.captureGeneration,
        sourceRevision: job.sourceRevision, surface: job.surface, capturedAtEpochMs: job.capturedAt,
        receivedAtEpochMs: job.receivedAt, evidence: resolved});
      const captureLatency = this.#now() - job.capturedAt;
      this.#emit({type: 'published', ...ids, sequence, processingLatencyMs: this.#now() - job.receivedAt,
        captureToObservationMs: captureLatency >= 0 ? captureLatency : null});
    } catch (error: unknown) {
      const reason = error instanceof DiscardedResult ? error.reason : job.publicationStarted ? null : this.#discardReason(job);
      if (reason) this.#emitDiscard(job, reason); else this.#emit({type: 'error', code: safeCode(error), ...ids});
      const surfaceKey = job.surface ?? 'auto';
      if (job.generation === this.#generation && !this.#pending && job.ordinal === this.#ordinal &&
        this.#lastFingerprints.get(surfaceKey) === job.fingerprint) this.#lastFingerprints.delete(surfaceKey);
    } finally { this.#cancelTimer(timer); this.#active.delete(job); this.#pump(); }
  }
}
class DiscardedResult extends Error { readonly reason: DiscardReason; constructor(reason: DiscardReason) { super('Discarded result'); this.reason = reason; } }
class CodedError extends Error { readonly code: VisionErrorCode; constructor(code: VisionErrorCode) { super(code); this.code = code; } }
function isPromiseLike(value: object): value is object & PromiseLike<unknown> {
  return 'then' in value && typeof value.then === 'function';
}
function safeCode(error: unknown): VisionErrorCode {
  const code = error instanceof CodedError ? error.code :
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const allowed: readonly VisionErrorCode[] = ['invalid_model_output', 'evidence_unavailable', 'storage_error',
    'runner_unconfigured', 'runner_auth', 'runner_limit', 'runner_timeout', 'runner_unavailable', 'runner_invalid_response'];
  if (code === 'vision_incomplete') return code;
  return allowed.includes(code as VisionErrorCode) ? code as VisionErrorCode : 'vision_failed';
}
