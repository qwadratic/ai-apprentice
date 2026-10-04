// The fixed set of LLM tasks behind POST /api/agent/llm/:task. Prompts, JSON schemas and output validation live
// here (and in ./prompts), never in the browser: it sends typed input only, so the route is not a free chatbot.
import type { Json } from './config.ts';
import { isRecord } from './config.ts';
import { system as answerExtractionSystem } from './prompts/answer-extraction.ts';
import { system as entityResolutionSystem } from './prompts/entity-resolution.ts';
import { system as replyClassificationSystem } from './prompts/reply-classification.ts';

export interface RunnerRequest { system: string; prompt: string; schema: Json }
export type Prepared =
  | { ok: true; request: RunnerRequest; check(raw: unknown): unknown } // check: the validated output, or null if the runner's JSON breaks the schema
  | { ok: false; field: string };
export interface LlmTask { prepare(body: unknown): Prepared }

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
export const CAPS = { rationale: 300, correction: 300, condition: 200, requiredAction: 200, listItems: 5, listItemLength: 200 } as const;

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

export const LLM_TASKS: Readonly<Record<string, LlmTask>> = Object.freeze({
  answer_extraction: answerExtraction,
  reply_classification: replyClassification,
  entity_resolution: entityResolution,
});
