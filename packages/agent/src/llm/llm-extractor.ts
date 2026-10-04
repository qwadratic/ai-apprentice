// LLM-backed answer extraction behind the AnswerExtractor interface (route task "answer_extraction").
// The heuristic extraction is always computed first: it supplies what the model is not asked for (retractions, "I don't
// know why" customers, scope words) and it is the answer when the model fails, times out or returns something unusable.
// The model's output is parsed at runtime and validated; its quote must be a verbatim span of the expert's answer.
import { mentionedRefs, resolveAliases } from "../knowledge/entities.ts";
import type { EntityResolver } from "../knowledge/entities.ts";
import { extractionIssues } from "../knowledge/extractor.ts";
import type { AnswerExtraction, AnswerExtractor, ExtractionInput } from "../knowledge/extractor.ts";
import { findEscalateTo, heuristicExtract, mayJoinScope } from "../knowledge/heuristic-extractor.ts";
import { FACT_KEYS } from "../knowledge/types.ts";
import type { FactKey, MapExceptionData } from "../knowledge/types.ts";
import { isJsonObject } from "./client.ts";
import type { LlmClient } from "./client.ts";

/** What the route is sent for task answer_extraction (the route rejects any other key). */
export interface AnswerExtractionRequest {
  questionTopic: string;
  /** Never empty: the route refuses an empty question. */
  questionText: string;
  answerText: string;
  /** Customer refs seen on screen, and the visible order fields by name (orderId, deliveryAddress, deliveryWindow) with their values. */
  visibleFacts: { customerRefs: string[]; orderFields: Record<string, string> };
}

/** The route's limits: an answer of up to 4000 characters, up to 50 customer refs of up to 64 characters. */
const MAX_ANSWER = 4000;
const MAX_REFS = 50;
const MAX_REF_LENGTH = 64;

function questionTextFor(input: ExtractionInput): string {
  const asked = input.questionText?.trim();
  if (asked) return asked.slice(0, 1000);
  return input.topic === "correction" ? "The expert replied to the teach-back." : `The expert was asked about: ${input.topic.replace(/_/g, " ")}.`;
}

/** What the route answers. */
export interface AnswerExtractionOutput {
  rationale: string | null;
  quote: string;
  guardrail: { condition: string; requiredAction: string; requiredFields: string[]; scope: { entity: string | null } } | null;
  exceptions: string[];
  unknowns: string[];
  confidence: number;
}

const FIELD_ALIASES: ReadonlyArray<readonly [FactKey, RegExp]> = [
  ["orderId", /^(order[\s_-]*(number|id|no|ref(erence)?)|orderid|order)$/i],
  ["deliveryAddress", /^((delivery[\s_-]*)?address|deliveryaddress|street)$/i],
  ["deliveryWindow", /^((delivery[\s_-]*)?(window|time|time[\s_-]*slot|date|slot)|deliverywindow)$/i],
];

/** A field name the route used, mapped onto the order fields the map knows; null when it is none of them. */
export function toFactKey(name: string): FactKey | null {
  const trimmed = name.trim();
  const exact = FACT_KEYS.find((k) => k === trimmed);
  if (exact) return exact;
  return FIELD_ALIASES.find(([, re]) => re.test(trimmed))?.[0] ?? null;
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** Runtime validation of the route's output; null when it is not usable. */
export function parseAnswerExtractionOutput(raw: unknown): AnswerExtractionOutput | null {
  if (!isJsonObject(raw)) return null;
  const { rationale, quote, guardrail, exceptions, unknowns, confidence } = raw;
  if (rationale !== null && typeof rationale !== "string") return null;
  if (typeof quote !== "string" || quote.trim().length === 0) return null;
  const ex = strings(exceptions);
  const un = strings(unknowns);
  if (ex === null || un === null) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  let g: AnswerExtractionOutput["guardrail"] = null;
  if (guardrail !== null) {
    if (!isJsonObject(guardrail)) return null;
    const fields = strings(guardrail.requiredFields);
    const scope = guardrail.scope;
    if (typeof guardrail.condition !== "string" || typeof guardrail.requiredAction !== "string" || fields === null || !isJsonObject(scope)) return null;
    if (scope.entity !== null && typeof scope.entity !== "string") return null;
    g = { condition: guardrail.condition, requiredAction: guardrail.requiredAction, requiredFields: fields, scope: { entity: scope.entity } };
  }
  return { rationale: rationale === null ? null : rationale.trim() || null, quote: quote.trim(), guardrail: g, exceptions: ex, unknowns: un, confidence };
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Combines the model's output with the heuristic extraction. The model decides what it was asked for. */
export function mergeLlmExtraction(base: AnswerExtraction, out: AnswerExtractionOutput, input: ExtractionInput): AnswerExtraction {
  const merged: AnswerExtraction = { ...base, quote: out.quote, rationale: out.rationale, reasonQuote: out.rationale !== null ? out.quote : null };
  merged.confidence = out.confidence;
  merged.reasonUnknown = out.rationale === null ? base.reasonUnknown : false;
  const notes = [...base.unknowns];

  const fields: FactKey[] = [];
  for (const name of out.guardrail?.requiredFields ?? []) {
    const key = toFactKey(name);
    if (key === null) notes.push(`The route named a field the map does not track: ${name}.`);
    else if (!fields.includes(key)) fields.push(key);
  }
  if (fields.length > 0) merged.requiredFacts = FACT_KEYS.filter((k) => fields.includes(k));

  // Only a scope answer or a correction can widen the rule, and only to a customer the expert puts into it.
  const entity = input.topic === "scope" || input.topic === "correction" ? (out.guardrail?.scope.entity ?? null) : null;
  if (entity !== null) {
    // The model must name a customer the screen has shown; anything else is noted, not believed.
    const known = input.knownRefs ?? [];
    const guess = known.find((r) => r.toLowerCase() === entity.toLowerCase()) ?? mentionedRefs(entity, { knownRefs: input.knownRefs, aliases: input.aliases })[0];
    const ref = guess !== undefined && (known.length === 0 || known.includes(guess)) ? guess : undefined;
    if (ref === undefined) notes.push(`The route named a customer that is not on screen: ${entity}.`);
    else if (!mayJoinScope(input, ref)) notes.push(`The route put ${ref} into the scope, but the expert did not.`);
    else merged.scope = { ...base.scope, customers: [...new Set([...base.scope.customers, ref])], explicit: base.scope.explicit || input.topic === "scope" };
  }

  if (input.topic === "guardrail") {
    merged.stopCondition = out.guardrail ? out.guardrail.condition : null;
    merged.escalateTo = base.escalateTo ?? (out.guardrail ? findEscalateTo(out.guardrail.requiredAction) : null);
  }
  if (input.topic === "exception") {
    const text = squash(input.text);
    merged.exceptions = out.exceptions.map<MapExceptionData>((e) => ({ text: e, quote: text.includes(squash(e)) ? e : out.quote }));
  }
  merged.unknowns = [...new Set([...notes, ...out.unknowns])];
  return merged;
}

export interface LlmAnswerExtractorOptions {
  client: LlmClient;
  /** Used when the model fails. Default: the heuristic extractor. */
  fallback?: AnswerExtractor;
  /** Resolves spoken customer phrases the numeric scheme cannot. */
  resolver?: EntityResolver;
}

export class LlmAnswerExtractor implements AnswerExtractor {
  readonly name = "llm";
  private readonly client: LlmClient;
  private readonly fallback: AnswerExtractor | undefined;
  private readonly resolver: EntityResolver | undefined;

  constructor(options: LlmAnswerExtractorOptions) {
    this.client = options.client;
    this.fallback = options.fallback;
    this.resolver = options.resolver;
  }

  async extract(input: ExtractionInput): Promise<AnswerExtraction> {
    const aliases = { ...(await resolveAliases(input.text, input.knownRefs, this.resolver)), ...input.aliases };
    const withAliases: ExtractionInput = { ...input, aliases };
    const base = this.fallback ? await this.fallback.extract(withAliases) : heuristicExtract(withAliases);
    if (input.topic === "ticket_note") return base;

    if (input.text.trim().length === 0 || input.text.length > MAX_ANSWER) {
      this.client.skip("answer_extraction");
      return base;
    }
    const request: AnswerExtractionRequest = {
      questionTopic: input.topic,
      questionText: questionTextFor(input),
      answerText: input.text,
      visibleFacts: {
        customerRefs: (input.knownRefs ?? []).filter((r) => r.length > 0 && r.length <= MAX_REF_LENGTH).slice(0, MAX_REFS),
        orderFields: { ...input.orderFields },
      },
    };
    const { result, startedAt } = await this.client.call("answer_extraction", request);
    if (!result.ok) {
      this.client.record("answer_extraction", startedAt, "fallback", result.reason, result.status);
      return base;
    }
    const parsed = parseAnswerExtractionOutput(result.output);
    const merged = parsed === null ? null : mergeLlmExtraction(base, parsed, withAliases);
    if (merged === null || extractionIssues(merged).length > 0) {
      this.client.record("answer_extraction", startedAt, "fallback", "invalid_output");
      return base;
    }
    this.client.record("answer_extraction", startedAt, "llm");
    return merged;
  }
}

