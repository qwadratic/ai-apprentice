import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {ScreenObservation, ScreenStatus} from '@apprentice/contracts';
import type {VisionPublicationContext, VisionQueueEvent, VisionSurface} from '../../../packages/screen/vision/queue.ts';
import type {ProcessedFrame, ScreenEvidenceRecord} from './evidence-store.ts';
import type {ScreenService} from './service.ts';
import {ObservationProvenanceRegistry} from './provenance.ts';

export interface SessionServiceFactoryContext {
  readonly sessionId: string; readonly generation: number;
  readonly publish: (observation: ScreenObservation, context: VisionPublicationContext<ScreenEvidenceRecord>) => void;
  readonly onEvent: (event: VisionQueueEvent) => void;
}
export type SessionServiceFactory = (context: SessionServiceFactoryContext) => ScreenService;
export type ScreenStatusParser = (value: unknown) => ScreenStatus;
export interface ScreenSessionStartResult {
  readonly sessionId: string; readonly generation: number; readonly sessionToken: string;
  readonly nextCursor: number; readonly status: ScreenStatus;
}
export interface ScreenUpdates {
  readonly sessionId: string; readonly generation: number; readonly observations: readonly ScreenObservation[];
  readonly statuses: readonly ScreenStatus[]; readonly nextCursor: number;
}
export class SessionTransportError extends Error {
  readonly code: SessionTransportErrorCode; readonly details: Readonly<Record<string, number>>;
  constructor(code: SessionTransportErrorCode, details: Readonly<Record<string, number>> = {}) { super(code); this.code = code; this.details = details; }
}
export type SessionTransportErrorCode = 'session_not_found' | 'unauthorized' | 'generation_mismatch' |
  'cursor_expired' | 'invalid_cursor' | 'session_limit' | 'inactive';
interface UpdateEvent {readonly cursor: number; readonly type: 'observation' | 'status'; readonly value: ScreenObservation | ScreenStatus}
export interface ScreenSessionHandle {
  readonly sessionId: string; readonly sessionEpochMs: number; readonly tokenHash: Buffer; readonly service: ScreenService;
  generation: number; state: ScreenStatus['state']; cursor: number; events: UpdateEvent[];
  registry: ObservationProvenanceRegistry; touchedAt: number;
}
export interface FrameUpload {
  readonly generation: number; readonly frame: ProcessedFrame; readonly provenance: {
    readonly surface: VisionSurface | null; readonly sourceRevision: string | null; readonly captureGeneration: number | null;
  };
}
export class ScreenSessionHub {
  readonly #sessions = new Map<string, ScreenSessionHandle>();
  readonly #createService: SessionServiceFactory; readonly #parseStatus: ScreenStatusParser;
  readonly #now: () => number; readonly #maxSessions: number; readonly #maxEvents: number;
  constructor(createService: SessionServiceFactory, parseStatus: ScreenStatusParser,
    now: () => number = Date.now, maxSessions = 8, maxEvents = 128) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 2) {
      throw new TypeError('Invalid session limits');
    }
    this.#createService = createService; this.#parseStatus = parseStatus; this.#now = now;
    this.#maxSessions = maxSessions; this.#maxEvents = maxEvents;
  }
  start(sessionId: string, sessionEpochMs: number, clientGeneration: number): ScreenSessionStartResult {
    if (!sessionId || sessionId.length > 200 || !Number.isSafeInteger(sessionEpochMs) || sessionEpochMs < 0 || clientGeneration !== 1) {
      throw new TypeError('Invalid session start');
    }
    const existing = this.#sessions.get(sessionId); existing?.service.stop();
    if (!existing && this.#sessions.size >= this.#maxSessions) this.#evictStopped();
    if (!existing && this.#sessions.size >= this.#maxSessions) throw new SessionTransportError('session_limit');
    const generation = 1; const sessionToken = randomBytes(32).toString('base64url');
    let record: ScreenSessionHandle;
    const service = this.#createService({sessionId, generation,
      publish: (observation, context) => this.#publish(record, observation, context),
      onEvent: event => this.#onVisionEvent(record, event)});
    record = {sessionId, sessionEpochMs, tokenHash: tokenHash(sessionToken), service, generation,
      state: 'capturing', cursor: 0, events: [], registry: new ObservationProvenanceRegistry(sessionId, generation), touchedAt: this.#now()};
    this.#sessions.set(sessionId, record); service.start({sessionId, sessionEpochMs});
    const status = this.#status(record, 'capturing'); this.#append(record, 'status', status);
    return {sessionId, generation, sessionToken, nextCursor: record.cursor, status};
  }
  authenticate(sessionId: string, token: string): ScreenSessionHandle {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new SessionTransportError('session_not_found');
    const supplied = tokenHash(token);
    if (supplied.length !== record.tokenHash.length || !timingSafeEqual(supplied, record.tokenHash)) {
      throw new SessionTransportError('unauthorized');
    }
    record.touchedAt = this.#now(); return record;
  }
  offer(record: ScreenSessionHandle, upload: FrameUpload): ReturnType<ScreenService['offer']> {
    this.#assertGeneration(record, upload.generation);
    if (record.state !== 'capturing') throw new SessionTransportError('inactive');
    return record.service.offer(upload.frame, upload.provenance);
  }
  updates(record: ScreenSessionHandle, generation: number, cursor: number, limit = 50): ScreenUpdates {
    this.#assertGeneration(record, generation);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.cursor || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new SessionTransportError('invalid_cursor', {nextCursor: record.cursor});
    }
    const minCursor = record.events.length ? (record.events[0]?.cursor ?? 1) - 1 : record.cursor;
    if (cursor < minCursor) throw new SessionTransportError('cursor_expired', {generation: record.generation, minCursor, nextCursor: record.cursor});
    const events = record.events.filter(event => event.cursor > cursor).slice(0, limit);
    return {sessionId: record.sessionId, generation: record.generation,
      observations: events.filter(isObservationEvent).map(event => event.value),
      statuses: events.filter(isStatusEvent).map(event => event.value),
      nextCursor: events.at(-1)?.cursor ?? cursor};
  }
  lifecycle(record: ScreenSessionHandle, generation: number, command: 'pause' | 'resume' | 'stop', reason?: string): {
    readonly sessionId: string; readonly generation: number; readonly nextCursor: number; readonly status: ScreenStatus;
  } {
    this.#assertGeneration(record, generation);
    if (command === 'pause') record.service.pause();
    else if (command === 'resume') record.service.resume();
    else record.service.stop();
    record.generation++; record.cursor = 0; record.events = [];
    record.registry = new ObservationProvenanceRegistry(record.sessionId, record.generation);
    record.state = command === 'pause' ? 'paused' : command === 'resume' ? 'capturing' : 'stopped';
    const status = this.#status(record, record.state, reason); this.#append(record, 'status', status);
    return {sessionId: record.sessionId, generation: record.generation, nextCursor: record.cursor, status};
  }
  evidence(record: ScreenSessionHandle): ScreenService['evidence'] { return record.service.evidence; }
  provenance(record: ScreenSessionHandle): ObservationProvenanceRegistry { return record.registry; }
  #publish(record: ScreenSessionHandle, observation: ScreenObservation, context: VisionPublicationContext<ScreenEvidenceRecord>): void {
    if (record.state !== 'capturing' || observation.sessionId !== record.sessionId) return;
    record.registry.record(observation, context); this.#append(record, 'observation', observation);
  }
  #onVisionEvent(record: ScreenSessionHandle, event: VisionQueueEvent): void {
    if (event.type !== 'error' || record.state !== 'capturing') return;
    this.#append(record, 'status', this.#status(record, 'error', event.code));
  }
  #status(record: ScreenSessionHandle, state: ScreenStatus['state'], reason?: string): ScreenStatus {
    return this.#parseStatus({schemaVersion: 1, sessionId: record.sessionId, state, ...(reason ? {reason} : {})});
  }
  #append(record: ScreenSessionHandle, type: UpdateEvent['type'], value: UpdateEvent['value']): void {
    record.events.push({cursor: ++record.cursor, type, value});
    if (record.events.length > this.#maxEvents) record.events.splice(0, record.events.length - this.#maxEvents);
  }
  #assertGeneration(record: ScreenSessionHandle, generation: number): void {
    if (generation !== record.generation) throw new SessionTransportError('generation_mismatch',
      {generation: record.generation, nextCursor: record.cursor});
  }
  #evictStopped(): void {
    const stopped = [...this.#sessions.values()].filter(record => record.state === 'stopped').sort((a, b) => a.touchedAt - b.touchedAt)[0];
    if (stopped) this.#sessions.delete(stopped.sessionId);
  }
}
function tokenHash(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function isObservationEvent(event: UpdateEvent): event is UpdateEvent & {type: 'observation'; value: ScreenObservation} {
  return event.type === 'observation';
}
function isStatusEvent(event: UpdateEvent): event is UpdateEvent & {type: 'status'; value: ScreenStatus} {
  return event.type === 'status';
}
