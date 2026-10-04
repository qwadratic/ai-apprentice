import type {
  ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenBridge, ScreenObservation,
  ScreenStatus, SessionStart, Unsubscribe,
} from '@apprentice/contracts';
import {
  parseActionCheckpoint, parseCheckpointReply, parseScreenObservation, parseScreenStatus,
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
  readonly workspace: ScreenWorkspaceRuntime;
  dispose(): void;
}

export interface WorkspaceRevisions {readonly order: string; readonly email: string}
export interface WorkspaceScope {readonly sessionId: string; readonly revisions: WorkspaceRevisions}
export interface WorkspaceActivity {
  readonly surface: 'order' | 'email' | 'ticket'; readonly typing: boolean;
  readonly lastInputAtMs: number; readonly idleMs: number;
}
export interface CurrentObservationRequest extends WorkspaceScope {
  readonly signal: AbortSignal; readonly timeoutMs?: number;
}
export interface ScreenWorkspaceRuntime {
  readonly registry: {
    waitForCurrent(request: CurrentObservationRequest): Promise<readonly ScreenObservation[]>;
    snapshot(sessionId: string): readonly ScreenObservation[];
  };
  getSession(): SessionStart | null;
  setScope(scope: WorkspaceScope): void;
  publishActivity(activity: WorkspaceActivity): ScreenObservation;
  dispatchCheckpoint(checkpoint: ActionCheckpoint, options?: {readonly signal?: AbortSignal; readonly timeoutMs?: number}): Promise<CheckpointReply>;
}

interface ActiveSession {
  readonly session: SessionStart;
  readonly localGeneration: number;
  serverGeneration: number;
  cursor: number;
  screenToken: string | null;
  controller: AbortController;
  privacyGeneration: number;
  serverReady: boolean;
  lifecycleTail: Promise<void>;
  serverState: ScreenStatus['state'];
  startReady: Promise<void>;
  resolveStart(): void;
  rejectStart(error: unknown): void;
  startController: AbortController;
}

export function createScreenBridgeRuntime(options: ScreenBridgeRuntimeOptions): ScreenBridgeRuntime {
  return new Runtime(options);
}

class Runtime implements ScreenBridgeRuntime {
  readonly bridge: ScreenBridge;
  readonly capture: ScreenCapture;
  readonly panelController: ScreenBridgeRuntime['panelController'];
  readonly workspace: ScreenWorkspaceRuntime;
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
  #captureCommand = false;
  #review: ActiveSession | null = null;
  #reviewController = new AbortController();
  #timelineSequence = 0;
  #visuals: ScreenObservation[] = [];
  #workspaceScope: WorkspaceScope | null = null;
  #waiters = new Set<ObservationWaiter>();
  #pendingCheckpoint: PendingCheckpoint | null = null;
  readonly #startedSessionIds = new Set<string>();

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
      else if (snapshot.state === 'stopped') this.#emitStatus('stopped', snapshot.reason);
      else if (snapshot.state === 'error') this.#emitStatus('error', snapshot.reason);
    });
    this.capture.onInvalidate(event => {
      const active = this.#active;
      if (!active) return;
      this.#invalidateWorkspace(new DOMException(`Capture invalidated: ${event.reason}`, 'AbortError'), true);
      active.serverReady = false;
      this.#invalidateRequests(active);
      if (!this.#captureCommand && active.serverGeneration > 0) {
        this.#emitStatus('paused', event.reason);
        void this.#enqueueLifecycle(active, 'pause', event.reason).catch(() => undefined);
      }
    });
    this.bridge = {
      start: value => this.#offRecord ? Promise.reject(new Error('Screen is off the record.')) : this.#start(value),
      pause: () => this.#pause(true), resume: () => this.#resume(true),
      stop: () => this.#stop(true), resolveEvidence: id => this.#resolveEvidence(id),
      onObservation: listener => subscribe(this.#observations, listener),
      onStatus: listener => subscribe(this.#statuses, listener),
      onCheckpoint: listener => subscribe(this.#checkpoints, listener),
      replyToCheckpoint: reply => this.#replyToCheckpoint(reply),
    };
    this.panelController = {
      start: value => this.#offRecord ? Promise.resolve() : this.#start(value), pause: () => this.#pause(false), resume: () => this.#resume(false), stop: () => this.#stop(false),
    };
    this.workspace = {
      registry: {waitForCurrent: request => this.#waitForCurrent(request), snapshot: sessionId => this.#visualSnapshot(sessionId)},
      getSession: () => this.#active ? structuredClone(this.#active.session) : null,
      setScope: scope => this.#setWorkspaceScope(scope),
      publishActivity: activity => this.#publishActivity(activity),
      dispatchCheckpoint: (checkpoint, dispatchOptions) => this.#dispatchCheckpoint(checkpoint, dispatchOptions),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#invalidateWorkspace(new DOMException('Screen runtime disposed.', 'AbortError'), true);
    this.#closeActive();
    this.#reviewController.abort(); this.#review = null;
    this.capture.dispose();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
    this.#observations.clear(); this.#statuses.clear(); this.#checkpoints.clear();
  }

  async #start(value: SessionStart): Promise<void> {
    if (this.#disposed) throw new Error('Screen bridge has been disposed.');
    const session = parseSessionStart(value);
    if (this.#startedSessionIds.has(session.sessionId)) {
      throw new Error('Screen session cannot be restarted. Start a new app session before capturing again.');
    }
    this.#startedSessionIds.add(session.sessionId);
    this.#invalidateWorkspace(new DOMException('Screen session changed.', 'AbortError'), true);
    this.#timelineSequence = 0;
    this.#closeActive();
    this.#reviewController.abort(); this.#reviewController = new AbortController(); this.#review = null;
    this.#offRecord = false;
    const localGeneration = ++this.#generation;
    const controller = new AbortController();
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    const startReady = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void startReady.catch(() => undefined);
    const active: ActiveSession = {session, localGeneration, serverGeneration: 0, cursor: 0, screenToken: null, controller,
      privacyGeneration: 0, serverReady: false, lifecycleTail: Promise.resolve(), serverState: 'stopped', startReady,
      resolveStart, rejectStart, startController: new AbortController()};
    this.#active = active;
    // Deliberately invoke capture before constructing or awaiting the HTTP request.
    const captureStart = this.capture.start(session);
    // start() synchronously advances capture privacy generation before opening the picker.
    this.#renewRequests(active);
    try {
      const response = await this.#request(active, 'start', {sessionEpochMs: session.sessionEpochMs, clientGeneration: 1}, true,
        active.startController.signal);
      const body = await jsonRecord(response);
      exactKeys(body, ['sessionId', 'generation', 'nextCursor', 'status'], ['sessionId', 'generation', 'sessionToken', 'nextCursor', 'status']);
      if (body.sessionId !== session.sessionId) throw new TransportError('session_mismatch');
      active.serverGeneration = integer(body.generation, 'generation', 1);
      active.cursor = integer(body.nextCursor, 'nextCursor', 0);
      if ('sessionToken' in body) active.screenToken = token(body.sessionToken);
      active.serverState = parseScreenStatus(body.status).state;
      active.resolveStart();
      await captureStart;
      await active.lifecycleTail;
      const selected = this.capture.getSnapshot();
      if (selected.state === 'paused' && active.serverState === 'capturing') {
        await this.#enqueueLifecycle(active, 'pause', selected.reason);
      }
      this.#renewRequests(active);
      if (!this.#current(active)) return;
      const snapshot = this.capture.getSnapshot();
      this.#emitStatus(snapshot.state === 'capturing' ? 'capturing' : 'paused', snapshot.reason);
      if (snapshot.state === 'capturing') this.#schedulePoll(active, 0);
    } catch (error) {
      active.rejectStart(error);
      await captureStart.catch(() => undefined);
      if (this.#active === active && this.#generation === active.localGeneration) {
        this.capture.stop(); this.#emitStatus('error', transportReason(error)); this.#closeActive();
      }
      throw error;
    }
  }

  async #pause(offRecord: boolean): Promise<void> {
    if (offRecord) this.#offRecord = true;
    const active = this.#active;
    if (!active) return;
    this.#invalidateWorkspace(new DOMException('Screen paused.', 'AbortError'), true);
    active.serverReady = false;
    this.#captureCommand = true;
    try { this.capture.pause('user-paused'); } finally { this.#captureCommand = false; }
    this.#invalidateRequests(active);
    this.#emitStatus('paused', offRecord ? 'off_record' : 'user-paused');
    await this.#enqueueLifecycle(active, 'pause', offRecord ? 'off_record' : 'user-paused');
  }

  async #resume(appOwned: boolean): Promise<void> {
    const active = this.#active;
    if (!active) { if (appOwned) this.#offRecord = false; return; }
    if (this.#offRecord && !appOwned) return;
    if (appOwned) this.#offRecord = false;
    active.serverReady = false;
    if (!this.capture.resume()) {
      const snapshot = this.capture.getSnapshot();
      this.#emitStatus('paused', snapshot.reason ?? 'resume-refused');
      return;
    }
    this.#renewRequests(active);
    const privacyGeneration = active.privacyGeneration;
    try {
      await this.#enqueueLifecycle(active, 'resume');
      if (this.#current(active, privacyGeneration) && !this.#offRecord && this.capture.getSnapshot().state === 'capturing') {
        active.serverReady = true; this.#emitStatus('capturing'); this.#schedulePoll(active, 0);
      }
    } catch (error) {
      if (appOwned) this.#offRecord = true;
      if (this.#current(active, privacyGeneration)) {
        this.#captureCommand = true; try { this.capture.pause('user-paused'); } finally { this.#captureCommand = false; }
        this.#emitStatus('error', transportReason(error));
      }
      throw error;
    }
  }

  async #stop(appOwned: boolean): Promise<void> {
    const active = this.#active;
    if (!active) { this.capture.stop(); return; }
    active.serverReady = false;
    this.#captureCommand = true; try { this.capture.stop(); } finally { this.#captureCommand = false; }
    this.#invalidateRequests(active); this.#emitStatus('stopped', 'stopped');
    try {
      await this.#enqueueLifecycle(active, 'stop');
      this.#review = active; this.#reviewController.abort(); this.#reviewController = new AbortController();
    } finally { if (this.#active === active) this.#closeActive(appOwned); }
  }

  async #upload(frame: ProcessedFrame, lease: FrameLease): Promise<void> {
    const active = this.#active;
    if (!active || !active.serverReady || !this.#current(active) || this.#offRecord || !lease.isCurrent() || frame.sessionId !== active.session.sessionId) return;
    const data = base64(new Uint8Array(await frame.image.arrayBuffer()));
    if (!active.serverReady || !this.#current(active) || this.#offRecord || !lease.isCurrent()) return;
    const response = await this.#request(active, 'frames', {generation: active.serverGeneration, frameId: frame.frameId,
      timestampMs: frame.timestampMs, processed: true, mediaType: 'image/png', data,
      provenance: {...frame.provenance, captureGeneration: frame.generation}});
    const body = await jsonRecord(response); exactKeys(body, ['ok', 'outcome', 'sessionId', 'generation', 'frameId']);
    if (body.sessionId !== active.session.sessionId || body.frameId !== frame.frameId || body.generation !== active.serverGeneration ||
        typeof body.ok !== 'boolean' || typeof body.outcome !== 'string') throw new TransportError('invalid_frame_response');
  }

  #schedulePoll(active: ActiveSession, delay = this.#options.pollIntervalMs ?? 1000,
    privacyGeneration = active.privacyGeneration): void {
    if (!active.serverReady || !this.#current(active, privacyGeneration) || this.#offRecord || this.capture.getSnapshot().state !== 'capturing') return;
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
        const projected = parseScreenObservation({...observation, sequence: ++this.#timelineSequence});
        if (this.#isCurrentVisual(projected)) this.#visuals.push(structuredClone(projected));
        this.#publish(this.#observations, projected);
        this.#settleObservationWaiters();
      }
      for (const status of statuses) {
        if (!this.#current(active, privacyGeneration) || this.#offRecord) return;
        if (status.sessionId !== active.session.sessionId) throw new TransportError('status_session');
        this.#publish(this.#statuses, status);
      }
    } catch (error) {
      if (this.#current(active, privacyGeneration) && !isAbort(error)) this.#emitStatus('error', transportReason(error));
    } finally { this.#schedulePoll(active, this.#options.pollIntervalMs ?? 1000, privacyGeneration); }
  }

  #enqueueLifecycle(active: ActiveSession, command: 'pause' | 'resume' | 'stop', reason?: string): Promise<void> {
    const operation = active.lifecycleTail.then(async () => {
      await active.startReady;
      const controller = new AbortController();
      const response = await this.#request(active, 'lifecycle', {generation: active.serverGeneration, command, ...(reason ? {reason} : {})}, false, controller.signal);
      const body = await jsonRecord(response);
      exactKeys(body, ['sessionId', 'generation', 'nextCursor', 'status']);
      if (body.sessionId !== active.session.sessionId) throw new TransportError('session_mismatch');
      active.serverGeneration = integer(body.generation, 'generation', active.serverGeneration + 1);
      active.cursor = integer(body.nextCursor, 'nextCursor', 0);
      active.serverState = parseScreenStatus(body.status).state;
    });
    active.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  async #resolveEvidence(evidenceId: string): Promise<EvidenceRef> {
    const active = this.#active ?? this.#review;
    if (!active) throw new Error('Screen bridge has no session evidence context.');
    if (typeof evidenceId !== 'string' || !evidenceId) throw new TypeError('Evidence id required.');
    const isActive = this.#active === active;
    const privacyGeneration = active.privacyGeneration;
    const reviewSignal = this.#reviewController.signal;
    const response = await this.#request(active, `evidence/${encodeURIComponent(evidenceId)}`, undefined, false, isActive ? undefined : reviewSignal);
    const body = await jsonRecord(response); exactKeys(body, ['ok', 'evidence']);
    if (body.ok !== true) throw new TransportError('evidence_failed');
    const evidence = record(body.evidence, 'evidence');
    exactKeys(evidence, ['schemaVersion', 'id', 'kind', 'assetRef', 'startMs', 'endMs', 'sessionId', 'frameId', 'mediaType', 'byteLength']);
    if (evidence.id !== evidenceId || typeof evidence.assetRef !== 'string' || !evidence.assetRef ||
        !Number.isSafeInteger(evidence.startMs) || !Number.isSafeInteger(evidence.endMs) ||
        (evidence.endMs as number) < (evidence.startMs as number)) throw new TransportError('invalid_evidence');
    const assetResponse = await this.#request(active, `evidence/${encodeURIComponent(evidenceId)}/asset`, undefined, false, isActive ? undefined : reviewSignal);
    const blob = await assetResponse.blob();
    if (this.#disposed || (isActive ? !this.#current(active, privacyGeneration) : this.#review !== active || reviewSignal.aborted)) throw new TransportError('evidence_invalidated');
    const assetRef = URL.createObjectURL(blob);
    this.#objectUrls.add(assetRef);
    return {assetRef, startMs: evidence.startMs as number, endMs: evidence.endMs as number};
  }

  async #replyToCheckpoint(value: CheckpointReply): Promise<void> {
    const reply = parseCheckpointReply(value);
    const pending = this.#pendingCheckpoint;
    if (!pending || reply.checkpointId !== pending.checkpoint.id ||
        reply.basedOn.order !== pending.checkpoint.revisions.order || reply.basedOn.email !== pending.checkpoint.revisions.email) {
      throw new Error('Checkpoint reply is stale or unknown.');
    }
    this.#pendingCheckpoint = null; pending.cleanup(); pending.resolve(reply);
  }

  #setWorkspaceScope(value: WorkspaceScope): void {
    const scope = parseWorkspaceScope(value);
    const changed = !this.#workspaceScope || this.#workspaceScope.sessionId !== scope.sessionId ||
      this.#workspaceScope.revisions.order !== scope.revisions.order || this.#workspaceScope.revisions.email !== scope.revisions.email;
    if (!changed) return;
    this.#workspaceScope = scope;
    this.#invalidatePendingCheckpoint(new DOMException('Workspace revisions changed.', 'AbortError'));
    for (const waiter of [...this.#waiters]) {
      if (sameWorkspaceScope(waiter.scope, scope)) continue;
      this.#waiters.delete(waiter); clearTimeout(waiter.timer!); waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new DOMException('Workspace revisions changed.', 'AbortError'));
    }
    this.#visuals = this.#visuals.filter(observation => observation.sessionId === scope.sessionId &&
      ((observation.kind === 'order_view' && observation.sourceRevision === scope.revisions.order) ||
       (observation.kind === 'email_draft' && observation.sourceRevision === scope.revisions.email) || observation.kind === 'ticket'));
    this.#settleObservationWaiters();
  }

  #publishActivity(activity: WorkspaceActivity): ScreenObservation {
    const active = this.#active;
    if (!active || !active.serverReady || this.#offRecord || this.capture.getSnapshot().state !== 'capturing') {
      throw new Error('Screen workspace output is paused.');
    }
    const facts = parseWorkspaceActivity(activity);
    const timestampMs = facts.lastInputAtMs + facts.idleMs;
    const observation = parseScreenObservation({schemaVersion: 1,
      id: `${active.session.sessionId}:workspace:${this.#timelineSequence + 1}`, sessionId: active.session.sessionId,
      sequence: ++this.#timelineSequence, timestampMs, source: 'workspace', frameId: null, sourceRevision: null,
      kind: 'input_activity', facts, entityRef: null, evidenceIds: []});
    this.#publish(this.#observations, observation);
    return observation;
  }

  #waitForCurrent(request: CurrentObservationRequest): Promise<readonly ScreenObservation[]> {
    const scope = parseWorkspaceScope(request);
    if (!(request.signal instanceof AbortSignal)) throw new TypeError('Observation wait requires an AbortSignal.');
    request.signal.throwIfAborted();
    const current = this.#matchingVisuals(scope);
    if (hasCurrentPair(current, scope.revisions)) return Promise.resolve(current);
    const timeoutMs = request.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Observation timeout must be positive.');
    return new Promise((resolve, reject) => {
      const waiter: ObservationWaiter = {scope, signal: request.signal, resolve, reject, timer: null, onAbort: () => undefined};
      waiter.onAbort = () => { this.#waiters.delete(waiter); clearTimeout(waiter.timer!); reject(request.signal.reason); };
      waiter.timer = setTimeout(() => { this.#waiters.delete(waiter); request.signal.removeEventListener('abort', waiter.onAbort);
        reject(new Error('Timed out waiting for current screen observations.')); }, timeoutMs);
      request.signal.addEventListener('abort', waiter.onAbort, {once: true}); this.#waiters.add(waiter);
    });
  }

  #visualSnapshot(sessionId: string): readonly ScreenObservation[] {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Session id required.');
    return structuredClone(this.#visuals.filter(observation => observation.sessionId === sessionId));
  }

  #matchingVisuals(scope: WorkspaceScope): ScreenObservation[] {
    return this.#visuals.filter(observation => observation.sessionId === scope.sessionId &&
      ((observation.kind === 'order_view' && observation.sourceRevision === scope.revisions.order) ||
       (observation.kind === 'email_draft' && observation.sourceRevision === scope.revisions.email)));
  }

  #isCurrentVisual(observation: ScreenObservation): boolean {
    const scope = this.#workspaceScope;
    if (!scope) return true;
    if (observation.sessionId !== scope.sessionId) return false;
    if (observation.kind === 'order_view') return observation.sourceRevision === scope.revisions.order;
    if (observation.kind === 'email_draft') return observation.sourceRevision === scope.revisions.email;
    return observation.kind === 'ticket';
  }

  #settleObservationWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      const current = this.#matchingVisuals(waiter.scope);
      if (!hasCurrentPair(current, waiter.scope.revisions)) continue;
      this.#waiters.delete(waiter); clearTimeout(waiter.timer!); waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(structuredClone(current));
    }
  }

  #dispatchCheckpoint(value: ActionCheckpoint, options: {readonly signal?: AbortSignal; readonly timeoutMs?: number} = {}): Promise<CheckpointReply> {
    const checkpoint = parseActionCheckpoint(value); const active = this.#active;
    if (!active || !active.serverReady || checkpoint.sessionId !== active.session.sessionId) throw new Error('Checkpoint session is inactive.');
    const scope = this.#workspaceScope;
    if (!scope || scope.sessionId !== checkpoint.sessionId || scope.revisions.order !== checkpoint.revisions.order ||
        scope.revisions.email !== checkpoint.revisions.email) throw new Error('Checkpoint revisions are stale.');
    const current = this.#matchingVisuals(scope);
    const order = current.filter(value => value.kind === 'order_view').at(-1);
    const email = current.filter(value => value.kind === 'email_draft').at(-1);
    if (!order || !email || checkpoint.observationIds.length !== 2 ||
        !checkpoint.observationIds.includes(order.id) || !checkpoint.observationIds.includes(email.id)) {
      throw new Error('Checkpoint observations are stale.');
    }
    if (this.#pendingCheckpoint) throw new Error('Another checkpoint is pending.');
    const timeoutMs = options.timeoutMs ?? 4_000; const signal = options.signal;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Checkpoint timeout must be positive.');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pendingCheckpoint = null; cleanup(); reject(new Error('Checkpoint reply timed out.')); }, timeoutMs);
      const onAbort = () => { this.#pendingCheckpoint = null; cleanup(); reject(signal?.reason); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.#pendingCheckpoint = {checkpoint, resolve, reject, cleanup}; signal?.addEventListener('abort', onAbort, {once: true});
      this.#publish(this.#checkpoints, checkpoint);
    });
  }

  #invalidatePendingCheckpoint(error: unknown): void {
    const pending = this.#pendingCheckpoint; if (!pending) return;
    this.#pendingCheckpoint = null; pending.cleanup(); pending.reject(error);
  }

  #invalidateWorkspace(error: unknown, clearVisuals: boolean): void {
    this.#invalidatePendingCheckpoint(error);
    for (const waiter of [...this.#waiters]) { this.#waiters.delete(waiter); clearTimeout(waiter.timer!);
      waiter.signal.removeEventListener('abort', waiter.onAbort); waiter.reject(error); }
    if (clearVisuals) this.#visuals = [];
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

  #current(active: ActiveSession, privacyGeneration = active.privacyGeneration): boolean { return !this.#disposed && this.#active === active && this.#generation === active.localGeneration && active.privacyGeneration === privacyGeneration && !active.controller.signal.aborted; }
  #invalidateRequests(active: ActiveSession): void { active.privacyGeneration++; active.controller.abort(); if (this.#pollTimer !== null) clearTimeout(this.#pollTimer); this.#pollTimer = null; }
  #renewRequests(active: ActiveSession): void { active.controller = new AbortController(); }
  #closeActive(clearOffRecord = true): void {
    if (this.#active) { this.#active.startController.abort(); this.#invalidateRequests(this.#active); }
    this.#active = null; if (clearOffRecord) this.#offRecord = false; ++this.#generation;
  }
  #emitStatus(state: ScreenStatus['state'], reason?: string): void {
    const active = this.#active; if (!active) return;
    this.#publish(this.#statuses, parseScreenStatus({schemaVersion: 1, sessionId: active.session.sessionId, state, ...(reason ? {reason} : {})}));
  }
  #publish<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) { try { listener(structuredClone(value)); } catch { /* subscriber isolation */ } }
  }
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

interface ObservationWaiter {
  readonly scope: WorkspaceScope;
  readonly signal: AbortSignal;
  readonly resolve: (observations: readonly ScreenObservation[]) => void;
  readonly reject: (error: unknown) => void;
  timer: Timer | null;
  onAbort: () => void;
}
interface PendingCheckpoint {
  readonly checkpoint: ActionCheckpoint;
  readonly resolve: (reply: CheckpointReply) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}
function parseWorkspaceScope(value: WorkspaceScope): WorkspaceScope {
  if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string' || !value.sessionId ||
      !value.revisions || typeof value.revisions.order !== 'string' || !value.revisions.order ||
      typeof value.revisions.email !== 'string' || !value.revisions.email) throw new TypeError('Invalid workspace scope.');
  return structuredClone({sessionId: value.sessionId, revisions: value.revisions});
}
function parseWorkspaceActivity(value: WorkspaceActivity): WorkspaceActivity {
  if (!value || typeof value !== 'object' || !['order', 'email', 'ticket'].includes(value.surface) ||
      typeof value.typing !== 'boolean' || !Number.isSafeInteger(value.lastInputAtMs) || value.lastInputAtMs < 0 ||
      !Number.isSafeInteger(value.idleMs) || value.idleMs < 0) throw new TypeError('Invalid workspace activity.');
  return structuredClone(value);
}
function hasCurrentPair(observations: readonly ScreenObservation[], revisions: WorkspaceRevisions): boolean {
  return observations.some(value => value.kind === 'order_view' && value.sourceRevision === revisions.order) &&
    observations.some(value => value.kind === 'email_draft' && value.sourceRevision === revisions.email);
}
function sameWorkspaceScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return a.sessionId === b.sessionId && a.revisions.order === b.revisions.order && a.revisions.email === b.revisions.email;
}
