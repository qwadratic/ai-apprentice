// FakeScreenBridge: replays a recorded fixture through the ScreenBridge v1 draft
// interface on an injectable clock. Stream B develops and tests against it until
// stream A's real bridge lands; the real bridge must behave the same way.
//
// This module is browser-safe: it takes the fixture object and imports no node: module.
// The Node loader is in ./fixture-node.ts (package subpath "@apprentice/agent/node").
//
// Lifecycle (matches A's ScreenCapture):
// - start() ends paused with reason "mask-review"; capturing begins only after
//   confirmMasks() (or a resume() once the masks are confirmed);
// - resume() can be refused (masks unconfirmed, or a reason set with blockResume());
//   it then resolves {state: "paused", reason} and is not an error.
//
// Time model:
// - observation.timestampMs = clock.now() - sessionEpochMs at emission (wall clock);
// - the fixture timeline is anchored at the moment capturing first begins and runs on
//   the wall clock: a fixture observation is due at captureStart + atMs;
// - input_activity facts: the fixture's lastInputAtMs counts from capture start like atMs
//   and is shifted by the same offset when emitted, so idleMs = timestampMs - lastInputAtMs holds;
// - confirmMasks() never lifts a pause other than "mask-review" (off-record stays in force);
// - replyToCheckpoint() accepts only a checkpoint raised in this session, with matching basedOn;
// - pause() cancels emission; observations that fall due while paused are DROPPED
//   (never deferred, never replayed in a burst on resume). Paused time is a gap in
//   the session timeline, so evidence times are not shifted by pauses.

import { SCHEMA_VERSION, validateCheckpointReply, validateScreenObservation } from "../contract-draft.ts";
import type {
  ActionCheckpoint,
  CheckpointReply,
  EvidenceKind,
  EvidenceRef,
  InputActivityFacts,
  PauseReason,
  ScreenBridge,
  ScreenBridgeResult,
  ScreenObservation,
  ScreenStatus,
  ScreenStatusReason,
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
  /** Offset from the moment capturing first began (wall clock, pauses included). */
  atMs: number;
  kind: ScreenObservation["kind"];
  source: ScreenObservation["source"];
  frameId: string | null;
  sourceRevision: string | null;
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
  /** The fixture timeline is anchored here (clock ms) when capturing first begins; null before that. */
  private captureStartMs: number | null = null;
  private masksConfirmed = false;
  private pauseReason: ScreenStatusReason | undefined = undefined;
  private blockedResume: ScreenStatusReason | null = null;
  private timer: TimerHandle | null = null;
  private obsListeners = new Set<(o: ScreenObservation) => void>();
  private statusListeners = new Set<(s: ScreenStatus) => void>();
  private checkpointListeners = new Set<(c: ActionCheckpoint) => void>();
  private resolved = new Map<string, EvidenceRef>();
  private checkpointCount = 0;
  /** Checkpoints raised in this session; a reply must name one of them. */
  private raised = new Map<string, ActionCheckpoint>();

  /** Everything emitted so far, in order. */
  readonly emitted: ScreenObservation[] = [];
  /** Replies the agent sent to checkpoints, in order. */
  readonly replies: CheckpointReply[] = [];
  /** Ids of fixture observations that fell due while paused and were dropped. */
  readonly dropped: string[] = [];

  constructor(fixture: ScreenFixture, clock: Clock = systemClock) {
    this.fixture = fixture;
    this.clock = clock;
  }

  async start(opts: { sessionId: string; sessionEpochMs: number }): Promise<ScreenBridgeResult> {
    if (this.state !== "idle" && this.state !== "stopped") throw new Error(`start(): bridge is ${this.state}`);
    this.sessionId = opts.sessionId;
    this.sessionEpochMs = opts.sessionEpochMs;
    this.index = 0;
    this.sequence = 0;
    this.captureStartMs = null;
    this.masksConfirmed = false;
    this.blockedResume = null;
    this.resolved.clear();
    this.emitted.length = 0;
    this.dropped.length = 0;
    this.replies.length = 0;
    this.checkpointCount = 0;
    this.raised.clear();
    this.state = "paused";
    this.pauseReason = "mask-review";
    this.emitStatus("paused", "mask-review");
    return { state: "paused", reason: "mask-review" };
  }

  /** Output is closed synchronously; whatever was scheduled is gone and never emitted later. */
  async pause(reason: PauseReason = "user-paused"): Promise<void> {
    if (this.state === "capturing") {
      this.cancelTimer();
      this.state = "paused";
      this.pauseReason = reason;
      this.emitStatus("paused", reason);
    } else if (this.state === "paused" && this.pauseReason !== reason) {
      this.pauseReason = reason;
      this.emitStatus("paused", reason);
    }
  }

  async resume(): Promise<ScreenBridgeResult> {
    if (this.state !== "paused") return { state: this.state === "idle" ? "stopped" : this.state };
    const refusal: ScreenStatusReason | null = !this.masksConfirmed ? "mask-review" : this.blockedResume;
    if (refusal) {
      if (this.pauseReason !== refusal) {
        this.pauseReason = refusal;
        this.emitStatus("paused", refusal);
      }
      return { state: "paused", reason: refusal };
    }
    const now = this.clock.now();
    if (this.captureStartMs === null) {
      this.captureStartMs = now;
    } else {
      // Everything that fell due while paused is dropped, not deferred.
      for (;;) {
        const next = this.fixture.observations[this.index];
        if (!next || this.dueAt(next) >= now) break;
        this.dropped.push(next.id);
        this.index++;
      }
    }
    this.state = "capturing";
    this.pauseReason = undefined;
    this.emitStatus("capturing");
    this.scheduleNext();
    return { state: "capturing" };
  }

  /**
   * Masks reviewed and confirmed: clears the review flag and resumes only if the current
   * pause reason is "mask-review". It never lifts any other pause: an off-the-record pause
   * (or a user pause, or a refused resume) stays in force and is reported back.
   */
  async confirmMasks(): Promise<ScreenBridgeResult> {
    if (this.state === "idle" || this.state === "stopped") throw new Error(`confirmMasks(): bridge is ${this.state}`);
    this.masksConfirmed = true;
    if (this.state === "paused" && this.pauseReason === "mask-review") return this.resume();
    if (this.state === "paused") return { state: "paused", reason: this.pauseReason };
    return { state: this.state };
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    this.cancelTimer();
    this.state = "stopped";
    this.pauseReason = undefined;
    this.emitStatus("stopped", "stopped");
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
    const cp = this.raised.get(reply.checkpointId);
    if (!cp) throw new Error(`replyToCheckpoint(): unknown checkpoint ${reply.checkpointId}`);
    if (reply.basedOn.order !== cp.revisions.order || reply.basedOn.email !== cp.revisions.email) {
      throw new Error(`replyToCheckpoint(): reply to ${cp.id} is based on revisions that differ from the checkpoint's`);
    }
    this.replies.push(structuredClone(reply));
  }

  // -- test and demo helpers (not part of the ScreenBridge interface) --------

  /** Simulates a refusal reason for resume() (e.g. "geometry-changed", "source-muted"); null clears it. */
  blockResume(reason: ScreenStatusReason | null): void {
    this.blockedResume = reason;
  }

  /**
   * Plays the sandbox's role at Preview: raises an ActionCheckpoint whose
   * observationIds include the latest order and latest email-draft observation,
   * with the workspace's revisions (the observations' sourceRevision). No facts: the
   * agent reads them from the referenced observations (see factsFromCheckpoint).
   */
  raiseCheckpoint(): ActionCheckpoint {
    if (this.state !== "capturing") throw new Error(`raiseCheckpoint(): bridge is ${this.state}`);
    const latest = {} as Record<"order_view" | "email_draft", ScreenObservation>;
    for (const kind of ["order_view", "email_draft"] as const) {
      const o = this.emitted.filter((x) => x.kind === kind).at(-1);
      if (!o) throw new Error(`raiseCheckpoint(): no ${kind} observation emitted yet`);
      if (o.sourceRevision === null) throw new Error(`raiseCheckpoint(): ${kind} observation ${o.id} has no sourceRevision`);
      latest[kind] = o;
    }
    const order = latest.order_view;
    const email = latest.email_draft;
    const checkpoint: ActionCheckpoint = {
      schemaVersion: SCHEMA_VERSION,
      id: `cp-${++this.checkpointCount}`,
      sessionId: this.sessionId,
      timestampMs: this.clock.now() - this.sessionEpochMs,
      observationIds: [order.id, email.id],
      revisions: { order: order.sourceRevision!, email: email.sourceRevision! },
      action: "send",
    };
    this.raised.set(checkpoint.id, structuredClone(checkpoint));
    for (const l of [...this.checkpointListeners]) l(structuredClone(checkpoint));
    return checkpoint;
  }

  /** True once every fixture observation has been emitted. */
  get finished(): boolean {
    return this.index >= this.fixture.observations.length;
  }

  // -- internals -------------------------------------------------------------

  private dueAt(f: FixtureObservation): number {
    return (this.captureStartMs ?? 0) + f.atMs;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    this.cancelTimer();
    const next = this.fixture.observations[this.index];
    if (!next) return;
    const delay = Math.max(0, this.dueAt(next) - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.emitNext(), delay);
  }

  private emitNext(): void {
    this.timer = null;
    if (this.state !== "capturing") return;
    const f = this.fixture.observations[this.index];
    if (!f) return;
    this.index++;
    const timestampMs = this.clock.now() - this.sessionEpochMs;
    const shift = (this.captureStartMs ?? 0) - this.sessionEpochMs; // evidence offsets count from capture start
    for (const id of f.evidenceIds) {
      if (this.resolved.has(id)) continue;
      const e = this.fixture.evidence.find((x) => x.id === id);
      if (!e) throw new Error(`fixture observation ${f.id} references unknown evidence ${id}`);
      this.resolved.set(id, { assetRef: e.assetRef, startMs: e.startOffsetMs + shift, endMs: e.endOffsetMs + shift });
    }
    let facts = structuredClone(f.facts);
    if (f.kind === "input_activity") {
      // The fixture counts lastInputAtMs from capture start, like atMs; the session timeline
      // counts from sessionEpochMs, so it moves by the same offset as timestampMs does.
      const hb = facts as InputActivityFacts;
      facts = { ...hb, lastInputAtMs: hb.lastInputAtMs + shift };
    }
    const obs = {
      schemaVersion: SCHEMA_VERSION,
      id: f.id,
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      timestampMs,
      source: f.source,
      frameId: f.frameId,
      sourceRevision: f.sourceRevision,
      kind: f.kind,
      facts,
      entityRef: f.entityRef,
      evidenceIds: [...f.evidenceIds],
    } as ScreenObservation;
    const check = validateScreenObservation(obs);
    if (!check.ok) throw new ValidationError(`fixture observation ${f.id}`, check.errors);
    this.emitted.push(obs);
    for (const l of [...this.obsListeners]) l(structuredClone(obs));
    this.scheduleNext();
  }

  private emitStatus(state: ScreenStatus["state"], reason?: ScreenStatusReason): void {
    const status: ScreenStatus = { schemaVersion: SCHEMA_VERSION, sessionId: this.sessionId, state };
    if (reason !== undefined) status.reason = reason;
    for (const l of [...this.statusListeners]) l({ ...status });
  }
}
