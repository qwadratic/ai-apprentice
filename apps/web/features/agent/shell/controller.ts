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
import { ConductorClient } from './conductor/client.ts';
import type { ConductorStatus } from './conductor/client.ts';
import { ConductorFace } from './conductor/face.ts';
import type { FaceHost } from './conductor/face.ts';
import { linkSession } from './conductor/join.ts';
import type { Activity, ClientEvent, ClipaPose, ConductorPersona, ShareState, Target, UiAction } from './conductor/protocol.ts';
import { createConductorStore } from './conductor/store.ts';
import type { ConductorLine, ConductorStore } from './conductor/store.ts';

type ConductorLineKind = ConductorLine['kind'];
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
/** The viewer's "Lead me through" choice ('off' when turned off; anything else is on). */
export const AUTO_LEAD_STORAGE_KEY = 'apprentice.shell.autoLead';
const MAX_BUFFERED_CONTEXT = 20;
/** No key press for this long after typing: the page reports `activity idle` to the conductor (its pause signal). */
export const TYPING_IDLE_MS = 2500;
/** Events made before the conductor stream is live wait for the hello; at most this many. */
const MAX_EARLY_EVENTS = 20;
/** Screen observations kept for the Review board's keyframes. */
const MAX_KEPT_OBSERVATIONS = 200;
/** The observation kinds of the contracts union, which the in-browser brain reads. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['order_view', 'email_draft', 'ticket', 'input_activity']);

/** The Clipa Conductor (doc-12): when present, the page is a face of the server's conductor and the brain is the fallback. */
export interface ConductorOptions {
  /** API origin of the conductor routes ('' means this site). */
  base: string;
  /** The web app's version, sent in the hello. */
  version: string;
  /**
   * One motion of the floating Clipa for a cue (runtime.ts drives the director): `text` is her line ('' clears the bubble, null
   * keeps it), said beside `target` (null: no target, undefined: she stays where she is).
   */
  present?(text: string | null, target: Target | null | undefined, kind?: ConductorLineKind): void;
  /** The conductor's journey step for the rail (its `guide` cue), or null to clear it. */
  guide?(step: { phase: string; step: string; text: string } | null): void;
  /** The floating Clipa flashes briefly (the conductor's `attention` cue); where she goes comes as a `present` motion. */
  attention?(target: Target | null): void;
}

/** The conductor's pose as the shell's Clipa state, for the poses that the voice signals do not already show. */
const POSE_STATE: Partial<Record<ClipaPose, ClipaState>> = { point: 'pointing', warn: 'warning', celebrate: 'happy', think: 'thinking', hidden: 'off' };

/** Expert in Show and Reflect, new hire in Pass it on. */
export function personaFor(mode: Mode): ConductorPersona {
  return mode === 'teach' ? 'new_hire' : 'expert';
}

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
  /** Epoch ms of the last key press or text input in the page (the demo workspace included), or null. */
  lastInputAt?: () => number | null;
  /** The Clipa Conductor; without it the in-browser brain leads (tests, the placeholder API). */
  conductor?: ConductorOptions;
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

/** The local capture state as the conductor's `share` state; null for states it has no word for (idle, paused, stopped). */
function shareOf(state: CaptureInfo['state']): ShareState | null {
  switch (state) {
    case 'selecting': return 'requested';
    case 'capturing': return 'capturing';
    case 'error': return 'unavailable';
    default: return null;
  }
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
  /** The microphone toggle; it holds across sessions and modes until the person turns it back on. */
  private micMuted = false;
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
  // ---- Clipa Conductor (doc-12) ----
  /** What the conductor's cues put on the page (line, pose, regions, map, teach-back). */
  readonly conductorStore: ConductorStore = createConductorStore();
  private conductor: ConductorClient | null = null;
  private face: ConductorFace | null = null;
  /** The page's one session for the whole journey (Show, Reflect, Pass it on): the conductor is per session id. */
  private journey: { session: AgentSession; epochMs: number } | null = null;
  private booting: Promise<void> | null = null;
  private helloSent = false;
  private earlyEvents: ClientEvent[] = [];
  private personaSent: ConductorPersona | null = null;
  private shareSent: ShareState | null = null;
  private activitySent: Activity | null = null;
  private activityTimer: unknown = null;
  private personTalking = false;
  private agentTalking = false;
  /** "Lead me through" (auto mode): on unless this viewer turned it off. */
  private autoLead = true;
  private readonly conductorOff: () => void;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.store = deps.store ?? createStore(parsePersona(this.readStorage(PERSONA_STORAGE_KEY)));
    this.autoLead = this.readStorage(AUTO_LEAD_STORAGE_KEY) !== 'off';
    this.brain = deps.createBrain((line) => this.log('sys', 'BRAIN', line));
    this.store.dispatch({ type: 'BRAIN_SET', name: this.brain.name, wired: this.brain.wired });
    this.limits = new SessionLimits({
      timers: deps.timers,
      onExpire: (reason) => { void this.end(reason); },
    });
    this.storeOff = this.store.subscribe(() => this.syncClipa());
    this.conductorOff = this.conductorStore.subscribe(() => this.syncClipa());
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
    // The conductor's expressive poses (point, warn, celebrate, think, hidden) win; speaking and listening follow the voice itself.
    const pose = this.conductorLeads() ? this.conductorStore.getState().pose : null;
    const posed = pose === null ? undefined : POSE_STATE[pose];
    const next = this.state.offRecord ? 'off' : posed ?? deriveClipaState(this.state);
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

  /**
   * A tab click only changes what is shown. It never ends or starts a session: the running session (and its voice agent) stays until
   * the person ends it or presses "End ... and start ..." (switchSession).
   */
  setMode(mode: Mode): void {
    if (this.state.mode === mode) return;
    this.store.dispatch({ type: 'MODE_SET', mode });
    if (mode === 'review') this.loadReview();
    this.conductorMode(mode);
  }

  /** The person's explicit switch: the running session ends, then a session of `mode` starts (with that mode's voice agent). */
  async switchSession(mode: Mode): Promise<void> {
    const s = this.state;
    if (s.phase === 'live' && s.session !== null) {
      await this.end(`${MODE_NAMES[s.session.mode]} ended: the person started ${MODE_NAMES[mode]}.`);
    }
    if (this.state.phase === 'live' || this.state.phase === 'starting' || this.state.phase === 'ending') return;
    if (this.state.mode !== mode) this.store.dispatch({ type: 'MODE_SET', mode });
    await this.start(mode);
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
    if (typing) this.noteTyping();
  }

  // ---- Clipa Conductor (doc-12) -------------------------------------------

  /** The conductor leads while its client runs and the server did not refuse it; otherwise the in-browser brain does. */
  conductorLeads(): boolean {
    return this.conductor !== null && this.conductorStore.getState().status !== 'failed';
  }

  /** Session time of the journey (ms since its epoch): the atMs of every conductor event. */
  private journeyTime(): number {
    return this.journey === null ? 0 : Math.max(0, this.deps.now() - this.journey.epochMs);
  }

  /**
   * Makes this page a face of the conductor: one session for the whole journey, its cue stream and its events. With a join code
   * (the macOS hand-over) the session is first linked to the macOS session's conductor. `page` opens a stage (review: Reflect).
   */
  async bootConductor(options: { join?: string | null; page?: Mode | null } = {}): Promise<void> {
    if (!this.deps.conductor || this.conductor !== null || this.booting !== null) return;
    // A Start pressed while the journey session is being made waits for it (start() awaits this), so both use one session.
    const job = this.doBootConductor(options).finally(() => { this.booting = null; });
    this.booting = job;
    await job;
  }

  private async doBootConductor(options: { join?: string | null; page?: Mode | null }): Promise<void> {
    const opts = this.deps.conductor;
    if (!opts) return;
    if (options.page) this.setMode(options.page);
    let session: AgentSession;
    try {
      session = await this.deps.api.createSession();
    } catch (e) {
      this.err(`Clipa conductor: no session (${errMsg(e)}). The in-browser brain leads.`);
      return;
    }
    if (session.legacy) { this.sys('Clipa conductor: the server runs the placeholder API. The in-browser brain leads.'); return; }
    this.journey = { session, epochMs: this.deps.now() };
    const authorization = (): string | null => session.events().headers['Authorization'] ?? null;
    let linked = false;
    if (options.join) {
      const result = await linkSession({ base: opts.base, sessionId: session.sessionId, authorization: authorization(), code: options.join, fetch: this.deps.fetch });
      linked = result.ok;
      if (result.ok) this.sys('Clipa conductor: joined the session handed over from the Mac.');
      else this.store.dispatch({ type: 'BANNER_SET', banner: { kind: 'warn', text: 'The hand-over link has expired or was already used. This page starts its own session.' } });
    }
    const face = new ConductorFace(this.faceHost(), this.conductorStore);
    this.face = face;
    this.conductorStore.set({ enabled: true, linked, status: 'connecting' });
    const client = new ConductorClient({
      base: opts.base,
      sessionId: session.sessionId,
      authorization,
      fetch: this.deps.fetch,
      timers: this.deps.timers,
      clock: () => this.journeyTime(),
      onCue: (env) => face.onCue(env),
      onHello: (hello, first, reset) => {
        // A page that joined a hand-over restores the map from what was sent before, but does not replay old lines.
        if (first && linked) face.historyUntil = hello.lastCueSeq;
        if (reset) {
          // The server restarted: its new conductor knows nothing of this page (nor of a hand-over link), so it is told again.
          face.historyUntil = -1;
          this.helloSent = false;
        }
        if (!this.helloSent) this.sendHello();
      },
      onStatus: (status, detail) => this.onConductorStatus(status, detail),
      log: (line) => this.log('sys', 'CONDUCTOR', line),
    });
    this.conductor = client;
    client.open();
    this.sys(`Clipa conductor: session ${session.sessionId}; Clipa follows the server from now on.`);
  }

  private onConductorStatus(status: ConductorStatus, detail: string | null): void {
    this.conductorStore.set({ status, statusDetail: detail });
    this.log('sys', 'CONDUCTOR', `${status}${detail ? ` (${detail})` : ''}`);
    if (status === 'failed') this.sys('Clipa conductor is not available: the in-browser brain leads for this page.');
    this.syncClipa();
  }

  private sendHello(): void {
    const opts = this.deps.conductor;
    if (!opts || this.conductor === null) return;
    const persona = personaFor(this.state.session?.mode ?? this.state.mode);
    const first = !this.helloSent;
    this.helloSent = true;
    this.personaSent = persona;
    this.conductor.send({ type: 'hello', client: 'web', version: opts.version, persona, language: null, mapFrom: null });
    this.conductor.send({ type: 'mode', mode: this.state.mode });
    // Auto mode is on unless the page says otherwise (also to a conductor that restarted).
    if (!this.autoLead) this.conductor.send({ type: 'auto', on: false });
    if (!first) return;
    // What happened before the stream was live: the current session (not its history) and the latest of the other signals.
    const s = this.state;
    if (s.offRecord) this.conductor.send({ type: 'off_record', on: true });
    if (s.phase === 'live' && s.session !== null) this.conductor.send({ type: 'session', mode: s.session.mode, live: true, reason: null });
    const early = this.earlyEvents;
    this.earlyEvents = [];
    const signals = new Set<ClientEvent['type']>(['mode', 'session', 'off_record', 'activity', 'talking', 'share']);
    for (const e of early) if (!signals.has(e.type)) this.conductor.send(e);
    // The latest of the page's signals (a conductor that restarted, or a stream that opened late, has none of them).
    if (s.offRecord) return;
    if (this.shareSent !== null) this.conductor.send({ type: 'share', state: this.shareSent, reason: null });
    if (this.activitySent !== null) this.conductor.send({ type: 'activity', state: this.activitySent });
    if (this.personTalking) this.conductor.send({ type: 'talking', by: 'person', active: true });
    if (this.agentTalking) this.conductor.send({ type: 'talking', by: 'agent', active: true });
  }

  /** One event for the conductor; held until the stream is live (the hello goes first). Nothing is sent off the record except off_record itself. */
  private conductorSend(event: ClientEvent): void {
    const client = this.conductor;
    if (client === null) return;
    if (this.state.offRecord && event.type !== 'off_record' && event.type !== 'mode' && event.type !== 'session' && event.type !== 'auto') return;
    if (!this.helloSent) {
      this.earlyEvents.push(event);
      if (this.earlyEvents.length > MAX_EARLY_EVENTS) this.earlyEvents.shift();
      return;
    }
    client.send(event);
  }

  private conductorMode(mode: Mode): void {
    if (this.conductor === null) return;
    // The persona follows the stage: a new hello tells the conductor who is in front of the screen now.
    const persona = personaFor(this.state.session?.mode ?? mode);
    if (this.helloSent && persona !== this.personaSent) this.sendHello();
    else this.conductorSend({ type: 'mode', mode });
  }

  /** A key press in the page: `activity typing` at once, `idle` after TYPING_IDLE_MS without input. */
  noteTyping(): void {
    if (this.conductor === null) return;
    this.setActivity('typing');
    if (this.activityTimer !== null) this.deps.timers.clearTimeout(this.activityTimer);
    this.activityTimer = this.deps.timers.setTimeout(() => {
      this.activityTimer = null;
      this.setActivity('idle');
    }, TYPING_IDLE_MS);
  }

  private setActivity(state: Activity): void {
    if (this.activitySent === state) return;
    this.activitySent = state;
    this.conductorSend({ type: 'activity', state });
  }

  private setShare(state: ShareState | null, reason: string | null): void {
    // A stopped or paused capture has no `share` word: the next capture is reported again.
    if (state === null) { this.shareSent = null; return; }
    if (this.shareSent === state) return;
    this.shareSent = state;
    this.conductorSend({ type: 'share', state, reason });
  }

  private setTalking(by: 'person' | 'agent', active: boolean): void {
    if (by === 'person') {
      if (this.personTalking === active) return;
      this.personTalking = active;
    } else {
      if (this.agentTalking === active) return;
      this.agentTalking = active;
    }
    this.conductorSend({ type: 'talking', by, active });
  }

  /**
   * A click on the Review board or the teach-back: confirm, correct (with the person's words), answer_gap or ask_about (with the
   * item's id), finish. The conductor answers with cues (a spoken question, a new map version).
   */
  uiAction(action: UiAction, targetId: string | null = null, text: string | null = null): void {
    if (this.conductor === null) return;
    this.conductorSend({ type: 'ui', action, targetId, text });
    this.log('sent', 'UI', `${action}${targetId ? ` ${targetId}` : ''}`);
  }

  private faceHost(): FaceHost {
    return {
      speak: (text, maxChars) => this.speakLine(text, maxChars),
      context: (text) => this.sendContext(text, this.voice),
      personBusy: () => this.activitySent === 'typing' || this.speech.isSpeaking(this.deps.perfNow()),
      present: (text, target, kind) => {
        // The presenter's store keeps the text for the line under the rail; the floating Clipa says it beside the target.
        if (text !== null) this.deps.presenter.say(text);
        this.deps.conductor?.present?.(text, target, kind);
      },
      guide: (step) => this.deps.conductor?.guide?.(step),
      pose: () => this.syncClipa(),
      log: (type, text) => this.log('sys', type, text),
      sessionNow: () => (this.conductorStore.getState().linked || this.journey === null ? null : this.journeyTime()),
      now: () => this.deps.now(),
      send: (event) => this.conductorSend(event),
      timers: this.deps.timers,
      attention: (target) => this.deps.conductor?.attention?.(target),
      // A stage by voice: what a click on its tab of the journey rail does, or with `start` what Start does.
      stage: (mode, start) => { if (start) this.startStage(mode); else this.setMode(mode); },
      // The person said stop, or Pass it on is done: what End does.
      end: (reason) => { void this.end(reason === 'off' ? 'Clipa switched off: the person asked her to stop.' : 'Session ended: the person said they were done.'); },
    };
  }

  /** The conductor starts a stage (by voice, or moving on by herself): as Start or "End ... and start ..." does. */
  private startStage(mode: Mode): void {
    const s = this.state;
    if (s.offRecord) return;
    // A late cue (replayed after a reconnect, or after the person pressed End) never starts a session by itself.
    if (s.phase !== 'live' || s.session?.mode === mode) { this.setMode(mode); return; }
    void this.switchSession(mode);
  }

  /** "Lead me through": on, Clipa moves on to the next stage by herself; off, she only proposes it. Remembered per viewer. */
  isAutoLead(): boolean { return this.autoLead; }

  setAutoLead(on: boolean): void {
    if (this.autoLead === on) return;
    this.autoLead = on;
    this.writeStorage(AUTO_LEAD_STORAGE_KEY, on ? 'on' : 'off');
    this.conductorSend({ type: 'auto', on });
    this.sys(on ? 'Lead me through: on. Clipa moves on to the next stage by herself.' : 'Lead me through: off. Clipa only proposes the next stage.');
  }

  /** A conductor line said by the voice agent as `[ASK] text`; false when the voice is not connected. */
  private speakLine(text: string, maxChars?: number): boolean {
    if (this.state.offRecord) return false;
    const sent = this.voice?.ask(text, maxChars) ?? null;
    if (sent === null) return false;
    this.log('sent', 'USER_MSG', sent);
    return true;
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
      if (was !== snapshot.state) this.setShare(shareOf(snapshot.state), snapshot.reason ?? null);
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
    if (this.booting !== null) await this.booting;
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
    // With the conductor, every stage runs in the journey's one session: the screen, the voice and the conductor share its id, so
    // Reflect reads what Show saw and Pass it on reads the confirmed map. Its epoch stays the journey's.
    const journey = this.journey;
    const timelineEpochMs = journey !== null ? journey.epochMs : epochMs;
    if (journey !== null) {
      session = journey.session;
    } else {
      try {
        session = await this.deps.api.createSession();
      } catch (e) {
        if (this.isCurrent(run)) this.store.dispatch({ type: 'SESSION_FAILED', message: errMsg(e) });
        return;
      }
    }
    if (!this.isCurrent(run)) return; // off the record or a new start while the session was being made
    this.session = session;
    this.epochMs = timelineEpochMs;
    this.uploader = new EventUploader({
      session, fetch: this.deps.fetch, timers: this.deps.timers, now: () => this.deps.now(),
      onProblem: (text) => this.store.dispatch({ type: 'LOG', t: this.deps.now(), dir: 'err', logType: 'ERR', text }),
    });
    this.store.dispatch({
      type: 'SESSION_READY',
      session: {
        id: session.sessionId, mode, epochMs: timelineEpochMs, legacyRoutes: session.legacy, deadlineMs: deadlineOf(epochMs, SESSION_LIMIT_MS),
        clockSkewMs: session.clockSkewMs, conversationId: null,
      },
    });
    this.sys(`Session ${session.sessionId} started in ${mode} mode. Events, transcript and audio recording are stored on our server.`);
    if (this.conductor !== null && this.personaSent !== null && personaFor(mode) !== this.personaSent) this.sendHello();
    this.conductorSend({ type: 'session', mode, live: true, reason: null });
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
    // The conductor stops its cues and its model calls, and keeps no transcript of the span; this page renders nothing meanwhile.
    this.conductorSend({ type: 'off_record', on: true });
    this.conductorStore.set({ paused: true });
    this.face?.clear();
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

  /** Mic off: Clipa stops hearing the person; the screen, the session and Clipa's own voice go on. */
  setMicMuted(muted: boolean): void {
    if (this.micMuted === muted) return;
    this.micMuted = muted;
    this.voice?.setMicMuted(muted);
    this.sys(muted ? 'Microphone off: Clipa does not hear you; the screen and the session go on.' : 'Microphone on.');
  }

  isMicMuted(): boolean { return this.micMuted; }

  backOnRecord(): void {
    if (!this.state.offRecord) return;
    this.store.dispatch({ type: 'OFF_RECORD_SET', on: false });
    this.conductorStore.set({ paused: false });
    this.conductorSend({ type: 'off_record', on: false });
    // What changed while nothing was sent: the conductor would otherwise wait for a pause that already began.
    if (this.activitySent !== null) this.conductorSend({ type: 'activity', state: this.activitySent });
    this.conductorSend({ type: 'talking', by: 'person', active: this.personTalking });
    this.conductorSend({ type: 'talking', by: 'agent', active: this.agentTalking });
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
    const endingMode = this.state.phase === 'live' ? this.state.session?.mode ?? null : null;
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
    // After the bubble is cleared: the conductor answers the end of a stage with the next step's line.
    if (endingMode !== null) this.conductorSend({ type: 'session', mode: endingMode, live: false, reason: this.state.offRecord ? 'off_record' : 'ended' });
    // The microphone and the agent are closed: nobody is talking any more (no voice event will say so).
    this.setTalking('agent', false);
    this.setTalking('person', false);
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
    this.conductorOff();
    if (this.activityTimer !== null) this.deps.timers.clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.face?.clear();
    this.conductor?.close();
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
    voice.setMicMuted(this.micMuted);
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
        // Final turns only (the SDK reports a turn when it is complete); the conductor reads the person's words and Clipa's.
        if (turn.text !== '') this.conductorSend({ type: 'transcript', role: turn.role === 'agent' ? 'agent' : 'expert', text: turn.text });
        this.safe('onTranscript', () => this.brain.onTranscript(turn), undefined);
        if (turn.role === 'agent') this.store.dispatch({ type: 'VOICE_THINKING', thinking: false });
        else this.captureAnswer(turn);
      },
      onError: (message) => { if (live()) this.err(message); },
      onVadScore: (score) => {
        if (!live()) return;
        const at = this.deps.perfNow();
        this.speech.onScore(score, at);
        this.setTalking('person', this.speech.isSpeaking(at));
      },
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
    // The voice SDK's speaking/listening switch (not the Learn/Review/Teach tab). Logged only when it changes.
    const was = this.state.voice.phase;
    if ((mode === 'speaking') === (was === 'speaking') && (was === 'speaking' || was === 'listening')) return;
    this.log('recv', 'VOICE_MODE', mode);
    this.store.dispatch({ type: 'VOICE_PHASE', phase: mode === 'speaking' ? 'speaking' : 'listening' });
    this.setTalking('agent', mode === 'speaking');
    this.face?.onAgentSpeaking(mode === 'speaking');
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
    this.keepObservation(o);
    if (o.kind === 'input_activity') this.deps.presenter.noteInput?.(o.facts.typing);
    // The brain knows the workspace kinds only; a generic screen_activity is the conductor's (it reads it on the server).
    if (KNOWN_KINDS.has(o.kind)) {
      this.safe('onObservation', () => this.brain.onObservation(o), undefined);
      this.mapDirty = true;
    }
    // With the conductor the server already has every observation and sends its own `context` cues.
    if (this.conductorLeads()) return;
    const context = observationToContext(o, this.source?.synthetic ?? false);
    if (context !== null) this.sendContext(context, this.voice);
  }

  /** The raw observations of this page (newest last, capped): the Review board draws its keyframes from them. */
  private observationLog: ScreenObservation[] = [];
  private keepObservation(o: ScreenObservation): void {
    if (o.kind === 'input_activity') return;
    this.observationLog = [...this.observationLog.filter((x) => x.id !== o.id), o].slice(-MAX_KEPT_OBSERVATIONS);
    this.conductorStore.set({ observations: this.observationLog });
  }

  private onScreenStatus(s: ScreenStatus): void {
    this.safe('onStatus', () => this.brain.onStatus(s), undefined);
    // A frame the vision could not read (no order, email or ticket in view: vision_incomplete, a model timeout) is reported by the
    // server as an `error` status while the capture keeps running. It does not stop observation, so it is not shown as a stop.
    if (s.state === 'error' && this.state.screen.capture?.state === 'capturing') {
      this.store.dispatch({ type: 'SCREEN_STATUS', state: 'capturing', reason: `last frame skipped: ${s.reason ?? 'vision error'}` });
      this.log('sys', 'SCREEN', `frame skipped (${s.reason ?? 'vision error'}); capture continues`);
      return;
    }
    this.store.dispatch({ type: 'SCREEN_STATUS', state: s.state, reason: s.reason ?? null });
    this.log('sys', 'SCREEN', `${s.state}${s.reason ? ` (${s.reason})` : ''}`);
    if (s.state === 'capturing') this.setShare('capturing', null);
    else if (s.state === 'error') this.setShare('unavailable', s.reason ?? null);
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
      ...(this.deps.lastInputAt ? { lastInputAtMs: this.sessionTime(this.deps.lastInputAt()) } : {}),
    };
  }

  /** An epoch-ms instant as session time, or null (before the session started, or none). */
  private sessionTime(epochMs: number | null): number | null {
    return epochMs === null || epochMs < this.epochMs ? null : epochMs - this.epochMs;
  }

  private tickBrain(): void {
    if (this.state.phase !== 'live') return;
    const nowMs = this.deps.now() - this.epochMs;
    const held = this.held;
    if (held && this.state.voice.phase !== 'speaking') {
      this.held = null;
      if (this.deps.perfNow() - held.atPerfMs <= WARN_HOLD_MS) this.applyDecision(held.decision, nowMs);
    }
    // The conductor leads: the brain keeps reading (its map is the fallback) but never speaks over the conductor.
    const decisions = this.conductorLeads() ? [] : this.safe('tick', () => this.brain.tick(nowMs, this.signals()), [] as BrainDecision[]);
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

  /** What the demo workspace's Preview may do now: the tutor checks only in a live Teach session. */
  checkpointGate(): { ok: true } | { ok: false; message: string } {
    const s = this.state;
    if (s.offRecord) return { ok: false, message: 'Off the record: nothing is checked.' };
    if (s.phase !== 'live' || s.session === null || s.session.mode !== 'teach') {
      return { ok: false, message: 'Start Teach first: the tutor checks a draft only while a Teach session runs. Nothing was checked.' };
    }
    return { ok: true };
  }

  /**
   * The tutor's answer to a checkpoint (the brain within CHECKPOINT_TIMEOUT_MS, else `unknown`), shown and recorded. The bridge path
   * (onCheckpoint) and the demo workspace's own Preview port (screen/checkpoint-binding.ts) both come here.
   */
  async answerCheckpoint(cp: ActionCheckpoint): Promise<CheckpointReply | null> {
    const run = this.runId;
    this.sys(`Checkpoint ${cp.id} raised by the workspace.`);
    const reply = await this.judge(cp);
    if (!this.isCurrent(run)) return null;
    this.store.dispatch({
      type: 'CHECKPOINT_RESULT',
      card: { checkpointId: reply.checkpointId, status: reply.status, message: reply.message, evidenceIds: reply.evidenceIds, atMs: cp.timestampMs, deliveryError: null },
    });
    this.refreshMastery();
    this.persist('CHECKPOINT_RESULT', { checkpointId: reply.checkpointId, status: reply.status, evidenceIds: reply.evidenceIds, atMs: cp.timestampMs });
    this.log('sent', 'CHECKPOINT', `${reply.status}: ${reply.message}`);
    return reply;
  }

  private async onCheckpoint(cp: ActionCheckpoint): Promise<void> {
    const reply = await this.answerCheckpoint(cp);
    const source = this.source;
    if (!reply || !source) return;
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
