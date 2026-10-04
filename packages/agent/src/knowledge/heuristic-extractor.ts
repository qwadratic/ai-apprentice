// Heuristic answer extraction: sentence splitting and keyword cues. No model, no network.
// Its vocabulary is generic (reason words, scope words, the names of order fields); it contains no customer rule.
// It is deliberately simple and has known blind spots (negation, pronouns, deep paraphrase); an LLM extractor behind the
// same AnswerExtractor interface (llm/) replaces it where it is available, and falls back to this one.
import { mentionedRefs, resolveAliases } from "./entities.ts";
import type { EntityResolver } from "./entities.ts";
import type { AnswerExtraction, AnswerExtractor, ExtractionInput } from "./extractor.ts";
import { FACT_KEYS } from "./types.ts";
import type { FactKey, MapExceptionData } from "./types.ts";

const FACT_PATTERNS: ReadonlyArray<readonly [FactKey, RegExp]> = [
  ["deliveryAddress", /\b(address|street)\b/i],
  ["deliveryWindow", /\b(window|time ?slot|delivery (time|date|slot|day)|time|date)\b/i],
  ["orderId", /\border (number|id|no\.?|ref(erence)?)\b|\bORD-\d+|\border ?#/i],
];

/** The reason follows the cue: "because the customer asked". */
const REASON_CUE = /\b(because|since|so that|the reason( is)?|due to|owing to|on account of)\b/i;
/** The reason comes before the cue: "the customer asked, that is why I ...". */
const REASON_BEFORE_CUE = /\b(that's why|that is why|which is why|this is why|that's the reason|hence|therefore)\b/i;
const UNKNOWN_REASON_CUE =
  /\b(never (found out|asked|learned|knew)|no idea|don't know why|do not know why|not sure why|can't say why|dunno|idk|no clue|just because|no (particular |real )?reason)\b/i;
const EXCEPTION_CUE = /\b(fine|ok|okay|allowed|acceptable|no problem|doesn't matter|does not matter|on top)\b/i;
const RETRACT_CUE = /\b(actually,? (no|not)|not needed any more|no longer|ignore that|scratch that|never mind)\b/i;
const CONFIRM_CUE = /^\s*(yes|yep|yeah|correct|right|exactly|that's (right|correct)|confirmed)\b/i;
const ALL_CUE = /\b(all|every|each|any) (other )?customers?\b|\beveryone\b|\bin general\b/i;
const NOT_ALL_CUE = /\bno (other )?customers?\b|\bnot (for )?(all|every|other)\b/i;
const ONLY_CUE = /\b(only|just)\b/i;
const STOP_CUE = /\bif (.+?),? I (stop|hold|ask|check|escalate)\b/i;
const WHO_CUE =
  /\b(?:ask|check with|call|escalate to|tell|ping)\s+((?:the|my)\s+[a-z]+(?:\s+[a-z]+)?)(?=\s+(?:first|before|about)|[.,;!?]|$)/i;
const LEADING_FILLER = /^(?:(?:well|so|um|uh|er|hmm|yeah|yes|yep|okay|ok|right|sure|honestly|basically|actually|look)\b[\s,.-]*)+/i;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractFacts(text: string): FactKey[] {
  const found: FactKey[] = [];
  for (const [key, re] of FACT_PATTERNS) if (re.test(text)) found.push(key);
  return found;
}

/** Every fact the answer says is wanted ("everything", "all the details"), in canonical order. */
export function extractFactsOrAll(text: string): FactKey[] {
  return /\b(everything|all of it|all the details)\b/i.test(text) ? [...FACT_KEYS] : extractFacts(text);
}

const stripEnd = (s: string): string => s.replace(/[\s.!?,;:-]+$/, "").trim();

/** Who the expert asks or defers to in a sentence ("ask the finance lead first"), or null. */
export function findEscalateTo(text: string): string | null {
  return WHO_CUE.exec(text)?.[1]?.trim() ?? null;
}

function clauseAfter(sentence: string, cue: RegExp): string | null {
  const m = cue.exec(sentence);
  if (!m) return null;
  const rest = sentence.slice(m.index + m[0].length).replace(/^[\s,:-]+/, "");
  const clause = rest
    .split(/(?<=[.!?])\s|,\s*so\b/i)[0]
    ?.replace(/[.!?]+$/, "")
    .trim();
  return clause && clause.length > 2 ? clause : null;
}

function clauseBefore(sentence: string, cue: RegExp): string | null {
  const m = cue.exec(sentence);
  if (!m) return null;
  const clause = stripEnd(sentence.slice(0, m.index));
  return clause.length > 2 ? clause : null;
}

export function heuristicExtract(input: ExtractionInput): AnswerExtraction {
  const text = input.text.trim();
  const sentences = splitSentences(text);
  const mentions = (s: string): string[] => mentionedRefs(s, { knownRefs: input.knownRefs, aliases: input.aliases });
  const asksWhy = input.topic === "reason" || input.topic === "why_stop";

  let rationale: string | null = null;
  let reasonQuote: string | null = null;
  let reasonUnknown = false;
  let scopeExplicit = false;
  let scopeAll = false;
  let scopeQuote: string | null = null;
  let stopCondition: string | null = null;
  let stopQuote: string | null = null;
  let escalateTo: string | null = null;
  const exceptions: MapExceptionData[] = [];
  const unexplainedCustomers: Array<{ customerRef: string; quote: string }> = [];
  const scopeCustomers = new Set<string>();
  let namedCustomerSentence: string | null = null;
  const unknowns: string[] = [];

  sentences.forEach((s, i) => {
    const unknownWhy = UNKNOWN_REASON_CUE.test(s);
    const refs = mentions(s);
    if (unknownWhy) {
      reasonUnknown = true;
      for (const ref of refs) {
        unexplainedCustomers.push({ customerRef: ref, quote: s });
        unknowns.push(`The expert does not know why ${ref} is treated this way.`);
      }
      if (refs.length === 0) unknowns.push("The expert does not know why.");
    } else {
      for (const ref of refs) scopeCustomers.add(ref);
      if (refs.length > 0) namedCustomerSentence ??= s;
    }
    if (rationale === null && !unknownWhy) {
      const after = REASON_CUE.test(s) ? clauseAfter(s, REASON_CUE) : null;
      if (after) {
        rationale = after;
        reasonQuote = s;
      } else if (REASON_BEFORE_CUE.test(s)) {
        const before = clauseBefore(s, REASON_BEFORE_CUE);
        const previous = sentences[i - 1];
        if (before) {
          rationale = before;
          reasonQuote = s;
        } else if (previous !== undefined && stripEnd(previous).length > 2) {
          rationale = stripEnd(previous);
          reasonQuote = previous;
        }
      }
    }
    if (ALL_CUE.test(s) && !NOT_ALL_CUE.test(s)) {
      scopeAll = true;
      scopeExplicit = true;
      scopeQuote ??= s;
    } else if (ONLY_CUE.test(s) && input.topic === "scope" && !unknownWhy) {
      scopeExplicit = true;
      scopeQuote ??= s;
    }
    if (input.topic === "exception" && EXCEPTION_CUE.test(s)) exceptions.push({ text: s, quote: s });
    const cond = STOP_CUE.exec(s);
    if (cond && stopCondition === null) {
      stopCondition = cond[1]?.trim() ?? null;
      stopQuote = s;
    }
    const who = WHO_CUE.exec(s);
    if (who && escalateTo === null) escalateTo = who[1]?.trim() ?? null;
  });

  const retracts = RETRACT_CUE.test(text);
  // A "why" question was asked and the answer gives something other than "I don't know": that something is the reason,
  // whether or not the expert said "because". The whole answer (minus leading filler) is kept in their own words.
  if (asksWhy && rationale === null && !reasonUnknown && !retracts) {
    const body = stripEnd(text.replace(LEADING_FILLER, ""));
    if (body.split(/\s+/).filter(Boolean).length >= 3) {
      rationale = body;
      reasonQuote = text;
    }
  }

  // A scope answer that names customers is explicit even without "only" or "all".
  if (input.topic === "scope" && !scopeExplicit && scopeCustomers.size > 0) {
    scopeExplicit = true;
    scopeQuote ??= namedCustomerSentence;
  }

  const requiredFacts = extractFacts(text);
  const factSentence = sentences.find((s) => extractFacts(s).length > 0) ?? null;

  let quote: string;
  let evidenceOfClaim: boolean;
  switch (input.topic) {
    case "reason":
    case "why_stop":
      quote = reasonQuote ?? text;
      evidenceOfClaim = rationale !== null;
      break;
    case "essentials":
      quote = factSentence ?? text;
      evidenceOfClaim = requiredFacts.length > 0;
      break;
    case "guardrail":
      quote = stopQuote ?? text;
      evidenceOfClaim = stopCondition !== null;
      break;
    case "scope":
      quote = scopeQuote ?? text;
      evidenceOfClaim = scopeExplicit;
      break;
    case "exception":
      quote = exceptions[0]?.quote ?? text;
      evidenceOfClaim = exceptions.length > 0;
      break;
    default:
      quote = text;
      evidenceOfClaim = false;
  }

  return {
    schemaVersion: 1,
    topic: input.topic,
    questionId: input.questionId,
    atMs: input.atMs,
    evidenceIds: [...input.evidenceIds],
    targetId: input.targetId,
    entityRef: input.entityRef,
    text,
    quote,
    rationale,
    reasonQuote,
    reasonUnknown,
    scope: { explicit: scopeExplicit, all: scopeAll, customers: [...scopeCustomers] },
    scopeQuote,
    requiredFacts,
    exceptions,
    unknowns,
    stopCondition,
    escalateTo,
    unexplainedCustomers,
    retracts,
    confirms: CONFIRM_CUE.test(text),
    confidence: evidenceOfClaim ? 0.7 : 0.4,
  };
}

export class HeuristicAnswerExtractor implements AnswerExtractor {
  readonly name = "heuristic";
  private readonly resolver: EntityResolver | undefined;
  /** An optional EntityResolver resolves spoken customer phrases the numeric scheme cannot ("customer Kowalski"). */
  constructor(resolver?: EntityResolver) {
    this.resolver = resolver;
  }
  async extract(input: ExtractionInput): Promise<AnswerExtraction> {
    const aliases = { ...(await resolveAliases(input.text, input.knownRefs, this.resolver)), ...input.aliases };
    return heuristicExtract({ ...input, aliases });
  }
}
