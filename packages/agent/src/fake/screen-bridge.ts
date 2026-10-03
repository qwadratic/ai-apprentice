// FakeScreenBridge: replays a recorded fixture through the ScreenBridge v1 draft
// interface on an injectable clock. Stream B develops and tests against it until
// stream A's real bridge lands; the real bridge must behave the same way.
//
// This module is browser-safe: it takes the fixture object and imports no node: module.
// The Node loader is in ./fixture-node.ts (package subpath "@apprentice/agent/node").
//
// Time model:
// - observation.timestampMs = clock.now() - sessionEpochMs at emission;
// - the fixture timeline advances only while capturing, so pause() freezes it and
//   resume() continues from the same point: nothing is dropped, nothing is emitted
//   in a burst, and later timestamps (and evidence times) shift by the paused time.

import { SCHEMA_VERSION, validateCheckpointReply, validateScreenObservation } from "../contract-draft.ts";
import type {
  ActionCheckpoint,
  CheckpointReply,
  EvidenceKind,
  EvidenceRef,
  ScreenBridge,
  ScreenObservation,
  ScreenStatus,
  Unsubscribe,
} from "../contract-draft.ts";
import { systemClock } from "../clock.ts";
import type { Clock, TimerHandle } from "../clock.ts";
import { ValidationError } from "../validation.ts";

export interface FixtureEvidence {
  id: string;
  kind: EvidenceKind;
  assetRef: string;
  startOffsetMs: number;
  endOffsetMs: number;
}

export interface FixtureObservation {
  id: string;
  /** Offset from the start of the active timeline. */
  atMs: number;
  kind: ScreenObservation["kind"];
  frameId: string;
  entityRef: string | null;
  evidenceIds: string[];
  facts: ScreenObservation["facts"];
}

export interface ScreenFixture {
  schemaVersion: 1;
  scenario: string;
  description: string;
  sessionId: string;
  durationMs: number;
  evidence: FixtureEvidence[];
  observations: FixtureObservation[];
}

type BridgeState = "idle" | "capturing" | "paused" | "stopped";

export class FakeScreenBridge implements ScreenBridge {
  private readonly fixture: ScreenFixture;
  private readonly clock: Clock;
  private state: BridgeState = "idle";
  private sessionId = "";
  private sessionEpochMs = 0;
  private index = 0;
  private sequence = 0;
  /** Active (non-paused) time already consumed, excluding the running segment. */
  private activeElapsedMs = 0;
  private activeSinceMs = 0;
  private timer: TimerHandle | null = null;
  private obsListeners = new Set<(o: ScreenObservation) => void>();
  private statusListeners = new Set<(s: ScreenStatus) => void>();
  private checkpointListeners = new Set<(c: ActionCheckpoint) => void>();
  private resolved = new Map<string, EvidenceRef>();
  private checkpointCount = 0;

  /** Everything emitted so far, in order. */
  readonly emitted: ScreenObservation[] = [];
  /** Replies the agent sent to checkpoints, in order. */
  readonly replies: CheckpointReply[] = [];

  constructor(fixture: ScreenFixture, clock: Clock = systemClock) {
    this.fixture = fixture;
    this.clock = clock;
  }

  async start(opts: { sessionId: string; sessionEpochMs: number }): Promise<void> {
    if (this.state !== "idle" && this.state !== "stopped") throw new Error(`start(): bridge is ${this.state}`);
    this.sessionId = opts.sessionId;
    this.sessionEpochMs = opts.sessionEpochMs;
    this.index = 0;
    this.sequence = 0;
    this.activeElapsedMs = 0;
    this.activeSinceMs = this.clock.now();
    this.resolved.clear();
    this.emitted.length = 0;
    this.state = "capturing";
    this.emitStatus("capturing");
    this.scheduleNext();
  }

  async pause(): Promise<void> {
    if (this.state !== "capturing") return;
    this.cancelTimer();
    this.activeElapsedMs = this.elapsedActive();
    this.state = "paused";
    this.emitStatus("paused");
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    this.activeSinceMs = this.clock.now();
    this.state = "capturing";
    this.emitStatus("capturing");
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    this.cancelTimer();
    this.state = "stopped";
    this.emitStatus("stopped");
  }

  async resolveEvidence(evidenceId: string): Promise<EvidenceRef> {
    const ref = this.resolved.get(evidenceId);
    if (!ref) throw new Error(`unknown or not yet emitted evidence: ${evidenceId}`);
    return { ...ref };
  }

  onObservation(listener: (obs: ScreenObservation) => void): Unsubscribe {
    this.obsListeners.add(listener);
    return () => this.obsListeners.delete(listener);
  }

  onStatus(listener: (status: ScreenStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onCheckpoint(listener: (checkpoint: ActionCheckpoint) => void): Unsubscribe {
    this.checkpointListeners.add(listener);
    return () => this.checkpointListeners.delete(listener);
  }

  async replyToCheckpoint(reply: CheckpointReply): Promise<void> {
    const r = validateCheckpointReply(reply);
    if (!r.ok) throw new ValidationError("checkpoint reply", r.errors);
    this.replies.push(structuredClone(reply));
  }

  // -- test and demo helpers (not part of the ScreenBridge interface) --------

  /**
   * Plays the sandbox's role at Preview: raises an ActionCheckpoint whose
   * observationIds include the latest order and latest email-draft observation.
   */
  raiseCheckpoint(): ActionCheckpoint {
    if (this.state !== "capturing") throw new Error(`raiseCheckpoint(): bridge is ${this.state}`);
    const ids: string[] = [];
    for (const kind of ["order_view", "email_draft"] as const) {
      const latest = this.emitted.filter((o) => o.kind === kind).at(-1);
      if (!latest) throw new Error(`raiseCheckpoint(): no ${kind} observation emitted yet`);
      ids.push(latest.id);
    }
    const checkpoint: ActionCheckpoint = {
      schemaVersion: SCHEMA_VERSION,
      id: `cp-${++this.checkpointCount}`,
      sessionId: this.sessionId,
      timestampMs: this.clock.now() - this.sessionEpochMs,
      observationIds: ids,
      action: "send",
    };
    for (const l of [...this.checkpointListeners]) l(structuredClone(checkpoint));
    return checkpoint;
  }

  /** True once every fixture observation has been emitted. */
  get finished(): boolean {
    return this.index >= this.fixture.observations.length;
  }

  // -- internals -------------------------------------------------------------

  private elapsedActive(): number {
    return this.activeElapsedMs + (this.state === "capturing" ? this.clock.now() - this.activeSinceMs : 0);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    this.cancelTimer();
    const next = this.fixture.observations[this.index];
    if (!next) return;
    const delay = Math.max(0, next.atMs - this.elapsedActive());
    this.timer = this.clock.setTimeout(() => this.emitNext(), delay);
  }

  private emitNext(): void {
    this.timer = null;
    if (this.state !== "capturing") return;
    const f = this.fixture.observations[this.index];
    if (!f) return;
    this.index++;
    const timestampMs = this.clock.now() - this.sessionEpochMs;
    const shift = timestampMs - f.atMs; // accumulated paused time
    for (const id of f.evidenceIds) {
      if (this.resolved.has(id)) continue;
      const e = this.fixture.evidence.find((x) => x.id === id);
      if (!e) throw new Error(`fixture observation ${f.id} references unknown evidence ${id}`);
      this.resolved.set(id, { assetRef: e.assetRef, startMs: e.startOffsetMs + shift, endMs: e.endOffsetMs + shift });
    }
    const obs = {
      schemaVersion: SCHEMA_VERSION,
      id: f.id,
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      timestampMs,
      frameId: f.frameId,
      kind: f.kind,
      facts: structuredClone(f.facts),
      entityRef: f.entityRef,
      evidenceIds: [...f.evidenceIds],
    } as ScreenObservation;
    const check = validateScreenObservation(obs);
    if (!check.ok) throw new ValidationError(`fixture observation ${f.id}`, check.errors);
    this.emitted.push(obs);
    for (const l of [...this.obsListeners]) l(structuredClone(obs));
    this.scheduleNext();
  }

  private emitStatus(state: ScreenStatus["state"]): void {
    const status: ScreenStatus = { schemaVersion: SCHEMA_VERSION, sessionId: this.sessionId, state };
    for (const l of [...this.statusListeners]) l({ ...status });
  }
}
