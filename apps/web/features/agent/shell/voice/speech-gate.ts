// "Is the person speaking right now?" from the microphone's voice-activity score. The policy never asks while the person
// talks; the SDK reports a score between 0 and 1 several times a second. A score above the threshold starts speech, and it
// ends only after the score stayed low for `hangoverMs` (a breath between words is not a pause). Without scores (a connector
// that does not report them) the gate is never "speaking" and the transcript alone keeps the channel quiet afterwards.
export interface SpeechGateOptions {
  /** Scores at or above this count as speech. Default 0.6. */
  threshold?: number;
  /** Speech ends this long after the last high score. Default 800 ms. */
  hangoverMs?: number;
  /** Scores that stay high for this long are treated as noise, not speech (a fan, a bad microphone). Default 20 s. */
  noiseAfterMs?: number;
}

export class SpeechGate {
  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly noiseAfterMs: number;
  private startedAtMs: number | null = null;
  private lastHighAtMs: number | null = null;

  constructor(options: SpeechGateOptions = {}) {
    this.threshold = options.threshold ?? 0.6;
    this.hangoverMs = options.hangoverMs ?? 800;
    this.noiseAfterMs = options.noiseAfterMs ?? 20_000;
  }

  /** Feed every score with the time it arrived (any monotonic clock, in ms). */
  onScore(score: number, nowMs: number): void {
    if (!Number.isFinite(score)) return;
    if (score >= this.threshold) {
      if (this.startedAtMs === null || (this.lastHighAtMs !== null && nowMs - this.lastHighAtMs > this.hangoverMs)) this.startedAtMs = nowMs;
      this.lastHighAtMs = nowMs;
    }
  }

  isSpeaking(nowMs: number): boolean {
    if (this.startedAtMs === null || this.lastHighAtMs === null) return false;
    if (nowMs - this.lastHighAtMs > this.hangoverMs) return false;
    return nowMs - this.startedAtMs <= this.noiseAfterMs;
  }

  reset(): void {
    this.startedAtMs = null;
    this.lastHighAtMs = null;
  }
}
