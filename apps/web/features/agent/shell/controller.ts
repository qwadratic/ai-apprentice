// The shell controller: everything imperative about a session lives here, outside React, so that switching
// Learn / Review / Teach never loses it. React only reads the store and calls the methods below.
// All outside world (network, voice, timers, clock, brain, screen source) is injected, so the flows are unit-tested.
import type { ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import { parseCheckpointReply } from '@apprentice/contracts';
import type { AgentApi, AgentSession, FetchLike, VoiceRole } from './api.ts';
import { createLlmClient } from './brain/llm-transport.ts';
import type { AbortableLlmClient } from './brain/llm-transport.ts';
import type { AnswerInput, AnswerResult, Brain, BrainDecision, BrainSignals, ClipaTargetRef, DraftMap, TranscriptTurn } from './brain/types.ts';
import { isSpoken } from './brain/types.ts';
import type { ClipaPresenter, ClipaState, TargetRect } from './clipa/presenter.ts';
import { SessionLimits } from './limits.ts';
import type { LimitTimers } from './limits.ts';
import { EventUploader } from './log/uploader.ts';
import type { LogDir, Timers } from './log/uploader.ts';
import type { ObservationSource } from './screen/observation-source.ts';
import { teachCase } from './screen/sample-scenarios.ts';
import type { SampleScenarioId, TeachCaseId } from './screen/sample-scenarios.ts';
import { SESSION_LIMIT_MS, deadlineOf } from './session-clock.ts';
import { deriveClipaState } from './state/derive.ts';
import { createStore } from './state/store.ts';
import type { Store } from './state/store.ts';
import { MODES, PERSONAS } from './state/types.ts';
import type { Action } from './state/reducer.ts';
import type { CaptureInfo, DecisionEntry, FeedItem, Mode, Persona, ShellState } from './state/types.ts';
import { observationToContext, stripAudioTags, summarizeObservation } from './voice/context.ts';
import { scrub } from './voice/scrub.ts';
import { SpeechGate } from './voice/speech-gate.ts';
import type { VoiceConnector, VoiceEvents, VoiceMode } from './voice/types.ts';
import { VoiceSession } from './voice/voice-session.ts';

export const BRAIN_TICK_MS = 500;
/** The workspace waits for the checkpoint reply for 4 s (doc-7); after that the shell answers `unknown` itself. */
/** Below the workspace's own 4 s reply deadline, so that even `unknown` reaches it in time. */
export const CHECKPOINT_TIMEOUT_MS = 3500;
/** A WARN that has to wait for the agent to finish speaking is dropped after this long. */
export const WARN_HOLD_MS = 15000;
/** A spoken question that produces no agent audio within this time stops looking "thinking". */
export const ASK_AUDIO_TIMEOUT_MS = 12000;
/** What the person is told when a reply did not confirm or correct the teach-back. */
const REVIEW_NOTICES: Readonly<Record<string, string>> = {
  unclear: 'I could not tell whether that was a confirmation or a correction, so nothing changed. Say it again, or use the buttons.',
  stale: 'The teach-back changed since you read it, so nothing was confirmed. Read the new one and confirm that.',
  refused: 'The teach-back cannot be confirmed yet: an item of the Work Map lacks the expert\'s words or a screen moment. Answer the open questions first.',
  skipped: 'Skipped. The rule stays provisional: in Teach the tutor will say it does not know instead of applying it.',
  corrected: 'Corrected. The new version is provisional until you confirm the new teach-back.',
  needs_words: 'Say or type what is different, and Clipa will update the map.',
};
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
  /** The sample source for a scenario: `learn` for Learn, a Teach case for Teach, `neutral` otherwise. */
  createSampleSource(scenario: SampleScenarioId): ObservationSource;
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

/** Voice role per mode: Learn and Review talk to the interviewer agent, Teach to the tutor agent (its own voice, PR #38). */
const MODE_NAMES: Record<Mode, string> = { learn: 'Learn', review: 'Review', teach: 'Teach' };

export function voiceRoleFor(mode: Mode): VoiceRole {
  return mode === 'teach' ? 'tutor' : 'interviewer';
}

interface PendingAsk {
  decisionId: string;
  fromPerfMs: number;
  decision: BrainDecision;
  /** The decision is a question (the next thing the person says answers it), not a statement. */
  answerable: boolean;
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
  /** Every source of this page, newest last: evidence of an earlier session (the expert's moment) stays resolvable in Teach. */
  private evidenceSources: ObservationSource[] = [];
  /** A real source that waits for the person to share a screen while a sample source runs. */
  private standby: ObservationSource | null = null;
  private standbyOff: Array<() => void> = [];
  private readonly speech = new SpeechGate();
  /** The LLM client of the live session; cut off on off the record and on teardown. */
  private llm: AbortableLlmClient | null = null;
  private held: { decision: BrainDecision; atPerfMs: number } | null = null;
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
  /**
   * A structured record for the server's session log (the existing /events route, next to the transcript that /finish stores):
   * the expert's answers, the Work Map versions and the checkpoint results. It is not shown in the visible log, it respects off the
   * record (nothing is queued after the switch) and the token never reaches it.
   */
  private persist(type: string, payload: Record<string, unknown>): void {
    this.uploader?.enqueue('sys', type, JSON.stringify(payload));
  }
  private lastPersistedMap = '';
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
    // One voice agent per session: a live session whose agent is not the one of the new mode ends. Teach starts its own session
    // with the tutor at once; leaving Teach only ends the tutor session (starting Learn is the person's choice: it begins a new map).
    const s = this.state;
    if (s.phase !== 'live' || s.session === null || voiceRoleFor(s.session.mode) === voiceRoleFor(mode)) return;
    const from = MODE_NAMES[s.session.mode];
    void this.end(`${from} ended: ${MODE_NAMES[mode]} talks to the ${voiceRoleFor(mode)} agent.`).then(() => {
      if (mode === 'teach' && this.state.mode === 'teach' && this.state.phase !== 'live') return this.start('teach');
      return undefined;
    });
  }

  setPersona(persona: Persona): void {
    this.store.dispatch({ type: 'PERSONA_SET', persona });
    this.writeStorage(PERSONA_STORAGE_KEY, persona);
    this.sys(`Persona: ${persona}. The policy reads it when the next session starts.`);
  }

  setTargetResolver(resolver: TargetResolver | null): void {
    this.resolveTarget = resolver;
  }

  /** The person is typing in the workspace (or stopped): Clipa holds still. Called by the workspace adapter's host. */
  reportInput(typing: boolean): void {
    this.deps.presenter.noteInput?.(typing);
  }

  /** A line for the debug log from outside the controller (the Clipa director's refusals). */
  note(type: string, text: string): void {
    this.log('sys', type, text);
  }

  /** Which sample case the next Teach session plays. */
  setSampleCase(caseId: TeachCaseId): void {
    this.store.dispatch({ type: 'SAMPLE_CASE_SET', caseId });
  }

  /** Teach: ends the running session and starts a new one on this sample case (a reset starts a new session). */
  async runSampleCase(caseId: TeachCaseId): Promise<void> {
    this.setSampleCase(caseId);
    if (this.state.phase === 'live') await this.end('Session ended: a new sample case starts a new session.');
    await this.start('teach');
  }

  dismissBanner(): void {
    this.store.dispatch({ type: 'BANNER_SET', banner: null });
  }

  // ---- Screen capture (A's ScreenPanel) -----------------------------------

  registerCapture(capture: CaptureLike): () => void {
    this.captureOff?.();
    this.capture = capture;
    let last: string | null = null;
    const off = capture.subscribe((snapshot) => {
      const was = last;
      last = snapshot.state;
      this.store.dispatch({ type: 'CAPTURE_SNAPSHOT', capture: { state: snapshot.state, reason: snapshot.reason ?? null } });
      if (was !== snapshot.state && (snapshot.state === 'stopped' || snapshot.state === 'error')) this.onCaptureEnded(snapshot.reason ?? null);
    });
    this.captureOff = off;
    return () => {
      off();
      if (this.capture === capture) { this.capture = null; this.captureOff = null; }
    };
  }

  /**
   * A cancelled picker or a Stop ends the capture for good: the screen runtime does not share again inside the same session id. The
   * person is told plainly what to do; nothing restarts on its own (a new Learn session would start a new Work Map).
   */
  private onCaptureEnded(reason: string | null): void {
    const s = this.state;
    if (s.phase !== 'live' || s.offRecord || s.session === null || s.session.mode === 'review') return;
    const mode = s.session.mode === 'learn' ? 'Learn' : 'Teach';
    const text = `Screen sharing ended${reason ? ` (${reason})` : ''}. This session cannot share a screen again: press End, then start ${mode} again for a new session and share the window.`;
    this.sys(text);
    this.store.dispatch({ type: 'BANNER_SET', banner: { kind: 'warn', text } });
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
    this.speech.reset();
    this.held = null;
    this.lastPersistedMap = '';
    this.beginBrain(session, mode);
    this.limits.start(this.deps.isHidden());
    this.sys('The session auto-ends after 10 minutes, or after 2 minutes with this tab hidden.');
    this.tickTimer = this.deps.timers.setInterval(() => this.tickBrain(), BRAIN_TICK_MS);
    if (mode === 'review') this.loadReview();
    if (mode !== 'review' && this.state.screen.sampleOn) await this.startSample(run);
    if (!this.isCurrent(run)) return;
    await this.startVoice(run, session, mode);
  }

  private beginBrain(session: AgentSession, mode: Mode): void {
    const caseId = mode === 'teach' ? this.state.teach.sampleCase : null;
    this.llm?.abort();
    const llm = createLlmClient({ session, fetch: this.deps.fetch, log: (line) => this.log('sys', 'LLM', line) });
    this.llm = llm;
    this.safe('begin', () => this.brain.begin?.({
      sessionId: session.sessionId,
      mode,
      persona: this.state.persona,
      llm,
      caseId,
      caseTitle: caseId === null ? null : teachCase(caseId).title,
    }), undefined);
    if (llm === null) this.sys('No LLM route (placeholder API): the brain reads answers with its heuristics.');
  }

  /** Ends the session: voice first, then the screen, then the log. */
  async end(reason = 'Session ended.'): Promise<void> {
    if (this.state.phase !== 'live') return;
    await this.teardown(reason);
  }

  /** Off the record stops both channels. It does not delete or recall what was already sent. */
  async goOffRecord(): Promise<void> {
    if (this.state.offRecord) return;
    // Before anything else: pending and queued model calls are cut off, so no expert words are posted after the switch.
    this.llm?.abort();
    if (this.uploader?.isRecording()) {
      // This is the last line that is queued: nothing after the switch reaches the server.
      this.sys('Off the record: capture and upload stopped.');
      this.uploader.stopRecording();
    }
    this.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
    // A live source coordinates the workspace and the capture itself (also before capture has started).
    try {
      await this.source?.setOffRecord?.(true);
      await this.standby?.setOffRecord?.(true);
    } catch (e) { this.err(`The workspace could not go off the record cleanly: ${errMsg(e)}`); }
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
    // No model call is sent or left waiting once the session is over.
    this.llm?.abort();
    const voice = this.voice;
    this.voice = null;
    // The microphone closes first: nothing below may keep it open.
    if (voice) await voice.end();
    await this.stopSource();
    this.dropStandby();
    this.capture?.stop();
    this.deps.presenter.say('');
    this.deps.presenter.setTarget(null);
    this.clearPendingAsk();
    this.expireOpenQuestions();
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

  /** A question that is still waiting for an answer when its session ends will never get one: it stops looking open. */
  private expireOpenQuestions(): void {
    for (const f of this.state.feed) {
      if (f.status === 'asked') this.store.dispatch({ type: 'FEED_STATUS', id: f.id, status: 'unspoken', note: 'the session ended before it was answered' });
    }
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
    this.dropStandby();
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
        // v4 turbo may carry audio tags ("[warmly]"): they are not words, so they never reach the brain or the feed.
        const turn: TranscriptTurn = { role: m.source === 'ai' ? 'agent' : 'user', text: stripAudioTags(m.text), atMs: this.deps.now() - this.epochMs };
        this.log('recv', turn.role === 'agent' ? 'AGENT' : 'USER', m.text);
        this.safe('onTranscript', () => this.brain.onTranscript(turn), undefined);
        if (turn.role === 'agent') this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
        else this.captureAnswer(turn);
      },
      onError: (message) => { if (live()) this.err(message); },
      onVadScore: (score) => { if (live()) this.speech.onScore(score, this.deps.perfNow()); },
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
      const lost = this.pendingAsk;
      this.pendingAsk = null;
      this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
      this.err(`The agent did not start speaking within ${ASK_AUDIO_TIMEOUT_MS / 1000} s after the question.`);
      this.deps.presenter.say('');
      // The question never reached the person: it goes back to the brain's queue and the feed no longer waits for an answer.
      this.store.dispatch({ type: 'FEED_STATUS', id: lost.decisionId, status: 'unspoken', note: 'not spoken: the agent did not start speaking' });
      this.safe('onNotSpoken', () => this.brain.onNotSpoken?.(lost.decision), undefined);
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
    // Only a question of this session takes the answer: an item left over from an earlier session never does.
    const sessionId = this.state.session?.id;
    const open = [...this.state.feed].reverse().find((f) => f.status === 'asked' && f.sessionId === sessionId);
    if (!open) return;
    this.store.dispatch({ type: 'FEED_ANSWER', id: open.id, text: turn.text, atMs: turn.atMs });
    this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
    this.deps.presenter.say('');
    this.deps.presenter.ack?.();
    this.clearPendingAsk();
    const input: AnswerInput = { questionId: open.id, topic: open.topic, text: turn.text, atMs: turn.atMs, kind: 'answer' };
    this.persist('ANSWER', { kind: 'answer', mode: this.state.session?.mode ?? null, topic: open.topic, questionId: open.id, atMs: turn.atMs, text: turn.text, evidenceIds: open.evidenceIds });
    const run = this.runId;
    this.afterAnswer(this.safe('onAnswer', () => this.brain.onAnswer(input), undefined), null, turn.text, run);
    this.mapDirty = true;
  }

  /**
   * What the brain says about an answer: it may be asynchronous (a model reads it), and it may change the Work Map, the review
   * and the teach-back. `fallback` is what a brain that reports nothing (a test double) means for a button press.
   */
  private afterAnswer(
    outcome: AnswerResult | void | Promise<AnswerResult | void> | undefined,
    fallback: Action | null,
    text: string,
    run: number | null,
  ): void {
    const apply = (result: AnswerResult | void): void => {
      if (run !== null && !this.isCurrent(run)) return;
      if (!result) {
        if (fallback) this.store.dispatch(fallback);
        this.refreshAfterAnswer();
        return;
      }
      if (result.teachBack === 'confirmed') this.store.dispatch({ type: 'TEACHBACK_CONFIRM' });
      else if (result.teachBack === 'corrected') this.store.dispatch({ type: 'TEACHBACK_CORRECT', text: text.trim() });
      if (result.changed || result.teachBack !== undefined) this.refreshAfterAnswer();
      // The notice comes after the reload: a new teach-back clears the old one.
      const notice = REVIEW_NOTICES[result.teachBack ?? ''];
      if (notice !== undefined) this.store.dispatch({ type: 'REVIEW_NOTICE', notice });
    };
    if (outcome instanceof Promise) {
      outcome.then(apply, (e: unknown) => this.err(`${this.brain.name} answer failed: ${errMsg(e)}`));
    } else {
      apply(outcome);
    }
  }

  private refreshAfterAnswer(): void {
    this.loadReview();
    this.refreshMastery();
  }

  private refreshMastery(): void {
    const mastery = this.safe('mastery', () => this.brain.mastery?.() ?? null, null);
    if (mastery) this.store.dispatch({ type: 'MASTERY_SET', mastery });
  }

  // ---- Observations -------------------------------------------------------

  private async startSample(run: number): Promise<void> {
    if (this.source || !this.session) return;
    const info = this.state.session;
    const scenario: SampleScenarioId = info?.mode === 'teach' ? this.state.teach.sampleCase : info?.mode === 'learn' ? 'learn' : 'neutral';
    await this.attach(this.deps.createSampleSource(scenario), run, true);
  }

  /**
   * The real screen (stream A's bridge, alone or inside the integrated runtime) attaches here once its mount exists. It is never
   * started by the shell: the real bridge's start opens the screen picker, which only the person's own click in the panel may do.
   * While a sample source is running it waits in standby, and takes over the moment the bridge reports `capturing`: the sample is a
   * labelled fallback for when no screen is shared, never mixed with a real screen. The controller listens to the real source's
   * observations, status and checkpoints, and answers every checkpoint.
   */
  async attachLiveSource(source: ObservationSource): Promise<void> {
    if (this.state.phase !== 'live' || !this.session) {
      source.dispose();
      return;
    }
    this.dropStandby();
    // The sample runs (or is about to: the session's own start continues after this) until a screen is shared.
    const sampleWanted = this.source === null && this.state.screen.sampleOn && this.state.session?.mode !== 'review';
    if (this.source?.synthetic || sampleWanted) {
      this.standby = source;
      this.evidenceSources = [...this.evidenceSources.filter((x) => x !== source), source].slice(-6);
      this.standbyOff = [source.onStatus((st) => {
        if (this.standby === source && st.state === 'capturing') void this.promoteStandby(source, st);
      })];
      this.sys('The real screen is ready: choose a window in the Screen panel. Until then the sample observations run (synthetic).');
      return;
    }
    if (this.source) await this.stopSource();
    await this.attach(source, this.runId, false);
  }

  private async promoteStandby(source: ObservationSource, status: ScreenStatus): Promise<void> {
    const run = this.runId;
    this.standby = null;
    for (const off of this.standbyOff) off();
    this.standbyOff = [];
    await this.stopSource();
    if (!this.isCurrent(run) || !this.session) return;
    this.sys('A screen is shared: the sample observations stopped. From now on the brain reads your screen.');
    this.restartForRealScreen();
    await this.attach(source, run, false);
    this.onScreenStatus(status);
  }

  /**
   * The real screen replaced the sample: nothing the sample produced may stay in a Work Map, a feed or a tutor's record. The brain
   * begins again for this session (Learn: a new map; Teach: the same confirmed map, no case progress from invented data) and the
   * voice agent is told that the earlier lines were invented.
   */
  private restartForRealScreen(): void {
    const session = this.session;
    const info = this.state.session;
    if (!session || !info) return;
    this.askedCount = 0;
    this.held = null;
    this.clearPendingAsk();
    this.lastPersistedMap = '';
    this.store.dispatch({ type: 'SOURCE_TAKEOVER', mode: info.mode });
    this.beginBrain(session, info.mode);
    this.sendContext('[screen] The earlier screen lines were invented sample data (synthetic) and no longer apply. From now on the lines describe the person\'s real screen.', this.voice);
  }

  private dropStandby(): void {
    for (const off of this.standbyOff) off();
    this.standbyOff = [];
    const standby = this.standby;
    this.standby = null;
    if (standby) {
      void standby.stop().catch(() => {});
      standby.dispose();
    }
  }

  /** `Bearer <token>` of the live session for the real bridge's own requests, or null (placeholder API, no session). The token is never stored or logged. */
  authHeader(): string | null {
    const header = this.session?.events().headers['Authorization'];
    return header ?? null;
  }

  private async attach(source: ObservationSource, run: number, autoStart: boolean): Promise<void> {
    if (!this.session) return;
    this.source = source;
    this.safe('setSource', () => this.brain.setSource?.(source.synthetic), undefined);
    this.evidenceSources = [...this.evidenceSources.filter((s) => s !== source), source].slice(-6);
    this.sourceOff = [
      source.onObservation((o) => { if (this.source === source) this.onObservation(o); }),
      source.onStatus((s) => { if (this.source === source) this.onScreenStatus(s); }),
      source.onCheckpoint((c) => { if (this.source === source) void this.onCheckpoint(c); }),
    ];
    this.store.dispatch({ type: 'SCREEN_SOURCE', source: { label: source.label, synthetic: source.synthetic } });
    this.sys(`Observation source: ${source.label}.${source.synthetic ? ' Invented data, not your screen.' : ''}`);
    if (!autoStart) return;
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
    if (this.source && !this.source.synthetic) return; // the real screen is attached: the sample never replaces it
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
    if (o.kind === 'input_activity') this.deps.presenter.noteInput?.(o.facts.typing);
    this.safe('onObservation', () => this.brain.onObservation(o), undefined);
    this.mapDirty = true;
    const context = observationToContext(o, this.source?.synthetic ?? false);
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
      humanSpeaking: this.speech.isSpeaking(this.deps.perfNow()),
      asked: this.askedCount,
    };
  }

  private tickBrain(): void {
    if (this.state.phase !== 'live') return;
    const nowMs = this.deps.now() - this.epochMs;
    const held = this.held;
    if (held && this.state.voice.phase !== 'speaking') {
      this.held = null;
      if (this.deps.perfNow() - held.atPerfMs <= WARN_HOLD_MS) this.applyDecision(held.decision, nowMs);
    }
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
      ...(this.state.session ? { sessionId: this.state.session.id } : {}),
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
    else if (s.voice.phase === 'speaking') {
      if (d.decision === 'WARN') {
        // A warning is never dropped: it waits until the agent has finished the sentence it is saying.
        this.held = { decision: d, atPerfMs: this.deps.perfNow() };
        this.record({ ...entry, note: 'waits for the agent to finish speaking' });
        return;
      }
      note = 'the agent was already speaking';
      status = 'deferred';
    }
    if (note !== null) {
      this.record({ ...entry, note: `not spoken: ${note}` });
      this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, status, `not spoken: ${note}`) });
      this.safe('onNotSpoken', () => this.brain.onNotSpoken?.(d), undefined);
      return;
    }
    const sent = voice?.ask(text) ?? null;
    if (sent === null) {
      this.record({ ...entry, note: 'not spoken: the voice is not connected' });
      this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, 'unspoken', 'not spoken: the voice is not connected') });
      this.safe('onNotSpoken', () => this.brain.onNotSpoken?.(d), undefined);
      return;
    }
    this.askedCount += 1;
    this.log('sent', 'USER_MSG', sent);
    this.safe('onSpoken', () => this.brain.onSpoken?.(d), undefined);
    this.record({ ...entry, spoken: true });
    // A question waits for the answer; a warning, a piece of feedback or a closing line is only said.
    const expectsAnswer = d.expectsAnswer ?? d.decision !== 'WARN';
    this.store.dispatch({ type: 'FEED_ADD', item: this.feedItem(entry, expectsAnswer ? 'asked' : 'said', null) });
    this.store.dispatch({ type: 'VOICE_THINKING', thinking: true });
    this.pendingAsk = { decisionId: id, fromPerfMs: this.lastObservationPerfMs ?? this.deps.perfNow(), decision: d, answerable: expectsAnswer };
    this.armAskTimer();
    this.deps.presenter.say(text);
    const cue = d.clipa?.state;
    const hint = cue === 'warning' || cue === 'pointing' ? cue : d.decision === 'WARN' ? 'warning' : null;
    this.store.dispatch({ type: 'CLIPA_HINT', hint });
    const target = d.clipa?.target;
    this.deps.presenter.setTarget(target && this.resolveTarget ? this.resolveTarget(target) : null);
    this.deps.presenter.play?.(d);
  }

  // ---- Review and the map -------------------------------------------------

  private refreshMap(): void {
    const review = this.safe('review', () => this.brain.review(), null);
    if (review) this.store.dispatch({ type: 'MAP_SET', map: review.map });
  }

  /** Asks the brain for the draft map, the gaps and the teach-back. */
  loadReview(): void {
    // On the Review view the teach-back text is on screen: that counts as stating it, like speaking it (the confirmation gate).
    const shown = this.state.mode === 'review';
    const review = this.safe('review', () => this.brain.review(shown), null);
    if (!review) return;
    this.store.dispatch({ type: 'MAP_SET', map: review.map });
    this.store.dispatch({
      type: 'REVIEW_SET', gaps: review.gaps, teachBack: review.teachBack, digest: review.teachBackDigest ?? null, buttons: review.buttons ?? false,
    });
    this.persistMap(review.map);
  }

  /** A new Work Map version, or a confirmation, is written to the session log once. */
  private persistMap(map: DraftMap): void {
    if (map.version === undefined || (map.steps.length === 0 && (map.guardrails ?? []).length === 0)) return;
    const key = `${map.version}:${map.confirmed === true ? 'confirmed' : 'draft'}:${map.steps.length}:${(map.guardrails ?? []).length}`;
    if (key === this.lastPersistedMap) return;
    this.lastPersistedMap = key;
    const guardrails = (map.guardrails ?? []).map((g) => ({ id: g.id, text: g.text, evidenceIds: g.evidenceIds }));
    const steps = map.steps.map((st) => ({ id: st.id, title: st.title, kind: st.kind, decision: st.decision, reason: st.reason, evidenceIds: st.evidenceIds }));
    const full = { version: map.version, confirmed: map.confirmed === true, guardrails, steps };
    const text = JSON.stringify(full);
    // The server keeps up to 4000 characters of a line: a map that is larger is stored without the step details.
    this.persist('MAP_VERSION', text.length <= 3800 ? full : { version: map.version, confirmed: map.confirmed === true, guardrails, stepCount: steps.length });
  }

  /** Confirm: counts for exactly the teach-back on screen (its digest). The brain refuses it as `stale` if the map moved on. */
  confirmTeachBack(): void {
    const tb = this.state.review.teachBack;
    if (tb.text === null) return;
    this.sys('Teach-back confirmed by button.');
    const atMs = this.deps.now() - this.epochMs;
    this.persist('ANSWER', { kind: 'confirm', mode: this.state.session?.mode ?? null, topic: 'teach_back', atMs, digest: tb.digest });
    const input: AnswerInput = { questionId: null, topic: 'teach_back', text: tb.text, atMs, kind: 'confirm', digest: tb.digest };
    this.afterAnswer(this.safe('onAnswer', () => this.brain.onAnswer(input), undefined), { type: 'TEACHBACK_CONFIRM' }, tb.text, null);
  }

  correctTeachBack(text: string): void {
    const tb = this.state.review.teachBack;
    const clean = text.trim();
    if (tb.text === null || clean === '') return;
    this.sys('Teach-back corrected by button.');
    const atMs = this.deps.now() - this.epochMs;
    this.persist('ANSWER', { kind: 'correct', mode: this.state.session?.mode ?? null, topic: 'teach_back', atMs, text: clean, digest: tb.digest });
    const input: AnswerInput = { questionId: null, topic: 'teach_back', text: clean, atMs, kind: 'correct', digest: tb.digest };
    this.afterAnswer(this.safe('onAnswer', () => this.brain.onAnswer(input), undefined), { type: 'TEACHBACK_CORRECT', text: clean }, clean, null);
  }

  /** Skip: the rule stays provisional and Teach will not apply it. Offered after two unclear replies. */
  skipTeachBack(): void {
    const tb = this.state.review.teachBack;
    if (tb.text === null) return;
    this.sys('Teach-back skipped by button.');
    const atMs = this.deps.now() - this.epochMs;
    this.persist('ANSWER', { kind: 'skip', mode: this.state.session?.mode ?? null, topic: 'teach_back', atMs, digest: tb.digest });
    const input: AnswerInput = { questionId: null, topic: 'teach_back', text: '', atMs, kind: 'skip', digest: tb.digest };
    this.afterAnswer(this.safe('onAnswer', () => this.brain.onAnswer(input), undefined), null, '', null);
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

  /** The brain's reply, or `unknown` when it fails or does not answer within CHECKPOINT_TIMEOUT_MS: the workspace never waits forever. */
  private judge(cp: ActionCheckpoint): Promise<CheckpointReply> {
    const unknown = (message: string): CheckpointReply => ({
      schemaVersion: 1, checkpointId: cp.id, status: 'unknown', message, evidenceIds: [],
      basedOn: { order: cp.revisions.order, email: cp.revisions.email },
    });
    return new Promise<CheckpointReply>((resolve) => {
      let settled = false;
      const finish = (reply: CheckpointReply): void => {
        if (settled) return;
        settled = true;
        this.deps.timers.clearTimeout(timer);
        resolve(reply);
      };
      const timer = this.deps.timers.setTimeout(() => {
        this.err(`${this.brain.name} did not answer the checkpoint within ${CHECKPOINT_TIMEOUT_MS / 1000} s: replying unknown.`);
        finish(unknown('Not judged: the tutor did not answer in time. Ask the expert before you send.'));
      }, CHECKPOINT_TIMEOUT_MS);
      Promise.resolve()
        .then(() => this.brain.checkpoint(cp))
        .then((reply) => finish(parseCheckpointReply(reply)))
        .catch((e: unknown) => {
          this.err(`${this.brain.name} checkpoint failed: ${errMsg(e)}`);
          finish(unknown('Not judged: the tutor failed. Ask the expert before you send.'));
        });
    });
  }

  private async onCheckpoint(cp: ActionCheckpoint): Promise<void> {
    const run = this.runId;
    this.sys(`Checkpoint ${cp.id} raised by the workspace.`);
    const reply = await this.judge(cp);
    if (!this.isCurrent(run)) return;
    this.store.dispatch({
      type: 'CHECKPOINT_RESULT',
      card: { checkpointId: reply.checkpointId, status: reply.status, message: reply.message, evidenceIds: reply.evidenceIds, atMs: cp.timestampMs, deliveryError: null },
    });
    this.refreshMastery();
    this.persist('CHECKPOINT_RESULT', { checkpointId: reply.checkpointId, status: reply.status, evidenceIds: reply.evidenceIds, atMs: cp.timestampMs });
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
    // Newest source first: the current session, then the earlier ones (the expert's Learn moments stay resolvable in Teach).
    const sources = [...this.evidenceSources].reverse();
    if (sources.length === 0) return Promise.reject(new Error('No observation source has run in this page.'));
    return sources.reduce<Promise<EvidenceRef>>(
      (previous, source) => previous.catch(() => source.resolveEvidence(evidenceId)),
      Promise.reject(new Error('Evidence is not published in the current session')),
    );
  }
}
