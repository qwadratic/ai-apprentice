// The fixed set of LLM tasks behind POST /api/agent/llm/:task. Prompts, JSON schemas and output validation live
// here (and in ./prompts), never in the browser: it sends typed input only, so the route is not a free chatbot.
import type { BaselineAppId, BaselineProfileId, BaselinePromptContext } from '../../../packages/screen/baseline/profiles.ts';
import { parseBaselinePromptContext } from '../../../packages/screen/baseline/profiles.ts';
import type { Json } from './config.ts';
import { isRecord } from './config.ts';
import { system as answerExtractionSystem } from './prompts/answer-extraction.ts';
import { system as entityResolutionSystem } from './prompts/entity-resolution.ts';
import { system as genericQuestionSystem } from './prompts/generic-question.ts';
import { system as guardrailCheckSystem } from './prompts/guardrail-check.ts';
import { system as mapEditSystem } from './prompts/map-edit.ts';
import { system as mapSynthesisSystem } from './prompts/map-synthesis.ts';
import { system as processMatchSystem } from './prompts/process-match.ts';
import { system as replyClassificationSystem } from './prompts/reply-classification.ts';

export interface RunnerRequest { system: string; prompt: string; schema: Json }
export type Prepared =
  | { ok: true; request: RunnerRequest; check(raw: unknown): unknown } // check: the validated output, or null if the runner's JSON breaks the schema
  | { ok: false; field: string };
export interface LlmTask {
  prepare(body: unknown): Prepared;
  /** Request body cap for this task; the configured default when absent. */
  readonly maxInputBytes?: number;
  /** Runner timeout for this task; the configured default when absent. */
  readonly timeoutMs?: number;
  /** Latency-bound: run on the configured fast model when there is one. */
  readonly fast?: boolean;
}

// ---- input parsing ---------------------------------------------------------
type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };
const fail = (field: string): { ok: false; field: string } => ({ ok: false, field });

/** A plain string of min..max UTF-16 units without NUL or other control characters except tab and newline. */
function text(v: unknown, field: string, max: number, min = 1): Parsed<string> {
  if (typeof v !== 'string' || v.length < min || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return fail(field);
  return { ok: true, value: v };
}
function textList(v: unknown, field: string, maxItems: number, maxLen: number, minItems = 0): Parsed<string[]> {
  if (!Array.isArray(v) || v.length < minItems || v.length > maxItems) return fail(field);
  const out: string[] = [];
  for (const [i, item] of (v as unknown[]).entries()) {
    const t = text(item, `${field}.${i}`, maxLen);
    if (!t.ok) return t;
    out.push(t.value);
  }
  return { ok: true, value: [...new Set(out)] }; // duplicates would repeat enum values in the schema
}
const onlyKeys = (o: Json, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const hasOwn = (o: Json, k: string): boolean => Object.hasOwn(o, k);

// Input text can never close the <input> block: "</input" is written "<\/input" (a valid JSON escape for "/").
const prompt = (input: unknown): string => `<input>\n${JSON.stringify(input).replace(/<\/(input)/gi, '<\\/$1')}\n</input>`;
const nullable = (schema: Json): Json => ({ anyOf: [schema, { type: 'null' }] });
const STRING: Json = { type: 'string' };
const stringArray: Json = { type: 'array', items: STRING };

// ---- output checking helpers ----------------------------------------------
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const strList = (v: unknown, maxItems: number, maxLen: number): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every((x) => isStr(x, maxLen, 1));
// Structured outputs do not enforce maxLength, so the free-text caps are enforced here and stated in the prompts.
export const CAPS = { rationale: 300, correction: 300, condition: 200, requiredAction: 200, listItems: 5, listItemLength: 200, question: 240, goal: 160, escalateTo: 120, teachBack: 1500 } as const;

// ---- quote matching ---------------------------------------------------------
// The model's quote and the answer are compared after folding: NFKC, curly to straight quotes, dashes, collapsed
// whitespace and lower case, ignoring punctuation at the edges of the quote. The original span is returned.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function foldGrapheme(g: string): string {
  const out = g.normalize('NFKC')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase();
  return /^\s+$/u.test(out) ? ' ' : out;
}
interface Folded { text: string; start: number[]; end: number[] }
function fold(source: string): Folded {
  const f: Folded = { text: '', start: [], end: [] };
  for (const { segment, index } of graphemes.segment(source)) {
    const piece = foldGrapheme(segment);
    if (piece === ' ' && f.text.endsWith(' ')) continue;
    for (let i = 0; i < piece.length; i++) { f.start.push(index); f.end.push(index + segment.length); }
    f.text += piece;
  }
  return f;
}
/** The span of `answer` that `quote` designates once both are folded, or null. */
export function findQuoteSpan(answer: string, quote: string): string | null {
  const needle = fold(quote).text.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
  if (needle === '') return null;
  const hay = fold(answer);
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;
  const from = hay.start[at];
  const to = hay.end[at + needle.length - 1];
  return from === undefined || to === undefined ? null : answer.slice(from, to);
}

const exactKeys = (o: Json, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => hasOwn(o, k));

// ---- answer_extraction ------------------------------------------------------
interface ExtractionInput { questionTopic: string; questionText: string; answerText: string; customerRefs: string[]; orderFields: Record<string, string> }

function parseExtraction(body: unknown): Parsed<ExtractionInput> {
  if (!isRecord(body) || !onlyKeys(body, ['questionTopic', 'questionText', 'answerText', 'visibleFacts'])) return fail('body');
  const topic = text(body.questionTopic, 'questionTopic', 200); if (!topic.ok) return topic;
  const question = text(body.questionText, 'questionText', 1000); if (!question.ok) return question;
  const answer = text(body.answerText, 'answerText', 4000); if (!answer.ok) return answer;
  const facts = body.visibleFacts;
  if (!isRecord(facts) || !onlyKeys(facts, ['customerRefs', 'orderFields'])) return fail('visibleFacts');
  const refs = textList(facts.customerRefs, 'visibleFacts.customerRefs', 50, 64); if (!refs.ok) return refs;
  const fields = facts.orderFields;
  if (!isRecord(fields) || Object.keys(fields).length > 40) return fail('visibleFacts.orderFields');
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(fields)) {
    const k = text(name, 'visibleFacts.orderFields', 64); if (!k.ok) return k;
    const v = text(value, `visibleFacts.orderFields.${name}`, 500, 0); if (!v.ok) return v;
    entries.push([k.value, v.value]);
  }
  return { ok: true, value: { questionTopic: topic.value, questionText: question.value, answerText: answer.value, customerRefs: refs.value, orderFields: Object.fromEntries(entries) } };
}

const GUARDRAIL_KEYS = ['condition', 'requiredAction', 'requiredFields', 'scope'] as const;
const EXTRACTION_KEYS = ['rationale', 'quote', 'guardrail', 'exceptions', 'unknowns', 'confidence'] as const;

function extractionSchema(input: ExtractionInput): Json {
  const fieldNames = Object.keys(input.orderFields);
  return {
    type: 'object', additionalProperties: false, required: [...EXTRACTION_KEYS],
    properties: {
      rationale: nullable(STRING),
      quote: STRING,
      guardrail: nullable({
        type: 'object', additionalProperties: false, required: [...GUARDRAIL_KEYS],
        properties: {
          condition: STRING, requiredAction: STRING,
          requiredFields: { type: 'array', items: fieldNames.length ? { type: 'string', enum: fieldNames } : STRING },
          scope: { type: 'object', additionalProperties: false, required: ['entity'], properties: { entity: nullable(input.customerRefs.length ? { type: 'string', enum: input.customerRefs } : STRING) } },
        },
      }),
      exceptions: stringArray,
      unknowns: stringArray,
      confidence: { type: 'number' },
    },
  };
}

export interface ExtractionOutput {
  rationale: string | null;
  quote: string;
  guardrail: null | { condition: string; requiredAction: string; requiredFields: string[]; scope: { entity: string | null } };
  exceptions: string[];
  unknowns: string[];
  confidence: number;
}

function checkExtraction(raw: unknown, input: ExtractionInput): ExtractionOutput | null {
  if (!isRecord(raw) || !exactKeys(raw, EXTRACTION_KEYS)) return null;
  const { rationale, quote, guardrail, exceptions, unknowns, confidence } = raw;
  if (rationale !== null && !isStr(rationale, CAPS.rationale)) return null;
  if (!isStr(quote, 4000, 1)) return null;
  const span = findQuoteSpan(input.answerText, quote); // the original span of the answer, whatever small drift the model made
  if (span === null) return null;
  if (!strList(exceptions, CAPS.listItems, CAPS.listItemLength) || !strList(unknowns, CAPS.listItems, CAPS.listItemLength)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  let out: ExtractionOutput['guardrail'] = null;
  if (guardrail !== null) {
    if (!isRecord(guardrail) || !exactKeys(guardrail, GUARDRAIL_KEYS)) return null;
    const { condition, requiredAction, requiredFields, scope } = guardrail;
    if (!isStr(condition, CAPS.condition, 1) || !isStr(requiredAction, CAPS.requiredAction, 1)) return null;
    if (!strList(requiredFields, 40, 64) || !requiredFields.every((f) => hasOwn(input.orderFields, f))) return null;
    if (!isRecord(scope) || !exactKeys(scope, ['entity'])) return null;
    const entity = scope.entity;
    if (entity !== null && (typeof entity !== 'string' || !input.customerRefs.includes(entity))) return null;
    out = { condition, requiredAction, requiredFields, scope: { entity } };
  }
  return { rationale, quote: span, guardrail: out, exceptions, unknowns, confidence };
}

const answerExtraction: LlmTask = {
  prepare(body) {
    const p = parseExtraction(body);
    if (!p.ok) return p;
    const input = p.value;
    const modelInput = { questionTopic: input.questionTopic, questionText: input.questionText, answerText: input.answerText, visibleFacts: { customerRefs: input.customerRefs, orderFields: input.orderFields } };
    return { ok: true, request: { system: answerExtractionSystem, prompt: prompt(modelInput), schema: extractionSchema(input) }, check: (raw) => checkExtraction(raw, input) };
  },
};

// ---- reply_classification ---------------------------------------------------
interface ReplyInput { teachBack: string; reply: string }
export interface ReplyOutput { verdict: 'confirm' | 'correct' | 'unclear'; correction: string | null }

const replyClassification: LlmTask = {
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['teachBack', 'reply'])) return fail('body');
    const teachBack = text(body.teachBack, 'teachBack', 4000); if (!teachBack.ok) return teachBack;
    const reply = text(body.reply, 'reply', 2000); if (!reply.ok) return reply;
    const input: ReplyInput = { teachBack: teachBack.value, reply: reply.value };
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['verdict', 'correction'],
      properties: { verdict: { type: 'string', enum: ['confirm', 'correct', 'unclear'] }, correction: nullable(STRING) },
    };
    return {
      ok: true, request: { system: replyClassificationSystem, prompt: prompt(input), schema },
      check(raw): ReplyOutput | null {
        if (!isRecord(raw) || !exactKeys(raw, ['verdict', 'correction'])) return null;
        const { verdict, correction } = raw;
        if (verdict !== 'confirm' && verdict !== 'correct' && verdict !== 'unclear') return null;
        if (correction !== null && !isStr(correction, CAPS.correction)) return null;
        // A correction is only meaningful with the "correct" verdict; "correct" without one is treated as unclear.
        if (verdict === 'correct') return typeof correction === 'string' && correction.trim() !== '' ? { verdict, correction } : { verdict: 'unclear', correction: null };
        return { verdict, correction: null };
      },
    };
  },
};

// ---- entity_resolution ------------------------------------------------------
interface EntityInput { spoken: string; knownRefs: string[] }
export interface EntityOutput { ref: string | null }

const entityResolution: LlmTask = {
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['spoken', 'knownRefs'])) return fail('body');
    const spoken = text(body.spoken, 'spoken', 200); if (!spoken.ok) return spoken;
    const refs = textList(body.knownRefs, 'knownRefs', 100, 64, 1); if (!refs.ok) return refs;
    const input: EntityInput = { spoken: spoken.value, knownRefs: refs.value };
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['ref'],
      properties: { ref: nullable({ type: 'string', enum: input.knownRefs }) },
    };
    return {
      ok: true, request: { system: entityResolutionSystem, prompt: prompt(input), schema },
      check(raw): EntityOutput | null {
        if (!isRecord(raw) || !exactKeys(raw, ['ref'])) return null;
        const { ref } = raw;
        if (ref === null) return { ref: null };
        return typeof ref === 'string' && input.knownRefs.includes(ref) ? { ref } : null; // only from knownRefs
      },
    };
  },
};

// ---- generic screen input (any app, any workflow) ---------------------------
// Shared by generic_question, map_synthesis and guardrail_check: what the screen showed and what was said.
export interface GenericRegion { id: string; label: string }
export interface GenericObservation { id: string; atMs: number; app: string | null; surface: string; summary: string; change: string | null; pendingAction: string | null; regions: GenericRegion[] }
export interface GenericTurn { role: 'expert' | 'agent'; text: string; atMs: number }

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
function id(v: unknown, field: string): Parsed<string> {
  return typeof v === 'string' && ID_RE.test(v) ? { ok: true, value: v } : fail(field);
}
function nullableText(v: unknown, field: string, max: number): Parsed<string | null> {
  return v === null ? { ok: true, value: null } : text(v, field, max);
}
function ms(v: unknown, field: string): Parsed<number> {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 604_800_000 ? { ok: true, value: Math.round(v) } : fail(field);
}
function language(v: unknown, field: string): Parsed<string | null> {
  if (v === null) return { ok: true, value: null };
  return typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) ? { ok: true, value: v } : fail(field);
}

function parseObservations(v: unknown, field: string, maxItems: number): Parsed<GenericObservation[]> {
  if (!Array.isArray(v) || v.length < 1 || v.length > maxItems) return fail(field);
  const out: GenericObservation[] = [];
  const seen = new Set<string>();
  for (const [i, o] of (v as unknown[]).entries()) {
    const f = `${field}.${i}`;
    if (!isRecord(o) || !onlyKeys(o, ['id', 'atMs', 'app', 'surface', 'summary', 'change', 'pendingAction', 'regions'])) return fail(f);
    const oid = id(o.id, `${f}.id`); if (!oid.ok) return oid;
    if (seen.has(oid.value)) return fail(`${f}.id`);
    seen.add(oid.value);
    const at = ms(o.atMs ?? 0, `${f}.atMs`); if (!at.ok) return at;
    const app = nullableText(o.app ?? null, `${f}.app`, 80); if (!app.ok) return app;
    const surface = text(o.surface, `${f}.surface`, 120); if (!surface.ok) return surface;
    const summary = text(o.summary, `${f}.summary`, 400); if (!summary.ok) return summary;
    const change = nullableText(o.change ?? null, `${f}.change`, 300); if (!change.ok) return change;
    const pending = nullableText(o.pendingAction ?? null, `${f}.pendingAction`, 80); if (!pending.ok) return pending;
    const rawRegions = o.regions ?? [];
    if (!Array.isArray(rawRegions) || rawRegions.length > 8) return fail(`${f}.regions`);
    const regions: GenericRegion[] = [];
    for (const [j, r] of (rawRegions as unknown[]).entries()) {
      if (!isRecord(r) || !onlyKeys(r, ['id', 'label'])) return fail(`${f}.regions.${j}`);
      const rid = id(r.id, `${f}.regions.${j}.id`); if (!rid.ok) return rid;
      const label = text(r.label, `${f}.regions.${j}.label`, 120); if (!label.ok) return label;
      regions.push({ id: rid.value, label: label.value });
    }
    out.push({ id: oid.value, atMs: at.value, app: app.value, surface: surface.value, summary: summary.value, change: change.value, pendingAction: pending.value, regions });
  }
  return { ok: true, value: out };
}

function parseTranscript(v: unknown, field: string, maxItems: number): Parsed<GenericTurn[]> {
  if (!Array.isArray(v) || v.length > maxItems) return fail(field);
  const out: GenericTurn[] = [];
  for (const [i, t] of (v as unknown[]).entries()) {
    const f = `${field}.${i}`;
    if (!isRecord(t) || !onlyKeys(t, ['role', 'text', 'atMs'])) return fail(f);
    if (t.role !== 'expert' && t.role !== 'agent') return fail(`${f}.role`);
    const body = text(t.text, `${f}.text`, 1000); if (!body.ok) return body;
    const at = ms(t.atMs ?? 0, `${f}.atMs`); if (!at.ok) return at;
    out.push({ role: t.role, text: body.value, atMs: at.value });
  }
  return { ok: true, value: out };
}

/** Ids from `wanted` that are in `allowed`, deduplicated, in order, at most `max`. */
function pick(wanted: unknown, allowed: ReadonlySet<string>, max: number): string[] | null {
  if (!Array.isArray(wanted) || !wanted.every((x) => typeof x === 'string')) return null;
  return [...new Set((wanted as string[]).filter((x) => allowed.has(x)))].slice(0, max);
}
const idEnum = (ids: readonly string[]): Json => (ids.length ? { type: 'array', items: { type: 'string', enum: [...new Set(ids)] } } : { type: 'array', items: STRING, maxItems: 0 });
const regionIdsOf = (obs: readonly GenericObservation[]): string[] => [...new Set(obs.flatMap((o) => o.regions.map((r) => r.id)))];
const sameText = (a: string, b: string): boolean => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

/** The span of an expert turn that `quote` designates, with that turn's time; null when no expert turn holds it. */
export function expertQuote(transcript: readonly GenericTurn[], quote: unknown): { quote: string; atMs: number } | null {
  if (typeof quote !== 'string' || quote.trim() === '') return null;
  for (const turn of transcript) {
    if (turn.role !== 'expert') continue;
    const span = findQuoteSpan(turn.text, quote);
    if (span !== null) return { quote: span, atMs: turn.atMs };
  }
  return null;
}

// ---- generic_question -------------------------------------------------------
const GENERIC_TOPICS = ['reason', 'limit', 'exception', 'scope', 'stop_and_ask'] as const;
export interface GenericQuestionOutput { question: string | null; topic: (typeof GENERIC_TOPICS)[number]; observationIds: string[]; regionIds: string[] }

const genericQuestion: LlmTask = {
  maxInputBytes: 32 * 1024,
  fast: true,
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['observations', 'transcript', 'asked', 'language', 'baselineContext'])) return fail('body');
    const observations = parseObservations(body.observations, 'observations', 8); if (!observations.ok) return observations;
    const transcript = parseTranscript(body.transcript ?? [], 'transcript', 16); if (!transcript.ok) return transcript;
    const asked = textList(body.asked ?? [], 'asked', 20, 300); if (!asked.ok) return asked;
    const lang = language(body.language ?? null, 'language'); if (!lang.ok) return lang;
    const obs = observations.value;
    const obsIds = obs.map((o) => o.id);
    const regionIds = regionIdsOf(obs);
    let baselineContext: BaselinePromptContext | null;
    try { baselineContext = parseBaselinePromptContext(body.baselineContext); }
    catch { return fail('baselineContext'); }
    if (baselineContext && !baselineContext.evidence.observationIds.every((oid) => obsIds.includes(oid))) {
      return fail('baselineContext.evidence.observationIds');
    }
    // Asset references are retained by the server; these observation inputs cannot validate them.
    const baseline = baselineContext === null ? null : {
      ...baselineContext,
      evidence: { observationIds: baselineContext.evidence.observationIds },
    };
    const input = { observations: obs, transcript: transcript.value, asked: asked.value, language: lang.value,
      ...(baseline === null ? {} : { baselineContext: baseline }) };
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['question', 'topic', 'observationIds', 'regionIds'],
      properties: { question: nullable(STRING), topic: { type: 'string', enum: [...GENERIC_TOPICS] }, observationIds: idEnum(obsIds), regionIds: idEnum(regionIds) },
    };
    return {
      ok: true, request: { system: genericQuestionSystem, prompt: prompt(input), schema },
      check(raw): GenericQuestionOutput | null {
        if (!isRecord(raw) || !exactKeys(raw, ['question', 'topic', 'observationIds', 'regionIds'])) return null;
        const { question, topic } = raw;
        if (typeof topic !== 'string' || !(GENERIC_TOPICS as readonly string[]).includes(topic)) return null;
        const observationIds = pick(raw.observationIds, new Set(obsIds), 4);
        const regions = pick(raw.regionIds, new Set(regionIds), 4);
        if (observationIds === null || regions === null) return null;
        if (question === null || (typeof question === 'string' && question.trim() === '')) return { question: null, topic: topic as GenericQuestionOutput['topic'], observationIds: [], regionIds: [] };
        if (!isStr(question, CAPS.question, 1)) return null;
        // A repeat of a question already asked is no question at all.
        if (asked.value.some((a) => sameText(a, question))) return { question: null, topic: topic as GenericQuestionOutput['topic'], observationIds: [], regionIds: [] };
        const newest = obsIds[obsIds.length - 1];
        return { question: question.trim(), topic: topic as GenericQuestionOutput['topic'], observationIds: observationIds.length ? observationIds : (newest ? [newest] : []), regionIds: regions };
      },
    };
  },
};

// ---- map_synthesis ----------------------------------------------------------
export interface GenericDecision { summary: string; reason: string | null; quote: string | null; quoteAtMs: number | null }
export interface GenericProcess { id: string; title: string; summary: string }
export interface GenericStep { id: string; processId: string | null; kind: 'action' | 'judgment'; goal: string; action: string; decision: GenericDecision | null; evidenceIds: string[] }
export interface GenericGuardrail { id: string; processId: string | null; condition: string; requiredAction: string; reason: string | null; quote: string | null; quoteAtMs: number | null; escalateTo: string | null; exceptions: string[]; evidenceIds: string[] }
export interface GenericGap { question: string; targetId: string | null; evidenceIds: string[]; regionIds: string[] }
/** Server-generated provenance, separate from the model's learned process and rule output. */
export interface BaselineProvenance {
  observations: Array<{ observationId: string; appId: BaselineAppId | null; profileId: BaselineProfileId | null; evidenceIds: string[] }>;
  turns: Array<{ atMs: number; appId: BaselineAppId | null; profileId: BaselineProfileId | null; observationIds: string[]; evidenceIds: string[]; questionId: string | null }>;
}
export interface MapSynthesisOutput { processes: GenericProcess[]; steps: GenericStep[]; guardrails: GenericGuardrail[]; gaps: GenericGap[]; teachBack: string; baselineProvenance?: BaselineProvenance }

const PROCESS_KEYS = ['id', 'title', 'summary'] as const;
const STEP_KEYS = ['id', 'processId', 'kind', 'goal', 'action', 'decision', 'evidenceIds'] as const;
const DECISION_KEYS = ['summary', 'reason', 'quote'] as const;
const RULE_KEYS = ['id', 'processId', 'condition', 'requiredAction', 'reason', 'quote', 'escalateTo', 'exceptions', 'evidenceIds'] as const;
const GAP_KEYS = ['question', 'targetId', 'evidenceIds', 'regionIds'] as const;
const MAP_KEYS = ['processes', 'steps', 'guardrails', 'gaps', 'teachBack'] as const;
/** Exactly `keys`, or exactly `keys` without `optional`: a model that leaves out the newer field is not a broken one. */
const keysWithOptional = (o: Json, keys: readonly string[], optional: string): boolean =>
  exactKeys(o, keys) || (!hasOwn(o, optional) && exactKeys(o, keys.filter((k) => k !== optional)));

function mapSchema(obsIds: readonly string[]): Json {
  const ev = idEnum(obsIds);
  return {
    type: 'object', additionalProperties: false, required: [...MAP_KEYS],
    properties: {
      processes: { type: 'array', items: { type: 'object', additionalProperties: false, required: [...PROCESS_KEYS], properties: { id: STRING, title: STRING, summary: STRING } } },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: [...STEP_KEYS], properties: {
        id: STRING, processId: nullable(STRING), kind: { type: 'string', enum: ['action', 'judgment'] }, goal: STRING, action: STRING,
        decision: nullable({ type: 'object', additionalProperties: false, required: [...DECISION_KEYS], properties: { summary: STRING, reason: nullable(STRING), quote: nullable(STRING) } }),
        evidenceIds: ev,
      } } },
      guardrails: { type: 'array', items: { type: 'object', additionalProperties: false, required: [...RULE_KEYS], properties: {
        id: STRING, processId: nullable(STRING), condition: STRING, requiredAction: STRING, reason: nullable(STRING), quote: nullable(STRING), escalateTo: nullable(STRING), exceptions: stringArray, evidenceIds: ev,
      } } },
      gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: [...GAP_KEYS], properties: {
        question: STRING, targetId: nullable(STRING), evidenceIds: ev, regionIds: { type: 'array', items: STRING },
      } } },
      teachBack: STRING,
    },
  };
}

/**
 * Checks the model's map and makes it safe to show: a reason stands only with a quote found in an expert turn (else both
 * are dropped and the item is unexplained), evidence ids are kept only when they name an input observation, ids are
 * renumbered s1.. and g1.., and gaps point at the renumbered ids.
 */
export function checkMap(raw: unknown, obs: readonly GenericObservation[], transcript: readonly GenericTurn[]): MapSynthesisOutput | null {
  // A map without processes (or a step without processId) is still a map: it then holds one process.
  if (!isRecord(raw) || !keysWithOptional(raw, MAP_KEYS, 'processes')) return null;
  const { steps, guardrails, gaps, teachBack } = raw;
  const processes = hasOwn(raw, 'processes') ? raw.processes : [];
  if (!Array.isArray(processes) || !Array.isArray(steps) || !Array.isArray(guardrails) || !Array.isArray(gaps)) return null;
  if (!isStr(teachBack, CAPS.teachBack, 1)) return null;
  const allowed = new Set(obs.map((o) => o.id));
  const regionIds = new Set(regionIdsOf(obs));
  const renamed = new Map<string, string>();
  // Processes are renumbered p1..; a step or rule that names none belongs to the only process, when there is one.
  // A malformed process is left out rather than failing the whole map: the steps and rules matter more than the grouping.
  const outProcesses: GenericProcess[] = [];
  const processIds = new Map<string, string>();
  for (const p of processes.slice(0, 3)) {
    if (!isRecord(p) || !exactKeys(p, PROCESS_KEYS) || typeof p.title !== 'string' || !p.title.trim() || typeof p.summary !== 'string') continue;
    const newId = `p${outProcesses.length + 1}`;
    if (typeof p.id === 'string') processIds.set(p.id, newId);
    outProcesses.push({ id: newId, title: p.title.trim().slice(0, 80), summary: p.summary.slice(0, CAPS.condition) });
  }
  const processOf = (v: unknown): string | null => {
    const named = typeof v === 'string' ? processIds.get(v) : undefined;
    return named ?? (outProcesses.length === 1 ? 'p1' : null);
  };
  const outSteps: GenericStep[] = [];
  for (const s of steps.slice(0, 10)) {
    if (!isRecord(s) || !keysWithOptional(s, STEP_KEYS, 'processId')) return null;
    if (s.kind !== 'action' && s.kind !== 'judgment') return null;
    if (!isStr(s.goal, CAPS.goal, 1) || !isStr(s.action, CAPS.requiredAction, 1)) return null;
    const evidenceIds = pick(s.evidenceIds, allowed, 8); if (evidenceIds === null) return null;
    let decision: GenericDecision | null = null;
    if (s.decision !== null) {
      const d = s.decision;
      if (!isRecord(d) || !exactKeys(d, DECISION_KEYS) || !isStr(d.summary, CAPS.condition, 1)) return null;
      if (d.reason !== null && !isStr(d.reason, CAPS.rationale)) return null;
      const q = expertQuote(transcript, d.quote);
      decision = { summary: d.summary, reason: q && typeof d.reason === 'string' && d.reason.trim() ? d.reason : null, quote: q?.quote ?? null, quoteAtMs: q?.atMs ?? null };
    }
    const newId = `s${outSteps.length + 1}`;
    if (typeof s.id === 'string') renamed.set(s.id, newId);
    outSteps.push({ id: newId, processId: processOf(s.processId), kind: s.kind, goal: s.goal, action: s.action, decision, evidenceIds });
  }
  const outRules: GenericGuardrail[] = [];
  for (const g of guardrails.slice(0, 8)) {
    if (!isRecord(g) || !keysWithOptional(g, RULE_KEYS, 'processId')) return null;
    if (!isStr(g.condition, CAPS.condition, 1) || !isStr(g.requiredAction, CAPS.requiredAction, 1)) return null;
    if (g.reason !== null && !isStr(g.reason, CAPS.rationale)) return null;
    if (g.escalateTo !== null && !isStr(g.escalateTo, CAPS.escalateTo)) return null;
    if (!strList(g.exceptions, CAPS.listItems, CAPS.listItemLength)) return null;
    const evidenceIds = pick(g.evidenceIds, allowed, 8); if (evidenceIds === null) return null;
    const q = expertQuote(transcript, g.quote);
    const newId = `g${outRules.length + 1}`;
    if (typeof g.id === 'string') renamed.set(g.id, newId);
    outRules.push({
      id: newId, processId: processOf(g.processId), condition: g.condition, requiredAction: g.requiredAction,
      reason: q && typeof g.reason === 'string' && g.reason.trim() ? g.reason : null, quote: q?.quote ?? null, quoteAtMs: q?.atMs ?? null,
      escalateTo: typeof g.escalateTo === 'string' && g.escalateTo.trim() ? g.escalateTo : null, exceptions: g.exceptions, evidenceIds,
    });
  }
  const outGaps: GenericGap[] = [];
  for (const q of gaps.slice(0, 3)) {
    if (!isRecord(q) || !exactKeys(q, GAP_KEYS) || !isStr(q.question, CAPS.question, 1)) return null;
    if (q.targetId !== null && typeof q.targetId !== 'string') return null;
    const evidenceIds = pick(q.evidenceIds, allowed, 4);
    const regions = pick(q.regionIds, regionIds, 4);
    if (evidenceIds === null || regions === null) return null;
    outGaps.push({ question: q.question, targetId: typeof q.targetId === 'string' ? renamed.get(q.targetId) ?? null : null, evidenceIds, regionIds: regions });
  }
  return { processes: outProcesses, steps: outSteps, guardrails: outRules, gaps: outGaps, teachBack };
}

const mapSynthesis: LlmTask = {
  maxInputBytes: 96 * 1024,
  timeoutMs: 55_000,
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['observations', 'transcript', 'correction', 'previousTeachBack'])) return fail('body');
    const observations = parseObservations(body.observations, 'observations', 40); if (!observations.ok) return observations;
    const transcript = parseTranscript(body.transcript ?? [], 'transcript', 60); if (!transcript.ok) return transcript;
    const correction = nullableText(body.correction ?? null, 'correction', 600); if (!correction.ok) return correction;
    const previous = nullableText(body.previousTeachBack ?? null, 'previousTeachBack', 3000); if (!previous.ok) return previous;
    const obs = observations.value;
    const turns = transcript.value;
    const input = { observations: obs, transcript: turns, correction: correction.value, previousTeachBack: previous.value };
    return { ok: true, request: { system: mapSynthesisSystem, prompt: prompt(input), schema: mapSchema(obs.map((o) => o.id)) }, check: (raw) => checkMap(raw, obs, turns) };
  },
};

// ---- guardrail_check --------------------------------------------------------
export interface GuardrailCheckOutput { status: 'clear' | 'warn' | 'unknown'; guardrailId: string | null; message: string | null; regionIds: string[] }

const guardrailCheck: LlmTask = {
  maxInputBytes: 32 * 1024,
  fast: true,
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['guardrails', 'observations', 'transcript', 'language'])) return fail('body');
    const rules = body.guardrails;
    if (!Array.isArray(rules) || rules.length < 1 || rules.length > 10) return fail('guardrails');
    const parsedRules: Array<{ id: string; condition: string; requiredAction: string; reason: string | null; quote: string | null }> = [];
    for (const [i, g] of (rules as unknown[]).entries()) {
      const f = `guardrails.${i}`;
      if (!isRecord(g) || !onlyKeys(g, ['id', 'condition', 'requiredAction', 'reason', 'quote'])) return fail(f);
      const gid = id(g.id, `${f}.id`); if (!gid.ok) return gid;
      const condition = text(g.condition, `${f}.condition`, 300); if (!condition.ok) return condition;
      const action = text(g.requiredAction, `${f}.requiredAction`, 300); if (!action.ok) return action;
      const reason = nullableText(g.reason ?? null, `${f}.reason`, 400); if (!reason.ok) return reason;
      const quote = nullableText(g.quote ?? null, `${f}.quote`, 600); if (!quote.ok) return quote;
      parsedRules.push({ id: gid.value, condition: condition.value, requiredAction: action.value, reason: reason.value, quote: quote.value });
    }
    const observations = parseObservations(body.observations, 'observations', 6); if (!observations.ok) return observations;
    const transcript = parseTranscript(body.transcript ?? [], 'transcript', 8); if (!transcript.ok) return transcript;
    const lang = language(body.language ?? null, 'language'); if (!lang.ok) return lang;
    const ruleIds = [...new Set(parsedRules.map((g) => g.id))];
    const latest = observations.value[observations.value.length - 1];
    const latestRegions = latest ? latest.regions.map((r) => r.id) : [];
    const input = { guardrails: parsedRules, observations: observations.value, transcript: transcript.value, language: lang.value };
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['status', 'guardrailId', 'message', 'regionIds'],
      properties: { status: { type: 'string', enum: ['clear', 'warn', 'unknown'] }, guardrailId: nullable({ type: 'string', enum: ruleIds }), message: nullable(STRING), regionIds: idEnum(latestRegions) },
    };
    return {
      ok: true, request: { system: guardrailCheckSystem, prompt: prompt(input), schema },
      check(raw): GuardrailCheckOutput | null {
        if (!isRecord(raw) || !exactKeys(raw, ['status', 'guardrailId', 'message', 'regionIds'])) return null;
        const { status, guardrailId, message } = raw;
        if (status !== 'clear' && status !== 'warn' && status !== 'unknown') return null;
        if (guardrailId !== null && (typeof guardrailId !== 'string' || !ruleIds.includes(guardrailId))) return null;
        if (message !== null && !isStr(message, CAPS.question)) return null;
        const regions = pick(raw.regionIds, new Set(latestRegions), 4); if (regions === null) return null;
        // A warning must name its rule and say something; without either it cannot be explained, so it is unknown.
        if (status === 'warn' && (guardrailId === null || typeof message !== 'string' || message.trim() === '')) return { status: 'unknown', guardrailId, message: null, regionIds: [] };
        if (status === 'clear') return { status, guardrailId, message: null, regionIds: [] };
        return { status, guardrailId, message: typeof message === 'string' && message.trim() ? message.trim() : null, regionIds: regions };
      },
    };
  },
};

// ---- map_edit ---------------------------------------------------------------
// The expert talks, Clipa edits: one utterance becomes a few checked operations on the current map.
export const EDIT_OPS = ['set', 'add_step', 'add_rule', 'remove', 'comment', 'resolve_gap'] as const;
export const STEP_FIELDS = ['goal', 'action', 'decision', 'reason'] as const;
export const RULE_FIELDS = ['condition', 'requiredAction', 'reason', 'escalateTo', 'exception'] as const;
export interface EditOperation { op: (typeof EDIT_OPS)[number]; targetId: string | null; field: string | null; value: string | null; value2: string | null; quote: string | null }
export interface MapEditOutput { intent: 'edit' | 'confirm' | 'question' | 'other'; operations: EditOperation[]; reply: string; teachBack: string | null }
interface EditMapView {
  steps: Array<{ id: string; kind: string; goal: string; action: string; decision: { summary: string; reason: string | null } | null }>;
  guardrails: Array<{ id: string; condition: string; requiredAction: string; reason: string | null; escalateTo: string | null; exceptions: string[] }>;
  gaps: Array<{ name: string; question: string }>;
  teachBack: string;
}

function parseEditMap(v: unknown): Parsed<EditMapView> {
  if (!isRecord(v) || !Array.isArray(v.steps) || !Array.isArray(v.guardrails)) return fail('map');
  if (v.steps.length > 20 || v.guardrails.length > 12) return fail('map');
  const steps: EditMapView['steps'] = [];
  for (const [i, s] of (v.steps as unknown[]).entries()) {
    if (!isRecord(s)) return fail(`map.steps.${i}`);
    const sid = id(s.id, `map.steps.${i}.id`); if (!sid.ok) return sid;
    const goal = text(s.goal, `map.steps.${i}.goal`, 300); if (!goal.ok) return goal;
    const action = text(s.action, `map.steps.${i}.action`, 300); if (!action.ok) return action;
    let decision: EditMapView['steps'][number]['decision'] = null;
    if (isRecord(s.decision)) {
      const summary = text(s.decision.summary, `map.steps.${i}.decision.summary`, 300); if (!summary.ok) return summary;
      const reason = nullableText(s.decision.reason ?? null, `map.steps.${i}.decision.reason`, 400); if (!reason.ok) return reason;
      decision = { summary: summary.value, reason: reason.value };
    }
    steps.push({ id: sid.value, kind: s.kind === 'judgment' ? 'judgment' : 'action', goal: goal.value, action: action.value, decision });
  }
  const guardrails: EditMapView['guardrails'] = [];
  for (const [i, g] of (v.guardrails as unknown[]).entries()) {
    if (!isRecord(g)) return fail(`map.guardrails.${i}`);
    const gid = id(g.id, `map.guardrails.${i}.id`); if (!gid.ok) return gid;
    const condition = text(g.condition, `map.guardrails.${i}.condition`, 300); if (!condition.ok) return condition;
    const action = text(g.requiredAction, `map.guardrails.${i}.requiredAction`, 300); if (!action.ok) return action;
    const reason = nullableText(g.reason ?? null, `map.guardrails.${i}.reason`, 400); if (!reason.ok) return reason;
    const escalateTo = nullableText(g.escalateTo ?? null, `map.guardrails.${i}.escalateTo`, 200); if (!escalateTo.ok) return escalateTo;
    const exceptions = textList(g.exceptions ?? [], `map.guardrails.${i}.exceptions`, 10, 300); if (!exceptions.ok) return exceptions;
    guardrails.push({ id: gid.value, condition: condition.value, requiredAction: action.value, reason: reason.value, escalateTo: escalateTo.value, exceptions: exceptions.value });
  }
  const gaps: EditMapView['gaps'] = [];
  for (const [i, q] of (Array.isArray(v.gaps) ? v.gaps as unknown[] : []).slice(0, 10).entries()) {
    if (!isRecord(q)) return fail(`map.gaps.${i}`);
    const question = text(q.question, `map.gaps.${i}.question`, 300); if (!question.ok) return question;
    gaps.push({ name: `gap-${i + 1}`, question: question.value });
  }
  const teachBack = text(v.teachBack ?? '', 'map.teachBack', 3000, 0); if (!teachBack.ok) return teachBack;
  return { ok: true, value: { steps, guardrails, gaps, teachBack: teachBack.value } };
}

/** Drops operations that name an unknown item or field; quotes are kept only as spans of the utterance. */
export function checkEdit(raw: unknown, map: EditMapView, utterance: string): MapEditOutput | null {
  if (!isRecord(raw) || !exactKeys(raw, ['intent', 'operations', 'reply', 'teachBack'])) return null;
  const { intent, operations, reply, teachBack } = raw;
  if (intent !== 'edit' && intent !== 'confirm' && intent !== 'question' && intent !== 'other') return null;
  if (!Array.isArray(operations) || !isStr(reply, 400) || (teachBack !== null && !isStr(teachBack, CAPS.teachBack))) return null;
  const stepIds = new Set(map.steps.map((x) => x.id));
  const ruleIds = new Set(map.guardrails.map((x) => x.id));
  const gapNames = new Set(map.gaps.map((x) => x.name));
  const ops: EditOperation[] = [];
  for (const o of operations.slice(0, 6)) {
    if (!isRecord(o) || !exactKeys(o, ['op', 'targetId', 'field', 'value', 'value2', 'quote'])) return null;
    const { op, targetId, field } = o;
    const value = isStr(o.value, CAPS.condition, 1) ? o.value : null;
    const value2 = isStr(o.value2, CAPS.condition, 1) ? o.value2 : null;
    if (typeof op !== 'string' || !(EDIT_OPS as readonly string[]).includes(op)) continue;
    const target = typeof targetId === 'string' ? targetId : null;
    const quote = typeof o.quote === 'string' ? findQuoteSpan(utterance, o.quote) : null;
    const isStep = target !== null && stepIds.has(target);
    const isRule = target !== null && ruleIds.has(target);
    if (op === 'set') {
      const fields: readonly string[] = isStep ? STEP_FIELDS : isRule ? RULE_FIELDS : [];
      if (typeof field !== 'string' || !fields.includes(field) || value === null) continue;
      ops.push({ op, targetId: target, field, value, value2: null, quote: field === 'reason' ? quote : null });
    } else if (op === 'add_step') {
      if (value === null || (target !== null && !isStep)) continue;
      ops.push({ op, targetId: target, field: null, value, value2, quote: null });
    } else if (op === 'add_rule') {
      if (value === null || value2 === null) continue;
      ops.push({ op, targetId: null, field: null, value, value2, quote });
    } else if (op === 'remove') {
      if (!isStep && !isRule) continue;
      ops.push({ op, targetId: target, field: null, value: null, value2: null, quote: null });
    } else if (op === 'comment') {
      if ((!isStep && !isRule) || value === null) continue;
      ops.push({ op, targetId: target, field: null, value, value2: null, quote: null });
    } else if (op === 'resolve_gap') {
      if (target === null || !gapNames.has(target)) continue;
      ops.push({ op, targetId: target, field: null, value: null, value2: null, quote: null });
    }
  }
  // An edit with nothing left to apply must not be announced as done.
  if (intent === 'edit' && ops.length === 0) return { intent: 'other', operations: [], reply: '', teachBack: null };
  return { intent, operations: intent === 'edit' ? ops : [], reply: reply.trim(), teachBack: intent === 'edit' && typeof teachBack === 'string' && teachBack.trim() ? teachBack.trim() : null };
}

const mapEdit: LlmTask = {
  maxInputBytes: 48 * 1024,
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['map', 'utterance', 'recent', 'language'])) return fail('body');
    const map = parseEditMap(body.map); if (!map.ok) return map;
    const utterance = text(body.utterance, 'utterance', 1000); if (!utterance.ok) return utterance;
    const recent = parseTranscript(body.recent ?? [], 'recent', 8); if (!recent.ok) return recent;
    const lang = language(body.language ?? null, 'language'); if (!lang.ok) return lang;
    const input = { map: map.value, utterance: utterance.value, recent: recent.value, language: lang.value };
    const nullableString = nullable(STRING);
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['intent', 'operations', 'reply', 'teachBack'],
      properties: {
        intent: { type: 'string', enum: ['edit', 'confirm', 'question', 'other'] },
        operations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', 'targetId', 'field', 'value', 'value2', 'quote'], properties: {
          op: { type: 'string', enum: [...EDIT_OPS] }, targetId: nullableString, field: nullable({ type: 'string', enum: [...new Set([...STEP_FIELDS, ...RULE_FIELDS])] }),
          value: nullableString, value2: nullableString, quote: nullableString,
        } } },
        reply: STRING,
        teachBack: nullableString,
      },
    };
    return { ok: true, request: { system: mapEditSystem, prompt: prompt(input), schema }, check: (raw) => checkEdit(raw, map.value, utterance.value) };
  },
};

// ---- process_match -----------------------------------------------------------
// Which known process is on screen now: the conductor uses it to pick the expert's strategy (what to ask, which rules).
export interface ProcessMatchOutput { processId: string | null; confidence: number }

const processMatch: LlmTask = {
  maxInputBytes: 32 * 1024,
  fast: true,
  prepare(body) {
    if (!isRecord(body) || !onlyKeys(body, ['processes', 'observations'])) return fail('body');
    const list = body.processes;
    if (!Array.isArray(list) || list.length < 1 || list.length > 12) return fail('processes');
    const processes: Array<{ id: string; title: string; summary: string; steps: string[]; rules: string[] }> = [];
    for (const [i, p] of (list as unknown[]).entries()) {
      const f = `processes.${i}`;
      if (!isRecord(p) || !onlyKeys(p, ['id', 'title', 'summary', 'steps', 'rules'])) return fail(f);
      const pid = id(p.id, `${f}.id`); if (!pid.ok) return pid;
      const title = text(p.title, `${f}.title`, 120); if (!title.ok) return title;
      const summary = text(p.summary ?? '', `${f}.summary`, 300, 0); if (!summary.ok) return summary;
      const steps = textList(p.steps ?? [], `${f}.steps`, 10, 300); if (!steps.ok) return steps;
      const rules = textList(p.rules ?? [], `${f}.rules`, 8, 400); if (!rules.ok) return rules;
      processes.push({ id: pid.value, title: title.value, summary: summary.value, steps: steps.value, rules: rules.value });
    }
    const observations = parseObservations(body.observations, 'observations', 6); if (!observations.ok) return observations;
    const ids = [...new Set(processes.map((p) => p.id))];
    const schema: Json = {
      type: 'object', additionalProperties: false, required: ['processId', 'confidence'],
      properties: { processId: nullable({ type: 'string', enum: ids }), confidence: { type: 'number' } },
    };
    return {
      ok: true, request: { system: processMatchSystem, prompt: prompt({ processes, observations: observations.value }), schema },
      check(raw): ProcessMatchOutput | null {
        if (!isRecord(raw) || !exactKeys(raw, ['processId', 'confidence'])) return null;
        const { processId, confidence } = raw;
        if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
        if (processId !== null && (typeof processId !== 'string' || !ids.includes(processId))) return null;
        return { processId, confidence };
      },
    };
  },
};

export const LLM_TASKS: Readonly<Record<string, LlmTask>> = Object.freeze({
  answer_extraction: answerExtraction,
  reply_classification: replyClassification,
  entity_resolution: entityResolution,
  generic_question: genericQuestion,
  map_synthesis: mapSynthesis,
  guardrail_check: guardrailCheck,
  map_edit: mapEdit,
  process_match: processMatch,
});
