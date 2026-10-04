import type { ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenObservation, ScreenStatus, SessionStart, Unsubscribe } from '@apprentice/contracts';
import { createScreenFixtures } from '@apprentice/contracts/fixtures';
import { MockScreenBridge } from '@apprentice/contracts/mock';
import type { ObservationSource } from './observation-source.ts';

export const SAMPLE_LABEL = 'Sample observations (synthetic)';
/** How often the manual mock clock is advanced to the wall clock. */
export const SAMPLE_TICK_MS = 250;

export interface SampleTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * The contracts' MockScreenBridge, driven by the wall clock. Its fixture is neutral and synthetic. The unknown-order
 * observation is left out, so that the latest order always has a tracked revision and a sample checkpoint can be raised
 * at any time after the email preview. Everything it emits is labelled synthetic in the shell.
 */
export class SampleObservationSource implements ObservationSource {
  readonly label = SAMPLE_LABEL;
  readonly synthetic = true;
  private readonly mock: MockScreenBridge;
  private readonly now: () => number;
  private readonly timers: SampleTimers;
  private timer: unknown = null;
  private clockMs: number;

  constructor(now: () => number, timers: SampleTimers) {
    this.now = now;
    this.timers = timers;
    this.clockMs = now();
    this.mock = new MockScreenBridge(this.clockMs, (sessionId) => {
      const all = createScreenFixtures(sessionId);
      const observations = all.observations.filter((o) => o.id !== 'order-unknown');
      const used = new Set(observations.flatMap((o) => o.evidenceIds));
      return { observations, evidence: all.evidence.filter((e) => used.has(e.id)) };
    });
  }

  /** Advances the mock clock to the wall clock. The timer calls this; tests call it with a fake `now`. */
  tick(): void {
    const t = this.now();
    if (t > this.clockMs) {
      this.clockMs = t;
      this.mock.advanceTo(t);
    }
  }

  async start(session: SessionStart): Promise<void> {
    this.tick();
    await this.mock.start(session);
    if (this.timer === null) this.timer = this.timers.setInterval(() => this.tick(), SAMPLE_TICK_MS);
  }

  async pause(): Promise<void> { await this.mock.pause(); }
  async resume(): Promise<void> { await this.mock.resume(); }

  async stop(): Promise<void> {
    this.stopTimer();
    await this.mock.stop();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopTimer();
    void this.mock.stop();
  }

  resolveEvidence(id: string): Promise<EvidenceRef> { return this.mock.resolveEvidence(id); }
  onObservation(listener: (o: ScreenObservation) => void): Unsubscribe { return this.mock.onObservation(listener); }
  onStatus(listener: (s: ScreenStatus) => void): Unsubscribe { return this.mock.onStatus(listener); }
  onCheckpoint(listener: (c: ActionCheckpoint) => void): Unsubscribe { return this.mock.onCheckpoint(listener); }
  replyToCheckpoint(reply: CheckpointReply): Promise<void> { return this.mock.replyToCheckpoint(reply); }

  raiseSampleCheckpoint(): void {
    this.tick();
    this.mock.raiseCheckpoint();
  }
}
