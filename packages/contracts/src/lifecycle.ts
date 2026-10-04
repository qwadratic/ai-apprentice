import type { ScreenObservation, SessionStart } from './types.ts';
import { parseScreenObservation, parseSessionStart } from './validators.ts';
export interface CaptureToken {
  readonly sessionId: string; readonly generation: number; readonly sequence: number;
  readonly timestampMs: number; readonly frameId: string; readonly sourceRevision: string | null;
}
/** Shared sequencing helper, not a capture/vision implementation. Use a token per captured frame. */
export class ObservationGate {
  #session: SessionStart | undefined;
  #generation = 0;
  #capturing = false;
  #sequence = 0;
  #publishedSequence = 0;
  #captureMs = -1;
  #publishedIds = new Set<string>();
  #issued = new WeakSet<CaptureToken>();
  start(value: SessionStart): void {
    this.#session = parseSessionStart(value); this.#generation++; this.#capturing = true;
    this.#sequence = 0; this.#publishedSequence = 0; this.#captureMs = -1; this.#publishedIds.clear();
  }
  pause(): void { this.#capturing = false; this.#generation++; }
  resume(): void { if (!this.#session) throw new Error('Session not started'); this.#capturing = true; }
  stop(): void { this.pause(); this.#session = undefined; }
  capture(capturedAtEpochMs: number, frameId: string, sourceRevision: string | null = null): CaptureToken {
    if (!this.#capturing || !this.#session) throw new Error('Capture is not active');
    const timestampMs = capturedAtEpochMs - this.#session.sessionEpochMs;
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs < this.#captureMs) throw new Error('Capture clock moved backwards');
    this.#captureMs = timestampMs;
    const token = Object.freeze({sessionId: this.#session.sessionId, generation: this.#generation, sequence: ++this.#sequence, timestampMs, frameId, sourceRevision});
    this.#issued.add(token); return token;
  }
  publish(token: CaptureToken, value: ScreenObservation): ScreenObservation | null {
    if (!this.#issued.has(token)) throw new Error('Unknown capture token');
    this.#issued.delete(token);
    if (!this.#capturing || token.generation !== this.#generation || token.sessionId !== this.#session?.sessionId || token.sequence <= this.#publishedSequence) return null;
    const o = parseScreenObservation(value);
    if (o.source !== 'vision' || o.sessionId !== token.sessionId || o.sequence !== token.sequence || o.timestampMs !== token.timestampMs || o.frameId !== token.frameId || o.sourceRevision !== token.sourceRevision) throw new Error('Observation does not match capture token');
    if (this.#publishedIds.has(o.id)) throw new Error('Duplicate observation id');
    this.#publishedIds.add(o.id); this.#publishedSequence = token.sequence; return o;
  }
}
