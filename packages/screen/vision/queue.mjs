/** Internal scheduler. The approved ScreenBridge is supplied by the composition root. */
export class VisionQueue {
  constructor({ analyze, validate, makeObservation, evidence, publish, onEvent = () => {},
    fingerprint, now = Date.now, schedule = setTimeout, cancelTimer = clearTimeout,
    sampleIntervalMs = 1500, maxConcurrent = 1, maxResultAgeMs = 75000,
    requestTimeoutMs = 65000, maxCheckpointAgeMs = 2500 }) {
    for (const value of [analyze, validate, makeObservation, publish, fingerprint]) {
      if (typeof value !== 'function') throw new TypeError('Missing vision dependency');
    }
    for (const value of [validate, makeObservation, publish]) {
      if (value.constructor.name === 'AsyncFunction') throw new TypeError('Contract callbacks must be synchronous');
    }
    if (!evidence?.save || !evidence?.resolve) throw new TypeError('Missing Evidence dependency');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
      !Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0 ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 ||
      !Number.isFinite(maxResultAgeMs) || maxResultAgeMs < requestTimeoutMs ||
      !Number.isFinite(maxCheckpointAgeMs) || maxCheckpointAgeMs <= 0 || maxCheckpointAgeMs > maxResultAgeMs) {
      throw new TypeError('Invalid queue limits');
    }
    Object.assign(this, { analyze, validate, makeObservation, evidence, publish, onEvent,
      fingerprint, now, schedule, cancelTimer, sampleIntervalMs, maxConcurrent,
      maxResultAgeMs, requestTimeoutMs, maxCheckpointAgeMs });
    this.active = new Set();
    this.generation = 0;
    this.sourceGeneration = 0;
    this.sourceRevision = null;
    this.checkpointContext = null;
    this.state = 'stopped';
    this.pending = null;
  }

  emit(event) {
    // Observability must not interrupt scheduling. Events contain no media/model payload.
    try { this.onEvent(event); } catch { /* consumer owns its callback errors */ }
  }

  invalidate() {
    this.generation++;
    this.sourceGeneration++;
    this.sourceRevision = null;
    this.checkpointContext = null;
    this.pending = null;
    this.lastFingerprint = undefined;
    this.lastAcceptedAt = -Infinity;
    for (const job of this.active) job.controller.abort();
  }

  start({ sessionId, sessionEpochMs }) {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(sessionEpochMs) ||
      sessionEpochMs < 0 || sessionEpochMs > this.now()) throw new TypeError('Invalid session');
    this.invalidate();
    this.session = { sessionId, sessionEpochMs };
    this.ordinal = 0;
    this.lastPublishedOrdinal = 0;
    this.lastTimestampMs = -1;
    this.sequence = 0;
    this.state = 'capturing';
  }

  pause() { this.state = 'paused'; this.invalidate(); }
  stop() { this.state = 'stopped'; this.invalidate(); }
  resume() {
    if (this.state !== 'paused' || !this.session) throw new Error('Resume requires a paused session');
    this.invalidate();
    this.state = 'capturing';
  }

  snapshot() {
    return { state: this.state, sessionId: this.session?.sessionId ?? null,
      active: this.active.size, queued: this.pending ? 1 : 0, sequence: this.sequence ?? 0 };
  }

  /** Internal revision side channel, not an extension of ScreenBridge. */
  setSourceRevision(revision) {
    if (revision !== null && (typeof revision !== 'string' || !revision || revision.length > 200)) {
      throw new TypeError('Invalid source revision');
    }
    if (revision === this.sourceRevision) return;
    this.sourceRevision = revision;
    this.sourceGeneration++;
    this.checkpointContext = null;
    // Identical pixels in a new draft/source revision still need their own provenance.
    this.lastFingerprint = undefined;
    this.lastAcceptedAt = -Infinity;
  }

  canUseForCheckpoint({ sessionId, frameId, sourceRevision } = {}) {
    const current = this.checkpointContext;
    if (!current || this.state !== 'capturing' || !sourceRevision ||
      current.generation !== this.generation || current.sourceGeneration !== this.sourceGeneration ||
      current.sourceRevision !== this.sourceRevision || sourceRevision !== this.sourceRevision ||
      sessionId !== this.session.sessionId || frameId !== current.frameId) return false;
    const age = this.now() - current.capturedAt;
    return age >= 0 && age <= this.maxCheckpointAgeMs;
  }

  offer(frame, { sourceRevision = null } = {}) {
    if (this.state !== 'capturing' || frame.sessionId !== this.session.sessionId) return 'inactive';
    if (sourceRevision !== null && (typeof sourceRevision !== 'string' || !sourceRevision || sourceRevision.length > 200)) {
      return 'invalid';
    }
    const age = this.now() - (this.session.sessionEpochMs + frame.timestampMs);
    if (frame.processed !== true || typeof frame.frameId !== 'string' || !frame.frameId ||
      !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 || age < 0) return 'invalid';
    if (age > this.maxResultAgeMs) return 'stale';
    if (frame.timestampMs <= this.lastTimestampMs) return 'out_of_order';
    if (this.now() - this.lastAcceptedAt < this.sampleIntervalMs) return 'sampled_out';
    const digest = this.fingerprint(frame);
    if (typeof digest !== 'string' || !digest) return 'invalid';
    if (digest === this.lastFingerprint) return 'duplicate';
    this.lastFingerprint = digest;
    this.lastAcceptedAt = this.now();
    this.lastTimestampMs = frame.timestampMs;
    // One pending slot, always the most recent accepted frame.
    this.pending = { frame, ordinal: ++this.ordinal, generation: this.generation,
      capturedAt: this.session.sessionEpochMs + frame.timestampMs,
      sourceRevision, sourceGeneration: this.sourceGeneration };
    this.pump();
    return 'accepted';
  }

  reason(job) {
    if (job.generation !== this.generation || this.state !== 'capturing') return 'invalidated';
    if (job.controller.signal.aborted) return job.timedOut ? 'timeout' : 'cancelled';
    if (this.now() - job.capturedAt > this.maxResultAgeMs) return 'stale';
    if (job.ordinal <= this.lastPublishedOrdinal) return 'out_of_order';
    return null;
  }

  pump() {
    if (this.state !== 'capturing' || !this.pending || this.active.size >= this.maxConcurrent) return;
    const job = this.pending;
    this.pending = null;
    job.controller = new AbortController();
    const reason = this.reason(job);
    if (reason) {
      this.emit({ type: 'discarded', reason, sessionId: job.frame.sessionId,
        frameId: job.frame.frameId, timestampMs: job.frame.timestampMs });
      return;
    }
    this.active.add(job);
    void this.run(job);
  }

  async run(job) {
    const ids = { sessionId: job.frame.sessionId, frameId: job.frame.frameId,
      timestampMs: job.frame.timestampMs };
    const timer = this.schedule(() => {
      if (job.generation !== this.generation) return;
      job.timedOut = true;
      job.controller.abort();
      this.emit({ type: 'error', code: 'timeout', ...ids });
    }, this.requestTimeoutMs);
    const assertCurrent = () => {
      const reason = this.reason(job);
      if (reason) throw Object.assign(new Error('Discarded result'), { discard: reason });
    };
    try {
      const signal = job.controller.signal;
      const answer = await this.analyze(job.frame, { signal });
      assertCurrent();
      // Validator must return the validated value or throw; false is never a success.
      const validated = this.validate(answer);
      if (!validated || typeof validated !== 'object' || typeof validated.then === 'function') {
        throw Object.assign(new Error('Invalid model output'), { code: 'invalid_model_output' });
      }
      assertCurrent();
      const stored = await this.evidence.save(job.frame, { signal });
      assertCurrent();
      const resolved = await this.evidence.resolve(stored.id, { signal });
      if (!resolved || resolved.id !== stored.id || !resolved.assetRef) {
        throw Object.assign(new Error('Evidence unavailable'), { code: 'evidence_unavailable' });
      }
      assertCurrent();
      const sequence = this.sequence + 1;
      const observation = this.makeObservation(validated, { ...ids, sequence, evidence: resolved });
      if (!observation || typeof observation !== 'object' || typeof observation.then === 'function') {
        throw Object.assign(new Error('Invalid observation'), { code: 'invalid_model_output' });
      }
      assertCurrent();
      // Synchronous publication is required: no awaited external send can bypass invalidation.
      this.sequence = sequence;
      this.lastPublishedOrdinal = job.ordinal;
      job.publicationStarted = true;
      const checkpointContext = { frameId: job.frame.frameId, capturedAt: job.capturedAt,
        generation: job.generation, sourceRevision: job.sourceRevision, sourceGeneration: job.sourceGeneration };
      this.checkpointContext = checkpointContext;
      this.publish(observation);
      this.emit({ type: 'published', ...ids, sequence, latencyMs: this.now() - job.capturedAt,
        checkpointEligible: this.canUseForCheckpoint({ ...ids, sourceRevision: job.sourceRevision }) });
    } catch (error) {
      if (this.checkpointContext?.frameId === job.frame.frameId &&
        this.checkpointContext?.generation === job.generation) this.checkpointContext = null;
      const reason = error?.discard ?? (job.publicationStarted ? null : this.reason(job));
      if (reason) this.emit({ type: 'discarded', reason, ...ids });
      else this.emit({ type: 'error', code: safeCode(error?.code), ...ids });
      // Failed/invalid frames may be retried without waiting for a different image.
      if (job.generation === this.generation && !this.pending &&
        job.ordinal === this.ordinal) this.lastFingerprint = undefined;
    } finally {
      this.cancelTimer(timer);
      this.active.delete(job);
      this.pump();
    }
  }
}

function safeCode(code) {
  const allowed = ['invalid_model_output', 'evidence_unavailable', 'storage_error',
    'runner_unconfigured', 'runner_auth', 'runner_limit', 'runner_timeout',
    'runner_unavailable', 'runner_invalid_response'];
  return allowed.includes(code) ? code : 'vision_failed';
}
