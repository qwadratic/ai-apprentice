import type { ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenObservation, ScreenStatus, SessionStart, Unsubscribe } from '@apprentice/contracts';
import { MockScreenBridge } from '@apprentice/contracts/mock';
import type { ObservationSource } from './observation-source.ts';
import { buildScenario, scenarioLabel } from './sample-scenarios.ts';
import type { SampleScenarioId } from './sample-scenarios.ts';

export const SAMPLE_LABEL = 'Sample observations (synthetic)';
/** How often the manual mock clock is advanced to the wall clock. */
export const SAMPLE_TICK_MS = 250;

export interface SampleTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * The contracts' MockScreenBridge, driven by the wall clock. The default scenario is neutral and synthetic: the unknown-order
 * observation is left out, so that the latest order always has a tracked revision and a sample checkpoint can be raised at any
 * time after the email preview. The `learn` and Teach case scenarios (sample-scenarios.ts) play the customer_07 run and the
 * new cases. Everything it emits is labelled synthetic in the shell.
 */
export class SampleObservationSource implements ObservationSource {
  readonly label: string;
  readonly synthetic = true;
  readonly scenario: SampleScenarioId;
  private readonly mock: MockScreenBridge;
  private readonly now: () => number;
  private readonly timers: SampleTimers;
  private timer: unknown = null;
  private clockMs: number;

  constructor(now: () => number, timers: SampleTimers, scenario: SampleScenarioId = 'neutral') {
    this.now = now;
    this.timers = timers;
    this.scenario = scenario;
    this.label = scenario === 'neutral' ? SAMPLE_LABEL : scenarioLabel(scenario);
    this.clockMs = now();
    this.mock = new MockScreenBridge(this.clockMs, (sessionId) => buildScenario(scenario, sessionId));
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
