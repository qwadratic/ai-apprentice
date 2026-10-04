import type { ActionCheckpoint, CheckpointReply, ResolvedEvidence, ScreenBridge, ScreenEvidence, ScreenObservation, ScreenStatus, SessionStart, Unsubscribe } from './types.ts';
import { createScreenFixtures } from './fixtures.ts';
import { assertCurrentCheckpoint, parseCheckpointReply, parseScreenEvidence, parseScreenObservation, parseSessionStart } from './validators.ts';
export class EvidenceUnavailableError extends Error {
  readonly code = 'EVIDENCE_UNAVAILABLE';
  constructor() { super('Evidence is not published in the current session'); this.name = 'EvidenceUnavailableError'; }
}
export interface MockFixture { observations: ScreenObservation[]; evidence: ScreenEvidence[] }
/** Manual absolute clock: advanceTo(epochMs). No wall-clock timers, network or real capture. */
export class MockScreenBridge implements ScreenBridge {
  #clockMs: number;
  #session: SessionStart | undefined;
  #state: ScreenStatus['state'] = 'stopped';
  #generation = 0;
  #cursor = 0;
  #fixture: MockFixture = {observations: [], evidence: []};
  #available = new Map<string, ScreenEvidence>();
  #observations = new Set<(o: ScreenObservation) => void>();
  #statuses = new Set<(s: ScreenStatus) => void>();
  #checkpointListeners = new Set<(c: ActionCheckpoint) => void>();
  #pending = new Map<string, {checkpoint: ActionCheckpoint; generation: number}>();
  #emitted: ScreenObservation[] = [];
  #checkpointCount = 0;
  readonly replies: CheckpointReply[] = [];
  readonly fixtureFactory: (sessionId: string) => MockFixture;
  constructor(nowEpochMs = 0, fixtureFactory: (sessionId: string) => MockFixture = createScreenFixtures) {
    this.fixtureFactory = fixtureFactory;
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new Error('Invalid mock clock');
    this.#clockMs = nowEpochMs;
  }
  onObservation(listener: (o: ScreenObservation) => void): Unsubscribe { this.#observations.add(listener); return () => { this.#observations.delete(listener); }; }
  onStatus(listener: (s: ScreenStatus) => void): Unsubscribe { this.#statuses.add(listener); return () => { this.#statuses.delete(listener); }; }
  onCheckpoint(listener: (c: ActionCheckpoint) => void): Unsubscribe { this.#checkpointListeners.add(listener); return () => { this.#checkpointListeners.delete(listener); }; }
  raiseCheckpoint(): ActionCheckpoint {
    if (!this.#session || this.#state !== 'capturing') throw new Error('Checkpoint requires active capture');
    const order = this.#emitted.filter((o) => o.kind === 'order_view').at(-1);
    const email = this.#emitted.filter((o) => o.kind === 'email_draft').at(-1);
    if (!order?.sourceRevision || !email?.sourceRevision) throw new Error('Checkpoint requires tracked order and email revisions');
    const checkpoint = assertCurrentCheckpoint({
      schemaVersion: 1,
      id: `checkpoint-${++this.#checkpointCount}`,
      sessionId: this.#session.sessionId,
      timestampMs: this.#clockMs - this.#session.sessionEpochMs,
      observationIds: [order.id, email.id],
      revisions: {order: order.sourceRevision, email: email.sourceRevision},
      action: 'send',
    }, this.#session.sessionId, this.#emitted);
    this.#pending.set(checkpoint.id, {checkpoint, generation: this.#generation});
    for (const listener of this.#checkpointListeners) {
      if (this.#state !== 'capturing' || !this.#pending.has(checkpoint.id)) break;
      listener(structuredClone(checkpoint));
    }
    return structuredClone(checkpoint);
  }
  async replyToCheckpoint(value: CheckpointReply): Promise<void> {
    const reply = parseCheckpointReply(value);
    const pending = this.#pending.get(reply.checkpointId);
    if (!pending || !this.#session || this.#state !== 'capturing' || pending.generation !== this.#generation) throw new Error('Unknown or stale checkpoint reply');
    assertCurrentCheckpoint(pending.checkpoint, this.#session.sessionId, this.#emitted);
    if (reply.basedOn.order !== pending.checkpoint.revisions.order || reply.basedOn.email !== pending.checkpoint.revisions.email) throw new Error('Checkpoint reply revision mismatch');
    this.#pending.delete(reply.checkpointId); this.replies.push(reply);
  }
  #status(state: ScreenStatus['state'], reason?: string): void {
    this.#state = state;
    if (this.#session) for (const listener of this.#statuses) listener({schemaVersion: 1, sessionId: this.#session.sessionId, state, ...(reason ? {reason} : {})});
  }
  async start(value: SessionStart): Promise<void> {
    const session = parseSessionStart(value);
    if (session.sessionEpochMs > this.#clockMs) throw new Error('Session epoch is in the future');
    const raw = this.fixtureFactory(session.sessionId);
    const fixture = {observations: raw.observations.map(parseScreenObservation), evidence: raw.evidence.map(parseScreenEvidence)};
    let sequence = 0; let timestamp = -1;
    const ids = new Set<string>();
    const evidence = new Map(fixture.evidence.map((e) => [e.id, e]));
    if (evidence.size !== fixture.evidence.length) throw new Error('Duplicate evidence id');
    for (const o of fixture.observations) {
      if (o.sessionId !== session.sessionId || o.sequence <= sequence || o.timestampMs < timestamp || ids.has(o.id)) throw new Error('Invalid fixture order/session/id');
      for (const id of o.evidenceIds) {
        const e = evidence.get(id);
        if (!e || o.timestampMs < e.startMs || o.timestampMs > e.endMs) throw new Error('Fixture evidence does not cover capture');
      }
      sequence = o.sequence; timestamp = o.timestampMs; ids.add(o.id);
    }
    this.#generation++; this.#session = session; this.#fixture = fixture; this.#cursor = 0; this.#available.clear(); this.#pending.clear(); this.#emitted = []; this.replies.length = 0; this.#status('capturing');
  }
  async pause(): Promise<void> { this.#generation++; this.#pending.clear(); if (this.#session && this.#state === 'capturing') this.#status('paused', 'off_record'); }
  async resume(): Promise<void> {
    if (!this.#session || this.#state !== 'paused') throw new Error('Only a paused session can resume');
    this.#discardDue(); this.#status('capturing');
  }
  async stop(): Promise<void> { this.#generation++; this.#pending.clear(); if (this.#session) this.#status('stopped'); }
  #discardDue(): void {
    if (!this.#session) return;
    while (this.#cursor < this.#fixture.observations.length && this.#fixture.observations[this.#cursor]!.timestampMs <= this.#clockMs - this.#session.sessionEpochMs) this.#cursor++;
  }
  advanceTo(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.#clockMs) throw new Error('Mock clock moved backwards');
    this.#clockMs = epochMs;
    if (!this.#session) return;
    if (this.#state !== 'capturing') { this.#discardDue(); return; }
    const generation = this.#generation;
    while (generation === this.#generation && this.#state === 'capturing' && this.#cursor < this.#fixture.observations.length) {
      const o = this.#fixture.observations[this.#cursor]!;
      if (o.timestampMs > epochMs - this.#session.sessionEpochMs) break;
      this.#cursor++; this.#emitted.push(structuredClone(o));
      for (const id of o.evidenceIds) this.#available.set(id, this.#fixture.evidence.find((e) => e.id === id)!);
      for (const listener of this.#observations) {
        if (generation !== this.#generation || this.#state !== 'capturing') break;
        listener(structuredClone(o));
      }
    }
  }
  async resolveEvidence(id: string): Promise<ResolvedEvidence> {
    const e = this.#available.get(id); if (!e) throw new EvidenceUnavailableError();
    return {assetRef: e.assetRef, startMs: e.startMs, endMs: e.endMs};
  }
}
