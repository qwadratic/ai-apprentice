// Review: follow-up questions for what is still unclear, a teach-back of the map, and the expert's reply (confirm or
// correct). Follow-ups come from gaps in the guardrails (scope, exceptions, why, who decides and for how long), not from
// a fixed list: a gap the expert already closed, even with "no", is not asked again. A correction or a confirmation
// creates an immutable map version (see map.ts).
import { DEFAULT_PERSONA, getPersona } from "../policy/personas.ts";
import type { PersonaId } from "../policy/personas.ts";
import { renderGapQuestion } from "../policy/topics.ts";
import type { GapTopic } from "../policy/topics.ts";
import type { ReviewItem } from "../policy/types.ts";
import type { AnswerExtractor } from "./extractor.ts";
import { MapConfirmationError, confirmIssues, knownCustomerRefs, latestConfirmed, reduceMap, workingMap } from "./map.ts";
import type { ConfirmIssue, MapState } from "./map.ts";
import { isAnswered, labelFacts } from "./types.ts";
import type { MapGuardrail, Question, Topic, WorkMap } from "./types.ts";

export const MAX_FOLLOW_UPS = 5;

export interface FollowUpOptions {
  max?: number;
  persona?: PersonaId;
  /** Learn questions that were held back for Review (budget used, no pause came). */
  held?: readonly ReviewItem[];
}

function answeredFor(map: WorkMap, topic: Topic, g: MapGuardrail): boolean {
  return map.answered.some((a) => a.topic === topic && a.targetId === g.id);
}

const HELD_VARIANTS = (note: string): string[] => [
  `Earlier, ${note}, and I did not get to ask. What was your thinking there?`,
  "Earlier I did not get to ask: what was your thinking there?",
];

/** At least three follow-ups while gaps remain: scope, exceptions, why the expert stops, who decides and for how long. */
export function planFollowUps(map: WorkMap, options: FollowUpOptions = {}): Question[] {
  const max = options.max ?? MAX_FOLLOW_UPS;
  const words = getPersona(options.persona ?? DEFAULT_PERSONA).maxWords;
  const out: Question[] = [];
  const push = (g: MapGuardrail, topic: GapTopic): void => {
    const who = g.scope.customers[0] ?? "this customer";
    out.push({
      id: `q-R-${out.length + 1}`,
      topic,
      text: renderGapQuestion(topic, who, words),
      evidenceIds: [...g.evidenceIds],
      targetId: g.id,
      entityRef: g.scope.customers[0] ?? null,
    });
  };
  const own = map.guardrails.filter((g) => g.trigger === "customer" && !g.unexplained);
  const stops = map.guardrails.filter((g) => g.trigger !== "customer");
  // The reason comes first: without it the rule cannot be confirmed, and a paraphrase may have hidden it during the task.
  for (const g of own) if (g.reason === null && !g.reasonUnknown && !answeredFor(map, "reason", g)) push(g, "reason");
  for (const g of own) if (!g.scope.explicit && !answeredFor(map, "scope", g)) push(g, "scope");
  for (const g of own) if (g.exceptions.length === 0 && !answeredFor(map, "exception", g)) push(g, "exception");
  for (const g of stops) if (g.reason === null && !answeredFor(map, "why_stop", g)) push(g, "why_stop");
  for (const g of own) if (g.duration === null && !answeredFor(map, "duration", g)) push(g, "duration");
  for (const h of options.held ?? []) {
    if (isAnswered(map, h.topic, h.entityRef)) continue;
    if (out.some((q) => q.topic === h.topic && q.entityRef === h.entityRef)) continue;
    const variants = HELD_VARIANTS(h.note);
    out.push({
      id: `q-R-${out.length + 1}`,
      topic: h.topic,
      text: variants.find((v) => v.split(/\s+/).length <= words) ?? variants[variants.length - 1] ?? "",
      evidenceIds: [...h.evidenceIds],
      targetId: null,
      entityRef: h.entityRef,
    });
  }
  return out.slice(0, max);
}

export interface TeachBack {
  /** What Clipa says: the map in a few sentences, ending in "Did I get that right?". */
  text: string;
  evidenceIds: string[];
  version: number;
}

/** A short spoken summary of the map for the expert to confirm or correct. */
export function buildTeachBack(map: WorkMap): TeachBack {
  const parts: string[] = [`Let me play it back (version ${map.version}).`];
  const evidenceIds: string[] = [];
  for (const g of map.guardrails) {
    for (const id of g.evidenceIds) if (!evidenceIds.includes(id)) evidenceIds.push(id);
    const why = g.reason !== null ? ` because ${g.reason}` : "";
    if (g.unexplained) {
      parts.push(`For ${g.scope.customers.join(", ")} you do something similar, but you do not know why, so I will not treat it as a rule.`);
    } else if (g.trigger === "customer") {
      const who = g.scope.kind === "all" ? "every customer" : g.scope.customers.join(", ") || "this customer";
      const what = g.requiredFacts.length > 0 ? `include the ${labelFacts(g.requiredFacts)} in the message` : "something the expert has not spelled out yet";
      const exc = g.exceptions[0] ? ` Exception: ${g.exceptions[0].text}` : "";
      parts.push(`For ${who}, when you send the delivery email: ${what}${why}.${exc}`);
    } else if (g.trigger === "unknown_entity") {
      parts.push(`If you cannot match an order to a customer, you stop and ask ${g.escalateTo ?? "someone"} before sending${why}.`);
    } else {
      parts.push(`You also stop and ask ${g.escalateTo ?? "someone"} when: ${g.condition}${why}.`);
    }
  }
  parts.push("Did I get that right?");
  return { text: parts.join(" "), evidenceIds, version: map.version };
}

export type TeachBackReply = "confirm" | "correct" | "unclear";

// Reading the expert's reply to the teach-back is FAIL-SAFE: a reply is a confirmation only when nothing substantive is left
// after the confirmation tokens are taken away. Anything added is a correction carrying the addition; anything that cannot be
// parsed is "unclear" and Review asks again. Never a confirmation that drops added content.

// Confirmation tokens, longest phrase first. "no, that's right" agrees: the "no" answers "did I get anything wrong?".
const CONFIRMATION = [
  "no,? that(?:'?s| is) (?:absolutely |exactly |completely |perfectly )?(?:right|correct)",
  "that(?:'?s| is) (?:absolutely |exactly |completely |perfectly )?(?:right|correct|it|good|fine|perfect|great|true)",
  "you(?:'ve| have)? got it(?: right)?",
  "got it",
  "sounds? (?:good|right|correct|great|fine|perfect)",
  "looks? (?:good|right|correct|great|fine|perfect)",
  "that works",
  "spot on",
  "all good",
  "go ahead",
  "(?:and )?thank you(?: very much)?",
  "(?:and )?thanks(?: a lot| very much)?",
  "very much",
  "yes|yeah|yep|yup|yea|correct|right|exactly|absolutely|definitely|indeed|agreed|perfect|great|good|fine|okay|ok|sure|alright|all right|nice|cool|true",
];
const FILLER = "um+|uh+|er+m?|hm+|hmm+|ah+|oh+|well|like|you know|i mean";
// Denials and doubts say nothing by themselves.
const DENIAL = "no|nope|nah|not quite|not exactly|not really|not right|not correct|not true|wrong|incorrect|almost|never";
const DOUBT = "i'?m not sure|not sure|i don'?t know|don'?t know|no idea|what|pardon|sorry|repeat(?: that)?|again|come again|say that|one more time|huh|what do you mean|can you|could you";
// Words that can stay after the confirmation tokens without adding anything: "sounds good TO ME", "yes IT IS".
const NEUTRAL = new Set(["to", "me", "it", "is", "are", "was", "that", "this", "i", "you", "we", "so", "very", "really", "quite", "then", "there", "here", "the", "a", "my", "your", "for", "of", "all"]);
// Words that connect or hedge but carry no content of their own: "yes, AND." cannot be parsed.
const MARKERS = new Set(["and", "but", "or", "also", "too", "as", "well", "just", "not", "if", "he", "she", "they", "his", "her", "their", "our", "an", "in", "on", "at", "with", "be", "these", "those", "its", "that's", "it's", "i'm", "you're", "thats"]);

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripAll = (core: string, phrases: readonly string[]): string => {
  const re = new RegExp(`(?:^| )(?:${phrases.join("|")})(?= |$)`, "gi");
  let prev: string;
  let out = core;
  do {
    prev = out;
    out = out.replace(re, " ").replace(/\s+/g, " ").trim();
  } while (out !== prev);
  return out;
};

// The leading run of confirmation tokens, fillers and denials of the ORIGINAL text (to cut the correction out of it verbatim).
const LEAD = new RegExp(`^(?:[\\s,.!;:-]*(?:${[...CONFIRMATION, FILLER, DENIAL].join("|")})(?![a-z']))+[\\s,.!;:-]*`, "i");

const words = (core: string): string[] => core.split(" ").filter((w) => w.length > 0);

/**
 * Reads the expert's reply to the teach-back.
 *  - confirm: nothing substantive is left once the confirmation tokens (yes, right, correct, that's right, no that's right,
 *    sounds good, thanks...) and fillers are removed.
 *  - correct: something substantive is left. It is returned as the correction (cut out of the reply verbatim when the reply
 *    opens with agreement or denial); the reply is never treated as a plain confirmation.
 *  - unclear: only doubt, denial or noise is left ("Hmm.", "I'm not sure.", "No."): Review asks again.
 * Keyword heuristic and fail-safe; LlmReplyClassifier is the model-backed one.
 */
export function readReply(text: string): ReplyVerdict {
  const core = normalise(text);
  if (core.length === 0) return { verdict: "unclear", correction: null };
  const rest = stripAll(core, [...CONFIRMATION, FILLER]);
  const confirmedSomething = rest !== stripAll(core, [FILLER]);
  if (rest.length === 0) return { verdict: confirmedSomething ? "confirm" : "unclear", correction: null };
  // What is left once denials, doubts and neutral words are taken away is the content of the reply.
  const substance = stripAll(rest, [DENIAL, DOUBT, FILLER]);
  const content = words(substance).filter((w) => !NEUTRAL.has(w) && !MARKERS.has(w));
  if (content.length > 0) {
    const lead = LEAD.exec(text.trim());
    const cut = lead === null ? "" : text.trim().slice(lead[0].length).trim();
    return { verdict: "correct", correction: cut.length > 0 ? cut : null };
  }
  // No content. Neutral leftovers after a confirmation are still a confirmation; anything else cannot be parsed.
  const onlyNeutral = substance === rest && words(rest).every((w) => NEUTRAL.has(w));
  return { verdict: confirmedSomething && onlyNeutral ? "confirm" : "unclear", correction: null };
}

export function classifyReply(text: string): TeachBackReply {
  return readReply(text).verdict;
}

export interface ReplyVerdict {
  verdict: TeachBackReply;
  /** The expert's correction in their words when the verdict is "correct" and the classifier could isolate it, else null. */
  correction: string | null;
}

/** Reads the expert's reply to a teach-back. */
export interface ReplyClassifier {
  readonly name: string;
  classify(teachBack: string, reply: string): Promise<ReplyVerdict>;
}

export class HeuristicReplyClassifier implements ReplyClassifier {
  readonly name = "heuristic";
  classify(_teachBack: string, reply: string): Promise<ReplyVerdict> {
    return Promise.resolve(readReply(reply));
  }
}

export type TeachBackOutcome =
  | { outcome: "confirmed"; state: MapState; teachBack: null; issues: [] }
  /** The correction made a new version; the next teach-back asks the expert to confirm it. */
  | { outcome: "corrected"; state: MapState; teachBack: TeachBack; issues: [] }
  /** The map cannot be confirmed (an item lacks evidence or a quote); nothing changed. */
  | { outcome: "refused"; state: MapState; teachBack: null; issues: ConfirmIssue[] }
  /** The reply was neither a confirmation nor a correction; nothing changed, ask again. */
  | { outcome: "unclear"; state: MapState; teachBack: null; issues: [] };

/**
 * Applies the expert's reply to the teach-back: confirm, or correct (a new version, extracted behind the AnswerExtractor).
 * The reply is read by `classifier` (heuristic by default).
 */
export async function applyTeachBackReply(
  state: MapState,
  reply: { text: string; atMs: number; evidenceIds?: string[] },
  extractor: AnswerExtractor,
  classifier: ReplyClassifier = new HeuristicReplyClassifier(),
): Promise<TeachBackOutcome> {
  const current = workingMap(state);
  const read = await classifier.classify(buildTeachBack(current).text, reply.text);
  if (read.verdict === "unclear") return { outcome: "unclear", state, teachBack: null, issues: [] };
  if (read.verdict === "confirm") {
    try {
      return { outcome: "confirmed", state: reduceMap(state, { type: "confirm", atMs: reply.atMs, quote: reply.text.trim() }), teachBack: null, issues: [] };
    } catch (e) {
      if (e instanceof MapConfirmationError) return { outcome: "refused", state, teachBack: null, issues: e.confirmIssues };
      throw e;
    }
  }
  // A correction the classifier isolated is used when it really is the expert's wording; otherwise the whole reply.
  const text = read.correction !== null && reply.text.includes(read.correction) ? read.correction : reply.text;
  const extraction = await extractor.extract({
    topic: "correction",
    text,
    questionId: null,
    atMs: reply.atMs,
    evidenceIds: reply.evidenceIds ?? [],
    targetId: null,
    entityRef: null,
    knownRefs: knownCustomerRefs(state),
  });
  // Fail-safe: a correction that changes nothing the map can hold (no field, no scope, no reason) is not applied as one.
  if (extraction.requiredFacts.length === 0 && !extraction.scope.all && extraction.scope.customers.length === 0 && extraction.rationale === null && !extraction.retracts) {
    return { outcome: "unclear", state, teachBack: null, issues: [] };
  }
  const next = reduceMap(state, { type: "correct", extraction });
  return { outcome: "corrected", state: next, teachBack: buildTeachBack(workingMap(next)), issues: [] };
}

export interface ReviewStatus {
  /** Gaps still to ask about. */
  openFollowUps: Question[];
  /** What would stop the working version from being confirmed. */
  blockers: ConfirmIssue[];
  /** The latest confirmed version, or null. */
  confirmed: WorkMap | null;
  /** Review is done when no follow-up is left and the working version is the confirmed one. */
  done: boolean;
}

/** How the debrief decides it is done: every gap closed, then a teach-back the expert confirmed with nothing changed since. */
export function reviewStatus(state: MapState, options: FollowUpOptions = {}): ReviewStatus {
  const working = workingMap(state);
  const confirmed = latestConfirmed(state);
  const openFollowUps = planFollowUps(working, { ...options, max: Number.MAX_SAFE_INTEGER });
  return {
    openFollowUps,
    blockers: confirmIssues(state),
    confirmed,
    done: openFollowUps.length === 0 && confirmed !== null && confirmed.version === working.version && !state.draft.dirty,
  };
}
