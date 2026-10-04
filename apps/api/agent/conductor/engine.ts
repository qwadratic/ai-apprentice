// The conductor of one session: it reads the clients' events and the screen, and decides what Clipa says and does.
// One conductor serves every face of the session: the web app (the whole journey) and the macOS app (a lighter face
// that hands over to the web). Pure apart from the injected clock, LLM call, id source and web link, so tests drive it
// with a fake clock and fake tasks.
import type { GenericQuestionOutput, GuardrailCheckOutput, MapEditOutput, MapSynthesisOutput, ProcessMatchOutput, ReplyOutput } from '../llm-tasks.ts';
import type { TaskResult } from '../llm.ts';
import { GUIDE, OPEN_WEB, detectLanguage } from './lines.ts';
import { applyEdits } from './map-edits.ts';
import type { ConductorMap } from './map-edits.ts';
import type { Activity, Audience, ClientEnvelope, ClientEvent, ClientKind, Cue, CueEnvelope, Mode, Persona, Presence, Region, SeenObservation } from './protocol.ts';

export const RULES = {
  /** Quiet this long after the last typing, talking or screen change is a pause. */
  pauseMs: 1800,
  /** The screen counts as settled this long after a change: the question is prepared from then on, ready for the pause. */
  settleMs: 500,
  /** Learn: at most this many questions per window, at least minGapMs apart. */
  learnMaxQuestions: 4,
  learnWindowMs: 10 * 60_000,
  learnMinGapMs: 15_000,
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
  /** A quiet cue with the same reason is not repeated sooner than this. */
  quietRepeatMs: 20_000,
  keepCues: 300,
  keepObservations: 200,
  keepTurns: 200,
} as const;

export interface ConfirmedMap { sessionId: string; map: MapSynthesisOutput; confirmedAt: number }

/** Confirmed maps, shared by all sessions of this server: Teach reads the expert's map. One team, one demo server. */
export class MapRegistry {
  private readonly bySession = new Map<string, ConfirmedMap>();
  private latest: ConfirmedMap | null = null;
  confirm(sessionId: string, map: MapSynthesisOutput, at: number): void {
    const entry = { sessionId, map, confirmedAt: at };
    this.bySession.set(sessionId, entry);
    this.latest = entry;
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
interface Source { client: ClientKind | null; lastSeq: number }
type ReviewPhase = 'idle' | 'building' | 'gaps' | 'teachback' | 'confirmed';
interface ActiveCue { cueId: string; type: Cue['type']; expiresAt: number | null; done: boolean }
interface Prefetch { basis: string; status: 'running' | 'ready' | 'failed'; out: GenericQuestionOutput | null }

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
  private pendingChange = false;
  private pendingTeachCheck = false;
  private urgentTeachCheck = false;
  private prefetch: Prefetch | null = null;
  private readonly askedTexts: string[] = [];
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

  private review: { phase: ReviewPhase; map: ConductorMap | null; version: number; gapIndex: number; awaiting: 'gap' | 'teachback' | null; answeredAt: number; unclearAsked: boolean; editFailed: boolean } =
    { phase: 'idle', map: null, version: 0, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false };
  private readonly voiceQueue: string[] = [];

  private readonly cues: CueEnvelope[] = [];
  private seq = 0;
  private active: ActiveCue | null = null;
  private readonly listeners = new Set<(cue: CueEnvelope) => void>();
  private inflight: AbortController | null = null;
  private lastQuiet: { reason: string; at: number } | null = null;
  private readonly guided = new Set<string>();
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
    if (cue.type === 'ask' || cue.type === 'warn' || cue.type === 'teachback') this.active = { cueId: env.cueId, type: cue.type, expiresAt: ttl === null ? null : now + ttl, done: false };
    for (const l of [...this.listeners]) l(env);
    return env;
  }

  private pose(clipa: Extract<Cue, { type: 'state' }>['clipa']): void { this.emit({ type: 'state', clipa }); }

  /** macOS only: how far Clipa comes out of the corner. */
  private presence(size: Presence, anchor: 'corner' | 'target' = 'corner'): void {
    if (this.has('macos')) this.emit({ type: 'presence', size, anchor }, { for: 'macos' });
  }

  /** Each face gets its own line for the step; a face with no line for it says nothing. */
  private guide(step: string, only?: ClientKind): void {
    this.guided.add(step);
    for (const kind of only ? [only] : this.kinds()) {
      const line = GUIDE[kind][this.persona][step];
      if (line) this.emit({ type: 'guide', step: line.step, phase: line.phase, text: line.text, target: line.target, speak: line.speak }, { for: kind });
    }
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
        if (e.client === 'web' && this.review.map) this.emit({ type: 'map', version: this.review.version, map: this.review.map, confirmed: this.review.phase === 'confirmed' }, { for: 'web' });
        return;
      case 'off_record':
        if (e.on === this.offRecord) return;
        this.offRecord = e.on;
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
        this.onSession(e.mode, e.live, e.reason);
        return;
      case 'activity':
        this.activity = e.state;
        if (e.state === 'typing') {
          this.lastBusyAt = now;
          // The person went back to work: a question or warning that has not been said yet is out of date.
          if (this.active && !this.active.done && (this.active.type === 'ask' || this.active.type === 'warn')) { this.cancelActive(); this.presence('dot'); }
        }
        return;
      case 'talking':
        if (e.by === 'person') this.personTalking = e.active; else this.agentTalking = e.active;
        this.lastBusyAt = now;
        if (e.by === 'agent') this.pose(e.active ? 'speak' : 'listen');
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
    const last = this.observations[this.observations.length - 1];
    this.observations.push(o);
    if (this.observations.length > RULES.keepObservations) this.observations.splice(0, this.observations.length - RULES.keepObservations);
    if (o.kind === 'input_activity') return;
    const changed = o.change !== null || last === undefined || last.summary !== o.summary || last.surface !== o.surface;
    if (changed) {
      this.pendingChange = true;
      this.lastChangeAt = now;
      this.latestChangeId = o.id;
      // A question being prepared for an older screen is out of date.
      if (this.prefetch?.status === 'running' && this.prefetch.basis !== o.id && this.liveMode === 'learn') this.inflight?.abort();
    }
    if (changed || o.pendingAction !== null) this.pendingTeachCheck = true;
    if (o.pendingAction !== null) this.urgentTeachCheck = true;
  }

  private onSession(mode: Mode, live: boolean, reason: string | null): void {
    if (live) {
      this.liveMode = mode;
      this.selectedMode = mode;
      this.cancelActive();
      this.recognized = null;
      this.recognizedFor = null;
      this.pendingSay = null;
      // On the web the screen is shared after Start: until it is, the next step is to share it.
      if ((mode === 'learn' || mode === 'teach') && !this.sharing && this.has('web')) this.guide('share_now', 'web');
      if (mode === 'learn') { this.pose('listen'); this.presence('dot'); if (this.sharing || !this.has('web')) this.guideOnce('work'); }
      if (mode === 'review') void this.startReview();
      if (mode === 'teach') this.startTeach();
      return;
    }
    if (this.liveMode !== mode) return;
    this.liveMode = null;
    this.inflight?.abort();
    this.inflight = null;
    this.prefetch = null;
    this.pendingSay = null;
    this.cancelActive();
    if (reason === 'off_record') return;
    if (mode === 'learn' && this.persona === 'expert') { this.handOver('review', 'review'); this.prefetchMap(); }
    if (mode === 'teach') this.handOver('summary', 'summary');
    this.pose('idle');
  }

  private onTranscript(role: 'expert' | 'agent', text: string): void {
    const turn: Turn = { role, text: text.slice(0, 1000), atMs: this.sessionTime() };
    this.turns.push(turn);
    if (this.turns.length > RULES.keepTurns) this.turns.splice(0, this.turns.length - RULES.keepTurns);
    if (role !== 'expert') return;
    this.lastBusyAt = this.deps.now();
    // The person answered: whatever Clipa asked is done.
    if (this.active) this.active.done = true;
    if (!this.languageFixed) {
      const lang = detectLanguage(this.turns.filter((t) => t.role === 'expert').map((t) => t.text));
      if (lang !== null) this.language = lang;
      else if (/^[\x20-\x7e]+$/.test(text) && text.length > 20) this.language = null;
    }
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

  private onUi(action: 'confirm' | 'correct' | 'answer_gap' | 'ask_about' | 'finish', targetId: string | null, text: string | null): void {
    const map = this.review.map;
    if (action === 'confirm' && map && this.review.phase === 'teachback') { this.confirmMap(); return; }
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
    if (this.pendingSay && this.paused(now) && (!this.active || this.active.done)) { this.emit({ type: 'say', text: this.pendingSay }); this.pendingSay = null; return; }
    if ((this.liveMode === 'learn' || this.liveMode === 'teach') && this.inflight === null && this.shouldRecognize(now)) { void this.recognize(); return; }
    if (this.liveMode === 'learn') this.tickLearn(now);
    if (this.inflight !== null) return;
    if (this.active && !this.active.done) return;
    if (this.liveMode === 'review') this.tickReview(now);
    else if (this.liveMode === 'teach') this.tickTeach(now);
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
    const ordered = first ? [first, ...library.filter((p) => p !== first)] : library;
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
    const latest = [...this.observations].reverse().find((o) => o.kind !== 'input_activity');
    if (!latest || now - this.lastChangeAt < RULES.settleMs) return false;
    const where = `${latest.app ?? ''}|${latest.surface}`;
    if (where === this.recognizedFor || now - this.lastRecognitionAt < 4000) return false;
    return this.deps.maps.library(this.mapFrom).length > 0;
  }

  /** process_match: silent on any failure or doubt (no line is said); a late answer for an ended stage is dropped. */
  private async recognize(): Promise<void> {
    const mode = this.liveMode;
    const library = this.deps.maps.library(this.mapFrom);
    const observations = this.genericObservations(6);
    const latest = [...this.observations].reverse().find((o) => o.kind !== 'input_activity');
    if (!latest || library.length === 0 || observations.length === 0) return;
    this.recognizedFor = `${latest.app ?? ''}|${latest.surface}`;
    this.lastRecognitionAt = this.deps.now();
    const out = await this.run<ProcessMatchOutput>('process_match', {
      processes: library.map((p) => ({ id: p.key, title: p.title.slice(0, 120), summary: p.summary.slice(0, 300), steps: p.steps.slice(0, 10).map((x) => x.slice(0, 300)), rules: p.rules.slice(0, 8).map((r) => `when ${r.condition}, ${r.requiredAction}`.slice(0, 400)) })),
      observations,
    });
    if (this.offRecord || this.liveMode !== mode || !out || out.processId === null || out.confidence < RULES.processConfidence) return;
    const match = library.find((p) => p.key === out.processId);
    if (!match || match.key === this.recognized?.key) return;
    this.recognized = match;
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
    try {
      const r = await this.deps.llm(task, body, controller.signal);
      if (controller.signal.aborted || !r.ok) return null;
      return r.output as T;
    } catch {
      // A thrown call is a failed call: the caller falls back, and nothing rejects into the void (a crash on a live server).
      return null;
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  private genericObservations(max: number): Array<Record<string, unknown>> {
    return this.observations.filter((o) => o.kind !== 'input_activity').slice(-max).map((o) => ({
      id: o.id, atMs: o.atMs, app: o.app, surface: o.surface.slice(0, 120), summary: o.summary.slice(0, 400), change: o.change, pendingAction: o.pendingAction,
      regions: o.regions.map((r) => ({ id: r.regionId, label: r.label })),
    }));
  }

  private transcript(max: number, cut = 1000): Turn[] {
    return this.turns.slice(-max).map((t) => ({ role: t.role, text: t.text.slice(0, cut), atMs: t.atMs }));
  }

  /** Regions by id, looked up in the named observations first and then in the newest ones. */
  private regionsFor(observationIds: readonly string[], regionIds: readonly string[]): Region[] {
    const pool = [...this.observations.filter((o) => observationIds.includes(o.id)), ...[...this.observations].reverse()];
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
    const observations = this.genericObservations(8);
    if (observations.length === 0) { this.pendingChange = false; return; }
    const entry: Prefetch = { basis, status: 'running', out: null };
    this.prefetch = entry;
    this.pose('think');
    const out = await this.run<GenericQuestionOutput>('generic_question', {
      observations, transcript: [...this.knownContext(), ...this.transcript(this.recognized ? 15 : 16)], asked: this.askedTexts.slice(-20).map((a) => a.slice(0, 300)), language: this.language,
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
      const latest = [...this.observations].reverse().find((o) => o.change !== null);
      if (latest) { text = `I saw: ${latest.change} What made you do that?`; topic = 'reason'; obsIds = [latest.id]; regionIds = []; }
    }
    if (text === null) { this.quiet('nothing on screen worth asking about yet'); return; }
    const regions = this.regionsFor(obsIds, regionIds);
    this.askedTexts.push(text);
    this.askTimes.push(now);
    this.lastAskAt = now;
    this.presence('full', regions[0] ? 'target' : 'corner');
    if (regions[0]) this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
    this.emit({ type: 'ask', questionId: `q${this.askTimes.length}-${this.seq + 1}`, text, topic, regions, evidenceIds: this.evidenceFor(obsIds) }, { ttlMs: RULES.askTtlMs });
  }

  /** As soon as Show ends, the map is built in the background, so Reflect opens with it ready. */
  // If it fails, Reflect builds the map itself as before; if it is slow, Reflect waits for it (a second build would only
  // queue behind it). A confirmed map stays as it is, as before.
  private prefetchMap(): void {
    const observations = this.genericObservations(40);
    if (observations.length === 0 || this.mapPrefetch || this.review.phase === 'confirmed') return;
    this.mapPrefetch = (async () => {
      const map = await this.run<MapSynthesisOutput>('map_synthesis', { observations, transcript: this.transcript(60, 600), correction: null, previousTeachBack: null });
      if (map && !this.offRecord && this.review.phase !== 'confirmed') {
        this.review = { phase: 'idle', map: { ...map, comments: [] }, version: this.review.version, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false };
        this.freshMap = true;
      }
    })().catch(() => undefined).finally(() => { this.mapPrefetch = null; });
  }

  private async startReview(): Promise<void> {
    if (this.mapPrefetch) {
      this.pose('think');
      this.guide('building', 'web');
      await this.mapPrefetch;
      if (this.offRecord || this.liveMode !== 'review') return;
    }
    const observations = this.genericObservations(40);
    const turns = this.transcript(60, 600);
    if (this.review.map && this.freshMap) {
      // Built in the background after Show: go straight to the open points.
      this.freshMap = false;
      const map = this.review.map;
      this.publishMap(map, false);
      if (map.gaps.length > 0) { this.review.phase = 'gaps'; this.guide('gaps', 'web'); }
      else this.readTeachBack();
      return;
    }
    if (this.review.map) { this.publishMap(this.review.map, this.review.phase === 'confirmed', false); this.guide('talk_to_edit', 'web'); return; }
    if (observations.length === 0) { this.guide('no_session_yet', 'web'); return; }
    this.review = { phase: 'building', map: null, version: this.review.version, gapIndex: 0, awaiting: null, answeredAt: 0, unclearAsked: false, editFailed: false };
    this.pose('think');
    this.guide('building', 'web');
    const map = await this.run<MapSynthesisOutput>('map_synthesis', { observations, transcript: turns, correction: null, previousTeachBack: null });
    if (this.offRecord || this.liveMode !== 'review') return;
    if (!map) { this.review.phase = 'idle'; this.quiet('could not build the map; try Review again'); this.pose('idle'); return; }
    this.publishMap({ ...map, comments: [] }, false);
    if (map.gaps.length > 0) { this.review.phase = 'gaps'; this.guide('gaps', 'web'); }
    else this.readTeachBack();
  }

  private publishMap(map: ConductorMap, confirmed: boolean, bump = true): void {
    this.review.map = map;
    if (bump) this.review.version++;
    this.emit({ type: 'map', version: this.review.version, map, confirmed });
  }

  private askGap(): void {
    const map = this.review.map;
    const gap = map?.gaps[this.review.gapIndex];
    if (!map || !gap) return;
    this.review.awaiting = 'gap';
    const regions = this.regionsFor(gap.evidenceIds, gap.regionIds);
    if (regions[0]) this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
    else this.emit({ type: 'point', target: { kind: 'ui', name: 'board_gap' } });
    this.emit({ type: 'ask', questionId: `gap-${this.review.gapIndex + 1}`, text: gap.question, topic: 'gap', regions, evidenceIds: this.evidenceFor(gap.evidenceIds) });
  }

  /** After the gaps: rebuild the map when an answer could not be applied by voice, then read the teach-back. */
  private finishGaps(): void {
    if (this.review.editFailed) { void this.resynthesize(null); return; }
    this.readTeachBack();
  }

  private async resynthesize(correction: string | null): Promise<void> {
    const previous = this.review.map?.teachBack ?? null;
    const comments = this.review.map?.comments ?? [];
    this.review.phase = 'building';
    this.review.awaiting = null;
    this.pose('think');
    const map = await this.run<MapSynthesisOutput>('map_synthesis', {
      observations: this.genericObservations(40), transcript: this.transcript(60, 600), correction: correction?.slice(0, 600) ?? null, previousTeachBack: previous?.slice(0, 3000) ?? null,
    });
    if (this.offRecord || this.liveMode !== 'review') return;
    this.review.editFailed = false;
    if (map) this.publishMap({ ...map, comments }, false);
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
      this.publishMap({ ...map, teachBack: out.teachBack ?? map.teachBack }, confirmed);
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
    this.emit({ type: 'map', version: this.review.version, map, confirmed: true });
    this.pose('celebrate');
    this.guide('handoff', 'web');
  }

  private startTeach(): void {
    this.pose('listen');
    this.presence('dot');
    const library = this.deps.maps.library(this.mapFrom);
    if (library.length === 0) { this.guide('no_map'); return; }
    this.emit({ type: 'context', text: `[map] The expert's confirmed rules: ${library.flatMap((p) => p.rules.map((g) => `[${p.title}] when ${g.condition}, ${g.requiredAction}`)).join('; ') || 'none'}. Do not state them unless the app asks.`.slice(0, 2000) });
    this.guideOnce('work');
  }

  private async checkGuardrails(rules: LearnedRule[]): Promise<void> {
    this.pendingTeachCheck = false;
    this.urgentTeachCheck = false;
    this.lastTeachCheckAt = this.deps.now();
    const observations = this.genericObservations(6);
    if (observations.length === 0) return;
    const guardrails = rules.slice(0, 10).map((g) => ({
      id: g.id, condition: g.condition.slice(0, 300), requiredAction: g.requiredAction.slice(0, 300), reason: g.reason?.slice(0, 400) ?? null, quote: g.quote?.slice(0, 600) ?? null,
    }));
    const out = await this.run<GuardrailCheckOutput>('guardrail_check', { guardrails, observations, transcript: this.transcript(8), language: this.language });
    if (this.offRecord || this.liveMode !== 'teach' || !out) return;
    if (out.status === 'unknown' && out.message) { this.quiet(out.message); return; }
    if (out.status !== 'warn' || !out.guardrailId || !out.message) return;
    const latest = observations[observations.length - 1];
    const latestId = typeof latest?.id === 'string' ? latest.id : '';
    const key = `${out.guardrailId}:${latestId}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const rule = rules.find((g) => g.id === out.guardrailId);
    const regions = this.regionsFor([latestId], out.regionIds);
    this.pose('warn');
    this.presence('full', regions[0] ? 'target' : 'corner');
    if (regions[0]) this.emit({ type: 'point', target: { kind: 'region', ...regions[0] } });
    this.emit({ type: 'warn', guardrailId: out.guardrailId, text: out.message, regions, evidenceIds: rule?.evidenceIds ?? [] }, { ttlMs: RULES.warnTtlMs });
  }

  /** A snapshot for logs and tests: no transcript text. */
  status(): Record<string, unknown> {
    return {
      persona: this.persona, clients: this.kinds(), language: this.language, selectedMode: this.selectedMode, liveMode: this.liveMode, offRecord: this.offRecord,
      sharing: this.sharing, observations: this.observations.length, turns: this.turns.length, asked: this.askTimes.length, review: this.review.phase,
      mapVersion: this.review.version, cues: this.seq, busy: this.inflight !== null,
    };
  }
}
