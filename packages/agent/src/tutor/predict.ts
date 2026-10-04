// Teach, before the new hire acts: "what would you do here?". The question is built from the latest confirmed map and
// the persona's style; the answer is compared with the map. At the end, a mastery summary says what was mastered and
// what to practise. Heuristic: the comparison reads keywords in the answer (no negation handling, no paraphrase).
import type { OrderFacts } from "@apprentice/contracts";
import { extractFactsOrAll } from "../knowledge/heuristic-extractor.ts";
import { guardrailsFor, labelFacts } from "../knowledge/types.ts";
import type { FactKey, WorkMap } from "../knowledge/types.ts";
import { PERSONAS, wordCount } from "../policy/personas.ts";
import type { Persona } from "../policy/personas.ts";

/** write_out: the map says the message must carry some order fields. ask: the map says do not guess. usual: nothing on the map changes the usual way. */
export type PredictExpect = "write_out" | "ask" | "usual";

export interface Prediction {
  question: string;
  expect: PredictExpect;
  /** The fields the map expects in the message (write_out). */
  facts: FactKey[];
  guardrailId: string | null;
  /** The expert's moments behind the expectation. */
  evidenceIds: string[];
  /** The expert's words behind the expectation, for the hint. */
  quotes: string[];
  /** Two-choice style only: the choices as spoken, in spoken order, and which one the map expects. */
  options: [string, string] | null;
  correctOption: 0 | 1 | null;
  mapVersion: number;
}

const SEND_AS_USUAL = "send as usual";

function pick(variants: readonly string[], maxWords: number): string {
  return variants.find((v) => wordCount(v) <= maxWords) ?? variants[variants.length - 1] ?? "";
}

/** A fixed, content-free way to vary which choice comes first. */
function swapOptions(orderId: string | null): boolean {
  let sum = 0;
  for (const ch of orderId ?? "") sum += ch.charCodeAt(0);
  return sum % 2 === 1;
}

/** Before the new hire acts: what would they do, according to the map? */
export function buildPrediction(order: OrderFacts, map: WorkMap | null, persona: Persona = PERSONAS.plain): Prediction {
  const id = order.orderId ?? "this order";
  const empty = { facts: [] as FactKey[], guardrailId: null, evidenceIds: [] as string[], quotes: [] as string[], options: null, correctOption: null };
  const mapVersion = map?.version ?? 0;

  let expect: PredictExpect = "usual";
  let facts: FactKey[] = [];
  let guardrailId: string | null = null;
  let evidenceIds: string[] = [];
  let quotes: string[] = [];
  if (order.customerRef === null) {
    // An order that cannot be matched to a customer is never guessed, with or without a map.
    const stop = map?.guardrails.find((g) => g.trigger === "unknown_entity");
    expect = "ask";
    guardrailId = stop?.id ?? null;
    evidenceIds = [...(stop?.evidenceIds ?? [])];
    quotes = stop?.quote ? [stop.quote] : [];
  } else if (map !== null) {
    const mine = guardrailsFor(map, order.customerRef);
    const first = mine[0];
    if (first) {
      guardrailId = first.id;
      evidenceIds = [...first.evidenceIds];
      quotes = first.quote ? [first.quote] : [];
      if (mine.some((g) => g.status !== "confirmed")) expect = "ask";
      else {
        expect = "write_out";
        facts = [...first.requiredFacts];
      }
    }
  }
  if (expect === "usual") return { ...empty, question: `What would you do on ${id}?`, expect, mapVersion };

  const learned = expect === "write_out" ? `add the ${labelFacts(facts)} to the message` : "check with someone first";
  const learnedShort = expect === "write_out" ? "add the details to the message" : "check first";
  const style = persona.predictStyle;
  if (style === "two_choices") {
    const swap = swapOptions(order.orderId);
    const make = (l: string): [string, string] => (swap ? [SEND_AS_USUAL, l] : [l, SEND_AS_USUAL]);
    const full = make(learned);
    const short = make(learnedShort);
    const q = (o: [string, string]): string => `For ${id}: ${o[0]}, or ${o[1]}?`;
    const options = wordCount(q(full)) <= persona.maxWords ? full : short;
    return {
      question: q(options),
      expect,
      facts,
      guardrailId,
      evidenceIds,
      quotes,
      options,
      correctOption: swap ? 1 : 0,
      mapVersion,
    };
  }
  const question =
    style === "one_word"
      ? pick([`What next with ${id}?`], persona.maxWords)
      : style === "before_send"
        ? pick([`Before Send on ${id}: what will you do, and why?`, `What will you do on ${id}?`], persona.maxWords)
        : pick([`What will you do with the email for ${id}, and why?`, `What will you do on ${id}, and why?`], persona.maxWords);
  return { ...empty, question, expect, facts, guardrailId, evidenceIds, quotes, mapVersion };
}

export type PredictionVerdict = "match" | "partial" | "miss";

export interface PredictionEvaluation {
  verdict: PredictionVerdict;
  feedback: string;
  /** The expert's words to show with the hint on a partial match or a miss. */
  quotes: string[];
}

const ASK_CUE = /\b(ask|check|stop|not sure|don't know|do not know|confirm|who)\b/i;
const HOLD_CUE = /\b(stop|ask|check with)\b/i;

/** A bare choice between the two spoken options ("the first one", "option 2"); anything longer is read as a free answer. */
function chosenOption(answer: string): 0 | 1 | null {
  const bare = /^\s*(?:i('d| would)? (?:take|pick|choose) )?(?:the |option )?(first|1st|one|1|second|2nd|two|2)(?: one| option)?\s*[.!]?\s*$/i.exec(answer);
  const word = bare?.[2]?.toLowerCase();
  if (word === undefined) return null;
  return ["first", "1st", "one", "1"].includes(word) ? 0 : 1;
}

/** Compare what the new hire says they would do with what the map expects. */
export function evaluatePrediction(p: Prediction, answer: string): PredictionEvaluation {
  const hint = p.quotes;
  if (p.options !== null && p.correctOption !== null) {
    const idx = chosenOption(answer);
    if (idx !== null) {
      return idx === p.correctOption
        ? { verdict: "match", feedback: "That is what the expert did.", quotes: [] }
        : { verdict: "miss", feedback: "That is not what the expert did here. I will check again before Send.", quotes: hint };
    }
  }
  if (p.expect === "ask") {
    return ASK_CUE.test(answer)
      ? { verdict: "match", feedback: "Yes. The expert would not guess here either.", quotes: [] }
      : { verdict: "miss", feedback: "The expert would not guess here. Watch for what I flag at Preview.", quotes: hint };
  }
  if (p.expect === "usual") {
    return HOLD_CUE.test(answer)
      ? { verdict: "partial", feedback: "There is nothing on the map that needs holding up here.", quotes: [] }
      : { verdict: "match", feedback: "Right: nothing on the map changes the usual way here.", quotes: [] };
  }
  const given = new Set(extractFactsOrAll(answer));
  const hit = p.facts.filter((f) => given.has(f)).length;
  if (hit === p.facts.length && hit > 0) return { verdict: "match", feedback: "That matches what the expert did.", quotes: [] };
  if (hit > 0) {
    return { verdict: "partial", feedback: "Close, but one detail from the expert's flow is missing. I will check again before Send.", quotes: hint };
  }
  return { verdict: "miss", feedback: "That is not what the expert did here. I will check before Send.", quotes: hint };
}

export interface CaseOutcome {
  caseId: string;
  title: string;
  verdict: PredictionVerdict;
  /** What the checkpoint said the first time the new hire reached Send. */
  firstStatus: "clear" | "warn" | "unknown";
  sent: boolean;
}

export interface Mastery {
  mastered: string[];
  practise: string[];
  lines: string[];
}

/** Mastered: predicted like the expert and needed no stop. Practise: everything else. */
export function summarizeMastery(outcomes: readonly CaseOutcome[]): Mastery {
  const mastered: string[] = [];
  const practise: string[] = [];
  const lines: string[] = [];
  for (const o of outcomes) {
    const caught = o.firstStatus === "warn";
    const good = o.verdict === "match" && !caught;
    (good ? mastered : practise).push(o.caseId);
    const what = good
      ? o.firstStatus === "unknown"
        ? "asked instead of guessing"
        : "matched the expert without a stop"
      : [o.verdict !== "match" ? "predicted differently from the expert" : "", caught ? "needed the stop before Send" : ""]
          .filter(Boolean)
          .join(" and ");
    lines.push(`${o.caseId.toUpperCase()} ${o.title}: ${good ? "mastered" : "practise"} (${what})`);
  }
  return { mastered, practise, lines };
}
