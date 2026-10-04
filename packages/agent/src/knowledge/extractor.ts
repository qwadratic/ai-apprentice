// Answer extraction: what the expert said (free text, final transcript) becomes a structured claim.
// The Work Map reducer only ever sees an AnswerExtraction, so an LLM-backed extractor can replace the heuristic one
// without touching the map: record its output and replay it (the reducer is deterministic).
import type { FactKey, MapExceptionData, Topic } from "./types.ts";

export interface ExtractionInput {
  /** What was asked, or "correction" for the expert's reply to the teach-back. */
  topic: Topic | "correction";
  /** The expert's answer as transcribed. */
  text: string;
  questionId: string | null;
  atMs: number;
  /** The screen moments the question was about. */
  evidenceIds: string[];
  /** The guardrail a Review follow-up extends, or null. */
  targetId: string | null;
  /** The customer the question concerned, or null. */
  entityRef: string | null;
}

export interface AnswerExtraction {
  schemaVersion: 1;
  // Echoed from the input, so the reducer needs nothing else.
  topic: Topic | "correction";
  questionId: string | null;
  atMs: number;
  evidenceIds: string[];
  targetId: string | null;
  entityRef: string | null;
  /** The whole answer. */
  text: string;
  /** The expert's own words that carry the main claim. Must occur verbatim in `text`. */
  quote: string;
  /** The clause that explains why, or null. */
  rationale: string | null;
  /** The sentence that carries the reason, or null. */
  reasonQuote: string | null;
  /** The expert said they do not know why. */
  reasonUnknown: boolean;
  scope: { explicit: boolean; all: boolean; customers: string[] };
  /** The expert's words that limit or widen the scope, when stated. */
  scopeQuote: string | null;
  /** Order fields the expert named as essential. */
  requiredFacts: FactKey[];
  exceptions: MapExceptionData[];
  /** Open points the expert left unresolved. */
  unknowns: string[];
  /** The condition after "if ..., I stop/ask/check", or null. */
  stopCondition: string | null;
  /** Who the expert asks or defers to, or null. */
  escalateTo: string | null;
  /** Customers named in a sentence where the expert admits not knowing why. */
  unexplainedCustomers: Array<{ customerRef: string; quote: string }>;
  /** The expert takes something back. */
  retracts: boolean;
  confirms: boolean;
  /** 0 to 1. The heuristic extractor never reports more than 0.9. */
  confidence: number;
}

export interface AnswerExtractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<AnswerExtraction>;
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Problems that make an extraction unusable: an empty quote, or a quote that is not the expert's own words. */
export function extractionIssues(x: AnswerExtraction): string[] {
  const issues: string[] = [];
  if (x.quote.trim().length === 0) issues.push("quote is empty");
  else if (!squash(x.text).includes(squash(x.quote))) issues.push("quote does not occur in the expert's answer");
  if (!Number.isFinite(x.confidence) || x.confidence < 0 || x.confidence > 1) issues.push("confidence outside 0..1");
  for (const e of x.exceptions) {
    if (!squash(x.text).includes(squash(e.quote))) issues.push("exception quote does not occur in the expert's answer");
  }
  return issues;
}
