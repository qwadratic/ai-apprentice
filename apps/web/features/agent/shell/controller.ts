// The shell controller: everything imperative about a session lives here, outside React, so that switching
// Learn / Review / Teach never loses it. React only reads the store and calls the methods below.
// All outside world (network, voice, timers, clock, brain, screen source) is injected, so the flows are unit-tested.
import type { ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import { parseCheckpointReply } from '@apprentice/contracts';
import type { AgentApi, AgentSession, FetchLike, VoiceRole } from './api.ts';
import type { AnswerInput, Brain, BrainDecision, BrainSignals, ClipaTargetRef, TranscriptTurn } from './brain/types.ts';
import { isSpoken } from './brain/types.ts';
import type { ClipaPresenter, ClipaState, TargetRect } from './clipa/presenter.ts';
import { SessionLimits } from './limits.ts';
import type { LimitTimers } from './limits.ts';
import { EventUploader } from './log/uploader.ts';
import type { LogDir, Timers } from './log/uploader.ts';
import type { ObservationSource } from './screen/observation-source.ts';
import { SESSION_LIMIT_MS, deadlineOf } from './session-clock.ts';
import { deriveClipaState } from './state/derive.ts';
import { createStore } from './state/store.ts';
import type { Store } from './state/store.ts';
import { MODES, PERSONAS } from './state/types.ts';
import type { CaptureInfo, DecisionEntry, FeedItem, Mode, Persona, ShellState } from './state/types.ts';
import { observationToContext, summarizeObservation } from './voice/context.ts';
import { scrub } from './voice/scrub.ts';
import type { VoiceConnector, VoiceEvents, VoiceMode } from './voice/types.ts';
import { VoiceSession } from './voice/voice-session.ts';

export const BRAIN_TICK_MS = 500;
/** A spoken question that produces no agent audio within this time stops looking "thinking". */
export const ASK_AUDIO_TIMEOUT_MS = 12000;
export const PERSONA_STORAGE_KEY = 'apprentice.shell.persona';
const MAX_BUFFERED_CONTEXT = 20;

export type ControllerTimers = Timers & LimitTimers;

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** The part of A's ScreenCapture the controller needs (capture.stop on end and off the record). */
export interface CaptureLike {
  subscribe(listener: (snapshot: { state: CaptureInfo['state']; reason?: string }) => void): () => void;
  stop(): void;
}

export type TargetResolver = (target: ClipaTargetRef) => TargetRect | null;

export interface ControllerDeps {
  api: AgentApi;
  fetch: FetchLike;
  connectVoice: VoiceConnector;
  createBrain(log: (line: string) => void): Brain;
  createSampleSource(): ObservationSource;
  presenter: ClipaPresenter;
  /** Date.now() */
  now(): number;
  /** performance.now() */
  perfNow(): number;
  timers: ControllerTimers;
  isHidden(): boolean;
  storage: KeyValueStorage;
  store?: Store;
}

export function parsePersona(value: string | null): Persona {
  return PERSONAS.find((p) => p === value) ?? 'plain';
}

export function parseMode(value: string | null): Mode {
  return MODES.find((m) => m === value) ?? 'learn';
}

function errMsg(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

/** Voice role per mode. Teach moves to 'tutor' when the VM has a tutor agent (the API serves the interviewer only). */
export function voiceRoleFor(_mode: Mode): VoiceRole {
  return 'interviewer';
}

interface PendingAsk {
  decisionId: string;
  fromPerfMs: number;
}

export class ShellController {
  readonly store: Store;
  private readonly deps: ControllerDeps;
  private brain: Brain;
  private session: AgentSession | null = null;
  private epochMs = 0;
  private uploader: EventUploader | null = null;
  private voice: VoiceSession | null = null;
  private source: ObservationSource | null = null;
  private evidenceSource: ObservationSource | null = null;
  private sourceOff: Array<() => void> = [];
  private readonly limits: SessionLimits;
  private tickTimer: unknown = null;
  private capture: CaptureLike | null = null;
  private captureOff: (() => void) | null = null;
  /** Bumped at every start and teardown: callbacks of an older run are ignored. */
  private runId = 0;
  private tearing: Promise<void> | null = null;
  private pendingAsk: PendingAsk | null = null;
  private askTimer: unknown = null;
  private lastObservationPerfMs: number | null = null;
  private askedCount = 0;
  private decisionCount = 0;
  private mapDirty = false;
  private bufferedContext: string[] = [];
  private contextDropNoted = false;
  private resolveTarget: TargetResolver | null = null;
  private lastClipa: ClipaState | null = null;
  private readonly storeOff: () => void;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.store = deps.store ?? createStore(parsePersona(this.readStorage(PERSONA_STORAGE_KEY)));
    this.brain = deps.createBrain((line) => this.log('sys', 'BRAIN', line));
    this.store.dispatch({ type: 'BRAIN_SET', name: this.brain.name, wired: this.brain.wired });
    this.limits = new SessionLimits({
      timers: deps.timers,
      onExpire: (reason) => { void this.end(reason); },
    });
    this.storeOff = this.store.subscribe(() => this.syncClipa());
    this.syncClipa();
  }

  // ---- Small helpers ------------------------------------------------------

  private get state(): ShellState { return this.store.getState(); }

  private readStorage(key: string): string | null {
    try { return this.deps.storage.get(key); } catch { return null; }
  }

  private writeStorage(key: string, value: string): void {
    try { this.deps.storage.set(key, value); } catch { /* storage may be blocked: the choice just is not remembered */ }
  }

  /** One log line: visible in the debug drawer and queued for the server log (scrubbed, and only while recording). */
  private log(dir: LogDir, type: string, text: unknown): void {
    const clean = scrub(text);
    this.store.dispatch({ type: 'LOG', t: this.deps.now(), dir, logType: type, text: clean });
    this.uploader?.enqueue(dir, type, clean);
  }
  private sys(text: string): void { this.log('sys', 'SYS', text); }
  private err(text: string): void { this.log('err', 'ERR', text); }

  private syncClipa(): void {
    const next = deriveClipaState(this.state);
    if (next !== this.lastClipa) {
      this.lastClipa = next;
      this.deps.presenter.setState(next);
    }
  }

  private safe<T>(label: string, fn: () => T, fallback: T): T {
    try { return fn(); } catch (e) {
      this.err(`${this.brain.name} ${label} failed: ${errMsg(e)}`);
      return fallback;
    }
  }

  private isCurrent(run: number): boolean { return run === this.runId; }

  // ---- Settings -----------------------------------------------------------

  setMode(mode: Mode): void {
    this.store.dispatch({ type: 'MODE_SET', mode });
    if (mode === 'review') this.loadReview();
  }

  setPersona(persona: Persona): void {
    this.store.dispatch({ type: 'PERSONA_SET', persona });
    this.writeStorage(PERSONA_STORAGE_KEY, persona);
    this.sys(`Persona: ${persona} (stored; the brain and the voice do not use it yet).`);
  }

  setTargetResolver(resolver: TargetResolver | null): void {
    this.resolveTarget = resolver;
  }

  dismissBanner(): void {
    this.store.dispatch({ type: 'BANNER_SET', banner: null });
  }

  // ---- Screen capture (A's ScreenPanel) -----------------------------------

  registerCapture(capture: CaptureLike): () => void {
    this.captureOff?.();
    this.capture = capture;
    const off = capture.subscribe((snapshot) => {
      this.store.dispatch({ type: 'CAPTURE_SNAPSHOT', capture: { state: snapshot.state, reason: snapshot.reason ?? null } });
    });
    this.captureOff = off;
    return () => {
      off();
      if (this.capture === capture) { this.capture = null; this.captureOff = null; }
    };
  }

  /** What ScreenPanel needs at its start click: the live session and its one epoch. */
  captureSession(): { sessionId: string; sessionEpochMs: number } {
    const info = this.state.session;
    if (!info || this.state.phase !== 'live') throw new Error('Start a mode before sharing the screen.');
    return { sessionId: info.id, sessionEpochMs: info.epochMs };
  }

  // ---- Session ------------------------------------------------------------

  /** Start of a mode: one click makes the session (id and token from the API), the epoch and the voice. */
  async start(mode: Mode): Promise<void> {
    const before = this.state;
    if (before.offRecord) return;
    if (before.phase === 'starting' || before.phase === 'live' || before.phase === 'ending') return;
    const epochMs = this.deps.now(); // the start click: the only origin of the session timeline
    const run = ++this.runId;
    this.askedCount = 0;
    this.decisionCount = 0;
    this.clearPendingAsk();
    this.bufferedContext = [];
    this.contextDropNoted = false;
    this.lastObservationPerfMs = null;
    this.store.dispatch({ type: 'SESSION_STARTING', mode });
    let session: AgentSession;
    try {
      session = await this.deps.api.createSession();
    } catch (e) {
      if (this.isCurrent(run)) this.store.dispatch({ type: 'SESSION_FAILED', message: errMsg(e) });
      return;
    }
    if (!this.isCurrent(run)) return; // off the record or a new start while the session was being made
    this.session = session;
    this.epochMs = epochMs;
    this.uploader = new EventUploader({
      session, fetch: this.deps.fetch, timers: this.deps.timers, now: () => this.deps.now(),
      onProblem: (text) => this.store.dispatch({ type: 'LOG', t: this.deps.now(), dir: 'err', logType: 'ERR', text }),
    });
    this.store.dispatch({
      type: 'SESSION_READY',
      session: {
        id: session.sessionId, mode, epochMs, legacyRoutes: session.legacy, deadlineMs: deadlineOf(epochMs, SESSION_LIMIT_MS),
        clockSkewMs: session.clockSkewMs, conversationId: null,
      },
    });
    this.sys(`Session ${session.sessionId} started in ${mode} mode. Events, transcript and audio recording are stored on our server.`);
    if (session.legacy) this.sys('The server still runs the placeholder API: legacy routes, no session token.');
    this.limits.start(this.deps.isHidden());
    this.sys('The session auto-ends after 10 minutes, or after 2 minutes with this tab hidden.');
    this.tickTimer = this.deps.timers.setInterval(() => this.tickBrain(), BRAIN_TICK_MS);
    if (mode === 'review') this.loadReview();
    if (mode !== 'review' && this.state.screen.sampleOn) await this.startSample(run);
    if (!this.isCurrent(run)) return;
    await this.startVoice(run, session, mode);
  }

  /** Ends the session: voice first, then the screen, then the log. */
  async end(reason = 'Session ended.'): Promise<void> {
    if (this.state.phase !== 'live') return;
    await this.teardown(reason);
  }

  /** Off the record stops both channels. It does not delete or recall what was already sent. */
  async goOffRecord(): Promise<void> {
    if (this.state.offRecord) return;
    if (this.uploader?.isRecording()) {
      // This is the last line that is queued: nothing after the switch reaches the server.
      this.sys('Off the record: capture and upload stopped.');
      this.uploader.stopRecording();
    }
    this.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
    this.deps.presenter.say('');
    this.deps.presenter.setTarget(null);
    await this.teardown('Off the record: session ended, microphone closed. What was already sent is not deleted or recalled.');
  }

  backOnRecord(): void {
    if (!this.state.offRecord) return;
    this.store.dispatch({ type: 'OFF_RECORD_SET', on: false });
    this.sys('Back on record. Start a mode to capture again.');
  }

  private teardown(reason: string): Promise<void> {
    if (this.tearing) return this.tearing;
    const job = this.doTeardown(reason).finally(() => { this.tearing = null; });
    this.tearing = job;
    return job;
  }

  private async doTeardown(reason: string): Promise<void> {
    this.runId += 1; // late callbacks of this run are ignored from here on
    const active = this.state.phase === 'starting' || this.state.phase === 'live' || this.state.phase === 'ending';
    if (this.state.phase === 'live') this.store.dispatch({ type: 'SESSION_ENDING' });
    this.limits.stop();
    this.stopTick();
    const voice = this.voice;
    this.voice = null;
    // The microphone closes first: nothing below may keep it open.
    if (voice) await voice.end();
    await this.stopSource();
    this.capture?.stop();
    this.deps.presenter.say('');
    this.deps.presenter.setTarget(null);
    this.clearPendingAsk();
    this.bufferedContext = [];
    this.sys(reason);
    const uploader = this.uploader;
    this.uploader = null;
    if (uploader) {
      const result = await uploader.finish();
      if (result.kind === 'stored') this.sys(`Session log saved on the server: ${this.session?.sessionId ?? ''}, transcript stored: ${result.transcriptStored ? 'yes' : 'no'}.`);
      else if (result.kind === 'no-conversation') this.sys(`Session log on the server: ${this.session?.sessionId ?? ''} (no conversation to store).`);
      else this.err(`Session log could not be finished on the server (${result.message}). Lines not sent: ${result.unsent}.`);
    }
    this.session = null;
    if (active) this.store.dispatch({ type: 'SESSION_ENDED', reason });
  }

  private stopTick(): void {
    if (this.tickTimer !== null) this.deps.timers.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // ---- Visibility and page lifecycle --------------------------------------

  onVisibilityChange(hidden: boolean): void {
    this.limits.setHidden(hidden);
  }

  /** The tab is closing or reloading: close the voice at once and send what is queued (best effort). */
  onPageHide(): void {
    const voice = this.voice;
    this.voice = null;
    if (voice) void voice.end();
    this.uploader?.sendOnPageHide();
  }

  dispose(): void {
    this.storeOff();
    this.limits.stop();
    this.stopTick();
    void this.stopSource();
    const voice = this.voice;
    this.voice = null;
    if (voice) void voice.end();
    this.captureOff?.();
  }

  // ---- Voice --------------------------------------------------------------

  private async startVoice(run: number, session: AgentSession, mode: Mode): Promise<void> {
    this.store.dispatch({ type: 'VOICE_PHASE', phase: 'connecting', error: null });
    const voice = new VoiceSession(this.deps.connectVoice);
    this.voice = voice;
    try {
      const role = voiceRoleFor(mode);
      this.sys(`Asking the server for a voice connection (${role}).`);
      const signedUrl = await this.deps.api.fetchSignedUrl(session, role);
      if (!this.isCurrent(run)) { this.voice = null; return; }
      this.sys('Signed URL received (not logged).');
      await voice.start(signedUrl, this.voiceEvents(run, voice));
      if (!this.isCurrent(run)) { await voice.end(); return; }
      const id = voice.conversationId();
      if (id) this.bindConversation(id);
      // The SDK fires its connected events inside startSession, before the handle exists: flush only now.
      if (voice.isConnected()) this.flushBufferedContext(voice);
    } catch (e) {
      if (!this.isCurrent(run)) return;
      this.voice = null;
      const message = errMsg(e);
      this.err(message);
      this.store.dispatch({ type: 'VOICE_PHASE', phase: 'offline', error: message });
      this.store.dispatch({
        type: 'BANNER_SET',
        banner: { kind: 'warn', text: `Voice is not available. ${message} The session keeps running without voice. End it and start again to retry.` },
      });
    }
  }

  private bindConversation(id: string): void {
    this.uploader?.setConversationId(id);
    if (this.state.session?.conversationId !== id) this.store.dispatch({ type: 'CONVERSATION_BOUND', conversationId: id });
  }

  private voiceEvents(run: number, voice: VoiceSession): VoiceEvents {
    const live = (): boolean => this.isCurrent(run) && this.voice === voice;
    return {
      onConnect: (id) => {
        if (!live()) return;
        if (id) this.bindConversation(id);
        this.log('recv', 'CONNECT', `conversation ${id}`.trim());
        this.store.dispatch({ type: 'VOICE_PHASE', phase: 'listening', error: null });
        this.sys('Voice is live. The microphone is on.');
        if (voice.isConnected()) this.flushBufferedContext(voice);
      },
      onDisconnect: (reason) => {
        if (!live()) return;
        this.log('recv', 'DISCONNECT', reason);
        this.store.dispatch({ type: 'BANNER_SET', banner: { kind: 'warn', text: `Voice disconnected${reason ? ` (${reason})` : ''}. The session was ended.` } });
        void this.end('Voice disconnected: session ended.');
      },
      onStatus: (status) => {
        if (!live()) return;
        this.log('recv', 'STATUS', status);
        if (status === 'connected' && this.state.voice.phase === 'connecting') {
          this.store.dispatch({ type: 'VOICE_PHASE', phase: 'listening', error: null });
          if (voice.isConnected()) this.flushBufferedContext(voice);
        }
      },
      onMode: (mode) => { if (live()) this.onVoiceMode(mode); },
      onMessage: (m) => {
        if (!live()) return;
        const turn: TranscriptTurn = { role: m.source === 'ai' ? 'agent' : 'user', text: m.text, atMs: this.deps.now() - this.epochMs };
        this.log('recv', turn.role === 'agent' ? 'AGENT' : 'USER', m.text);
        this.safe('onTranscript', () => this.brain.onTranscript(turn), undefined);
        if (turn.role === 'agent') this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
        else this.captureAnswer(turn);
      },
      onError: (message) => { if (live()) this.err(message); },
    };
  }

  private clearPendingAsk(): void {
    this.pendingAsk = null;
    if (this.askTimer !== null) this.deps.timers.clearTimeout(this.askTimer);
    this.askTimer = null;
  }

  private armAskTimer(): void {
    if (this.askTimer !== null) this.deps.timers.clearTimeout(this.askTimer);
    const run = this.runId;
    this.askTimer = this.deps.timers.setTimeout(() => {
      this.askTimer = null;
      if (!this.isCurrent(run) || !this.pendingAsk) return;
      this.pendingAsk = null;
      this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
      this.err(`The agent did not start speaking within ${ASK_AUDIO_TIMEOUT_MS / 1000} s after the question.`);
    }, ASK_AUDIO_TIMEOUT_MS);
  }

  private onVoiceMode(mode: VoiceMode): void {
    this.log('recv', 'MODE', mode);
    this.store.dispatch({ type: 'VOICE_PHASE', phase: mode === 'speaking' ? 'speaking' : 'listening' });
    if (mode === 'speaking' && this.pendingAsk) {
      const ms = Math.max(0, Math.round(this.deps.perfNow() - this.pendingAsk.fromPerfMs));
      this.store.dispatch({ type: 'DECISION_LATENCY', id: this.pendingAsk.decisionId, latencyMs: ms });
      this.clearPendingAsk();
    }
  }

  private sendContext(text: string, voice: VoiceSession | null): void {
    if (voice && voice.sendContext(text)) {
      this.log('sent', 'CONTEXT', text);
      return;
    }
    if (voice && voice.isOpening()) {
      // Not writable yet (still connecting, or connected but the SDK has not returned the conversation): keep it.
      this.bufferedContext.push(text);
      if (this.bufferedContext.length > MAX_BUFFERED_CONTEXT) this.bufferedContext.shift();
      return;
    }
    if (!this.contextDropNoted) {
      this.contextDropNoted = true;
      this.sys('Screen context is not sent to the agent: the voice is not connected.');
    }
  }

  private flushBufferedContext(voice: VoiceSession): void {
    const buffered = this.bufferedContext;
    this.bufferedContext = [];
    this.contextDropNoted = false;
    for (const text of buffered) this.sendContext(text, voice);
  }

  /** The first thing the person says after a spoken question counts as its answer. */
  private captureAnswer(turn: TranscriptTurn): void {
    const open = [...this.state.feed].reverse().find((f) => f.status === 'asked');
    if (!open) return;
    this.store.dispatch({ type: 'FEED_ANSWER', id: open.id, text: turn.text, atMs: turn.atMs });
    this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
    this.deps.presenter.say('');
    this.clearPendingAsk();
    const input: AnswerInput = { questionId: open.id, topic: open.topic, text: turn.text, atMs: turn.atMs, kind: 'answer' };
    this.safe('onAnswer', () => this.brain.onAnswer(input), undefined);
    this.mapDirty = true;
  }

  // ---- Observations -------------------------------------------------------

  private async startSample(run: number): Promise<void> {
    if (this.source || !this.session) return;
    const source = this.deps.createSampleSource();
    this.source = source;
    this.evidenceSource = source;
    this.sourceOff = [
      source.onObservation((o) => { if (this.source === source) this.onObservation(o); }),
      source.onStatus((s) => { if (this.source === source) this.onScreenStatus(s); }),
      source.onCheckpoint((c) => { if (this.source === source) void this.onCheckpoint(c); }),
    ];
    this.store.dispatch({ type: 'SCREEN_SOURCE', source: { label: source.label, synthetic: source.synthetic } });
    this.sys(`Observation source: ${source.label}. Invented data, not your screen.`);
    try {
      await source.start({ sessionId: this.session.sessionId, sessionEpochMs: this.epochMs });
    } catch (e) {
      if (this.isCurrent(run)) this.err(`Observation source failed to start: ${errMsg(e)}`);
      await this.stopSource();
    }
  }

  private async stopSource(): Promise<void> {
    const source = this.source;
    this.source = null;
    for (const off of this.sourceOff) off();
    this.sourceOff = [];
    if (!source) return;
    try { await source.stop(); } catch { /* already stopped */ }
    source.dispose();
    this.store.dispatch({ type: 'SCREEN_SOURCE', source: null });
    this.store.dispatch({ type: 'SCREEN_STATUS', state: 'none', reason: null });
  }

  /** The "Use sample observations" toggle. It can be flipped before a session or while one is live. */
  async setSampleObservations(on: boolean): Promise<void> {
    this.store.dispatch({ type: 'SAMPLE_SET', on });
    const info = this.state.session;
    if (this.state.phase !== 'live' || !info || info.mode === 'review') return;
    if (on) await this.startSample(this.runId);
    else await this.stopSource();
  }

  private onObservation(o: ScreenObservation): void {
    this.lastObservationPerfMs = this.deps.perfNow();
    this.store.dispatch({
      type: 'OBSERVATION',
      row: {
        id: o.id, sequence: o.sequence, timestampMs: o.timestampMs, kind: o.kind, source: o.source,
        synthetic: this.source?.synthetic ?? false, summary: summarizeObservation(o), evidenceIds: o.evidenceIds,
      },
    });
    this.log('sys', 'OBS', `${o.kind} #${o.sequence} ${o.id} t=${o.timestampMs} ms${o.evidenceIds.length ? ` evidence ${o.evidenceIds.join(',')}` : ''}`);
    this.safe('onObservation', () => this.brain.onObservation(o), undefined);
    this.mapDirty = true;
    const context = observationToContext(o);
    if (context !== null) this.sendContext(context, this.voice);
  }

  private onScreenStatus(s: ScreenStatus): void {
    this.store.dispatch({ type: 'SCREEN_STATUS', state: s.state, reason: s.reason ?? null });
    this.log('sys', 'SCREEN', `${s.state}${s.reason ? ` (${s.reason})` : ''}`);
    this.safe('onStatus', () => this.brain.onStatus(s), undefined);
    if (s.state === 'error') {
      this.store.dispatch({ type: 'BANNER_SET', banner: { kind: 'error', text: `Screen observation stopped${s.reason ? `: ${s.reason}` : ''}.` } });
    }
  }

  // ---- Brain loop ---------------------------------------------------------

  private signals(): BrainSignals {
    const s = this.state;
    return {
      sessionId: s.session?.id ?? '',
      mode: s.session?.mode ?? s.mode,
      persona: s.persona,
      offRecord: s.offRecord,
      voiceConnected: this.voice?.isConnected() ?? false,
      agentSpeaking: s.voice.phase === 'speaking',
      asked: this.askedCount,
    };
  }

  private tickBrain(): void {
    if (this.state.phase !== 'live') return;
    const nowMs = this.deps.now() - this.epochMs;
    const decisions = this.safe('tick', () => this.brain.tick(nowMs, this.signals()), [] as BrainDecision[]);
    for (const d of decisions) this.applyDecision(d, nowMs);
    if (this.mapDirty) {
      this.mapDirty = false;
      this.refreshMap();
    }
  }

  private record(entry: DecisionEntry): void {
    this.store.dispatch({ type: 'DECISION', entry });
    this.log('sys', 'DECISION', `${entry.decision} ${entry.topic}: ${entry.whyNow}${entry.note ? ` [${entry.note}]` : ''}`);
  }

  private feedItem(entry: DecisionEntry, status: FeedItem['status'], note: string | null): FeedItem {
    return {
      id: entry.id, decision: entry.decision, topic: entry.topic, text: entry.text ?? '', status, note,
      whyNow: entry.whyNow, evidenceIds: entry.evidenceIds, atMs: entry.atMs, answer: null,
    };
  }

  private applyDecision(d: BrainDecision, nowMs: number): void {
    const id = `d-${++this.decisionCount}`;
    const text = d.utterance?.text.trim() || null;
    const entry: DecisionEntry = {
      id, atMs: nowMs, decision: d.decision, topic: d.topic, kind: d.kind, whyNow: d.whyNow, text,
      evidenceIds: d.evidenceIds, spoken: false, latencyMs: null, note: null,
    };
    if (d.decision === 'SKIP') { this.record(entry); return; }
    if (d.decision === 'DEFER') {
      this.record(entry);
      if (text) this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, 'deferred', 'saved for Review') });
      return;
    }
    if (!isSpoken(d.decision) || text === null) {
      this.record({ ...entry, note: 'no utterance to speak' });
      return;
    }
    const s = this.state;
    const voice = this.voice;
    let note: string | null = null;
    let status: FeedItem['status'] = 'unspoken';
    if (s.offRecord) note = 'off the record';
    else if (!voice || !voice.isConnected()) note = 'the voice is not connected';
    else if (s.voice.phase === 'speaking') { note = 'the agent was already speaking'; status = 'deferred'; }
    if (note !== null) {
      this.record({ ...entry, note: `not spoken: ${note}` });
      this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, status, `not spoken: ${note}`) });
      return;
    }
    const sent = voice?.ask(text) ?? null;
    if (sent === null) {
      this.record({ ...entry, note: 'not spoken: the voice is not connected' });
      this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, 'unspoken', 'not spoken: the voice is not connected') });
      return;
    }
    this.askedCount += 1;
    this.log('sent', 'USER_MSG', sent);
    this.record({ ...entry, spoken: true });
    this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, 'asked', null) });
    this.store.dispatch({ type: 'VOICE_THINKING', thinking: true });
    this.pendingAsk = { decisionId: id, fromPerfMs: this.lastObservationPerfMs ?? this.deps.perfNow() };
    this.armAskTimer();
    this.deps.presenter.say(text);
    const cue = d.clipa?.state;
    const hint = cue === 'warning' || cue === 'pointing' ? cue : d.decision === 'WARN' ? 'warning' : null;
    this.store.dispatch({ type: 'CLIPA_HINT', hint });
    const target = d.clipa?.target;
    this.deps.presenter.setTarget(target && this.resolveTarget ? this.resolveTarget(target) : null);
  }

  // ---- Review and the map -------------------------------------------------

  private refreshMap(): void {
    const review = this.safe('review', () => this.brain.review(), null);
    if (review) this.store.dispatch({ type: 'MAP_SET', map: review.map });
  }

  /** Asks the brain for the draft map, the gaps and the teach-back. */
  loadReview(): void {
    const review = this.safe('review', () => this.brain.review(), null);
    if (!review) return;
    this.store.dispatch({ type: 'MAP_SET', map: review.map });
    this.store.dispatch({ type: 'REVIEW_SET', gaps: review.gaps, teachBack: review.teachBack });
  }

  confirmTeachBack(): void {
    const tb = this.state.review.teachBack;
    if (tb.text === null) return;
    this.store.dispatch({ type: 'TEACHBACK_CONFIRM' });
    this.sys('Teach-back confirmed.');
    this.safe('onAnswer', () => this.brain.onAnswer({ questionId: null, topic: 'teach_back', text: tb.text ?? '', atMs: this.deps.now() - this.epochMs, kind: 'confirm' }), undefined);
  }

  correctTeachBack(text: string): void {
    const clean = text.trim();
    if (this.state.review.teachBack.text === null || clean === '') return;
    this.store.dispatch({ type: 'TEACHBACK_CORRECT', text: clean });
    this.sys('Teach-back corrected.');
    this.safe('onAnswer', () => this.brain.onAnswer({ questionId: null, topic: 'teach_back', text: clean, atMs: this.deps.now() - this.epochMs, kind: 'correct' }), undefined);
  }

  // ---- Teach: checkpoint and evidence -------------------------------------

  raiseSampleCheckpoint(): void {
    const source = this.source;
    if (!source || !source.raiseSampleCheckpoint) return;
    try {
      source.raiseSampleCheckpoint();
    } catch (e) {
      this.err(`Sample checkpoint failed: ${errMsg(e)}`);
      this.store.dispatch({ type: 'BANNER_SET', banner: { kind: 'warn', text: `Sample checkpoint failed: ${errMsg(e)}` } });
    }
  }

  private async onCheckpoint(cp: ActionCheckpoint): Promise<void> {
    const run = this.runId;
    this.sys(`Checkpoint ${cp.id} raised by the workspace.`);
    let reply: CheckpointReply;
    try {
      reply = parseCheckpointReply(await this.brain.checkpoint(cp));
    } catch (e) {
      this.err(`${this.brain.name} checkpoint failed: ${errMsg(e)}`);
      reply = {
        schemaVersion: 1, checkpointId: cp.id, status: 'unknown',
        message: 'Not judged: the tutor failed. Ask the expert before you send.', evidenceIds: [],
        basedOn: { order: cp.revisions.order, email: cp.revisions.email },
      };
    }
    if (!this.isCurrent(run)) return;
    this.store.dispatch({
      type: 'CHECKPOINT_RESULT',
      card: { checkpointId: reply.checkpointId, status: reply.status, message: reply.message, evidenceIds: reply.evidenceIds, atMs: cp.timestampMs, deliveryError: null },
    });
    this.log('sent', 'CHECKPOINT', `${reply.status}: ${reply.message}`);
    const source = this.source;
    if (!source) return;
    try {
      await source.replyToCheckpoint(reply);
    } catch (e) {
      this.store.dispatch({ type: 'CHECKPOINT_DELIVERY_FAILED', checkpointId: reply.checkpointId, error: errMsg(e) });
    }
  }

  openEvidence(evidenceId: string): void {
    this.store.dispatch({ type: 'REPLAY_OPEN', evidenceId });
  }

  closeEvidence(): void {
    this.store.dispatch({ type: 'REPLAY_CLOSE' });
  }

  resolveEvidence(evidenceId: string): Promise<EvidenceRef> {
    const source = this.source ?? this.evidenceSource;
    return source ? source.resolveEvidence(evidenceId) : Promise.reject(new Error('No observation source has run in this page.'));
  }
}
