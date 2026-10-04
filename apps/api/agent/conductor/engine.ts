// The conductor of one session: it reads the clients' events and the screen, and decides what Clipa says and does.
// One conductor serves every face of the session: the web app (the whole journey) and the macOS app (a lighter face
// that hands over to the web). Pure apart from the injected clock, LLM call, id source and web link, so tests drive it
// with a fake clock and fake tasks.
import { BaselineProfileSelector, baselinePromptContext } from '../../../../packages/screen/baseline/profiles.ts';
import { isRecord } from '../config.ts';
import type { GenericQuestionOutput, GuardrailCheckOutput, MapEditOutput, MapSynthesisOutput, ProcessMatchOutput, ReplyOutput } from '../llm-tasks.ts';
import type { TaskResult } from '../llm.ts';
import { demoMap } from './demo-map.ts';
import { GUIDE, MAC_DONE_LINE, NUDGES, OFF_LINE, OPEN_WEB, PROPOSE, SHOW_LOOKS_DONE, STAGE_ABOUT, STAGE_CONFIRM, STAGE_NAMES, STAGE_START, detectLanguage, donePhraseOnly, doneSaid, offSaid, stageAsked, stageCommand, yesSaid } from './lines.ts';
import { applyEdits } from './map-edits.ts';
import type { ConductorMap, MapComment } from './map-edits.ts';
import { mapTitle, storableMap } from './map-store.ts';
import type { MapStore, StoredMap } from './map-store.ts';
import type { Activity, Audience, ClientEnvelope, ClientEvent, ClientKind, Cue, CueEnvelope, MapOrigin, Mode, Persona, Presence, Region, SeenObservation, Target } from './protocol.ts';

export const RULES = {
  /** Quiet this long after the last typing, talking or screen change is a pause. */
  pauseMs: 1800,
  /** The screen counts as settled this long after a change: the question is prepared from then on, ready for the pause. */
  settleMs: 500,
  /** Learn: at most this many questions per window, at least minGapMs apart. */
  learnMaxQuestions: 4,
  learnWindowMs: 10 * 60_000,
  learnMinGapMs: 20_000,
  /** How long an ask or a warning stays valid before the moment has passed. */
  askTtlMs: 12_000,
  warnTtlMs: 15_000,
  /** Teach: a check at a pause at most this often; a pending action (about to commit) is checked after urgentSettleMs. */
  teachCheckGapMs: 8_000,
  urgentSettleMs: 400,
  urgentCheckGapMs: 3_000,
  /** Review: wait this long after an answer before the next gap; ask at most reviewMaxGaps of them (a 2-3 minute demo). */
  gapAfterAnswerMs: 1500,
  reviewMaxGaps: 2,
  /** A recognised process needs this confidence before Clipa follows its strategy. */
  processConfidence: 0.6,
  // Switches for the live demo: false turns the feature off and nothing else changes.
  /** Recognise a learned process on screen (process_match), say so and follow its strategy. */
  recognizeProcesses: true,
  /** Build the map in the background as soon as Show ends; false: Reflect builds it when it opens, as before. */
  mapAfterShow: true,
  /** The voice agent hears a new screen at once, and the same screen again at most this often. */
  screenContextMs: 8_000,
  /** When the person moves to another app, the turns said from this long before its first frame are kept for questions. */
  turnsBeforeFrameMs: 5_000,
  /** A quiet cue with the same reason is not repeated sooner than this. */
  quietRepeatMs: 20_000,
  /** Thought bubbles: a short visual line about what Clipa is working on (never spoken), at most one per thoughtGapMs. */
  thoughts: true,
  thoughtGapMs: 3_000,
  thoughtMaxChars: 60,
  /** Attention: Clipa flashes and goes where the person should look (an ask about a region, a warning, the next stage). */
  attention: true,
  /**
   * Show and Pass it on: a gentle line after nudgeAfterMs without the person talking or typing, at most nudgeMaxInRow in a row.
   * None in Reflect, none after the person said they are done, none while Clipa waits for a yes or is about to move on.
   */
  nudges: true,
  nudgeAfterMs: 20_000,
  nudgeMaxInRow: 2,
  /**
   * An explicit phrase in the person's final turn ("let me show you", "let's review", "teach me") opens that stage; while a
   * session runs on the web, Clipa starts it.
   */
  voiceStages: true,
  /** Short final turns on the web: "that's it" ends Show or Pass it on, "stop" ends the session, "yes" takes a proposal. */
  voiceControl: true,
  /**
   * The flow between stages (the web's "Lead me through"): when a stage is complete Clipa moves on by herself (auto) or
   * proposes it (manual). false: she never moves on or proposes by herself; voice control still works.
   */
  autoAdvance: true,
  /** Show is complete after this long without typing, talking or a screen change, once there was real work to learn from. */
  showIdleMs: 30_000,
  showIdleMinObservations: 3,
  /**
   * After the map is confirmed: the handoff line, then this long, then the Pass it on tab opens (auto). It is not started:
   * a new person takes over there, often in another browser, and presses Start.
   */
  afterHandoffMs: 5_000,
  /** In Pass it on, "done" this soon after a warning means the fix ("Done." after fixing the terms), not the end of the stage. */
  doneAfterWarnMs: 20_000,
  /** A proposal ("Shall we reflect?") waits this long for a yes. */
  proposalTtlMs: 30_000,
  /** A line Clipa says before she switches: the switch waits until it is said, at most this long. */
  lineBeforeSwitchMs: 10_000,
  keepCues: 300,
  keepObservations: 200,
  keepTurns: 200,
} as const;

/** One line of at most `max` characters: whitespace collapsed, an ellipsis where it was cut. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A generic frame's app name, compared loosely: lower-case letters and digits only. */
function appKey(app: string | null): string {
  return (app ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The same app on two generic frames: equal names, one inside the other ("gmail" in "googlechromegmail"), or one unknown. */
function sameApp(a: string, b: string): boolean {
  return a === b || a === '' || b === '' || a.includes(b) || b.includes(a);
}

/** The demo workspace shows its order, its email and its ticket side by side: they are one place, not three screens. */
const WORKSPACE_KINDS: ReadonlySet<string> = new Set(['order_view', 'email_draft', 'ticket']);

/**
 * Where a frame is: the key a move is told by. A generic frame names its surface in free words that change between frames
 * of one screen, and its app name can gain or lose a prefix ("Google Chrome - Gmail"): for those only another app is a move.
 * The workspace's frames alternate between its surfaces while the person works: the whole workspace is one place, so an order
 * frame after an email frame is neither a move nor a change. Any other kind keeps its app and surface.
 */
function placeOf(o: SeenObservation): string {
  if (o.kind === 'screen_activity') return appKey(o.app);
  if (WORKSPACE_KINDS.has(o.kind)) return 'workspace';
  return `${o.app ?? ''}|${o.surface}`;
}

/**
 * Free-text paraphrases on a generic frame do not restart the user's pause: the same app and pending control, and the same
 * surface, or a reworded one when vision saw nothing change.
 */
function sameScreen(a: SeenObservation, b: SeenObservation): boolean {
  return a.kind === 'screen_activity' && b.kind === 'screen_activity' && sameApp(appKey(a.app), appKey(b.app))
    && a.pendingAction === b.pendingAction && (a.surface === b.surface || b.change === null);
}

export interface ConfirmedMap { sessionId: string; map: MapSynthesisOutput; confirmedAt: number }

/** The comments a stored map carries (voice edits keep them on the map), or none. */
function commentsOf(map: unknown): MapComment[] {
  const raw = isRecord(map) ? map.comments : undefined;
  return Array.isArray(raw)
    ? raw.filter((c): c is MapComment => isRecord(c) && typeof c.targetId === 'string' && typeof c.text === 'string' && typeof c.atMs === 'number').slice(-50)
    : [];
}

/**
 * Confirmed maps, shared by all sessions of this server: Teach reads the expert's map. One team, one demo server. It also
 * keeps the last map built in any session, which Reflect shows when a session has none of its own. With a store, all of it
 * is written to disk on every change and read back at start, so a deploy or a restart keeps what Clipa learned.
 */
export class MapRegistry {
  private readonly bySession = new Map<string, ConfirmedMap>();
  private latest: ConfirmedMap | null = null;
  private built: StoredMap | null = null;
  private readonly store: MapStore | null;
  constructor(store: MapStore | null = null) {
    this.store = store;
    if (store === null) return;
    // Oldest first, so the newest confirmed map is the latest again.
    for (const e of [...store.loaded.confirmed].sort((a, b) => a.atMs - b.atMs)) this.remember({ sessionId: e.sessionId, map: e.map, confirmedAt: e.atMs });
    this.built = store.loaded.lastBuilt;
  }
  private remember(entry: ConfirmedMap): void {
    this.bySession.set(entry.sessionId, entry);
    this.latest = entry;
  }
  confirm(sessionId: string, map: MapSynthesisOutput, at: number): void {
    this.remember({ sessionId, map, confirmedAt: at });
    this.persist();
  }
  /** A session built (or edited) its own map: it becomes the last built map, confirmed or not. */
  recordBuilt(sessionId: string, map: MapSynthesisOutput, at: number): void {
    this.built = { sessionId, atMs: at, title: mapTitle(map), map: storableMap(map) };
    this.persist();
  }
  /** The newest map any session built from its own screen and words, or null. */
  lastBuilt(): StoredMap | null { return this.built; }
  private persist(): void {
    this.store?.save({
      confirmed: [...this.bySession.values()].map((e) => ({ sessionId: e.sessionId, atMs: e.confirmedAt, title: mapTitle(e.map), map: storableMap(e.map) })),
      lastBuilt: this.built,
    });
  }
  /** The map of `from` when named and confirmed, else the most recently confirmed one. */
  find(from: string | null): ConfirmedMap | null {
    return (from !== null ? this.bySession.get(from) : undefined) ?? this.latest;
  }
  /**
   * Every process Clipa has learned, newest map first (the map of `prefer` first when named): what she can recognise on
   * screen and follow. A map without named processes counts as one process; a step or rule that names no known process
   * belongs to the first one, so no rule is ever lost. Rules of the first map keep their own ids (g1 ..), the warning
   * then names the rule as the expert's map shows it; older maps' rules are prefixed (m2-g1 ..) to stay unique.
   */
  library(prefer: string | null = null): LearnedProcess[] {
    const maps = [...this.bySession.values()].sort((a, b) => b.confirmedAt - a.confirmedAt);
    if (prefer !== null) maps.sort((a, b) => Number(b.sessionId === prefer) - Number(a.sessionId === prefer));
    const out: LearnedProcess[] = [];
    maps.slice(0, 6).forEach((entry, m) => {
      const map = entry.map;
      const named = Array.isArray(map.processes) ? map.processes : [];
      const processes = named.length ? named : [{ id: 'p1', title: map.steps[0]?.goal ?? 'The expert\'s task', summary: '' }];
      const known = new Set(processes.map((p) => p.id));
      processes.forEach((p, i) => {
        const mine = (pid: string | null | undefined): boolean => (typeof pid === 'string' && known.has(pid) ? pid === p.id : i === 0);
        out.push({
          key: `m${m + 1}-${p.id}`, title: p.title, summary: p.summary,
          steps: map.steps.filter((x) => mine(x.processId)).map((x) => x.action),
          rules: map.guardrails.filter((g) => mine(g.processId)).map((g) => ({
            id: m === 0 ? g.id : `m${m + 1}-${g.id}`, condition: g.condition, requiredAction: g.requiredAction, reason: g.reason, quote: g.quote, evidenceIds: g.evidenceIds,
          })),
        });
      });
    });
    return out.slice(0, 12);
  }
}

export interface LearnedRule { id: string; condition: string; requiredAction: string; reason: string | null; quote: string | null; evidenceIds: string[] }
export interface LearnedProcess { key: string; title: string; summary: string; steps: string[]; rules: LearnedRule[] }

export interface ConductorDeps {
  now(): number;
  llm(task: string, body: unknown, signal: AbortSignal): Promise<TaskResult>;
  newId(): string;
  maps: MapRegistry;
  /** A link that opens the web app on `page`, joined to this session through a short-lived code; null when unavailable. */
  webLink?(page: 'review' | 'teach' | 'summary'): string | null;
}

interface Turn { role: 'expert' | 'agent'; text: string; atMs: number }
/** The order of the stages: while a session runs, a voice command only moves forward. */
const STAGE_ORDER: Readonly<Record<Mode, number>> = { learn: 0, review: 1, teach: 2 };
interface Source { client: ClientKind | null; lastSeq: number }
type ReviewPhase = 'idle' | 'building' | 'gaps' | 'teachback' | 'confirmed';
interface ActiveCue { cueId: string; type: Cue['type']; expiresAt: number | null; done: boolean; at: number }
interface Prefetch { basis: string; status: 'running' | 'ready' | 'failed'; out: GenericQuestionOutput | null }
/** What Clipa does next on her own: start a stage on the web, end the session, or propose a stage. */
type Next = { kind: 'start'; mode: Mode } | { kind: 'open'; mode: Mode } | { kind: 'end'; reason: 'off' | 'done' } | { kind: 'propose'; mode: 'review' | 'teach' };
/**
 * `next` waits for the line `cueId` to be said (cue_done), then delayMs; at dueAt it goes ahead in any case (never while the
 * person talks). `auto`: Clipa decided on it by herself, so the person going on (talking, typing, a screen change) drops it.
 */
interface After { next: Next; cueId: string | null; delayMs: number; dueAt: number; auto: boolean }

export class Conductor {
  readonly sessionId: string;
  private readonly deps: ConductorDeps;
  private persona: Persona = 'expert';
  private language: string | null = null;
  private languageFixed = false;
  private mapFrom: string | null = null;
  private selectedMode: Mode | null = null;
  private liveMode: Mode | null = null;
  private offRecord = false;
  /** The last screen line sent to the voice agent, and when. */
  private lastScreenContext = '';
  private lastScreenContextAt = -Infinity;
  private sharing = false;
  private readonly sources = new Map<string, Source>();
  /** Server time minus the session time of the latest event. */
  private epochOffset: number | null = null;

  private activity: Activity = 'working';
  private personTalking = false;
  private agentTalking = false;
  /** Last moment of typing or talking, server time. */
  private lastBusyAt = 0;
  /** Last meaningful screen change, server time: a pause only counts once the screen has settled after it. */
  private lastChangeAt = 0;
  private latestChangeId: string | null = null;

  private readonly observations: SeenObservation[] = [];
  private readonly turns: Turn[] = [];
  private readonly baseline = new BaselineProfileSelector();
  private baselinedSession = false;
  private contextRevision = 0;
  private contextWhere: string | null = null;
  private readonly contextObservationIds = new Set<string>();
  private readonly contextTurns: Turn[] = [];
  private readonly contextAskedTexts: string[] = [];
  private readonly baselineProvenance: NonNullable<MapSynthesisOutput['baselineProvenance']> = { observations: [], turns: [] };
  private questionContext: NonNullable<MapSynthesisOutput['baselineProvenance']>['turns'][number] | null = null;
  private pendingChange = false;
  private pendingTeachCheck = false;
  private urgentTeachCheck = false;
  private prefetch: Prefetch | null = null;
  private readonly askTimes: number[] = [];
  private lastAskAt = -Infinity;
  private lastTeachCheckAt = -Infinity;
  private readonly warned = new Set<string>();
  /** The learned process Clipa recognised on screen in this stage, and the app it was recognised in. */
  private recognized: LearnedProcess | null = null;
  private recognizedFor: string | null = null;
  private lastRecognitionAt = -Infinity;
  /** A line to say at the next pause (so it never cuts into the person's work). */
  private pendingSay: string | null = null;
  /** The map being built in the background as soon as Show ends, so Reflect opens with it ready. */
  private mapPrefetch: Promise<void> | null = null;
  private freshMap = false;

  /** `origin`: the map is this session's own, a copy of an earlier session's, or the demo map (Reflect's fallbacks). */
  private review: { phase: ReviewPhase; map: ConductorMap | null; version: number; gapIndex: number; awaiting: 'gap' | 'teachback' | null; answeredAt: number; unclearAsked: boolean; editFailed: boolean; origin: MapOrigin } =
    { phase: 'idle', map: null, version: 0, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false, origin: 'session' };
  private readonly voiceQueue: string[] = [];

  private readonly cues: CueEnvelope[] = [];
  private seq = 0;
  private active: ActiveCue | null = null;
  private readonly listeners = new Set<(cue: CueEnvelope) => void>();
  private inflight: AbortController | null = null;
  private inflightTask: string | null = null;
  private lastQuiet: { reason: string; at: number } | null = null;
  private readonly guided = new Set<string>();
  private lastThoughtAt = -Infinity;
  private pendingThought: { text: string; at: number } | null = null;
  /** Nudges: the person's last talk or typing, Clipa's last line (or the voice agent's own), the start of the stage. */
  private lastPersonAt = -Infinity;
  private lastSpokeAt = -Infinity;
  private stageStartedAt = -Infinity;
  private nudgesInRow = 0;
  private nudgeIndex = 0;
  /** Auto mode (the web's "Lead me through", on unless the web says otherwise): Clipa moves on by herself. */
  private auto = true;
  /** A stage Clipa proposed (manual mode); a yes within proposalTtlMs starts it. */
  private proposal: { mode: 'review' | 'teach'; at: number } | null = null;
  /** The stage in which Clipa already proposed or moved on by herself (once per stage). */
  private advancedIn: Mode | null = null;
  private after: After | null = null;
  /** The person said they are done with the running stage (or asked Clipa to stop). */
  private stageDone = false;
  /** The kind of face whose session is live: the web-only flow (stage starts, end, proposals) runs for a web session only. */
  private liveClient: ClientKind | null = null;
  /** Screen observations since the current stage started (Show is complete only after real work of its own). */
  private stageObservations = 0;
  /** The last screen change of any kind, an edit on the same surface included (the Show-idle clock). */
  private lastActivityAt = 0;
  /** When Clipa last warned (Pass it on). */
  private lastWarnAt = -Infinity;
  /** The person answered one of Clipa's questions in this session. */
  private answered = false;
  /** The end of the running stage was asked for by Clipa: the end says no "open the next stage" line of its own. */
  private quietEnd = false;
  lastSeenAt: number;

  constructor(sessionId: string, deps: ConductorDeps) {
    this.sessionId = sessionId;
    this.deps = deps;
    this.lastSeenAt = deps.now();
  }

  // ---- cue stream ----------------------------------------------------------
  subscribe(listener: (cue: CueEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  listenerCount(): number { return this.listeners.size; }
  /** Cues after `seq` for this audience, oldest first (a reconnecting client replays what it missed). */
  cuesAfter(seq: number, client: ClientKind | null = null): CueEnvelope[] {
    return this.cues.filter((c) => c.seq > seq && (client === null || c.for === 'all' || c.for === client));
  }
  lastSeq(): number { return this.seq; }
  lastEventSeq(source: string = this.sessionId): number { return this.sources.get(source)?.lastSeq ?? -1; }
  clientOf(source: string): ClientKind | null { return this.sources.get(source)?.client ?? null; }

  private kinds(): ClientKind[] {
    const kinds = new Set<ClientKind>();
    for (const s of this.sources.values()) if (s.client) kinds.add(s.client);
    return kinds.size ? [...kinds] : ['web'];
  }
  private has(kind: ClientKind): boolean { return [...this.sources.values()].some((s) => s.client === kind); }

  private sessionTime(): number {
    return this.epochOffset === null ? 0 : Math.max(0, this.deps.now() - this.epochOffset);
  }

  private emit(cue: Cue, opts: { ttlMs?: number | null; for?: Audience } = {}): CueEnvelope {
    const now = this.deps.now();
    const ttl = opts.ttlMs ?? null;
    const env: CueEnvelope = {
      seq: ++this.seq, cueId: `c${this.seq}-${this.deps.newId().slice(0, 8)}`, atMs: this.sessionTime(), mode: this.liveMode ?? this.selectedMode,
      persona: this.persona, for: opts.for ?? 'all', cue, expiresAtMs: ttl === null ? null : this.sessionTime() + ttl,
    };
    this.cues.push(env);
    if (this.cues.length > RULES.keepCues) this.cues.splice(0, this.cues.length - RULES.keepCues);
    if (cue.type === 'ask' || cue.type === 'warn' || cue.type === 'teachback') this.active = { cueId: env.cueId, type: cue.type, expiresAt: ttl === null ? null : now + ttl, done: false, at: now };
    if (cue.type === 'ask' || cue.type === 'warn' || cue.type === 'teachback' || cue.type === 'say') this.lastSpokeAt = now;
    for (const l of [...this.listeners]) l(env);
    return env;
  }

  private pose(clipa: Extract<Cue, { type: 'state' }>['clipa']): void { this.emit({ type: 'state', clipa }); }

  /** The web face is (or may be) watching: the cues only the web renders for now (thought, attention, stage). */
  private webFace(): boolean { return this.kinds().includes('web'); }

  /** A thought bubble about what Clipa works on: visual only, never spoken, never off the record, at most one per thoughtGapMs. */
  private thought(text: string): void {
    if (!RULES.thoughts || this.offRecord || !this.webFace()) return;
    const line = clip(text, RULES.thoughtMaxChars);
    if (line === '') return;
    this.pendingThought = { text: line, at: this.deps.now() };
    this.flushThought();
  }

  /** A thought that came too soon waits for the gap (the newest one wins) and is dropped once it is stale. */
  private flushThought(): void {
    const t = this.pendingThought;
    if (t === null) return;
    const now = this.deps.now();
    if (this.offRecord || now - t.at > 2 * RULES.thoughtGapMs) { this.pendingThought = null; return; }
    if (now - this.lastThoughtAt < RULES.thoughtGapMs) return;
    this.pendingThought = null;
    this.lastThoughtAt = now;
    this.emit({ type: 'thought', text: t.text }, { for: 'web' });
  }

  /** The person should look elsewhere: Clipa flashes and goes to the target (an ask about a region, a warning, the next stage). */
  private attention(target: Target | null): void {
    if (!RULES.attention || this.offRecord || !this.webFace()) return;
    this.emit({ type: 'attention', target }, { for: 'web' });
  }

  /** macOS only: how far Clipa comes out of the corner. */
  private presence(size: Presence, anchor: 'corner' | 'target' = 'corner'): void {
    if (this.has('macos')) this.emit({ type: 'presence', size, anchor }, { for: 'macos' });
  }

  /** Each face gets its own line for the step; a face with no line for it says nothing. */
  private guide(step: string, only?: ClientKind): string | null {
    this.guided.add(step);
    let webCue: string | null = null;
    for (const kind of only ? [only] : this.kinds()) {
      const line = GUIDE[kind][this.persona][step];
      if (!line) continue;
      const env = this.emit({ type: 'guide', step: line.step, phase: line.phase, text: line.text, target: line.target, speak: line.speak }, { for: kind });
      if (kind === 'web') webCue = env.cueId;
      // The next stage of the journey: the person looks at its tab on the rail.
      if (kind === 'web' && line.target?.kind === 'ui' && line.target.name === 'mode_tab') this.attention(line.target);
    }
    return webCue;
  }
  private guideOnce(step: string): void { if (!this.guided.has(step)) this.guide(step); }

  /** macOS hands over to the web for Review and the summary; the web gets its own guide line instead. */
  private handOver(page: 'review' | 'summary', webStep: string): void {
    if (this.has('macos')) {
      const url = this.deps.webLink?.(page) ?? null;
      if (url) { this.presence('peek'); this.emit({ type: 'open_web', page, url, text: OPEN_WEB[page] }, { for: 'macos' }); }
    }
    if (this.has('web') || !this.has('macos')) this.guide(webStep, 'web');
  }

  private quiet(reason: string): void {
    const now = this.deps.now();
    if (this.lastQuiet && this.lastQuiet.reason === reason && now - this.lastQuiet.at < RULES.quietRepeatMs) return;
    this.lastQuiet = { reason, at: now };
    this.emit({ type: 'quiet', reason });
  }

  private cancelActive(): void {
    if (this.active && !this.active.done) this.emit({ type: 'cancel', cueId: this.active.cueId });
    this.active = null;
  }

  // ---- events --------------------------------------------------------------
  /**
   * Applies a batch from one face (`source` is its own session id; a linked web app has its own). Envelopes at or below
   * that source's last seq are duplicates of a retried POST and are skipped.
   */
  handle(batch: readonly ClientEnvelope[], source: string = this.sessionId): void {
    const now = this.deps.now();
    this.lastSeenAt = now;
    let src = this.sources.get(source);
    if (!src) { src = { client: null, lastSeq: -1 }; this.sources.set(source, src); }
    for (const env of batch) {
      if (env.seq <= src.lastSeq) continue;
      src.lastSeq = env.seq;
      if (source === this.sessionId) this.epochOffset = now - env.atMs;
      if (env.event.type === 'hello') src.client = env.event.client;
      this.apply(env.event, src);
    }
    this.tick();
  }

  private apply(e: ClientEvent, src: Source): void {
    const now = this.deps.now();
    switch (e.type) {
      case 'hello':
        // The first face decides the persona; a linked web app joins the same person.
        if (this.sources.size === 1 || src.client === null) this.persona = e.persona;
        if (e.mapFrom !== null) this.mapFrom = e.mapFrom;
        if (e.language !== null) { this.language = e.language; this.languageFixed = true; }
        this.pose('idle');
        if (e.client === 'macos') this.presence('peek');
        this.guide(this.review.map && e.client === 'web' ? 'talk_to_edit' : 'welcome', e.client);
        // A web app joining a session that already has a map shows it right away.
        if (e.client === 'web' && this.review.map) this.emit({ type: 'map', version: this.review.version, map: this.review.map, confirmed: this.review.phase === 'confirmed', origin: this.review.origin }, { for: 'web' });
        return;
      case 'auto':
        this.auto = e.on;
        if (!e.on) this.cancelAutoAfter();
        return;
      case 'off_record':
        if (e.on === this.offRecord) return;
        this.offRecord = e.on;
        this.resetLiveContext();
        this.pendingThought = null;
        this.proposal = null;
        this.after = null;
        if (e.on) {
          this.inflight?.abort();
          this.inflight = null;
          this.prefetch = null;
          this.voiceQueue.length = 0;
          this.cancelActive();
          this.pose('hidden');
        } else {
          this.pose('idle');
        }
        return;
      case 'cue_done':
        // The line before a switch is said: the switch follows after its delay.
        if (this.after && this.after.cueId === e.cueId) {
          // The person cut in, or the face skipped the line because they were busy: a switch of Clipa's own is dropped.
          if (this.after.auto && (e.outcome === 'interrupted' || e.outcome === 'skipped')) this.cancelAutoAfter();
          else {
            this.after.cueId = null;
            this.after.dueAt = Math.min(this.after.dueAt, now + this.after.delayMs);
          }
        }
        if (this.active && this.active.cueId === e.cueId) {
          this.active.done = true;
          if (this.active.type === 'ask' || this.active.type === 'warn') this.presence('dot');
        }
        return;
      default:
        break;
    }
    if (this.offRecord) {
      // Off the record: only mode and session changes are kept, so the flow is right when the record resumes.
      if (e.type === 'mode') this.selectedMode = e.mode;
      if (e.type === 'session') this.liveMode = e.live ? e.mode : this.liveMode === e.mode ? null : this.liveMode;
      return;
    }
    switch (e.type) {
      case 'mode':
        this.selectedMode = e.mode;
        return;
      case 'share':
        if (e.state === 'capturing' || e.state === 'camera') {
          this.sharing = true;
          if (this.liveMode === null) this.guide(this.persona === 'new_hire' ? 'start_teach' : 'start_learn', 'web');
          else this.guideOnce('work');
        } else if (e.state === 'unavailable') {
          this.sharing = false;
          this.guide('share_failed', 'web');
        }
        return;
      case 'session':
        this.onSession(e.mode, e.live, e.reason, src.client);
        return;
      case 'activity':
        // Typing lasts until the next activity word: that moment is when the person last typed.
        if (this.activity === 'typing' && e.state !== 'typing') this.lastPersonAt = now;
        this.activity = e.state;
        if (e.state === 'typing') {
          this.lastBusyAt = now;
          this.lastPersonAt = now;
          this.cancelAutoAfter();
          // The person went back to work: a question or warning that has not been said yet is out of date.
          if (this.active && !this.active.done && (this.active.type === 'ask' || this.active.type === 'warn')) { this.cancelActive(); this.presence('dot'); }
        }
        return;
      case 'talking':
        if (e.by === 'person') this.personTalking = e.active; else this.agentTalking = e.active;
        this.lastBusyAt = now;
        if (e.by === 'agent') {
          // The voice agent may also speak on its own: a nudge waits as long after it as after one of Clipa's lines.
          this.lastSpokeAt = now;
          this.pose(e.active ? 'speak' : 'listen');
        } else {
          // The person talks: Clipa listens, and the nudges start counting again.
          this.lastPersonAt = now;
          this.nudgesInRow = 0;
          if (e.active) this.cancelAutoAfter();
          if (e.active && !this.agentTalking) this.pose('listen');
        }
        return;
      case 'transcript':
        this.onTranscript(e.role, e.text);
        return;
      case 'observation':
        this.onObservation(e.observation);
        return;
      case 'ui':
        this.onUi(e.action, e.targetId, e.text);
        return;
    }
  }

  /** Observations from the vision path; the route feeds them from a client or from the screen module. */
  onObservation(o: SeenObservation): void {
    const now = this.deps.now();
    this.lastSeenAt = now;
    if (this.offRecord) return;
    // The same observation can arrive twice (from the screen module and from a client that forwards it): keep the first.
    if (this.observations.some((x) => x.id === o.id)) return;
    // What this frame is compared with: the previous frame of its own kind (the workspace's frames alternate between kinds).
    const last = [...this.observations].reverse().find((item) => item.kind === o.kind);
    this.observations.push(o);
    if (this.observations.length > RULES.keepObservations) this.observations.splice(0, this.observations.length - RULES.keepObservations);
    if (o.kind === 'input_activity') return;
    this.stageObservations++;
    const where = placeOf(o);
    const firstFrame = this.contextWhere === null;
    const moved = this.contextWhere !== null && (o.kind === 'screen_activity' ? !sameApp(this.contextWhere, where) : this.contextWhere !== where);
    if (moved) {
      this.invalidateLiveContext(true);
      this.contextObservationIds.clear();
      // Vision runs seconds behind speech: what the person said while this new screen was already up is about it.
      const kept = this.contextTurns.filter((t) => t.atMs >= o.atMs - RULES.turnsBeforeFrameMs);
      this.contextTurns.length = 0;
      this.contextTurns.push(...kept);
      this.contextAskedTexts.length = 0;
    }
    this.contextWhere = where;
    this.contextObservationIds.add(o.id);
    const retainedIds = new Set(this.observations.map((item) => item.id));
    for (const id of this.contextObservationIds) if (!retainedIds.has(id)) this.contextObservationIds.delete(id);
    const before = this.baseline.current();
    const current = this.baseline.observe(o);
    // A same-app navigation may retain the prior confirming frame; keep those evidence refs in the live input.
    for (const id of current.evidence.observationIds) this.contextObservationIds.add(id);
    if (current.candidate) this.baselinedSession = true;
    const baselineChanged = before.status !== current.status || before.appId !== current.appId || before.candidate?.appId !== current.candidate?.appId;
    this.baselineProvenance.observations.push({
      observationId: o.id, appId: current.candidate?.appId ?? current.appId,
      profileId: current.candidate?.profileId ?? current.profileId, evidenceIds: o.evidenceIds.slice(0, 8),
    });
    this.baselineProvenance.observations.splice(0, Math.max(0, this.baselineProvenance.observations.length - RULES.keepObservations));
    const changed = moved || baselineChanged || o.change !== null || last === undefined || last.summary !== o.summary || last.surface !== o.surface || last.app !== o.app;
    const newScreen = moved || baselineChanged || last === undefined || (o.kind === 'screen_activity' ? !sameScreen(last, o) : changed);
    if (o.change !== null || newScreen) { this.lastActivityAt = now; this.cancelAutoAfter(); }
    if (changed || newScreen) {
      this.pendingChange = true;
      if (newScreen) {
        // Keep PR60's generic-screen pause semantics; app/profile transitions always invalidate the old task.
        this.invalidateLiveContext(false);
        this.lastChangeAt = now;
        this.latestChangeId = o.id;
      }
      // A negative match describes the earlier moment, not every future observation in this surface.
      if (!this.recognized && this.inflightTask !== 'process_match') this.recognizedFor = null;
    }
    if (changed || o.pendingAction !== null) this.pendingTeachCheck = true;
    if (o.pendingAction !== null) this.urgentTeachCheck = true;
    this.shareScreen(o, newScreen, now);
    // The workspace's own edits are not worth a bubble each: it is shown once, when Clipa first sees it or comes back to it.
    if (newScreen && (this.liveMode === 'learn' || this.liveMode === 'teach') && (!WORKSPACE_KINDS.has(o.kind) || firstFrame || moved)) {
      this.thought(`Looking at ${o.app ? `${o.app}: ` : ''}${o.surface}`);
    }
  }

  /**
   * The voice agent knows what Clipa sees: a new screen goes to it at once as a contextual update, the same screen again
   * at most every screenContextMs when its description changed. It is never spoken, and nothing goes off the record.
   */
  private shareScreen(o: SeenObservation, newScreen: boolean, now: number): void {
    if (this.liveMode === null) return;
    const text = `[screen] ${o.app ? `${o.app}: ` : ''}${o.surface}. ${o.summary}${o.pendingAction ? ` About to use: ${o.pendingAction}.` : ''}`.slice(0, 500);
    if (text === this.lastScreenContext) return;
    if (!newScreen && now - this.lastScreenContextAt < RULES.screenContextMs) return;
    this.lastScreenContext = text;
    this.lastScreenContextAt = now;
    this.emit({ type: 'context', text });
  }

  /** Invalidate only live decisions; a Review map may still be synthesizing in the background. */
  private invalidateLiveContext(clearProcess: boolean): void {
    this.contextRevision++;
    if (this.liveMode === 'learn' || this.liveMode === 'teach') {
      if (this.inflightTask === 'process_match') {
        this.recognizedFor = null;
        this.lastRecognitionAt = -Infinity;
      }
      this.inflight?.abort();
      this.inflight = null;
    }
    this.prefetch = null;
    this.pendingSay = null;
    this.questionContext = null;
    if ((this.liveMode === 'learn' || this.liveMode === 'teach') && (this.active?.type === 'ask' || this.active?.type === 'warn')) this.cancelActive();
    if (clearProcess) {
      if (this.recognized && this.liveMode === 'teach' && !this.offRecord) {
        this.emit({ type: 'context', text: '[map] The visible context changed. No current expert process is recognized. Do not apply earlier process rules; wait for a new recognized process.' });
      }
      this.recognized = null;
      this.recognizedFor = null;
      this.lastRecognitionAt = -Infinity;
      this.lastTeachCheckAt = -Infinity;
      this.pendingTeachCheck = false;
      this.urgentTeachCheck = false;
    }
  }

  private resetLiveContext(): void {
    this.invalidateLiveContext(true);
    this.baseline.reset();
    this.contextWhere = null;
    this.contextObservationIds.clear();
    this.contextTurns.length = 0;
    this.contextAskedTexts.length = 0;
    this.pendingChange = false;
    this.latestChangeId = null;
  }

  private onSession(mode: Mode, live: boolean, reason: string | null, client: ClientKind | null = null): void {
    if (live || this.liveMode === mode) {
      if (!(live && mode === 'review' && this.mapPrefetch)) {
        this.inflight?.abort();
        this.inflight = null;
      }
      this.resetLiveContext();
    }
    if (live) {
      this.liveMode = mode;
      this.selectedMode = mode;
      this.stageStartedAt = this.deps.now();
      this.nudgesInRow = 0;
      this.stageDone = false;
      this.quietEnd = false;
      this.proposal = null;
      this.advancedIn = null;
      this.liveClient = client;
      this.stageObservations = 0;
      this.answered = false;
      // A stage that starts (by Clipa's switch or the person's own Start) replaces whatever switch was still waiting.
      this.after = null;
      this.emit({ type: 'context', text: `[stage] Now in ${STAGE_NAMES[mode]}: ${STAGE_ABOUT[mode]}` });
      this.cancelActive();
      this.recognized = null;
      this.recognizedFor = null;
      this.pendingSay = null;
      // A new Show supersedes the map still being built from the last one (its end builds a map of everything again).
      if (mode === 'learn' && this.mapPrefetch) this.inflight?.abort();
      // On the web the screen is shared after Start: until it is, the next step is to share it.
      if ((mode === 'learn' || mode === 'teach') && !this.sharing && this.has('web')) this.guide('share_now', 'web');
      if (mode === 'learn') { this.pose('listen'); this.presence('dot'); if (this.sharing || !this.has('web')) this.guideOnce('work'); }
      if (mode === 'review') void this.startReview();
      if (mode === 'teach') this.startTeach();
      return;
    }
    if (this.liveMode !== mode) return;
    this.liveMode = null;
    this.liveClient = null;
    // The person ended it (a switch Clipa asked for was already taken before her end): a switch still waiting is dropped, so
    // no session and no microphone start by themselves after End.
    this.after = null;
    this.pendingThought = null;
    this.inflight?.abort();
    this.inflight = null;
    this.prefetch = null;
    this.pendingSay = null;
    this.proposal = null;
    this.cancelActive();
    if (reason === 'off_record') return;
    this.emit({ type: 'context', text: `[stage] ${STAGE_NAMES[mode]} has ended.` });
    // Clipa asked for this end herself (the next stage starts, or she switched off): no "open the next stage" line of its own.
    const quiet = this.quietEnd;
    this.quietEnd = false;
    if (mode === 'learn' && this.persona === 'expert') { if (!quiet) this.handOver('review', 'review'); if (RULES.mapAfterShow) this.prefetchMap(); }
    if (mode === 'teach' && !quiet) this.handOver('summary', 'summary');
    this.pose('idle');
  }

  private onTranscript(role: 'expert' | 'agent', text: string): void {
    const turn: Turn = { role, text: text.slice(0, 1000), atMs: this.sessionTime() };
    this.turns.push(turn);
    this.contextTurns.push(turn);
    if (this.contextTurns.length > RULES.keepTurns) this.contextTurns.splice(0, this.contextTurns.length - RULES.keepTurns);
    if (role === 'expert') {
      const current = this.baseline.current();
      const provenance = this.questionContext ?? {
        atMs: turn.atMs, appId: current.candidate?.appId ?? current.appId,
        profileId: current.candidate?.profileId ?? current.profileId,
        observationIds: [...current.evidence.observationIds], evidenceIds: [...current.evidence.evidenceIds], questionId: null,
      };
      this.baselineProvenance.turns.push({ ...provenance, atMs: turn.atMs });
      this.baselineProvenance.turns.splice(0, Math.max(0, this.baselineProvenance.turns.length - RULES.keepTurns));
      this.questionContext = null;
    }
    if (this.turns.length > RULES.keepTurns) this.turns.splice(0, this.turns.length - RULES.keepTurns);
    if (role !== 'expert') return;
    this.lastBusyAt = this.deps.now();
    this.lastPersonAt = this.lastBusyAt;
    this.nudgesInRow = 0;
    this.cancelAutoAfter();
    // A question or warning of Clipa's is open (or was just said): this turn is most likely the answer to it.
    const answering = this.active !== null && (this.active.type === 'ask' || this.active.type === 'warn') && this.lastBusyAt - this.active.at <= RULES.askTtlMs;
    // The person answered: whatever Clipa asked is done.
    if (this.active?.type === 'ask') this.answered = true;
    if (this.active) this.active.done = true;
    if (!this.languageFixed) {
      const lang = detectLanguage(this.turns.filter((t) => t.role === 'expert').map((t) => t.text));
      if (lang !== null) this.language = lang;
      else if (/^[\x20-\x7e]+$/.test(text) && text.length > 20) this.language = null;
    }
    // Short commands ("stop", "that's it", "yes") and "let's review", "teach me": a turn that does one of these is not an answer
    // or a map edit.
    if (this.voiceCommand(text)) return;
    // With no session a stage phrase near the start opens that tab. While one runs only a whole short command that moves
    // forward starts a stage: "Let me show you what I would do" in Pass it on, or a correction in Reflect, is an ordinary turn.
    const asked = !RULES.voiceStages ? null : this.liveMode === null ? stageAsked(text) : stageCommand(text);
    if (asked !== null && asked !== this.liveMode && this.webFace() && (this.liveMode === null || STAGE_ORDER[asked] > STAGE_ORDER[this.liveMode])) { this.voiceStage(asked); return; }
    if (this.doneCommand(text, answering)) return;
    if (this.liveMode !== 'review' || !this.review.map) return;
    if (this.review.awaiting === 'teachback') { void this.classifyReply(text); return; }
    if (this.review.awaiting === 'gap') {
      this.review.awaiting = null;
      this.review.gapIndex++;
      this.review.answeredAt = this.deps.now();
    }
    // Everything the expert says in Review can change the map: Clipa makes the edit, the expert only talks.
    this.voiceQueue.push(text);
    void this.drainVoice();
  }

  /**
   * While a session runs on the web, Clipa says a few words and then starts the stage the way Start does (the screen is asked
   * for as after Start). Otherwise the web opens the stage the way a click on its tab does, and Clipa confirms it.
   */
  private voiceStage(mode: Mode): void {
    if (this.webLive()) { this.sayThen(STAGE_START[mode], { kind: 'start', mode }); return; }
    this.emit({ type: 'stage', mode }, { for: 'web' });
    this.attention({ kind: 'ui', name: 'mode_tab', mode });
    this.emit({ type: 'say', text: STAGE_CONFIRM[mode] }, { for: 'web' });
  }

  /** "Stop" ends the session; "yes" takes a pending proposal. True when the turn was one of these. */
  private voiceCommand(text: string): boolean {
    if (!RULES.voiceControl || !this.webLive()) return false;
    if (offSaid(text)) {
      // Already switching off ("Stop." then "Bye."): the line is not said twice.
      if (this.after?.next.kind === 'end') return true;
      this.stageDone = true;
      this.quietEnd = true;
      this.proposal = null;
      this.cancelActive();
      this.windDown();
      this.sayThen(OFF_LINE, { kind: 'end', reason: 'off' });
      return true;
    }
    const proposal = this.proposal;
    if (proposal && this.deps.now() - proposal.at <= RULES.proposalTtlMs && yesSaid(text)) {
      this.sayThen(STAGE_START[proposal.mode], { kind: 'start', mode: proposal.mode });
      return true;
    }
    return false;
  }

  /** "That's it": Show hands over to Reflect, Pass it on ends with the summary. Reflect keeps its own confirm flow. */
  private doneCommand(text: string, answering: boolean): boolean {
    if (!RULES.voiceControl || this.stageDone || (this.liveMode !== 'learn' && this.liveMode !== 'teach') || !doneSaid(text)) return false;
    // An answer to Clipa's own question ("The finance lead, that's it.") does not end the stage; the bare phrase still does.
    if (answering && !donePhraseOnly(text)) return false;
    if (this.liveMode === 'learn') {
      if (this.persona !== 'expert') return false;
      this.stageDone = true;
      this.cancelActive();
      this.windDown();
      if (this.webLive()) this.sayThen(STAGE_START.review, { kind: 'start', mode: 'review' });
      // The macOS face: its Show finishes on the hand-over only once it is ending, so the hand-over (and the map) stay at its
      // End; Clipa says so and asks nothing more meanwhile.
      else this.emit({ type: 'say', text: MAC_DONE_LINE }, { for: 'macos' });
      return true;
    }
    if (!this.webLive()) return false;
    // Right after a warning, "done" is the fix being made, not the end of Pass it on.
    if (this.deps.now() - this.lastWarnAt <= RULES.doneAfterWarnMs) return false;
    this.stageDone = true;
    this.quietEnd = true;
    this.cancelActive();
    this.windDown();
    // Pass it on is done: the summary is said, then the session ends (Clipa goes off).
    this.afterLine(this.guide('summary', 'web'), { kind: 'end', reason: 'done' }, 0);
    return true;
  }

  /** Clipa says `text` on the web, then does `next` once it is said. */
  private sayThen(text: string, next: Next, delayMs = 0, auto = false): void {
    this.afterLine(this.emit({ type: 'say', text }, { for: 'web' }).cueId, next, delayMs, auto);
  }

  /** `next` follows the line `cueId` (when it is said, or after lineBeforeSwitchMs at the latest) after delayMs. */
  private afterLine(cueId: string | null, next: Next, delayMs: number, auto = false): void {
    this.proposal = null;
    this.after = { next, cueId, delayMs, dueAt: this.deps.now() + delayMs + (cueId === null ? 0 : RULES.lineBeforeSwitchMs), auto };
  }

  /** The person goes on (talks, types, the screen changes) or turns auto off: a switch Clipa decided on by herself is dropped. */
  private cancelAutoAfter(): void {
    if (!this.after?.auto) return;
    this.after = null;
    this.stageDone = false;
    this.advancedIn = null;
  }

  /** The stage is winding down (done or stop): a question being prepared or waiting to be said is dropped. */
  private windDown(): void {
    this.prefetch = null;
    this.pendingChange = false;
    this.pendingSay = null;
    if (this.liveMode === 'learn' || this.liveMode === 'teach') { this.inflight?.abort(); this.inflight = null; }
  }

  /** A web session is live: the web-only flow (stage starts, end, proposals) applies. */
  private webLive(): boolean { return this.liveMode !== null && this.liveClient === 'web'; }

  private goNext(next: Next): void {
    if (next.kind === 'propose') { this.propose(next.mode); return; }
    if (next.kind === 'open') {
      this.emit({ type: 'stage', mode: next.mode }, { for: 'web' });
      this.attention({ kind: 'ui', name: 'mode_tab', mode: next.mode });
      return;
    }
    // The web ends the running stage for this: its end says no "open the next stage" line of its own.
    this.quietEnd = true;
    if (next.kind === 'end') { this.emit({ type: 'end', reason: next.reason }, { for: 'web' }); return; }
    this.emit({ type: 'stage', mode: next.mode, start: true }, { for: 'web' });
    this.attention({ kind: 'ui', name: 'mode_tab', mode: next.mode });
  }

  /** Manual mode: Clipa proposes the next stage in one line; a yes (or a click) starts it. */
  private propose(mode: 'review' | 'teach'): void {
    this.proposal = { mode, at: this.deps.now() };
    this.emit({ type: 'say', text: PROPOSE[mode] }, { for: 'web' });
    this.attention({ kind: 'ui', name: 'mode_tab', mode });
  }

  /** A stage is complete: auto mode moves on (after `line`, or a line of its own), manual mode proposes. Once per stage. */
  private stageComplete(mode: 'review' | 'teach', line: string | null, lineCue: string | null = null, delayMs = 0): void {
    if (!RULES.autoAdvance || !this.webLive() || this.advancedIn === this.liveMode) return;
    this.advancedIn = this.liveMode;
    if (this.auto) {
      this.stageDone = true;
      // Pass it on is a new person's (often in another browser): Clipa opens its tab and leaves Start to them.
      const next: Next = mode === 'teach' ? { kind: 'open', mode } : { kind: 'start', mode };
      if (line !== null) this.sayThen(line, next, delayMs, true);
      else this.afterLine(lineCue, next, delayMs, true);
    } else if (lineCue !== null) this.afterLine(lineCue, { kind: 'propose', mode }, 0);
    else this.propose(mode);
  }

  /** Auto mode: Show is complete after a long quiet, once there was real work (screens or an answered question). */
  private tickShowDone(now: number): void {
    if (this.liveMode !== 'learn' || this.persona !== 'expert' || this.stageDone || this.after !== null || this.proposal !== null) return;
    if (this.personTalking || this.agentTalking || this.activity === 'typing') return;
    if ((this.active && !this.active.done) || this.pendingSay !== null || this.prefetch?.status === 'running') return;
    if (this.stageObservations < RULES.showIdleMinObservations && !this.answered) return;
    if (now - Math.max(this.lastBusyAt, this.lastPersonAt, this.lastChangeAt, this.lastActivityAt, this.stageStartedAt) < RULES.showIdleMs) return;
    this.stageComplete('review', SHOW_LOOKS_DONE);
  }

  private onUi(action: 'confirm' | 'correct' | 'answer_gap' | 'ask_about' | 'finish', targetId: string | null, text: string | null): void {
    const map = this.review.map;
    // A map from an earlier session or the demo map may be confirmed at once, before its open points: it is not news.
    const confirmable = this.review.phase === 'teachback' || (this.review.phase === 'gaps' && this.review.origin !== 'session');
    if (action === 'confirm' && map && confirmable) { this.confirmMap(); return; }
    if (action === 'correct' && map && text) { this.voiceQueue.push(text); void this.drainVoice(); return; }
    if (action === 'finish' && this.liveMode === 'review' && this.review.phase === 'gaps') { this.review.gapIndex = map?.gaps.length ?? 0; this.finishGaps(); return; }
    if (action === 'answer_gap' && map) {
      const index = map.gaps.findIndex((g, i) => `gap-${i + 1}` === targetId || g.targetId === targetId);
      if (index >= 0) { this.review.gapIndex = index; this.askGap(); }
      return;
    }
    if (action === 'ask_about' && map && targetId) {
      const step = map.steps.find((s) => s.id === targetId);
      const rule = map.guardrails.find((g) => g.id === targetId);
      const what = step ? `step ${step.id}: ${step.action}` : rule ? `rule ${rule.id}: when ${rule.condition}, ${rule.requiredAction}` : null;
      if (!what) return;
      this.emit({ type: 'context', text: `[map] The person selected ${what}. Ask them one short question about it; any change they ask for is applied by the app.` });
      const region = this.regionsFor((step ?? rule)?.evidenceIds ?? [], [])[0];
      if (region) this.emit({ type: 'point', target: { kind: 'region', ...region } });
      this.pose('listen');
    }
  }

  // ---- the clock -----------------------------------------------------------
  private paused(now: number): boolean {
    if (this.personTalking || this.agentTalking) return false;
    if (this.activity === 'typing' || this.activity === 'away') return false;
    return now - Math.max(this.lastBusyAt, this.lastChangeAt) >= RULES.pauseMs;
  }

  /** Called on every batch, every observation and by the hub's timer (every 200 ms). At most one new step per tick. */
  tick(): void {
    const now = this.deps.now();
    if (this.active && !this.active.done && this.active.expiresAt !== null && now > this.active.expiresAt) { this.cancelActive(); this.presence('dot'); }
    if (this.offRecord) return;
    if (this.proposal && now - this.proposal.at > RULES.proposalTtlMs) this.proposal = null;
    if (this.after && now >= this.after.dueAt && !this.personTalking) { const next = this.after.next; this.after = null; this.goNext(next); return; }
    this.flushThought();
    // Show or Pass it on is winding down (done, stop, a switch or a proposal waiting): Clipa asks and warns no more.
    const winding = (this.liveMode === 'learn' || this.liveMode === 'teach') && (this.stageDone || this.after !== null || this.proposal !== null);
    if (this.pendingSay && !winding && this.paused(now) && (!this.active || this.active.done)) { this.emit({ type: 'say', text: this.pendingSay }); this.pendingSay = null; return; }
    if (!winding && (this.liveMode === 'learn' || this.liveMode === 'teach') && this.inflight === null && this.shouldRecognize(now)) { void this.recognize(); return; }
    if (this.liveMode === 'learn' && !winding) this.tickLearn(now);
    if (this.inflight !== null) return;
    if (this.active && !this.active.done) return;
    if (this.liveMode === 'review') this.tickReview(now);
    else if (this.liveMode === 'teach' && !winding) this.tickTeach(now);
    if (this.inflight === null) { this.tickShowDone(now); this.tickNudge(now); }
  }

  /**
   * Show and Pass it on never go silent for long: when the person has not talked or typed for nudgeAfterMs, nothing else is
   * due and Clipa is not speaking, she says one gentle line. At most nudgeMaxInRow in a row; the person talking resets that.
   */
  private tickNudge(now: number): void {
    if (!RULES.nudges || (this.liveMode !== 'learn' && this.liveMode !== 'teach')) return;
    if (this.nudgesInRow >= RULES.nudgeMaxInRow) return;
    if (this.stageDone || this.proposal !== null || this.after !== null) return;
    if (this.personTalking || this.agentTalking || this.activity === 'typing' || this.activity === 'away') return;
    if ((this.active && !this.active.done) || this.pendingSay !== null || this.prefetch !== null) return;
    if (now - Math.max(this.lastPersonAt, this.lastSpokeAt, this.stageStartedAt) < RULES.nudgeAfterMs) return;
    this.nudgesInRow++;
    this.emit({ type: 'say', text: NUDGES[this.nudgeIndex++ % NUDGES.length]! });
  }

  private learnBudget(now: number): 'ok' | 'used' | 'soon' {
    while (this.askTimes.length && now - this.askTimes[0]! > RULES.learnWindowMs) this.askTimes.shift();
    if (this.askTimes.length >= RULES.learnMaxQuestions) return 'used';
    return now - this.lastAskAt < RULES.learnMinGapMs ? 'soon' : 'ok';
  }

  /**
   * Learn, tuned for reaction time: the question is prepared as soon as the screen settles after a change (while the
   * person may still be working), and said the moment a pause begins, if the screen it is about is still the latest.
   */
  private tickLearn(now: number): void {
    if (!this.pendingChange || this.latestChangeId === null) return;
    if (this.active && !this.active.done) return;
    const budget = this.learnBudget(now);
    if (budget === 'used') { this.quiet('question budget used up for now'); return; }
    const basis = this.latestChangeId;
    const ready = this.prefetch && this.prefetch.basis === basis && this.prefetch.status !== 'running' ? this.prefetch : null;
    if (ready && budget === 'ok' && this.paused(now)) { this.sayQuestion(ready); return; }
    const settled = now - this.lastChangeAt >= RULES.settleMs;
    const nearlyAllowed = now - this.lastAskAt >= RULES.learnMinGapMs - 10_000;
    if (settled && nearlyAllowed && this.inflight === null && (!this.prefetch || this.prefetch.basis !== basis)) void this.prepareQuestion(basis);
    else if (budget === 'soon' && this.paused(now)) this.quiet('asked recently');
  }

  private tickReview(now: number): void {
    const r = this.review;
    if (r.phase !== 'gaps' || r.awaiting !== null || this.voiceQueue.length) return;
    if (!this.paused(now) || now - r.answeredAt < RULES.gapAfterAnswerMs) return;
    if (!r.map || r.gapIndex >= Math.min(r.map.gaps.length, RULES.reviewMaxGaps)) { this.finishGaps(); return; }
    this.askGap();
  }

  /** The rules Teach checks: the recognised process's first, then the rest of what Clipa learned (at most 10). */
  private teachRules(): LearnedRule[] {
    const library = this.deps.maps.library(this.mapFrom);
    const first = this.recognized ? library.find((p) => p.key === this.recognized?.key) : undefined;
    // Baseline apps require a recognized current workflow; app identity alone is not expert knowledge.
    const ordered = this.baselinedSession ? (first ? [first] : []) : first ? [first, ...library.filter((p) => p !== first)] : library;
    return ordered.flatMap((p) => p.rules.map((r) => ({ ...r, condition: ordered.length > 1 ? `[${p.title}] ${r.condition}` : r.condition }))).slice(0, 10);
  }

  private tickTeach(now: number): void {
    const rules = this.teachRules();
    if (rules.length === 0) return;
    // About to commit (a pending action is visible): check fast, without waiting for a full pause.
    if (this.urgentTeachCheck && this.activity !== 'typing' && now - this.lastChangeAt >= RULES.urgentSettleMs && now - this.lastTeachCheckAt >= RULES.urgentCheckGapMs) {
      void this.checkGuardrails(rules);
      return;
    }
    if (this.pendingTeachCheck && this.paused(now) && now - this.lastTeachCheckAt >= RULES.teachCheckGapMs) void this.checkGuardrails(rules);
  }

  // ---- strategy: which learned process is this? ----------------------------
  /** Recognise once the screen shows something, and again when the person moves to another app or surface. */
  private shouldRecognize(now: number): boolean {
    if (!RULES.recognizeProcesses) return false;
    if (this.baselinedSession && this.baseline.current().status !== 'candidate') return false;
    const latest = [...this.observations].reverse().find((o) => o.kind !== 'input_activity' && this.contextObservationIds.has(o.id));
    if (!latest || now - this.lastChangeAt < RULES.settleMs) return false;
    if (placeOf(latest) === this.recognizedFor || now - this.lastRecognitionAt < 4000) return false;
    return this.deps.maps.library(this.mapFrom).length > 0;
  }

  /** process_match: silent on any failure or doubt (no line is said); a late answer for an ended stage is dropped. */
  private async recognize(): Promise<void> {
    const mode = this.liveMode;
    const revision = this.contextRevision;
    const library = this.deps.maps.library(this.mapFrom);
    const observations = this.genericObservations(6, true);
    const latest = [...this.observations].reverse().find((o) => o.kind !== 'input_activity' && this.contextObservationIds.has(o.id));
    if (!latest || library.length === 0 || observations.length === 0) return;
    this.recognizedFor = placeOf(latest);
    this.lastRecognitionAt = this.deps.now();
    this.pose('think');
    const out = await this.run<ProcessMatchOutput>('process_match', {
      processes: library.map((p) => ({ id: p.key, title: p.title.slice(0, 120), summary: p.summary.slice(0, 300), steps: p.steps.slice(0, 10).map((x) => x.slice(0, 300)), rules: p.rules.slice(0, 8).map((r) => `when ${r.condition}, ${r.requiredAction}`.slice(0, 400)) })),
      observations,
    });
    if (!this.offRecord && this.liveMode === mode) this.pose('listen');
    if (revision !== this.contextRevision || this.offRecord || this.liveMode !== mode || !out || out.processId === null || out.confidence < RULES.processConfidence) return;
    const match = library.find((p) => p.key === out.processId);
    if (!match || match.key === this.recognized?.key) return;
    this.recognized = match;
    this.thought(`This looks like ${match.title}`);
    if (this.liveMode === 'teach') {
      this.emit({ type: 'context', text: `[map] The expert's confirmed rules for ${match.title}: ${match.rules.map((g) => `when ${g.condition}, ${g.requiredAction}`).join('; ') || 'none'}. Do not state them unless the app asks.`.slice(0, 2000) });
    }
    this.pendingSay = this.liveMode === 'learn'
      ? `I know this one: ${match.title}. I will only ask about what is different.`
      : `This is ${match.title}. I will step in if one of the expert's rules applies.`;
    this.quiet(`recognised: ${match.title}`);
  }

  /** In Learn, a recognised process goes to the question task as context, so Clipa asks only about what differs. */
  private knownContext(): Turn[] {
    const p = this.recognized;
    if (!p) return [];
    const text = `[known process from an earlier session] ${p.title}. Steps: ${p.steps.join('; ')}. Rules: ${p.rules.map((r) => `when ${r.condition}, ${r.requiredAction}`).join('; ')}. Ask only about what is different from this.`;
    return [{ role: 'agent', text: text.slice(0, 1000), atMs: 0 }];
  }

  // ---- LLM steps -----------------------------------------------------------
  private async run<T>(task: string, body: unknown): Promise<T | null> {
    const controller = new AbortController();
    this.inflight = controller;
    this.inflightTask = task;
    try {
      const r = await this.deps.llm(task, body, controller.signal);
      if (controller.signal.aborted || !r.ok) return null;
      return r.output as T;
    } catch {
      // A thrown call is a failed call: the caller falls back, and nothing rejects into the void (a crash on a live server).
      return null;
    } finally {
      if (this.inflight === controller) { this.inflight = null; this.inflightTask = null; }
    }
  }

  private genericObservations(max: number, current = false): Array<Record<string, unknown>> {
    return this.observations.filter((o) => o.kind !== 'input_activity' && (!current || this.contextObservationIds.has(o.id))).slice(-max).map((o) => ({
      id: o.id, atMs: o.atMs, app: o.app, surface: o.surface.slice(0, 120), summary: o.summary.slice(0, 400), change: o.change, pendingAction: o.pendingAction,
      regions: o.regions.map((r) => ({ id: r.regionId, label: r.label })),
    }));
  }

  private transcript(max: number, cut = 1000, current = false): Turn[] {
    return (current ? this.contextTurns : this.turns).slice(-max).map((t) => ({ role: t.role, text: t.text.slice(0, cut), atMs: t.atMs }));
  }

  /** Regions by id, looked up in the named observations first and then in the newest ones. */
  private regionsFor(observationIds: readonly string[], regionIds: readonly string[], current = false): Region[] {
    const observations = this.observations.filter((o) => !current || this.contextObservationIds.has(o.id));
    const pool = [...observations.filter((o) => observationIds.includes(o.id)), ...[...observations].reverse()];
    if (regionIds.length === 0) {
      const named = pool.find((o) => observationIds.includes(o.id) && o.regions.length > 0);
      return named ? named.regions.slice(0, 1) : [];
    }
    const out: Region[] = [];
    for (const id of regionIds) {
      const hit = pool.find((o) => o.regions.some((r) => r.regionId === id));
      const region = hit?.regions.find((r) => r.regionId === id);
      if (region && !out.some((r) => r.regionId === id)) out.push(region);
    }
    return out;
  }

  private evidenceFor(observationIds: readonly string[]): string[] {
    return [...new Set(this.observations.filter((o) => observationIds.includes(o.id)).flatMap((o) => o.evidenceIds))].slice(0, 8);
  }

  private async prepareQuestion(basis: string): Promise<void> {
    const observations = this.genericObservations(8, true);
    if (observations.length === 0) { this.pendingChange = false; return; }
    const entry: Prefetch = { basis, status: 'running', out: null };
    this.prefetch = entry;
    this.pose('think');
    const latest = [...this.observations].reverse().find((o) => o.kind !== 'input_activity' && this.contextObservationIds.has(o.id));
    const change = latest?.change ?? null;
    this.thought(change ? `Hmm… ${change.charAt(0).toLowerCase()}${change.slice(1)}` : `Hmm… what happens on ${latest?.surface ?? 'this screen'}?`);
    const out = await this.run<GenericQuestionOutput>('generic_question', {
      observations, transcript: [...this.knownContext(), ...this.transcript(this.recognized ? 15 : 16, 1000, true)], baselineContext: baselinePromptContext(this.baseline.current()), asked: this.contextAskedTexts.slice(-20).map((a) => a.slice(0, 300)), language: this.language,
    });
    if (this.prefetch !== entry) return; // superseded or reset
    entry.status = out ? 'ready' : 'failed';
    entry.out = out;
    this.pose('listen');
    this.tick(); // say it now if the pause has already begun
  }

  private sayQuestion(entry: Prefetch): void {
    const now = this.deps.now();
    this.pendingChange = false;
    this.prefetch = null;
    let text: string | null = entry.out?.question ?? null;
    let topic = entry.out?.topic ?? 'reason';
    let obsIds = entry.out?.observationIds ?? [];
    let regionIds = entry.out?.regionIds ?? [];
    if (entry.status === 'failed') {
      // The route failed: a plain question about the latest change, if there is one.
      const latest = [...this.observations].reverse().find((o) => o.change !== null && this.contextObservationIds.has(o.id));
      if (latest) { text = `I saw: ${latest.change} What made you do that?`; topic = 'reason'; obsIds = [latest.id]; regionIds = []; }
    }
    if (text === null) { this.quiet('nothing on screen worth asking about yet'); return; }
    obsIds = obsIds.filter((id) => this.contextObservationIds.has(id));
    const regions = this.regionsFor(obsIds, regionIds, true);
    this.contextAskedTexts.push(text);
    if (this.contextAskedTexts.length > 20) this.contextAskedTexts.shift();
    this.askTimes.push(now);
    this.lastAskAt = now;
    this.presence('full', regions[0] ? 'target' : 'corner');
    if (regions[0]) {
      this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
      this.attention({ kind: 'region', ...regions[0] });
    }
    const questionId = `q${this.askTimes.length}-${this.seq + 1}`;
    const current = this.baseline.current();
    const scopedIds = obsIds.filter((id) => this.contextObservationIds.has(id));
    this.questionContext = {
      atMs: this.sessionTime(), appId: current.candidate?.appId ?? current.appId,
      profileId: current.candidate?.profileId ?? current.profileId,
      observationIds: scopedIds.length ? scopedIds : [...current.evidence.observationIds],
      evidenceIds: scopedIds.length ? this.evidenceFor(scopedIds) : [...current.evidence.evidenceIds], questionId,
    };
    this.emit({ type: 'ask', questionId, text, topic, regions, evidenceIds: this.evidenceFor(scopedIds) }, { ttlMs: RULES.askTtlMs });
  }

  /** As soon as Show ends, the map is built in the background, so Reflect opens with it ready. */
  // If it fails, Reflect builds the map itself as before; if it is slow, Reflect waits for it (a second build would only
  // queue behind it). A confirmed map stays as it is, as before.
  private prefetchMap(): void {
    const observations = this.genericObservations(40);
    if (observations.length === 0 || this.mapPrefetch || this.ownConfirmed()) return;
    const provenance = this.provenanceSnapshot();
    this.thought('Putting your map together…');
    this.mapPrefetch = (async () => {
      const map = await this.run<MapSynthesisOutput>('map_synthesis', { observations, transcript: this.transcript(60, 600), correction: null, previousTeachBack: null });
      if (map && !this.offRecord && !this.ownConfirmed()) {
        const built: ConductorMap = { ...map, baselineProvenance: provenance, comments: [] };
        this.review = { phase: 'idle', map: built, version: this.review.version, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false, origin: 'session' };
        this.freshMap = true;
        this.deps.maps.recordBuilt(this.sessionId, built, this.deps.now());
      }
    })().catch(() => undefined).finally(() => { this.mapPrefetch = null; });
  }

  private async startReview(): Promise<void> {
    if (this.mapPrefetch) {
      this.pose('think');
      this.guide('building', 'web');
      this.thought('Putting your map together…');
      await this.mapPrefetch;
      if (this.offRecord || this.liveMode !== 'review') return;
    }
    const observations = this.genericObservations(40);
    const turns = this.transcript(60, 600);
    const provenance = this.provenanceSnapshot();
    if (this.review.map && this.freshMap) {
      // Built in the background after Show: go straight to the open points.
      this.freshMap = false;
      const map = this.review.map;
      this.publishMap(map, false);
      this.pose('listen');
      if (map.gaps.length > 0) { this.review.phase = 'gaps'; this.guide('gaps', 'web'); }
      else this.readTeachBack();
      return;
    }
    // A fallback copy gives way as soon as the session has a screen of its own: its own map is built instead.
    const fallback = this.review.map !== null && this.review.origin !== 'session';
    if (this.review.map && !(fallback && observations.length > 0)) { this.publishMap(this.review.map, this.review.phase === 'confirmed', false); this.guide('talk_to_edit', 'web'); return; }
    if (observations.length === 0) { this.openFallbackMap(); return; }
    this.review = { phase: 'building', map: null, version: this.review.version, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false, origin: 'session' };
    this.pose('think');
    this.guide('building', 'web');
    this.thought('Putting your map together…');
    const map = await this.run<MapSynthesisOutput>('map_synthesis', { observations, transcript: turns, correction: null, previousTeachBack: null });
    if (this.offRecord || this.liveMode !== 'review') return;
    // The model could not build this session's map: Reflect still opens with one (the last built map or the demo map),
    // labelled, and the next Review tries this session's own map again.
    if (!map) { this.quiet('could not build this session\'s map; showing an earlier one'); this.openFallbackMap(); return; }
    this.publishMap({ ...map, baselineProvenance: provenance, comments: [] }, false);
    this.pose('listen');
    if (map.gaps.length > 0) { this.review.phase = 'gaps'; this.guide('gaps', 'web'); }
    else this.readTeachBack();
  }

  /**
   * Reflect always has a session to explore. Without a map of its own (no screen yet, or the model could not build one),
   * the session gets a copy of the last map
   * built in an earlier session (kept across restarts), else the synthetic demo map; the board labels where it comes from.
   * Edits change this session's copy only, and a confirmation registers it like any confirmed map, so Pass it on works.
   */
  private openFallbackMap(): void {
    const stored = this.deps.maps.lastBuilt();
    // The same session id: this session's own map, back after a restart.
    const origin: MapOrigin = stored === null ? 'demo' : stored.sessionId === this.sessionId ? 'session' : 'earlier';
    const source = stored === null ? demoMap() : structuredClone(stored.map);
    this.freshMap = false;
    this.review = { phase: 'gaps', map: null, version: this.review.version, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false, origin };
    this.publishMap({ ...source, processes: source.processes ?? [], comments: commentsOf(source), baselineProvenance: this.provenanceSnapshot() }, false);
    this.pose('listen');
    if (origin === 'demo') this.emit({ type: 'context', text: '[map] The map on the board is a synthetic demo map, not from this session: payment terms on an invoice email and a prepaid cost spread by quarter. Say so if asked; any change the person asks for is applied by the app.' });
    if (origin === 'earlier') this.emit({ type: 'context', text: '[map] The map on the board comes from an earlier session, not from this one. Any change the person asks for is applied by the app to this session\'s copy.' });
    this.guide(origin === 'demo' ? 'demo_map' : origin === 'earlier' ? 'earlier_map' : 'talk_to_edit', 'web');
  }

  /** This session confirmed a map of its own (a confirmed fallback copy does not stop its own map from being built). */
  private ownConfirmed(): boolean { return this.review.phase === 'confirmed' && this.review.origin === 'session'; }

  private provenanceSnapshot(): NonNullable<MapSynthesisOutput['baselineProvenance']> {
    return structuredClone(this.baselineProvenance);
  }

  private publishMap(map: ConductorMap, confirmed: boolean, bump = true): void {
    map = { ...map, baselineProvenance: map.baselineProvenance ?? this.provenanceSnapshot() };
    this.review.map = map;
    if (bump) this.review.version++;
    // A new or edited map of the session's own is the last built one; an earlier or demo copy is never stored as built.
    if (bump && this.review.origin === 'session') this.deps.maps.recordBuilt(this.sessionId, map, this.deps.now());
    this.emit({ type: 'map', version: this.review.version, map, confirmed, origin: this.review.origin });
  }

  private askGap(): void {
    const map = this.review.map;
    const gap = map?.gaps[this.review.gapIndex];
    if (!map || !gap) return;
    this.review.awaiting = 'gap';
    const regions = this.regionsFor(gap.evidenceIds, gap.regionIds);
    if (regions[0]) {
      this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
      this.attention({ kind: 'region', ...regions[0] });
    } else this.emit({ type: 'point', target: { kind: 'ui', name: 'board_gap' } });
    this.emit({ type: 'ask', questionId: `gap-${this.review.gapIndex + 1}`, text: gap.question, topic: 'gap', regions, evidenceIds: this.evidenceFor(gap.evidenceIds) });
  }

  /** After the gaps: rebuild the map when an answer could not be applied by voice, then read the teach-back. */
  private finishGaps(): void {
    // Rebuilding needs the session's own screen: a map without it (an earlier or demo copy) is read back as it is.
    if (this.review.editFailed && this.genericObservations(1).length > 0) { void this.resynthesize(null); return; }
    this.readTeachBack();
  }

  private async resynthesize(correction: string | null): Promise<void> {
    const previous = this.review.map?.teachBack ?? null;
    const provenance = this.provenanceSnapshot();
    const comments = this.review.map?.comments ?? [];
    this.review.phase = 'building';
    this.review.awaiting = null;
    this.pose('think');
    this.thought('Putting your map together…');
    const map = await this.run<MapSynthesisOutput>('map_synthesis', {
      observations: this.genericObservations(40), transcript: this.transcript(60, 600), correction: correction?.slice(0, 600) ?? null, previousTeachBack: previous?.slice(0, 3000) ?? null,
    });
    if (this.offRecord || this.liveMode !== 'review') return;
    this.review.editFailed = false;
    if (map) this.publishMap({ ...map, baselineProvenance: provenance, comments }, false);
    this.pose('listen');
    if (!this.review.map) { this.review.phase = 'idle'; return; }
    this.readTeachBack();
  }

  private readTeachBack(): void {
    const map = this.review.map;
    if (!map) return;
    this.review.phase = 'teachback';
    this.review.awaiting = 'teachback';
    this.review.unclearAsked = false;
    this.guideOnce('teachback');
    this.emit({ type: 'teachback', version: this.review.version, text: map.teachBack });
  }

  private async classifyReply(reply: string): Promise<void> {
    const map = this.review.map;
    if (!map) return;
    this.review.awaiting = null;
    const out = await this.run<ReplyOutput>('reply_classification', { teachBack: map.teachBack.slice(0, 4000), reply: reply.slice(0, 2000) });
    if (this.offRecord || this.liveMode !== 'review') return;
    if (out?.verdict === 'confirm') { this.confirmMap(); return; }
    if (out?.verdict === 'correct') {
      // The correction is applied by voice editing; the teach-back is read again afterwards.
      this.voiceQueue.push(reply);
      await this.drainVoice(true);
      return;
    }
    // Unclear (or the route failed): ask once in plain words, then wait for the buttons or another answer.
    this.review.awaiting = 'teachback';
    if (!this.review.unclearAsked) {
      this.review.unclearAsked = true;
      this.emit({ type: 'ask', questionId: `confirm-${this.review.version}`, text: 'Is that summary right, or what should I change?', topic: 'confirm', regions: [], evidenceIds: [] });
    }
  }

  /** Voice editing: each thing the expert says in Review goes through map_edit, one at a time, in order. */
  private async drainVoice(rereadTeachBack = false): Promise<void> {
    if (this.inflight !== null) return; // the running step drains the queue when it ends
    while (this.voiceQueue.length && this.review.map && this.liveMode === 'review' && !this.offRecord) {
      const utterance = this.voiceQueue.shift()!;
      const before = this.review.map;
      const out = await this.run<MapEditOutput>('map_edit', {
        map: { steps: before.steps, guardrails: before.guardrails, gaps: before.gaps, teachBack: before.teachBack }, utterance: utterance.slice(0, 1000),
        recent: this.transcript(8), language: this.language,
      });
      if (this.offRecord || this.liveMode !== 'review') return;
      if (!out) { this.review.editFailed = true; continue; }
      if (out.intent === 'confirm' && this.review.phase === 'teachback') { this.confirmMap(); continue; }
      if (out.intent === 'question' && out.reply) { this.emit({ type: 'say', text: out.reply }); continue; }
      if (out.intent !== 'edit') continue;
      const { map, applied } = applyEdits(before, out.operations, utterance, this.sessionTime());
      if (applied === 0) continue;
      const confirmed = this.review.phase === 'confirmed';
      this.publishMap({ ...map, baselineProvenance: this.provenanceSnapshot(), teachBack: out.teachBack ?? map.teachBack }, confirmed);
      if (confirmed && this.review.map) this.deps.maps.confirm(this.sessionId, this.review.map, this.deps.now()); // the expert's own words keep it confirmed
      if (out.reply) this.emit({ type: 'say', text: out.reply });
      if (rereadTeachBack && !confirmed) { this.readTeachBack(); rereadTeachBack = false; }
    }
  }

  private confirmMap(): void {
    const map = this.review.map;
    if (!map) return;
    this.review.phase = 'confirmed';
    this.review.awaiting = null;
    this.deps.maps.confirm(this.sessionId, map, this.deps.now());
    this.emit({ type: 'map', version: this.review.version, map, confirmed: true, origin: this.review.origin });
    this.pose('celebrate');
    const handoff = this.guide('handoff', 'web');
    // Reflect is complete: after the handoff line, Pass it on starts (auto) or is proposed (manual).
    if (this.liveMode === 'review') this.stageComplete('teach', null, handoff, RULES.afterHandoffMs);
  }

  private startTeach(): void {
    this.pose('listen');
    this.presence('dot');
    const library = this.deps.maps.library(this.mapFrom);
    if (library.length === 0) { this.guide('no_map'); return; }
    // Rule context is sent only after recognizing a current process; the library may span unrelated apps.
    this.guideOnce('work');
  }

  private async checkGuardrails(rules: LearnedRule[]): Promise<void> {
    const revision = this.contextRevision;
    this.pendingTeachCheck = false;
    this.urgentTeachCheck = false;
    this.lastTeachCheckAt = this.deps.now();
    const observations = this.genericObservations(6, true);
    if (observations.length === 0) return;
    const guardrails = rules.slice(0, 10).map((g) => ({
      id: g.id, condition: g.condition.slice(0, 300), requiredAction: g.requiredAction.slice(0, 300), reason: g.reason?.slice(0, 400) ?? null, quote: g.quote?.slice(0, 600) ?? null,
    }));
    // The rule as the expert put it, without the process name teachRules() puts in front.
    const first = guardrails[0]?.condition.replace(/^\[[^\]]*\]\s*/, '');
    if (first) this.thought(`Checking: ${first}…`);
    this.pose('think');
    const out = await this.run<GuardrailCheckOutput>('guardrail_check', { guardrails, observations, transcript: this.transcript(8, 1000, true), language: this.language });
    if (this.offRecord || this.liveMode !== 'teach') return;
    const current = revision === this.contextRevision;
    if (!(current && out?.status === 'warn' && out.guardrailId && out.message)) this.pose('listen');
    if (!current || !out) return;
    if (out.status === 'unknown' && out.message) { this.quiet(out.message); return; }
    if (out.status !== 'warn' || !out.guardrailId || !out.message) return;
    const latest = observations[observations.length - 1];
    const latestId = typeof latest?.id === 'string' ? latest.id : '';
    const key = `${out.guardrailId}:${latestId}`;
    if (this.warned.has(key)) { this.pose('listen'); return; }
    this.warned.add(key);
    const rule = rules.find((g) => g.id === out.guardrailId);
    const regions = this.regionsFor([latestId], out.regionIds, true);
    this.pose('warn');
    this.presence('full', regions[0] ? 'target' : 'corner');
    if (regions[0]) this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
    this.attention(regions[0] ? { kind: 'region', ...regions[0] } : null);
    this.lastWarnAt = this.deps.now();
    this.emit({ type: 'warn', guardrailId: out.guardrailId, text: out.message, regions, evidenceIds: rule?.evidenceIds ?? [] }, { ttlMs: RULES.warnTtlMs });
  }

  /** A snapshot for logs and tests: no transcript text. */
  status(): Record<string, unknown> {
    return {
      persona: this.persona, clients: this.kinds(), language: this.language, selectedMode: this.selectedMode, liveMode: this.liveMode, offRecord: this.offRecord,
      auto: this.auto, sharing: this.sharing, observations: this.observations.length, turns: this.turns.length, asked: this.askTimes.length, review: this.review.phase,
      mapVersion: this.review.version, cues: this.seq, busy: this.inflight !== null, baseline: this.baseline.current(),
    };
  }
}
