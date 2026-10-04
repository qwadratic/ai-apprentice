import type {
  ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenBridge, ScreenObservation,
  ScreenStatus, SessionStart, Unsubscribe,
} from '@apprentice/contracts';
import {
  parseCheckpointReply, parseScreenObservation, parseScreenStatus,
  parseSessionStart,
} from '@apprentice/contracts';
import {ScreenCapture} from '../capture/ScreenCapture.js';
import type {CaptureProvenance, CaptureRuntime, FrameLease, ProcessedFrame} from '../capture/ScreenCapture.js';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Timer = ReturnType<typeof setTimeout>;

export interface ScreenBridgeRuntimeOptions {
  readonly apiBase: string;
  readonly authHeader: () => string | null;
  readonly sourceRevision: () => string | null;
  readonly surface?: () => CaptureProvenance['surface'];
  readonly fetch?: Fetch;
  readonly captureRuntime?: CaptureRuntime;
  readonly pollIntervalMs?: number;
  readonly frameIntervalMs?: number;
}

export interface ScreenBridgeRuntime {
  readonly bridge: ScreenBridge;
  readonly capture: ScreenCapture;
  /** Panel lifecycle which cannot clear an app-owned off-record pause. */
  readonly panelController: Pick<ScreenBridge, 'start' | 'pause' | 'resume' | 'stop'>;
  dispose(): void;
}

interface ActiveSession {
  readonly session: SessionStart;
  readonly localGeneration: number;
  serverGeneration: number;
  cursor: number;
  screenToken: string | null;
  controller: AbortController;
  privacyGeneration: number;
}

export function createScreenBridgeRuntime(options: ScreenBridgeRuntimeOptions): ScreenBridgeRuntime {
  return new Runtime(options);
}

class Runtime implements ScreenBridgeRuntime {
  readonly bridge: ScreenBridge;
  readonly capture: ScreenCapture;
  readonly panelController: ScreenBridgeRuntime['panelController'];
  readonly #fetch: Fetch;
  readonly #observations = new Set<(value: ScreenObservation) => void>();
  readonly #statuses = new Set<(value: ScreenStatus) => void>();
  readonly #checkpoints = new Set<(value: ActionCheckpoint) => void>();
  readonly #options: ScreenBridgeRuntimeOptions;
  #active: ActiveSession | null = null;
  #generation = 0;
  #pollTimer: Timer | null = null;
  #disposed = false;
  #offRecord = false;
  #objectUrls = new Set<string>();

  constructor(options: ScreenBridgeRuntimeOptions) {
    if (!options || typeof options.apiBase !== 'string' || typeof options.authHeader !== 'function' ||
        typeof options.sourceRevision !== 'function' ||
        (options.surface !== undefined && typeof options.surface !== 'function')) throw new TypeError('Invalid screen bridge options.');
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.capture = new ScreenCapture({
      ...(options.captureRuntime ? {runtime: options.captureRuntime} : {}),
      ...(options.frameIntervalMs ? {frameIntervalMs: options.frameIntervalMs} : {}),
      snapshotProvenance: () => ({surface: options.surface?.() ?? null, sourceRevision: options.sourceRevision()}),
      onFrame: (frame, lease) => this.#upload(frame, lease),
    });
    this.capture.subscribe(snapshot => {
      const active = this.#active;
      if (!active || snapshot.session?.sessionId !== active.session.sessionId) return;
      if (snapshot.state === 'paused' && !this.#offRecord) this.#emitStatus('paused', snapshot.reason);
      else if (snapshot.state === 'capturing' && !this.#offRecord) this.#emitStatus('capturing');
      else if (snapshot.state === 'stopped') this.#emitStatus('stopped', snapshot.reason);
      else if (snapshot.state === 'error') this.#emitStatus('error', snapshot.reason);
    });
    this.capture.onInvalidate(() => {
      const active = this.#active;
      if (active) this.#invalidateRequests(active);
    });
    this.bridge = {
      start: value => this.#start(value), pause: () => this.#pause(true), resume: () => this.#resume(true),
      stop: () => this.#stop(true), resolveEvidence: id => this.#resolveEvidence(id),
      onObservation: listener => subscribe(this.#observations, listener),
      onStatus: listener => subscribe(this.#statuses, listener),
      onCheckpoint: listener => subscribe(this.#checkpoints, listener),
      replyToCheckpoint: reply => this.#replyToCheckpoint(reply),
    };
    this.panelController = {
      start: value => this.#offRecord ? Promise.resolve() : this.#start(value), pause: () => this.#pause(false), resume: () => this.#resume(false), stop: () => this.#stop(false),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeActive();
    this.capture.dispose();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
    this.#observations.clear(); this.#statuses.clear(); this.#checkpoints.clear();
  }

  async #start(value: SessionStart): Promise<void> {
    if (this.#disposed) throw new Error('Screen bridge has been disposed.');
    const session = parseSessionStart(value);
    this.#closeActive();
    this.#offRecord = false;
    const localGeneration = ++this.#generation;
    const controller = new AbortController();
    const active: ActiveSession = {session, localGeneration, serverGeneration: 0, cursor: 0, screenToken: null, controller, privacyGeneration: 0};
    this.#active = active;
    // Deliberately invoke capture before constructing or awaiting the HTTP request.
    const captureStart = this.capture.start(session);
    // start() synchronously advances capture privacy generation before opening the picker.
    this.#renewRequests(active);
    try {
      const response = await this.#request(active, 'start', {sessionEpochMs: session.sessionEpochMs, clientGeneration: 1}, true);
      const body = await jsonRecord(response);
      exactKeys(body, ['sessionId', 'generation', 'nextCursor', 'status'], ['sessionId', 'generation', 'sessionToken', 'nextCursor', 'status']);
      if (body.sessionId !== session.sessionId) throw new TransportError('session_mismatch');
      active.serverGeneration = integer(body.generation, 'generation', 1);
      active.cursor = integer(body.nextCursor, 'nextCursor', 0);
      if ('sessionToken' in body) active.screenToken = token(body.sessionToken);
      parseScreenStatus(body.status);
      await captureStart;
      this.#renewRequests(active);
      if (!this.#current(active)) return;
      const snapshot = this.capture.getSnapshot();
      this.#emitStatus(snapshot.state === 'capturing' ? 'capturing' : 'paused', snapshot.reason);
      if (snapshot.state === 'capturing') this.#schedulePoll(active, 0);
    } catch (error) {
      await captureStart.catch(() => undefined);
      if (this.#current(active)) {
        this.capture.stop(); this.#emitStatus('error', transportReason(error)); this.#closeActive();
      }
      throw error;
    }
  }

  async #pause(offRecord: boolean): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (offRecord) this.#offRecord = true;
    this.capture.pause('user-paused');
    this.#invalidateRequests(active);
    this.#emitStatus('paused', offRecord ? 'off_record' : 'user-paused');
    await this.#lifecycle(active, 'pause', offRecord ? 'off_record' : 'user-paused');
  }

  async #resume(appOwned: boolean): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (this.#offRecord && !appOwned) return;
    if (appOwned) this.#offRecord = false;
    if (!this.capture.resume()) {
      const snapshot = this.capture.getSnapshot();
      this.#emitStatus('paused', snapshot.reason ?? 'resume-refused');
      return;
    }
    this.#renewRequests(active);
    await this.#lifecycle(active, 'resume');
    if (this.#current(active)) { this.#emitStatus('capturing'); this.#schedulePoll(active, 0); }
  }

  async #stop(appOwned: boolean): Promise<void> {
    const active = this.#active;
    if (!active) { this.capture.stop(); return; }
    this.capture.stop(); this.#invalidateRequests(active); this.#emitStatus('stopped', 'stopped');
    try { await this.#lifecycle(active, 'stop'); } finally { if (this.#active === active) this.#closeActive(appOwned); }
  }

  async #upload(frame: ProcessedFrame, lease: FrameLease): Promise<void> {
    const active = this.#active;
    if (!active || !this.#current(active) || this.#offRecord || !lease.isCurrent() || frame.sessionId !== active.session.sessionId) return;
    const data = base64(new Uint8Array(await frame.image.arrayBuffer()));
    if (!this.#current(active) || this.#offRecord || !lease.isCurrent()) return;
    const response = await this.#request(active, 'frames', {generation: active.serverGeneration, frameId: frame.frameId,
      timestampMs: frame.timestampMs, processed: true, mediaType: 'image/png', data,
      provenance: {...frame.provenance, captureGeneration: frame.generation}});
    const body = await jsonRecord(response); exactKeys(body, ['ok', 'outcome', 'sessionId', 'generation', 'frameId']);
    if (body.sessionId !== active.session.sessionId || body.frameId !== frame.frameId || body.generation !== active.serverGeneration ||
        typeof body.ok !== 'boolean' || typeof body.outcome !== 'string') throw new TransportError('invalid_frame_response');
  }

  #schedulePoll(active: ActiveSession, delay = this.#options.pollIntervalMs ?? 1000): void {
    if (!this.#current(active) || this.#offRecord || this.capture.getSnapshot().state !== 'capturing') return;
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    this.#pollTimer = setTimeout(() => { this.#pollTimer = null; void this.#poll(active); }, delay);
  }

  async #poll(active: ActiveSession): Promise<void> {
    const privacyGeneration = active.privacyGeneration;
    try {
      const response = await this.#request(active, `updates?cursor=${active.cursor}&generation=${active.serverGeneration}`);
      const body = await jsonRecord(response); exactKeys(body, ['sessionId', 'generation', 'observations', 'statuses', 'nextCursor']);
      if (body.sessionId !== active.session.sessionId || body.generation !== active.serverGeneration ||
          !Array.isArray(body.observations) || !Array.isArray(body.statuses)) throw new TransportError('invalid_updates');
      const observations = body.observations.map(parseScreenObservation);
      const statuses = body.statuses.map(parseScreenStatus);
      const nextCursor = integer(body.nextCursor, 'nextCursor', active.cursor);
      if (!this.#current(active, privacyGeneration) || this.#offRecord || this.capture.getSnapshot().state !== 'capturing') return;
      active.cursor = nextCursor;
      for (const observation of observations) {
        if (!this.#current(active, privacyGeneration) || this.#offRecord) return;
        if (observation.sessionId !== active.session.sessionId) throw new TransportError('observation_session');
        this.#publish(this.#observations, observation);
      }
      for (const status of statuses) {
        if (!this.#current(active, privacyGeneration) || this.#offRecord) return;
        if (status.sessionId !== active.session.sessionId) throw new TransportError('status_session');
        this.#publish(this.#statuses, status);
      }
    } catch (error) {
      if (this.#current(active) && !isAbort(error)) this.#emitStatus('error', transportReason(error));
    } finally { this.#schedulePoll(active); }
  }

  async #lifecycle(active: ActiveSession, command: 'pause' | 'resume' | 'stop', reason?: string): Promise<void> {
    if (!active.serverGeneration) return;
    try {
      const controller = new AbortController();
      const response = await this.#request(active, 'lifecycle', {generation: active.serverGeneration, command, ...(reason ? {reason} : {})}, true, controller.signal);
      const body = await jsonRecord(response);
      exactKeys(body, ['sessionId', 'generation', 'nextCursor', 'status']);
      if (body.sessionId !== active.session.sessionId) throw new TransportError('session_mismatch');
      active.serverGeneration = integer(body.generation, 'generation', active.serverGeneration + 1);
      active.cursor = integer(body.nextCursor, 'nextCursor', 0);
      parseScreenStatus(body.status);
    } catch (error) { if (!isAbort(error) && this.#active === active) this.#emitStatus('error', transportReason(error)); }
  }

  async #resolveEvidence(evidenceId: string): Promise<EvidenceRef> {
    const active = this.#requireActive();
    const privacyGeneration = active.privacyGeneration;
    if (typeof evidenceId !== 'string' || !evidenceId) throw new TypeError('Evidence id required.');
    const response = await this.#request(active, `evidence/${encodeURIComponent(evidenceId)}`);
    const body = await jsonRecord(response); exactKeys(body, ['ok', 'evidence']);
    if (body.ok !== true) throw new TransportError('evidence_failed');
    const evidence = record(body.evidence, 'evidence');
    exactKeys(evidence, ['schemaVersion', 'id', 'kind', 'assetRef', 'startMs', 'endMs', 'sessionId', 'frameId', 'mediaType', 'byteLength']);
    if (evidence.id !== evidenceId || typeof evidence.assetRef !== 'string' || !evidence.assetRef ||
        !Number.isSafeInteger(evidence.startMs) || !Number.isSafeInteger(evidence.endMs) ||
        (evidence.endMs as number) < (evidence.startMs as number)) throw new TransportError('invalid_evidence');
    const assetResponse = await this.#request(active, `evidence/${encodeURIComponent(evidenceId)}/asset`);
    const blob = await assetResponse.blob();
    if (!this.#current(active, privacyGeneration) || this.#offRecord) throw new TransportError('evidence_invalidated');
    const assetRef = URL.createObjectURL(blob);
    this.#objectUrls.add(assetRef);
    return {assetRef, startMs: evidence.startMs as number, endMs: evidence.endMs as number};
  }

  async #replyToCheckpoint(value: CheckpointReply): Promise<void> {
    parseCheckpointReply(value);
    throw new Error('Checkpoint reply transport is not configured.');
  }

  async #request(active: ActiveSession, suffix: string, body?: unknown, start = false, signal?: AbortSignal): Promise<Response> {
    const authorization = start ? this.#options.authHeader() : active.screenToken ? `Bearer ${active.screenToken}` : this.#options.authHeader();
    if (!authorization && !start) throw new TransportError('authorization_missing');
    const response = await this.#fetch(`${this.#options.apiBase}/screen/sessions/${encodeURIComponent(active.session.sessionId)}/${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', signal: signal ?? active.controller.signal,
      headers: {...(authorization ? {authorization} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    if (!response.ok) throw new TransportError(`http_${response.status}`);
    return response;
  }

  #requireActive(): ActiveSession { if (!this.#active) throw new Error('Screen bridge is not active.'); return this.#active; }
  #current(active: ActiveSession, privacyGeneration = active.privacyGeneration): boolean { return !this.#disposed && this.#active === active && this.#generation === active.localGeneration && active.privacyGeneration === privacyGeneration && !active.controller.signal.aborted; }
  #invalidateRequests(active: ActiveSession): void { active.privacyGeneration++; active.controller.abort(); if (this.#pollTimer !== null) clearTimeout(this.#pollTimer); this.#pollTimer = null; }
  #renewRequests(active: ActiveSession): void { active.controller = new AbortController(); }
  #closeActive(clearOffRecord = true): void { if (this.#active) this.#invalidateRequests(this.#active); this.#active = null; if (clearOffRecord) this.#offRecord = false; ++this.#generation; }
  #emitStatus(state: ScreenStatus['state'], reason?: string): void {
    const active = this.#active; if (!active) return;
    this.#publish(this.#statuses, parseScreenStatus({schemaVersion: 1, sessionId: active.session.sessionId, state, ...(reason ? {reason} : {})}));
  }
  #publish<T>(listeners: Set<(value: T) => void>, value: T): void { for (const listener of listeners) { try { listener(value); } catch { /* subscriber isolation */ } } }
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): Unsubscribe {
  if (typeof listener !== 'function') throw new TypeError('Listener required.');
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TransportError(`invalid_${path}`); return value as Record<string, unknown>; }
async function jsonRecord(response: Response): Promise<Record<string, unknown>> { return record(await response.json(), 'response'); }
function exactKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[] = required): void {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.includes(key))) throw new TransportError('invalid_response');
}
function integer(value: unknown, path: string, min: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new TransportError(`invalid_${path}`); return value; }
function token(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(value)) throw new TransportError('invalid_session_token'); return value; }
function base64(bytes: Uint8Array): string { let result = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(result); }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
function transportReason(error: unknown): string { return error instanceof TransportError ? error.code : 'screen_transport_failed'; }
class TransportError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'TransportError'; this.code = code; }
}
