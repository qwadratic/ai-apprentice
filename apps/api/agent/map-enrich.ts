// The map_enrich task: a background job that deepens the current Work Map with everything the expert said and showed, in this
// session and in earlier sessions of the same persona. It is not one of the browser's LLM tasks (no route reaches it): the
// conductor hands over the session's own material, the hub adds the earlier sessions from disk and the confirmed maps, and the
// runner's job route lets the model read all of it as files. Prompt and schema are fixed here. Whatever the model returns is
// checked before anything uses it: ids stay the input's, and a quote must be found word for word in an expert turn of a
// transcript that was given. Nothing here is logged.
import type { AgentConfig, Json } from './config.ts';
import { isRecord } from './config.ts';
import { STAGE_NAMES } from './conductor/lines.ts';
import { MODES } from './conductor/protocol.ts';
import type { Mode, Persona } from './conductor/protocol.ts';
import { callRunner } from './llm.ts';
import type { TaskResult } from './llm.ts';
import { CAPS, expertQuote } from './llm-tasks.ts';
import type { GenericStep, GenericTurn, MapContextFact, MapRelatedProcess, MapSynthesisOutput, RunnerRequest } from './llm-tasks.ts';
import { system as mapEnrichSystem } from './prompts/map-enrich.ts';
import type { SessionFiles } from './sessions.ts';

export const ENRICH_LIMITS = {
  /** Characters of one spoken turn or screen line in a file (the conductor already keeps turns to this). */
  cellChars: 1000,
  /** One file, UTF-8 bytes: when it is longer, the newest lines that fit are kept. */
  fileBytes: 200_000,
  /** All files together: below the runner's cap of 2 MiB. */
  totalBytes: 1_500_000,
  /** Earlier sessions looked at while searching for enough of the same persona. */
  scanSessions: 40,
  /** A quote shorter than this proves nothing (a "yes" is in every transcript). */
  minQuoteChars: 12,
  quoteChars: 600,
  steps: 20,
  rules: 12,
  gaps: 10,
  context: 6,
  related: 4,
} as const;

// ---- the material ------------------------------------------------------------
/** A screen line as the job reads it: `id` is null for an earlier session, whose observation ids are not kept. */
export interface MaterialObservation { id: string | null; atMs: number; app: string | null; surface: string; summary: string; change: string | null }
export interface SessionMaterial {
  sessionId: string;
  transcript: readonly GenericTurn[];
  observations: readonly MaterialObservation[];
  /** The map the expert confirmed in that session, when there is one. */
  map: MapSynthesisOutput | null;
}
/** What the conductor hands over: its own session's material and the map as it stands now. */
export interface EnrichInput {
  sessionId: string;
  persona: Persona;
  map: MapSynthesisOutput;
  observations: readonly MaterialObservation[];
  transcript: readonly GenericTurn[];
}
/** The job: the input plus the earlier sessions (and the confirmed maps) the hub found. */
export interface EnrichJob extends EnrichInput { earlier: readonly SessionMaterial[] }

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** One cell of a tab-separated line: control characters (tab and newline too) become a space, runs of space collapse, cut at `max`. */
function cell(v: string | null | undefined, max: number = ENRICH_LIMITS.cellChars): string {
  const line = (v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The header, then the newest of `lines` that fit in `maxBytes`, oldest first. */
function capNewest(header: string, lines: readonly string[], maxBytes: number): string {
  const kept: string[] = [];
  let bytes = Buffer.byteLength(header) + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(line);
  }
  return `${header}\n${kept.reverse().map((l) => `${l}\n`).join('')}`;
}

/** `time<TAB>role<TAB>text`, one spoken turn per line. */
export function transcriptTsv(turns: readonly GenericTurn[], maxBytes: number = ENRICH_LIMITS.fileBytes): string {
  return capNewest('time\trole\ttext', turns.map((t) => `${clock(t.atMs)}\t${t.role}\t${cell(t.text)}`), maxBytes);
}
/** `time<TAB>observation<TAB>app<TAB>surface<TAB>summary<TAB>change`, one screen line each. */
export function observationsTsv(observations: readonly MaterialObservation[], maxBytes: number = ENRICH_LIMITS.fileBytes): string {
  return capNewest('time\tobservation\tapp\tsurface\tsummary\tchange', observations.map((o) =>
    [clock(o.atMs), cell(o.id ?? '-', 64), cell(o.app, 80), cell(o.surface, 120), cell(o.summary, 400), cell(o.change, 300)].join('\t')), maxBytes);
}
function mapJson(map: MapSynthesisOutput): string {
  const { processes, steps, guardrails, gaps, teachBack } = map;
  const comments = (map as { comments?: unknown }).comments;
  return JSON.stringify({ processes: processes ?? [], steps, guardrails, gaps, teachBack, comments: Array.isArray(comments) ? comments : [] }, null, 1);
}

export interface JobFile { path: string; content: string }
export interface ListedFile { path: string; kind: 'transcript' | 'observations' | 'map'; sessionId: string }

/**
 * The files the model reads, current session first, then the earlier ones (newest first): per session a transcript and an
 * observations file, and a map file where the expert confirmed one. A file that would push the total over the cap is left out.
 */
export function exportFiles(job: EnrichJob): { files: JobFile[]; listing: ListedFile[] } {
  const files: JobFile[] = [];
  const listing: ListedFile[] = [];
  let bytes = 0;
  const add = (path: string, kind: ListedFile['kind'], sessionId: string, content: string): void => {
    const size = Buffer.byteLength(content);
    if (bytes + size > ENRICH_LIMITS.totalBytes) return;
    bytes += size;
    files.push({ path, content });
    listing.push({ path, kind, sessionId });
  };
  const addSession = (s: { sessionId: string; transcript: readonly GenericTurn[]; observations: readonly MaterialObservation[]; map: MapSynthesisOutput | null }): void => {
    if (s.transcript.length > 0) add(`sessions/${s.sessionId}/transcript.tsv`, 'transcript', s.sessionId, transcriptTsv(s.transcript));
    if (s.observations.length > 0) add(`sessions/${s.sessionId}/observations.tsv`, 'observations', s.sessionId, observationsTsv(s.observations));
    if (s.map !== null) add(`maps/${s.sessionId}.json`, 'map', s.sessionId, mapJson(s.map));
  };
  addSession({ sessionId: job.sessionId, transcript: job.transcript, observations: job.observations, map: null });
  for (const e of job.earlier) if (SESSION_ID.test(e.sessionId) && e.sessionId !== job.sessionId) addSession(e);
  return { files, listing };
}

// ---- the request ---------------------------------------------------------------
const STRING: Json = { type: 'string' };
const nullable = (schema: Json): Json => ({ anyOf: [schema, { type: 'null' }] });
const stringArray: Json = { type: 'array', items: STRING };
/** An id from the input: a closed set in the schema (a plain string when the set is empty). */
const idOf = (ids: readonly string[]): Json => (ids.length ? { type: 'string', enum: [...new Set(ids)] } : STRING);
const idList = (ids: readonly string[]): Json => (ids.length ? { type: 'array', items: { type: 'string', enum: [...new Set(ids)] } } : { type: 'array', items: STRING, maxItems: 0 });
const input = (value: unknown): string => `<input>\n${JSON.stringify(value).replace(/<\/(input)/gi, '<\\/$1')}\n</input>`;

const STEP_KEYS = ['id', 'goal', 'action', 'decision', 'evidenceIds'] as const;
const DECISION_KEYS = ['summary', 'reason', 'quote', 'sessionId'] as const;
const RULE_KEYS = ['id', 'condition', 'requiredAction', 'reason', 'quote', 'sessionId', 'escalateTo', 'exceptions', 'evidenceIds'] as const;
const RELATED_KEYS = ['title', 'summary', 'sessionId'] as const;
const CONTEXT_KEYS = ['fact', 'quote', 'sessionId'] as const;
const PREDICTION_KEYS = ['gapId', 'likelyAnswer', 'quote', 'sessionId', 'confidence'] as const;

interface Known { stepIds: string[]; ruleIds: string[]; gapIds: string[]; sessionIds: string[]; observationIds: string[] }

function schemaFor(k: Known): Json {
  const quoted = (keys: readonly string[], extra: Json): Json => ({ type: 'object', additionalProperties: false, required: [...keys], properties: extra });
  const session = idOf(k.sessionIds);
  return {
    type: 'object', additionalProperties: false, required: ['map', 'context', 'predictions'],
    properties: {
      map: {
        type: 'object', additionalProperties: false, required: ['steps', 'guardrails', 'related'],
        properties: {
          steps: { type: 'array', items: quoted(STEP_KEYS, {
            id: idOf(k.stepIds), goal: nullable(STRING), action: nullable(STRING),
            decision: nullable(quoted(DECISION_KEYS, { summary: STRING, reason: STRING, quote: STRING, sessionId: session })),
            evidenceIds: idList(k.observationIds),
          }) },
          guardrails: { type: 'array', items: quoted(RULE_KEYS, {
            id: idOf(k.ruleIds), condition: nullable(STRING), requiredAction: nullable(STRING), reason: nullable(STRING), quote: nullable(STRING),
            sessionId: nullable(session), escalateTo: nullable(STRING), exceptions: stringArray, evidenceIds: idList(k.observationIds),
          }) },
          related: { type: 'array', items: quoted(RELATED_KEYS, { title: STRING, summary: STRING, sessionId: session }) },
        },
      },
      context: { type: 'array', items: quoted(CONTEXT_KEYS, { fact: STRING, quote: STRING, sessionId: session }) },
      predictions: { type: 'array', items: quoted(PREDICTION_KEYS, {
        gapId: idOf(k.gapIds), likelyAnswer: STRING, quote: nullable(STRING), sessionId: nullable(session), confidence: { type: 'number' },
      }) },
    },
  };
}

// ---- the checked output ----------------------------------------------------------
export interface EnrichedStep { id: string; goal: string | null; action: string | null; decision: { summary: string; reason: string; quote: string; quoteSessionId: string; quoteAtMs: number | null } | null; evidenceIds: string[] }
export interface EnrichedRule {
  id: string; condition: string | null; requiredAction: string | null;
  reason: string | null; quote: string | null; quoteSessionId: string | null; quoteAtMs: number | null;
  escalateTo: string | null; exceptions: string[]; evidenceIds: string[];
}
/** `quote` and `sessionId` are both set (the quote found word for word in that session's expert turns) or both null. */
export interface Prediction { gapId: string; likelyAnswer: string; quote: string | null; sessionId: string | null; confidence: number }
export interface EnrichOutput {
  map: { steps: EnrichedStep[]; guardrails: EnrichedRule[]; related: MapRelatedProcess[] };
  context: MapContextFact[];
  predictions: Prediction[];
}

const isStr = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
/** A trimmed text of 1..max characters, else null. */
const textOrNull = (v: unknown, max: number): string | null => (isStr(v, max) ? v.trim() : null);
const exactKeys = (o: Json, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const ids = (v: unknown, allowed: ReadonlySet<string>, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && allowed.has(x)))].slice(0, max) : [];

interface QuoteSource { sessionId: string; own: boolean; turns: readonly GenericTurn[] }
interface Located { quote: string; sessionId: string; atMs: number | null }

/**
 * The expert's words as the transcripts hold them: `quote` found in an expert turn of the named session first, else of any given
 * session (a wrong session id on a real quote is mended, an invented quote is not found). `atMs` is the turn's time in the
 * map's own session, and null for another session, whose clock the map does not share.
 */
function locate(sources: readonly QuoteSource[], quote: unknown, preferred: unknown): Located | null {
  if (typeof quote !== 'string' || quote.trim().length < ENRICH_LIMITS.minQuoteChars || quote.length > ENRICH_LIMITS.quoteChars) return null;
  const ordered = [...sources].sort((a, b) => Number(b.sessionId === preferred) - Number(a.sessionId === preferred));
  for (const s of ordered) {
    const hit = expertQuote(s.turns, quote);
    if (hit !== null && hit.quote.trim().length >= ENRICH_LIMITS.minQuoteChars) return { quote: hit.quote, sessionId: s.sessionId, atMs: s.own ? hit.atMs : null };
  }
  return null;
}

interface CheckContext extends Known { sources: readonly QuoteSource[] }

/**
 * The job's output made safe: the shape must be exact (else null), then each item is checked on its own and dropped when it
 * names an id the input did not have or carries a quote no expert turn contains; a fact or a decision without a real quote does
 * not stand, a rule's reason without one is left out. A prediction without a verified quote is a guess: its confidence is
 * capped at 0.5, so a confidence above that always comes with the expert's words.
 */
export function checkEnrich(raw: unknown, c: CheckContext): EnrichOutput | null {
  if (!isRecord(raw) || !exactKeys(raw, ['map', 'context', 'predictions'])) return null;
  const { map, context, predictions } = raw;
  if (!isRecord(map) || !exactKeys(map, ['steps', 'guardrails', 'related'])) return null;
  if (!Array.isArray(map.steps) || !Array.isArray(map.guardrails) || !Array.isArray(map.related) || !Array.isArray(context) || !Array.isArray(predictions)) return null;
  const stepIds = new Set(c.stepIds);
  const ruleIds = new Set(c.ruleIds);
  const gapIds = new Set(c.gapIds);
  const sessionIds = new Set(c.sessionIds);
  const observationIds = new Set(c.observationIds);

  const steps: EnrichedStep[] = [];
  for (const s of map.steps.slice(0, ENRICH_LIMITS.steps)) {
    if (!isRecord(s) || !exactKeys(s, STEP_KEYS) || typeof s.id !== 'string' || !stepIds.has(s.id) || steps.some((x) => x.id === s.id)) continue;
    let decision: EnrichedStep['decision'] = null;
    if (isRecord(s.decision) && exactKeys(s.decision, DECISION_KEYS)) {
      const summary = textOrNull(s.decision.summary, CAPS.condition);
      const reason = textOrNull(s.decision.reason, CAPS.rationale);
      const q = locate(c.sources, s.decision.quote, s.decision.sessionId);
      if (summary !== null && reason !== null && q !== null) decision = { summary, reason, quote: q.quote, quoteSessionId: q.sessionId, quoteAtMs: q.atMs };
    }
    const item: EnrichedStep = { id: s.id, goal: textOrNull(s.goal, CAPS.goal), action: textOrNull(s.action, CAPS.requiredAction), decision, evidenceIds: ids(s.evidenceIds, observationIds, 8) };
    if (item.goal !== null || item.action !== null || item.decision !== null || item.evidenceIds.length > 0) steps.push(item);
  }

  const guardrails: EnrichedRule[] = [];
  for (const g of map.guardrails.slice(0, ENRICH_LIMITS.rules)) {
    if (!isRecord(g) || !exactKeys(g, RULE_KEYS) || typeof g.id !== 'string' || !ruleIds.has(g.id) || guardrails.some((x) => x.id === g.id)) continue;
    const reason = textOrNull(g.reason, CAPS.rationale);
    const q = reason === null ? null : locate(c.sources, g.quote, g.sessionId);
    const exceptions = Array.isArray(g.exceptions)
      ? [...new Set(g.exceptions.map((e) => textOrNull(e, CAPS.listItemLength)).filter((e): e is string => e !== null))].slice(0, CAPS.listItems)
      : [];
    const item: EnrichedRule = {
      id: g.id, condition: textOrNull(g.condition, CAPS.condition), requiredAction: textOrNull(g.requiredAction, CAPS.requiredAction),
      reason: q === null ? null : reason, quote: q?.quote ?? null, quoteSessionId: q?.sessionId ?? null, quoteAtMs: q?.atMs ?? null,
      escalateTo: textOrNull(g.escalateTo, CAPS.escalateTo), exceptions, evidenceIds: ids(g.evidenceIds, observationIds, 8),
    };
    if (item.condition !== null || item.requiredAction !== null || item.reason !== null || item.escalateTo !== null || item.exceptions.length > 0 || item.evidenceIds.length > 0) guardrails.push(item);
  }

  const related: MapRelatedProcess[] = [];
  for (const r of map.related.slice(0, ENRICH_LIMITS.related)) {
    if (!isRecord(r) || !exactKeys(r, RELATED_KEYS) || typeof r.sessionId !== 'string' || !sessionIds.has(r.sessionId)) continue;
    const title = textOrNull(r.title, 80);
    const summary = textOrNull(r.summary, CAPS.condition);
    if (title !== null && summary !== null) related.push({ title, summary, sessionId: r.sessionId });
  }

  const facts: MapContextFact[] = [];
  for (const f of context.slice(0, ENRICH_LIMITS.context)) {
    if (!isRecord(f) || !exactKeys(f, CONTEXT_KEYS)) continue;
    const fact = textOrNull(f.fact, CAPS.condition);
    const q = locate(c.sources, f.quote, f.sessionId);
    if (fact !== null && q !== null && !facts.some((x) => x.quote === q.quote)) facts.push({ fact, quote: q.quote, sessionId: q.sessionId });
  }

  const out: Prediction[] = [];
  for (const p of predictions.slice(0, ENRICH_LIMITS.gaps)) {
    if (!isRecord(p) || !exactKeys(p, PREDICTION_KEYS) || typeof p.gapId !== 'string' || !gapIds.has(p.gapId) || out.some((x) => x.gapId === p.gapId)) continue;
    const likelyAnswer = textOrNull(p.likelyAnswer, CAPS.condition);
    if (likelyAnswer === null || typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) continue;
    const q = p.quote === null ? null : locate(c.sources, p.quote, p.sessionId);
    out.push({ gapId: p.gapId, likelyAnswer, quote: q?.quote ?? null, sessionId: q?.sessionId ?? null, confidence: q === null ? Math.min(p.confidence, 0.5) : p.confidence });
  }
  return { map: { steps, guardrails, related }, context: facts, predictions: out };
}

export type PreparedEnrich = { ok: true; request: RunnerRequest; check(raw: unknown): EnrichOutput | null; files: number } | { ok: false; field: string };

/** The id the job gives the open point at `index` of the map's gaps, and the one a prediction names it by. */
export const gapIdAt = (index: number): string => `gap-${index + 1}`;

/** The runner request for a job, with its files, and the check of its answer. */
export function prepareEnrich(job: EnrichJob): PreparedEnrich {
  if (!SESSION_ID.test(job.sessionId)) return { ok: false, field: 'sessionId' };
  const { files, listing } = exportFiles(job);
  if (files.length === 0) return { ok: false, field: 'files' };
  const map = job.map;
  const gaps = map.gaps.slice(0, ENRICH_LIMITS.gaps).map((g, i) => ({ id: gapIdAt(i), question: cell(g.question, CAPS.question), targetId: g.targetId }));
  const view = {
    processes: (map.processes ?? []).map((p) => ({ id: p.id, title: cell(p.title, 80), summary: cell(p.summary, 200) })),
    steps: map.steps.slice(0, ENRICH_LIMITS.steps).map((s: GenericStep) => ({
      id: s.id, kind: s.kind, goal: cell(s.goal, CAPS.goal), action: cell(s.action, CAPS.requiredAction),
      decision: s.decision === null ? null : { summary: cell(s.decision.summary, CAPS.condition), reason: s.decision.reason === null ? null : cell(s.decision.reason, CAPS.rationale) },
    })),
    guardrails: map.guardrails.slice(0, ENRICH_LIMITS.rules).map((g) => ({
      id: g.id, condition: cell(g.condition, CAPS.condition), requiredAction: cell(g.requiredAction, CAPS.requiredAction),
      reason: g.reason === null ? null : cell(g.reason, CAPS.rationale), quote: g.quote === null ? null : cell(g.quote, ENRICH_LIMITS.quoteChars),
      escalateTo: g.escalateTo, exceptions: g.exceptions.map((e) => cell(e, CAPS.listItemLength)),
    })),
  };
  const sessions = [...new Set(listing.map((f) => f.sessionId))];
  const known: Known = {
    stepIds: view.steps.map((s) => s.id), ruleIds: view.guardrails.map((g) => g.id), gapIds: gaps.map((g) => g.id),
    sessionIds: sessions, observationIds: job.observations.flatMap((o) => (o.id === null ? [] : [o.id])),
  };
  const transcripts = new Map<string, readonly GenericTurn[]>([[job.sessionId, job.transcript]]);
  for (const e of job.earlier) if (SESSION_ID.test(e.sessionId) && e.sessionId !== job.sessionId) transcripts.set(e.sessionId, e.transcript);
  const sources: QuoteSource[] = sessions.map((sessionId) => ({ sessionId, own: sessionId === job.sessionId, turns: transcripts.get(sessionId) ?? [] }));
  const request: RunnerRequest = {
    system: mapEnrichSystem,
    prompt: input({ currentSessionId: job.sessionId, files: listing, map: view, gaps }),
    schema: schemaFor(known),
    files,
  };
  return { ok: true, request, check: (raw) => checkEnrich(raw, { ...known, sources }), files: files.length };
}

// ---- merging the answer into the map -----------------------------------------------
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The enriched details put into the map as it stands now. `base` is the map the job started from: a field the expert changed
 * since (by voice) is theirs and stays, a field nobody touched takes the more precise wording. Reasons and quotes only fill a
 * field that has none, exceptions and evidence ids are added, and context and related processes replace the earlier ones. No step
 * or rule is added or removed. Returns the new map and how many fields changed (0: nothing to publish). Pure.
 */
export function mergeEnrichment<M extends MapSynthesisOutput>(current: M, base: MapSynthesisOutput, out: EnrichOutput): { map: M; changed: number } {
  const next = structuredClone(current);
  let changed = 0;
  const addEvidence = (target: { evidenceIds: string[] }, more: readonly string[]): void => {
    const merged = [...new Set([...target.evidenceIds, ...more])].slice(0, 8);
    if (!sameList(merged, target.evidenceIds)) { target.evidenceIds = merged; changed++; }
  };
  for (const e of out.map.steps) {
    const step = next.steps.find((s) => s.id === e.id);
    if (!step) continue;
    const was = base.steps.find((s) => s.id === e.id);
    if (e.goal !== null && e.goal !== step.goal && (was === undefined || step.goal === was.goal)) { step.goal = e.goal; changed++; }
    if (e.action !== null && e.action !== step.action && (was === undefined || step.action === was.action)) { step.action = e.action; changed++; }
    if (e.decision !== null && (step.decision?.reason ?? null) === null) {
      step.kind = 'judgment';
      step.decision = { summary: step.decision?.summary ?? e.decision.summary, reason: e.decision.reason, quote: e.decision.quote, quoteAtMs: e.decision.quoteAtMs, quoteSessionId: e.decision.quoteSessionId };
      changed++;
    }
    addEvidence(step, e.evidenceIds);
  }
  for (const e of out.map.guardrails) {
    const rule = next.guardrails.find((g) => g.id === e.id);
    if (!rule) continue;
    const was = base.guardrails.find((g) => g.id === e.id);
    if (e.condition !== null && e.condition !== rule.condition && (was === undefined || rule.condition === was.condition)) { rule.condition = e.condition; changed++; }
    if (e.requiredAction !== null && e.requiredAction !== rule.requiredAction && (was === undefined || rule.requiredAction === was.requiredAction)) { rule.requiredAction = e.requiredAction; changed++; }
    if (e.escalateTo !== null && rule.escalateTo === null) { rule.escalateTo = e.escalateTo; changed++; }
    if (e.reason !== null && e.quote !== null && rule.reason === null) {
      rule.reason = e.reason; rule.quote = e.quote; rule.quoteAtMs = e.quoteAtMs; rule.quoteSessionId = e.quoteSessionId;
      changed++;
    }
    const known = new Set(rule.exceptions.map((x) => x.toLowerCase()));
    const added = e.exceptions.filter((x) => !known.has(x.toLowerCase()));
    if (added.length > 0 && rule.exceptions.length < CAPS.listItems) { rule.exceptions = [...rule.exceptions, ...added].slice(0, CAPS.listItems); changed++; }
    addEvidence(rule, e.evidenceIds);
  }
  if (JSON.stringify(next.context ?? []) !== JSON.stringify(out.context)) { next.context = out.context; changed++; }
  if (JSON.stringify(next.related ?? []) !== JSON.stringify(out.map.related)) { next.related = out.map.related; changed++; }
  return { map: next, changed };
}

// ---- earlier sessions, from what the web app already stores ---------------------------
interface Line { t: number; dir: string; type: string; text: string }
function lineOf(v: unknown): Line | null {
  return isRecord(v) && typeof v.t === 'number' && Number.isFinite(v.t) && typeof v.dir === 'string' && typeof v.type === 'string' && typeof v.text === 'string'
    ? { t: v.t, dir: v.dir, type: v.type, text: v.text } : null;
}

/**
 * What the session log of one session (`{id}.jsonl`, the lines the web app posts) tells: the spoken turns (`recv` USER and AGENT
 * lines), the screen lines the voice agent was given (`sent` CONTEXT lines that start with "[screen]": app, surface and summary
 * joined in one text, so they are split back apart as well as they can be, and a change is not kept) and which stages ran
 * (the "[stage] Now in <name>:" line), from which the persona follows: Show or Reflect is an expert's session, only Pass it on a
 * new hire's, none of them unknown. Times count from the first line. Never throws on a line it does not understand.
 */
export function materialFromEvents(events: readonly unknown[]): { persona: Persona | null; transcript: GenericTurn[]; observations: MaterialObservation[] } {
  const lines = events.map(lineOf).filter((l): l is Line => l !== null);
  const t0 = lines.reduce((m, l) => Math.min(m, l.t), Number.POSITIVE_INFINITY);
  const transcript: GenericTurn[] = [];
  const observations: MaterialObservation[] = [];
  const stages = new Set<Mode>();
  for (const l of lines) {
    const atMs = Math.max(0, Math.round(l.t - t0));
    if (l.dir === 'recv' && (l.type === 'USER' || l.type === 'AGENT')) {
      const text = cell(l.text);
      if (text !== '') transcript.push({ role: l.type === 'USER' ? 'expert' : 'agent', text, atMs });
    } else if (l.dir === 'sent' && l.type === 'CONTEXT') {
      if (l.text.startsWith('[screen] ')) {
        const body = cell(l.text.slice('[screen] '.length), 500);
        const dot = body.indexOf('. ');
        const head = dot >= 0 ? body.slice(0, dot) : body;
        const colon = head.indexOf(': ');
        const o: MaterialObservation = { id: null, atMs, app: colon > 0 ? head.slice(0, colon) : null, surface: colon > 0 ? head.slice(colon + 2) : head, summary: dot >= 0 ? body.slice(dot + 2) : '', change: null };
        const last = observations.at(-1);
        if (!last || last.app !== o.app || last.surface !== o.surface || last.summary !== o.summary) observations.push(o);
      } else {
        for (const mode of MODES) if (l.text.startsWith(`[stage] Now in ${STAGE_NAMES[mode]}:`)) stages.add(mode);
      }
    }
  }
  const persona: Persona | null = stages.has('learn') || stages.has('review') ? 'expert' : stages.has('teach') ? 'new_hire' : null;
  return { persona, transcript, observations };
}

export interface EarlierOptions {
  /** Sessions never to read (the current one). */
  exclude: ReadonlySet<string>;
  persona: Persona;
  limit: number;
  /** Sessions known to be the persona's whatever their log says (they confirmed a map). */
  knownPersona: ReadonlySet<string>;
}

/** Up to `limit` earlier sessions of the persona, newest first, read from the session logs; a session with nothing to read is skipped. */
export async function loadEarlierSessions(files: SessionFiles, o: EarlierOptions): Promise<Array<Omit<SessionMaterial, 'map'>>> {
  if (o.limit <= 0) return [];
  const { sessions } = await files.list();
  const out: Array<Omit<SessionMaterial, 'map'>> = [];
  let scanned = 0;
  for (const info of sessions) {
    if (out.length >= o.limit || scanned >= ENRICH_LIMITS.scanSessions) break;
    if (!info.hasEvents || o.exclude.has(info.id) || !SESSION_ID.test(info.id)) continue;
    scanned++;
    const dump = await files.dump(info.id);
    if (!dump?.events) continue;
    const m = materialFromEvents(dump.events);
    if ((m.persona ?? (o.knownPersona.has(info.id) ? o.persona : null)) !== o.persona) continue;
    if (m.transcript.length === 0 && m.observations.length === 0) continue;
    out.push({ sessionId: info.id, transcript: m.transcript, observations: m.observations });
  }
  return out;
}

// ---- the hub's entry point -------------------------------------------------------------
export interface EnrichDeps {
  config: AgentConfig;
  files: SessionFiles;
  /** Confirmed maps of other sessions, newest first (MapRegistry.recent). */
  confirmed(exclude: string, limit: number): Array<{ sessionId: string; map: MapSynthesisOutput }>;
}

export type EnrichResult =
  | { ok: true; output: EnrichOutput; files: number; sessions: number }
  | { ok: false; error: Extract<TaskResult, { ok: false }>['error'] };

/**
 * Runs the job for one session: finds the earlier sessions and confirmed maps, asks the runner's job route and checks the answer.
 * It never throws and logs nothing; the caller decides what a failure means (nothing: the map stays as it is).
 */
export async function runMapEnrich(deps: EnrichDeps, request: EnrichInput, signal: AbortSignal): Promise<EnrichResult> {
  try {
    const { config } = deps;
    const confirmed = deps.confirmed(request.sessionId, config.enrichSessions);
    const maps = new Map(confirmed.map((c) => [c.sessionId, c.map]));
    const earlier = await loadEarlierSessions(deps.files, { exclude: new Set([request.sessionId]), persona: request.persona, limit: config.enrichSessions, knownPersona: new Set(maps.keys()) });
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const sessions: SessionMaterial[] = earlier.map((e) => ({ ...e, map: maps.get(e.sessionId) ?? null }));
    // A confirmed map of a session whose log is gone (rotated away) still carries the expert's words.
    for (const [sessionId, map] of maps) if (!sessions.some((s) => s.sessionId === sessionId)) sessions.push({ sessionId, transcript: [], observations: [], map });
    const prepared = prepareEnrich({ ...request, earlier: sessions });
    if (!prepared.ok) return { ok: false, error: 'invalid_input' };
    const result = await callRunner(config, prepared.request, signal, config.timing.enrichTimeoutMs, null);
    if (signal.aborted) return { ok: false, error: 'aborted' };
    if (!result.ok) return { ok: false, error: result.error };
    const output = prepared.check(result.json);
    return output === null ? { ok: false, error: 'invalid_output' } : { ok: true, output, files: prepared.files, sessions: sessions.length };
  } catch {
    // Disk or parsing trouble: not logged here (the text could echo paths or content); the caller treats it as a failed job.
    return { ok: false, error: 'runner_error' };
  }
}
