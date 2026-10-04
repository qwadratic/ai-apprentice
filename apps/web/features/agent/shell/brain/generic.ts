// The generic mode (TASK-3.37): the expert works in any app (a mail client, a spreadsheet) and shares the entire screen. Stream A's
// vision describes each frame as a `screen_activity` observation. Until that kind is in @apprentice/contracts it is guarded here
// with a local type, so this file compiles against today's contracts.
//
// Who decides what:
//   - WHEN (ours, deterministic): a natural pause after a meaningful change: the screen has not changed, nobody typed in this page and
//     the expert has not spoken for GENERIC_PAUSE_MS, and the agent is quiet. At most GENERIC_MAX_PER_WINDOW questions per
//     GENERIC_WINDOW_MS and at least GENERIC_GAP_MS apart.
//   - WHAT (the model): POST /api/agent/llm/generic_question writes the question about what is on screen. If the route fails, a template
//     asks about the change ("I saw: ... What made you do that?").
//   - Teach: POST /api/agent/llm/guardrail_check at a pause when an action is about to happen or the screen changed. On `warn` the
//     tutor says the message. It warns; it never blocks the person's app.
//   - Review: the map comes from POST /api/agent/llm/map_synthesis (shape pending): `synthesizeMap` is the seam; until then the notes
//     (question, answer, screen moment) are the draft steps.
import type { ScreenObservation } from '@apprentice/contracts';
import type { BrainDecision, BrainSignals, DraftStep, GuardrailRef } from './types.ts';

export interface ScreenRegion {
  id: string;
  label: string;
  /** x, y, width, height as fractions (0..1) of the frame. */
  box: [number, number, number, number];
}

export interface ScreenActivityFacts {
  app: string | null;
  surface: string;
  summary: string;
  change: string | null;
  entities: string[];
  pendingAction: string | null;
  pendingRegionId?: string | null;
  regions: ScreenRegion[];
}

/** The 4th observation kind stream A is adding. Local until it is in the contracts. */
export interface ScreenActivityObservation {
  schemaVersion: 1;
  kind: 'screen_activity';
  id: string;
  sessionId: string;
  sequence: number;
  timestampMs: number;
  source: 'vision' | 'workspace';
  frameId: string | null;
  sourceRevision: string | null;
  entityRef: string | null;
  evidenceIds: string[];
  facts: ScreenActivityFacts;
}

export type AnyObservation = ScreenObservation | ScreenActivityObservation;

export function isScreenActivity(o: { kind: string }): o is ScreenActivityObservation {
  if (o.kind !== 'screen_activity') return false;
  const f = (o as { facts?: unknown }).facts as Partial<ScreenActivityFacts> | undefined;
  return f !== undefined && f !== null && typeof f.summary === 'string' && typeof f.surface === 'string';
}

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

/** "[screen] {app} · {surface}: {summary}. Changed: {change}. About to: {pendingAction}" (empty parts left out). */
export function screenActivityLine(f: ScreenActivityFacts): string {
  const where = [clean(f.app), clean(f.surface)].filter((x) => x !== '').join(' · ');
  const parts = [`${where === '' ? 'Screen' : where}: ${clean(f.summary) || 'nothing readable'}.`];
  if (clean(f.change) !== '') parts.push(`Changed: ${clean(f.change)}.`);
  if (clean(f.pendingAction) !== '') parts.push(`About to: ${clean(f.pendingAction)}.`);
  return `[screen] ${parts.join(' ')}`;
}

/** A short line for the observation list. */
export function screenActivitySummary(f: ScreenActivityFacts): string {
  const where = [clean(f.app), clean(f.surface)].filter((x) => x !== '').join(' · ');
  return `${where === '' ? 'Screen' : where}: ${clean(f.summary)}${f.change ? ` · changed: ${clean(f.change)}` : ''}`;
}

/** The expert's language from their last turns: Cyrillic -> ru, German letters or words -> de, other Latin text -> en; null when unknown. */
export function detectLanguage(texts: readonly string[]): string | null {
  const text = texts.slice(-4).join(' ');
  if (text.trim() === '') return null;
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  if (cyr > 0 && cyr >= lat / 2) return /[іїєґ]/i.test(text) ? 'uk' : 'ru';
  if (lat === 0) return null;
  if (/[äöüß]/i.test(text) || /\b(und|ich|nicht|weil|das|ist|der|die|wir|kunde)\b/i.test(text)) return 'de';
  if (/[àâçéèêëîïôûùœ]/i.test(text) || /\b(je|est|pas|parce|nous|vous)\b/i.test(text)) return 'fr';
  if (/[ñ¿¡]/i.test(text) || /\b(porque|el|los|que|una)\b/i.test(text)) return 'es';
  return 'en';
}

export const GENERIC_TOPICS = ['reason', 'limit', 'exception', 'stop_and_ask', 'scope'] as const;
export type GenericTopic = (typeof GENERIC_TOPICS)[number];

/** Posts one LLM task of the session (same token flow as the other llm tasks). Throws when the route fails. */
export type GenericPost = (task: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;

export const GENERIC_PAUSE_MS = 2500;
export const GENERIC_GAP_MS = 45_000;
export const GENERIC_MAX_PER_WINDOW = 4;
export const GENERIC_WINDOW_MS = 600_000;
/** A check in Teach is not repeated for the same screen within this long. */
const TEACH_RECHECK_MS = 15_000;
const KEEP_OBS = 40;
const KEEP_TURNS = 40;

export interface GenericTurn {
  role: 'expert' | 'agent';
  text: string;
  atMs: number;
}

/** What the expert said about a screen moment: the raw material of the generic Work Map. */
export interface GenericNote {
  id: string;
  question: string;
  answer: string;
  topic: GenericTopic;
  observationIds: string[];
  evidenceIds: string[];
  regions: ScreenRegion[];
  app: string | null;
  surface: string;
  change: string | null;
  summary: string;
  atMs: number;
}

export interface GenericGuardrail {
  id: string;
  condition: string;
  requiredAction: string;
  reason: string;
  quote: string;
  evidenceIds: string[];
}

interface OpenGeneric {
  questionId: string;
  question: string;
  topic: GenericTopic;
  observationIds: string[];
  evidenceIds: string[];
  regions: ScreenRegion[];
  obs: ScreenActivityObservation | null;
}

export interface GenericResult {
  /** Decisions ready for the shell (the LLM answers arrive between ticks). */
  decisions: BrainDecision[];
}

const asTopic = (v: unknown): GenericTopic => (GENERIC_TOPICS.includes(v as GenericTopic) ? (v as GenericTopic) : 'reason');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function obsForModel(o: ScreenActivityObservation): Record<string, unknown> {
  const f = o.facts;
  return {
    id: o.id, atMs: Math.max(0, Math.round(o.timestampMs)), app: f.app, surface: f.surface, summary: f.summary, change: f.change,
    pendingAction: f.pendingAction, regions: f.regions.map((r) => ({ id: r.id, label: r.label })),
  };
}

const turnForModel = (t: GenericTurn): Record<string, unknown> => ({ role: t.role, text: t.text, atMs: Math.max(0, Math.round(t.atMs)) });

// ---- the generic Work Map (map_synthesis output) ------------------------------------------------------------------------------

export interface GenericMapDecision { summary: string; reason: string | null; quote: string | null; quoteAtMs: number | null }
export interface GenericMapStep { id: string; kind: 'action' | 'judgment'; goal: string; action: string; decision: GenericMapDecision | null; evidenceIds: string[] }
export interface GenericMapRule {
  id: string; condition: string; requiredAction: string; reason: string | null; quote: string | null; quoteAtMs: number | null;
  escalateTo: string | null; exceptions: string[]; evidenceIds: string[];
}
export interface GenericMapGap { question: string; targetId: string | null; evidenceIds: string[]; regionIds: string[] }
export interface GenericMap {
  steps: GenericMapStep[];
  guardrails: GenericMapRule[];
  gaps: GenericMapGap[];
  teachBack: string;
  version: number;
  confirmed: boolean;
}

function parseMap(raw: unknown, version: number): GenericMap | null {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object' || !Array.isArray(r['steps']) || !Array.isArray(r['guardrails']) || typeof r['teachBack'] !== 'string') return null;
  return {
    steps: r['steps'] as GenericMapStep[],
    guardrails: r['guardrails'] as GenericMapRule[],
    gaps: Array.isArray(r['gaps']) ? (r['gaps'] as GenericMapGap[]) : [],
    teachBack: r['teachBack'],
    version,
    confirmed: false,
  };
}

/** The generic map as the shell's draft map (steps with the expert's words and screen moments, guardrails). */
/** What the shell state carries for the Review board: the map_synthesis output as is, its version and the Learn observations. */
export interface GenericShellState {
  map: { steps: GenericMapStep[]; guardrails: GenericMapRule[]; gaps: GenericMapGap[]; teachBack: string } | null;
  version: number;
  confirmed: boolean;
  /** The observations the map was built from, in the shape the model saw (id, atMs, app, surface, summary, change, ...). */
  observations: Array<{ id: string; atMs: number; app: string | null; surface: string; summary: string; change: string | null; pendingAction: string | null; regions: ScreenRegion[]; evidenceIds: string[] }>;
  phase: string | null;
  note: string | null;
}

export function genericDraft(map: GenericMap, atOf: (evidenceIds: readonly string[]) => number | null): { steps: DraftStep[]; guardrails: GuardrailRef[] } {
  const guardrails: GuardrailRef[] = map.guardrails.map((g) => ({
    id: g.id,
    text: `${g.condition}: ${g.requiredAction}${g.escalateTo ? ` (ask ${g.escalateTo})` : ''}${g.exceptions.length ? `. Except: ${g.exceptions.join('; ')}` : ''}${g.reason ? `. Why: ${g.reason}` : ''}${g.quote ? `. The expert: "${g.quote}"` : ''}`,
    evidenceIds: [...g.evidenceIds],
  }));
  const steps: DraftStep[] = map.steps.map((st) => ({
    id: st.id,
    title: st.goal,
    kind: st.kind === 'judgment' ? 'judgment' : 'step',
    decision: st.decision?.summary ?? st.action,
    reason: st.decision?.reason ? `${st.decision.reason}${st.decision.quote ? ` ("${st.decision.quote}")` : ''}` : null,
    guardrails: [],
    evidenceIds: [...st.evidenceIds],
    atMs: st.decision?.quoteAtMs ?? atOf(st.evidenceIds),
  }));
  return { steps, guardrails };
}

/** Learn and Teach in generic mode. One instance per brain; `begin` resets the per-session parts, notes survive into Teach. */
export class GenericMind {
  private readonly log: (line: string) => void;
  private mode: 'learn' | 'review' | 'teach' = 'learn';
  private obs: ScreenActivityObservation[] = [];
  private turns: GenericTurn[] = [];
  private asked: string[] = [];
  private askedAtMs: number[] = [];
  private lastChangeAtMs = Number.NEGATIVE_INFINITY;
  private lastSeenKey = '';
  /** The latest meaningful change nobody asked about yet. */
  private pendingChange: ScreenActivityObservation | null = null;
  private lastExpertAtMs = Number.NEGATIVE_INFINITY;
  private inflight: AbortController | null = null;
  private ready: BrainDecision[] = [];
  private open: OpenGeneric | null = null;
  private seq = 0;
  private lastCheckKey = '';
  private lastCheckAtMs = Number.NEGATIVE_INFINITY;
  notes: GenericNote[] = [];
  /** Guardrails from the map synthesis (Review), when that route exists; until then they are derived from the notes. */
  synthesized: GenericGuardrail[] | null = null;
  /** What the last Learn saw and heard: the input of map_synthesis (Review adds the gap answers to the transcript). */
  private learnObs: ScreenActivityObservation[] = [];
  private learnTurns: GenericTurn[] = [];
  /** The generic Work Map from map_synthesis; `confirmed` once the expert confirmed its teach-back. */
  map: GenericMap | null = null;
  private review: {
    phase: 'synth' | 'gaps' | 'teachback' | 'classify' | 'done' | 'failed';
    queue: GenericMapGap[];
    askedGaps: number;
    unclear: number;
    lastAnswerAtMs: number;
    note: string | null;
  } | null = null;
  /** Something the screen should reload (the map, the gaps, the teach-back) changed since the shell last asked. */
  dirty = false;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  /** True once this session saw a screen_activity observation (Review: once the last Learn did): the generic path drives it. */
  get active(): boolean {
    return this.mode === 'review' ? this.learnObs.length > 0 : this.obs.length > 0;
  }

  /** The guardrails Teach may apply: only those of a confirmed map. */
  confirmedGuardrails(): GenericMapRule[] {
    return this.map !== null && this.map.confirmed ? this.map.guardrails : [];
  }

  /** For the Review view: the gaps still to ask, the teach-back, and whether it waits for an answer. */
  reviewView(): { gaps: GenericMapGap[]; teachBack: string | null; note: string | null; phase: string | null } {
    const r = this.review;
    return {
      gaps: r?.queue ?? [],
      teachBack: r !== null && (r.phase === 'teachback' || r.phase === 'classify' || r.phase === 'done') ? this.map?.teachBack ?? null : null,
      note: r?.note ?? null,
      phase: r?.phase ?? null,
    };
  }

  get hasOpenQuestion(): boolean {
    return this.open !== null;
  }

  begin(mode: 'learn' | 'review' | 'teach'): void {
    this.cancel();
    // The Learn that just ended is the material of Review (and of a later map synthesis).
    if (this.mode === 'learn' && this.obs.length > 0) { this.learnObs = [...this.obs]; this.learnTurns = [...this.turns]; }
    this.mode = mode;
    this.review = mode === 'review' && this.learnObs.length > 0
      ? { phase: 'synth', queue: [], askedGaps: 0, unclear: 0, lastAnswerAtMs: Number.NEGATIVE_INFINITY, note: 'Building the Work Map from the Learn session...' }
      : null;
    this.obs = [];
    this.turns = [];
    this.asked = [];
    this.askedAtMs = [];
    this.lastChangeAtMs = Number.NEGATIVE_INFINITY;
    this.lastSeenKey = '';
    this.pendingChange = null;
    this.lastExpertAtMs = Number.NEGATIVE_INFINITY;
    this.ready = [];
    this.open = null;
    this.lastCheckKey = '';
    this.lastCheckAtMs = Number.NEGATIVE_INFINITY;
    if (mode === 'learn') { this.notes = []; this.synthesized = null; this.learnObs = []; this.learnTurns = []; this.map = null; }
    this.dirty = true;
  }

  /** Off the record or the end of a session: the model call in flight is cut off. */
  cancel(): void {
    this.inflight?.abort();
    this.inflight = null;
  }

  observe(o: ScreenActivityObservation): void {
    this.obs.push(o);
    if (this.obs.length > KEEP_OBS) this.obs.shift();
    const f = o.facts;
    const key = `${clean(f.app)}|${clean(f.surface)}|${clean(f.summary)}|${clean(f.change)}|${clean(f.pendingAction)}`;
    if (key === this.lastSeenKey) return;
    this.lastSeenKey = key;
    this.lastChangeAtMs = o.timestampMs;
    if (clean(f.change) !== '') this.pendingChange = o;
  }

  onTranscript(role: 'user' | 'agent', text: string, atMs: number): void {
    const t = text.trim();
    if (t === '') return;
    const turn: GenericTurn = { role: role === 'user' ? 'expert' : 'agent', text: t, atMs };
    this.turns.push(turn);
    if (this.turns.length > KEEP_TURNS) this.turns.shift();
    // Review answers join the Learn transcript: the next map synthesis reads them.
    if (this.mode === 'review' && this.review !== null) {
      this.learnTurns.push(turn);
      if (this.learnTurns.length > 60) this.learnTurns.shift();
    }
    if (role === 'user') this.lastExpertAtMs = atMs;
  }

  language(): string | null {
    const mine = this.turns.filter((t) => t.role === 'expert').map((t) => t.text);
    return detectLanguage(mine.length > 0 ? mine : this.learnTurns.filter((t) => t.role === 'expert').map((t) => t.text));
  }

  /** The when-gate: why it is not a natural pause right now, or null when it is. */
  private notPause(nowMs: number, s: BrainSignals | undefined): string | null {
    if (s !== undefined) {
      if (!s.voiceConnected) return 'the voice is not connected';
      if (s.agentSpeaking) return 'the agent is speaking';
      if (s.humanSpeaking) return 'the expert is speaking';
      if (s.lastInputAtMs !== undefined && s.lastInputAtMs !== null && nowMs - s.lastInputAtMs < GENERIC_PAUSE_MS) return 'the expert is typing';
    }
    if (nowMs - this.lastExpertAtMs < GENERIC_PAUSE_MS) return 'the expert just spoke';
    if (nowMs - this.lastChangeAtMs < GENERIC_PAUSE_MS) return 'the screen is still changing';
    return null;
  }

  private budget(nowMs: number): string | null {
    const recent = this.askedAtMs.filter((t) => nowMs - t < GENERIC_WINDOW_MS);
    if (recent.length >= GENERIC_MAX_PER_WINDOW) return `${GENERIC_MAX_PER_WINDOW} questions in the last 10 minutes`;
    const last = this.askedAtMs[this.askedAtMs.length - 1];
    if (last !== undefined && nowMs - last < GENERIC_GAP_MS) return `the last question was ${Math.round((nowMs - last) / 1000)} s ago`;
    return null;
  }

  tick(nowMs: number, signals: BrainSignals | undefined, post: GenericPost | null): BrainDecision[] {
    const out = this.ready.splice(0);
    if (signals?.offRecord) { this.cancel(); return out; }
    if (this.inflight !== null || this.open !== null) return out;
    if (this.mode === 'learn') this.learnTick(nowMs, signals, post);
    else if (this.mode === 'teach') this.teachTick(nowMs, signals, post);
    else this.reviewTick(nowMs, signals, post);
    return out;
  }

  // ---- Review: map_synthesis, the gaps, the teach-back, reply_classification ----------------------------------------------------

  private synthesize(post: GenericPost, correction: string | null, then: 'gaps' | 'teachback'): void {
    const r = this.review;
    if (r === null) return;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const previous = this.map;
    const body = {
      observations: this.learnObs.slice(-40).map(obsForModel),
      transcript: this.learnTurns.slice(-60).map(turnForModel),
      correction,
      previousTeachBack: correction !== null ? previous?.teachBack ?? null : null,
    };
    r.note = correction !== null ? 'Rebuilding the Work Map with the correction...' : 'Building the Work Map...';
    this.dirty = true;
    void post('map_synthesis', body, ctrl.signal).then((raw) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      const map = parseMap(raw, (previous?.version ?? 0) + 1);
      if (map === null) throw new Error('the map was not readable');
      this.map = map;
      this.synthesized = map.guardrails.map((g) => ({
        id: g.id, condition: g.condition, requiredAction: g.requiredAction, reason: g.reason ?? '', quote: g.quote ?? '', evidenceIds: g.evidenceIds,
      }));
      r.queue = then === 'gaps' ? [...map.gaps] : [];
      r.phase = r.queue.length > 0 ? 'gaps' : 'teachback';
      r.note = null;
      this.dirty = true;
      this.log(`map_synthesis: ${map.steps.length} steps, ${map.guardrails.length} guardrails, ${map.gaps.length} gaps (version ${map.version}).`);
    }).catch((e: unknown) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      r.phase = 'failed';
      r.note = `The Work Map could not be built (${e instanceof Error ? e.message : String(e)}). End Review and start it again to retry.`;
      this.dirty = true;
      this.ready.push({ decision: 'SKIP', topic: 'map_synthesis', kind: 'unknown', evidenceIds: [], whyNow: r.note });
    });
  }

  private reviewTick(nowMs: number, signals: BrainSignals | undefined, post: GenericPost | null): void {
    const r = this.review;
    if (r === null) return;
    if (post === null) {
      if (r.phase !== 'failed') {
        r.phase = 'failed';
        r.note = 'This session has no model route, so the generic Work Map cannot be built.';
        this.dirty = true;
      }
      return;
    }
    if (r.phase === 'synth') { this.synthesize(post, null, 'gaps'); return; }
    if (r.phase !== 'gaps' && r.phase !== 'teachback') return;
    if (signals !== undefined && (!signals.voiceConnected || signals.agentSpeaking || signals.humanSpeaking)) return;
    if (nowMs - r.lastAnswerAtMs < 1500) return;
    if (r.phase === 'gaps') {
      const gap = r.queue[0];
      if (gap === undefined) { this.synthesize(post, null, 'teachback'); return; }
      const questionId = `gr-${++this.seq}`;
      const regions = this.regionsOf(gap.regionIds, this.learnObs);
      this.open = { questionId, question: gap.question, topic: 'reason', observationIds: gap.evidenceIds, evidenceIds: gap.evidenceIds, regions, obs: null };
      this.ready.push({
        decision: 'ASK_NOW', questionId, topic: 'gap', kind: 'gap', evidenceIds: [...gap.evidenceIds], expectsAnswer: true,
        whyNow: `The Work Map has an open gap (${r.askedGaps + 1}).`, utterance: { text: gap.question }, clipa: { state: 'speaking' }, regions,
      });
      return;
    }
    const map = this.map;
    if (map === null) return;
    const questionId = `gt-${++this.seq}`;
    this.open = { questionId, question: map.teachBack, topic: 'scope', observationIds: [], evidenceIds: [], regions: [], obs: null };
    this.ready.push({
      decision: 'ASK_NOW', questionId, topic: 'teach_back', kind: 'teach_back', evidenceIds: [], expectsAnswer: true,
      whyNow: `No gap is left: playing back version ${map.version} for the expert to confirm or correct.`, utterance: { text: map.teachBack }, clipa: { state: 'speaking' },
    });
  }

  /** A Review answer: a gap answer moves to the next gap; a teach-back reply is classified (confirm, correct, unclear). */
  private reviewAnswer(open: OpenGeneric, text: string, atMs: number, post: GenericPost | null): void {
    const r = this.review;
    if (r === null) return;
    r.lastAnswerAtMs = atMs;
    if (open.questionId.startsWith('gr-')) {
      r.queue.shift();
      r.askedGaps += 1;
      this.dirty = true;
      return;
    }
    const map = this.map;
    if (map === null || post === null) return;
    r.phase = 'classify';
    this.dirty = true;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    void post('reply_classification', { teachBack: map.teachBack, reply: text }, ctrl.signal).then((raw) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      const out = (raw ?? {}) as { verdict?: unknown; correction?: unknown };
      this.applyVerdict(out.verdict === 'confirm' || out.verdict === 'correct' ? out.verdict : 'unclear', typeof out.correction === 'string' ? out.correction : null, post);
    }).catch((e: unknown) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      this.log(`reply_classification failed (${e instanceof Error ? e.message : String(e)}): the buttons decide.`);
      this.applyVerdict('unclear', null, post);
    });
  }

  private applyVerdict(verdict: 'confirm' | 'correct' | 'unclear', correction: string | null, post: GenericPost | null): void {
    const r = this.review;
    const map = this.map;
    if (r === null || map === null) return;
    this.dirty = true;
    if (verdict === 'confirm') {
      map.confirmed = true;
      r.phase = 'done';
      r.note = `Work Map version ${map.version} is confirmed. Teach applies its guardrails.`;
      this.ready.push({ decision: 'ASK_NOW', topic: 'closing', kind: 'closing', evidenceIds: [], expectsAnswer: false, whyNow: 'The expert confirmed the teach-back.', utterance: { text: 'Thank you. The map is confirmed.' } });
      return;
    }
    if (verdict === 'correct' && correction !== null && post !== null) {
      r.phase = 'synth';
      this.synthesize(post, correction, 'teachback');
      return;
    }
    r.unclear += 1;
    r.phase = r.unclear >= 2 ? 'done' : 'teachback';
    r.note = r.unclear >= 2 ? 'The reply was not clear twice: use Confirm or Correct.' : null;
  }

  /** The Review buttons. Confirm confirms the version on screen; a typed correction rebuilds the map. */
  pressReview(kind: 'confirm' | 'correct' | 'skip', text: string, post: GenericPost | null): boolean {
    if (this.review === null || this.map === null) return false;
    this.open = null;
    this.cancel();
    if (kind === 'skip') { this.review.phase = 'done'; this.review.note = 'Skipped: the map stays provisional; Teach does not apply it.'; this.dirty = true; return true; }
    this.applyVerdict(kind === 'confirm' ? 'confirm' : 'correct', kind === 'correct' ? text : null, post);
    return true;
  }

  shellState(): GenericShellState | null {
    const obs = this.learnObs.length > 0 ? this.learnObs : this.mode === 'learn' ? this.obs : [];
    if (this.map === null && obs.length === 0) return null;
    const m = this.map;
    return {
      map: m === null ? null : { steps: m.steps, guardrails: m.guardrails, gaps: m.gaps, teachBack: m.teachBack },
      version: m?.version ?? 0,
      confirmed: m?.confirmed ?? false,
      observations: obs.slice(-40).map((o) => ({
        id: o.id, atMs: o.timestampMs, app: o.facts.app, surface: o.facts.surface, summary: o.facts.summary, change: o.facts.change,
        pendingAction: o.facts.pendingAction, regions: o.facts.regions, evidenceIds: [...o.evidenceIds],
      })),
      phase: this.review?.phase ?? null,
      note: this.review?.note ?? null,
    };
  }

  get inReview(): boolean {
    return this.mode === 'review' && this.review !== null;
  }

  // ---- Learn --------------------------------------------------------------

  private learnTick(nowMs: number, signals: BrainSignals | undefined, post: GenericPost | null): void {
    const change = this.pendingChange;
    if (change === null) return;
    if (this.notPause(nowMs, signals) !== null || this.budget(nowMs) !== null) return;
    this.pendingChange = null;
    const recent = this.obs.slice(-8);
    const fallback = (): void => {
      const text = `I saw: ${clean(change.facts.change)}. What made you do that?`;
      this.queueQuestion(nowMs, text, 'reason', [change.id], change.facts.regions.slice(0, 1).map((r) => r.id), change, 'the question route failed: template question about the change');
    };
    if (post === null) { fallback(); return; }
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const body = {
      observations: recent.map(obsForModel),
      transcript: this.turns.slice(-16).map(turnForModel),
      asked: this.asked.slice(-20),
      language: this.language(),
    };
    void post('generic_question', body, ctrl.signal).then((raw) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      const r = (raw ?? {}) as Record<string, unknown>;
      const question = typeof r['question'] === 'string' && r['question'].trim() !== '' ? r['question'].trim() : null;
      if (question === null) {
        this.log('generic_question: the model chose not to ask about this moment.');
        this.ready.push({ decision: 'SKIP', topic: 'generic', kind: 'reason', evidenceIds: [], whyNow: 'The model found nothing worth asking about this change.' });
        return;
      }
      const ids = strings(r['observationIds']).filter((id) => recent.some((o) => o.id === id));
      const regionIds = strings(r['regionIds']);
      this.queueQuestion(nowMs, question, asTopic(r['topic']), ids.length > 0 ? ids : [change.id], regionIds, change, 'the model wrote the question about the latest change');
    }).catch((e: unknown) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      this.log(`generic_question failed (${e instanceof Error ? e.message : String(e)}): template question.`);
      fallback();
    });
  }

  private regionsOf(ids: readonly string[], within: readonly ScreenActivityObservation[]): ScreenRegion[] {
    const all = within.flatMap((o) => o.facts.regions);
    return ids.flatMap((id) => { const r = all.find((x) => x.id === id); return r ? [r] : []; });
  }

  private queueQuestion(nowMs: number, text: string, topic: GenericTopic, observationIds: string[], regionIds: string[], obs: ScreenActivityObservation, why: string): void {
    const used = this.obs.filter((o) => observationIds.includes(o.id));
    const evidenceIds = [...new Set(used.flatMap((o) => o.evidenceIds))];
    const regions = this.regionsOf(regionIds, used.length > 0 ? used : [obs]);
    const questionId = `g-${++this.seq}`;
    this.open = { questionId, question: text, topic, observationIds, evidenceIds, regions, obs };
    this.asked.push(text);
    this.askedAtMs.push(nowMs);
    this.ready.push({
      decision: 'ASK_NOW', questionId, topic, kind: topic, evidenceIds, expectsAnswer: true,
      whyNow: `A natural pause after "${clean(obs.facts.change)}": ${why}.`,
      utterance: { text },
      clipa: { state: 'speaking', ...(regions[0] ? { target: { surface: 'screen', hint: regions[0].id } } : {}) },
      regions,
    });
  }

  /** The question did not reach the person: it is not counted and the change can be asked about again. */
  notSpoken(questionId: string): boolean {
    const open = this.open;
    if (open === null || open.questionId !== questionId) return false;
    this.open = null;
    this.asked.pop();
    this.askedAtMs.pop();
    if (open.obs !== null && this.pendingChange === null) this.pendingChange = open.obs;
    return true;
  }

  /** The expert answered the open question: a note for the map. Returns false when no generic question was open. */
  answer(text: string, atMs: number, post: GenericPost | null = null): boolean {
    const open = this.open;
    if (open === null) return false;
    this.open = null;
    if (this.mode === 'review') { this.reviewAnswer(open, text, atMs, post); return true; }
    const f = open.obs?.facts;
    this.notes.push({
      id: `note-${this.notes.length + 1}`, question: open.question, answer: text.trim(), topic: open.topic,
      observationIds: open.observationIds, evidenceIds: open.evidenceIds, regions: open.regions,
      app: f?.app ?? null, surface: f?.surface ?? 'screen', change: f?.change ?? null, summary: f?.summary ?? '', atMs,
    });
    return true;
  }

  // ---- Review seam ----------------------------------------------------------

  /** Draft steps from the notes until map_synthesis exists: one step per answered question, with the expert's words and the moment. */
  draftSteps(): { steps: DraftStep[]; guardrails: GuardrailRef[] } {
    const guardrails = this.guardrails().map((g) => ({ id: g.id, text: `${g.condition}: ${g.requiredAction}. The expert: "${g.quote}"`, evidenceIds: g.evidenceIds }));
    const steps: DraftStep[] = this.notes.map((n, i) => ({
      id: `gstep-${i + 1}`,
      title: clean(n.change) || clean(n.summary) || 'A step on screen',
      kind: n.topic === 'reason' ? 'step' : 'judgment',
      decision: clean(n.change) || null,
      reason: n.answer,
      guardrails: guardrails.filter((g) => g.id === `ggr-${n.id}`),
      evidenceIds: n.evidenceIds,
      atMs: n.atMs,
    }));
    return { steps, guardrails };
  }

  /** Guardrails for Teach: the synthesized ones, or provisional ones from the limit / exception / stop-and-ask answers. */
  guardrails(): GenericGuardrail[] {
    if (this.synthesized !== null) return this.synthesized;
    return this.notes
      .filter((n) => n.topic !== 'reason' || /\b(never|always|only|stop|ask|unless|if)\b|никогда|всегда|только|если|нельзя/i.test(n.answer))
      .map((n) => ({
        id: `ggr-${n.id}`, condition: clean(n.change) || clean(n.summary), requiredAction: n.answer, reason: n.answer, quote: n.answer,
        evidenceIds: n.evidenceIds,
      }));
  }

  /** Seam for POST /api/agent/llm/map_synthesis (shape pending): replaces the derived guardrails once it exists. */
  setSynthesized(guardrails: GenericGuardrail[] | null): void {
    this.synthesized = guardrails;
  }

  // ---- Teach ----------------------------------------------------------------

  private teachTick(nowMs: number, signals: BrainSignals | undefined, post: GenericPost | null): void {
    const latest = this.obs[this.obs.length - 1];
    if (latest === undefined || post === null) return;
    const guardrails = this.map !== null ? this.confirmedGuardrails().map((g) => ({
      id: g.id, condition: g.condition, requiredAction: g.requiredAction, reason: g.reason ?? '', quote: g.quote ?? '', evidenceIds: g.evidenceIds,
    })) : this.guardrails();
    if (guardrails.length === 0) return;
    const f = latest.facts;
    const key = `${latest.id}|${clean(f.pendingAction)}`;
    const changed = this.lastSeenKey !== this.lastCheckKey;
    if (!(clean(f.pendingAction) !== '' || changed)) return;
    if (this.lastCheckKey === this.lastSeenKey && nowMs - this.lastCheckAtMs < TEACH_RECHECK_MS) return;
    // A pending action (about to send) is checked at once; anything else waits for a pause.
    if (clean(f.pendingAction) === '' && this.notPause(nowMs, signals) !== null) return;
    if (signals !== undefined && (signals.agentSpeaking || !signals.voiceConnected)) return;
    this.lastCheckKey = this.lastSeenKey;
    this.lastCheckAtMs = nowMs;
    const recent = this.obs.slice(-6);
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const body = {
      guardrails: guardrails.slice(0, 10).map((g) => ({ id: g.id, condition: g.condition, requiredAction: g.requiredAction, reason: g.reason || null, quote: g.quote || null })),
      observations: recent.map(obsForModel),
      transcript: this.turns.slice(-8).map(turnForModel),
      language: this.language(),
    };
    void post('guardrail_check', body, ctrl.signal).then((raw) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      const r = (raw ?? {}) as Record<string, unknown>;
      const status = r['status'] === 'warn' || r['status'] === 'clear' ? r['status'] : 'unknown';
      const g = guardrails.find((x) => x.id === r['guardrailId']) ?? null;
      const message = typeof r['message'] === 'string' && r['message'].trim() !== '' ? r['message'].trim() : null;
      if (status !== 'warn' || message === null) {
        this.ready.push({ decision: 'SKIP', topic: 'guardrail_check', kind: status, evidenceIds: [], whyNow: `Guardrail check (${key}): ${status}.` });
        return;
      }
      const regions = this.regionsOf(strings(r['regionIds']), recent);
      this.ready.push({
        decision: 'WARN', topic: 'guardrail', kind: 'guardrail', evidenceIds: g?.evidenceIds ?? [], expectsAnswer: false,
        whyNow: `Guardrail check: warn${g ? ` (${g.condition})` : ''}${clean(f.pendingAction) ? `, about to: ${clean(f.pendingAction)}` : ''}. The tutor warns; it does not block the app.`,
        utterance: { text: message },
        clipa: { state: 'warning', ...(regions[0] ? { target: { surface: 'screen', hint: regions[0].id } } : {}) },
        regions,
      });
    }).catch((e: unknown) => {
      if (this.inflight !== ctrl) return;
      this.inflight = null;
      this.log(`guardrail_check failed (${e instanceof Error ? e.message : String(e)}): no warning given.`);
      this.ready.push({ decision: 'SKIP', topic: 'guardrail_check', kind: 'unknown', evidenceIds: [], whyNow: 'The guardrail check failed: the tutor says nothing rather than guess.' });
    });
  }
}
