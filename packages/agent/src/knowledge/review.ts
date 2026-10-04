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
import { isVetoed } from "./heuristic-extractor.ts";
import { MapConfirmationError, confirmIssues, confirmationOf, knownCustomerRefs, latestConfirmed, reduceMap, teachBackDigest, workingMap } from "./map.ts";
import type { ConfirmIssue, MapState } from "./map.ts";
import { isAnswered, labelFacts } from "./types.ts";
import type { MapGuardrail, Question, Topic, WorkMap } from "./types.ts";

export const MAX_FOLLOW_UPS = 5;

export interface FollowUpOptions {
  max?: number;
  persona?: PersonaId;
  /** Learn questions that were held back for Review (budget used, no pause came). */
  held?: readonly ReviewItem[];
  /** Follow-ups the expert could not be understood on and that were skipped (see ReviewClarifier): never asked again. */
  unresolved?: readonly string[];
}

/** The identity of a follow-up across plans: its topic and the guardrail it extends. */
export function followUpKey(q: Pick<Question, "topic" | "targetId">): string {
  return `${q.topic}:${q.targetId ?? ""}`;
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
  const skipped = new Set(options.unresolved ?? []);
  const push = (g: MapGuardrail, topic: GapTopic): void => {
    if (skipped.has(followUpKey({ topic, targetId: g.id }))) return;
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
  /** The fingerprint of what this teach-back states (teachBackDigest). A confirmation is valid only for this digest. */
  digest: string;
}

const listOf = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * The spoken summary of the map for the expert to confirm or correct. It states every guardrail explicitly: the scope ("only for
 * customer_07", "for every customer"), the fields required, the exception (or that none was stated) and the reason (or "reason
 * unknown"). Nothing is applied in Teach until the expert has confirmed exactly this version.
 */
export function buildTeachBack(map: WorkMap): TeachBack {
  const parts: string[] = [`Let me play it back (version ${map.version}).`];
  const evidenceIds: string[] = [];
  for (const g of map.guardrails) {
    for (const id of g.evidenceIds) if (!evidenceIds.includes(id)) evidenceIds.push(id);
    const reason = g.reason !== null ? `Reason: ${g.reason}.` : "Reason unknown.";
    if (g.unexplained) {
      parts.push(`For ${listOf(g.scope.customers)} you do something similar, but you do not know why, so I will not treat it as a rule.`);
    } else if (g.trigger === "customer") {
      const scope =
        g.scope.kind === "all"
          ? "for every customer"
          : `only for ${listOf(g.scope.customers) || "this customer"}${g.scope.explicit ? "" : " (you did not say; I assume it from the screen)"}`;
      const what = g.requiredFacts.length > 0 ? `the email must include the ${labelFacts(g.requiredFacts)}` : "I do not know yet what the email must include";
      const exc = g.exceptions.length > 0 ? `Exception: ${g.exceptions.map((e) => e.text).join(" ")}` : "No exception stated.";
      parts.push(`Scope: ${scope}. ${what[0]?.toUpperCase() ?? ""}${what.slice(1)}. ${exc} ${reason}`);
    } else if (g.trigger === "unknown_entity") {
      parts.push(`If you cannot match an order to a customer, you stop and ask ${g.escalateTo ?? "someone"} before sending. ${reason}`);
    } else {
      parts.push(`You also stop and ask ${g.escalateTo ?? "someone"} when: ${g.condition}. ${reason}`);
    }
  }
  parts.push("Did I get that right?");
  return { text: parts.join(" "), evidenceIds, version: map.version, digest: teachBackDigest(map) };
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
// No scope word is neutral: "Yes, it is for all." carries a scope.
const NEUTRAL = new Set(["to", "me", "it", "is", "are", "was", "that", "this", "i", "you", "we", "so", "very", "really", "quite", "then", "there", "here", "the", "a", "my", "your", "for", "of"]);
// Words that connect or hedge but carry no content of their own: "yes, AND." cannot be parsed.
const MARKERS = new Set(["and", "but", "or", "also", "too", "as", "well", "not", "if", "he", "she", "they", "his", "her", "their", "our", "an", "in", "on", "at", "with", "be", "these", "those", "its", "that's", "it's", "i'm", "you're", "thats"]);

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
  if (core.length === 0 || text.includes("?")) return { verdict: "unclear", correction: null };
  const rest = stripAll(core, [...CONFIRMATION, FILLER]);
  const confirmedSomething = rest !== stripAll(core, [FILLER]);
  if (rest.length === 0) return { verdict: confirmedSomething ? "confirm" : "unclear", correction: null };
  // The global veto: a negation, a hedge or a contrast in what is left makes the reply unparseable for the heuristic.
  if (isVetoed(rest)) return { verdict: "unclear", correction: null };
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
  | { outcome: "unclear"; state: MapState; teachBack: null; issues: [] }
  /** The map changed since the teach-back the expert heard: nothing is confirmed; state the current version again. */
  | { outcome: "stale"; state: MapState; teachBack: TeachBack; issues: [] };

/**
 * Applies the expert's reply to the teach-back: confirm, or correct (a new version, extracted behind the AnswerExtractor).
 * The reply is read by `classifier` (heuristic by default).
 */
export async function applyTeachBackReply(
  state: MapState,
  reply: { text: string; atMs: number; evidenceIds?: string[] },
  extractor: AnswerExtractor,
  classifier: ReplyClassifier = new HeuristicReplyClassifier(),
  /** The teach-back the expert heard, when it is not the current one. */
  heard?: TeachBack,
): Promise<TeachBackOutcome> {
  const current = buildTeachBack(workingMap(state));
  // The gate: a reply answers the teach-back it followed. If the map moved on since, nothing is confirmed.
  if (heard !== undefined && heard.digest !== current.digest) return { outcome: "stale", state, teachBack: current, issues: [] };
  let read = await classifier.classify(current.text, reply.text);
  // A confirmation is a reply that is only confirmation tokens, whoever classified it: a model cannot confirm what the words do not.
  if (read.verdict === "confirm" && readReply(reply.text).verdict !== "confirm") read = { verdict: "unclear", correction: null };
  if (read.verdict === "unclear") return { outcome: "unclear", state, teachBack: null, issues: [] };
  if (read.verdict === "confirm") {
    try {
      return { outcome: "confirmed", state: reduceMap(state, confirmationOf(state, reply.atMs, reply.text.trim())), teachBack: null, issues: [] };
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

// ---------------------------------------------------------------------------
// Unclear replies: ask again once, then hand over to buttons and move on
// ---------------------------------------------------------------------------

export const REVIEW_BUTTONS = ["confirm", "correct", "skip"] as const;
export type ReviewButton = (typeof REVIEW_BUTTONS)[number];

/** What to do after an unclear reply. */
export type ClarifyStep =
  /** Ask the same question once more (attempt 1 is the first re-ask). */
  | { kind: "ask_again"; itemId: string; attempt: number }
  /** Stop asking. The item is unresolved; show Confirm / Correct / Skip as buttons and move on. */
  | { kind: "buttons"; itemId: string; options: readonly ReviewButton[] };

/**
 * Keeps the review from looping on an expert the heuristic cannot understand. An item is a teach-back (`teachback:<version>`)
 * or a follow-up (`followUpKey`). After MAX_UNCLEAR consecutive unclear replies to the same item the clarifier stops asking:
 * the item is marked unresolved and the host shows Confirm / Correct / Skip buttons. A reply that is not unclear starts the
 * count again. Five unclear replies in a row produce at most one re-ask.
 */
export const MAX_UNCLEAR = 2;

export class ReviewClarifier {
  private readonly counts = new Map<string, number>();
  private readonly open = new Set<string>();

  /** An unclear reply to this item. */
  unclear(itemId: string): ClarifyStep {
    const n = (this.counts.get(itemId) ?? 0) + 1;
    this.counts.set(itemId, n);
    if (n >= MAX_UNCLEAR) {
      this.open.add(itemId);
      return { kind: "buttons", itemId, options: REVIEW_BUTTONS };
    }
    return { kind: "ask_again", itemId, attempt: n };
  }

  /** A reply that could be read (or a button): the count for this item starts again. */
  understood(itemId: string): void {
    this.counts.delete(itemId);
    this.open.delete(itemId);
  }

  /** Skip was pressed: the item stays unresolved and is not asked again. */
  skip(itemId: string): void {
    this.open.add(itemId);
  }

  isUnresolved(itemId: string): boolean {
    return this.open.has(itemId);
  }

  /** Items the review gave up asking about, to show as open points and to pass to planFollowUps as `unresolved`. */
  unresolved(): string[] {
    return [...this.open];
  }
}

export type ButtonOutcome =
  | { outcome: "confirmed"; state: MapState }
  /** The map changed since the teach-back the expert heard: nothing was confirmed. */
  | { outcome: "stale"; state: MapState; teachBack: TeachBack }
  /** The expert wants to correct: the host takes their words (voice or text) and passes them to applyTeachBackReply. */
  | { outcome: "needs_words"; state: MapState }
  | { outcome: "skipped"; state: MapState }
  | { outcome: "refused"; state: MapState; issues: ConfirmIssue[] };

/**
 * A button press on an item the review stopped asking about. Confirm on the teach-back confirms the working map (refused, with
 * the issues, if an item lacks evidence or a quote); Confirm on a follow-up means there is nothing to add. Skip leaves the
 * item unresolved. Correct asks for the expert's words.
 */
export function pressReviewButton(
  state: MapState,
  clarifier: ReviewClarifier,
  itemId: string,
  button: ReviewButton,
  atMs: number,
  /** The teach-back the expert heard, when the buttons belong to one. */
  heard?: TeachBack,
): ButtonOutcome {
  if (button === "skip") {
    clarifier.skip(itemId);
    return { outcome: "skipped", state };
  }
  if (button === "correct") return { outcome: "needs_words", state };
  if (!itemId.startsWith("teachback:")) {
    clarifier.understood(itemId);
    return { outcome: "confirmed", state };
  }
  const current = buildTeachBack(workingMap(state));
  if (heard !== undefined && heard.digest !== current.digest) return { outcome: "stale", state, teachBack: current };
  try {
    const next = reduceMap(state, confirmationOf(state, atMs, "(confirmed with the button)"));
    clarifier.understood(itemId);
    return { outcome: "confirmed", state: next };
  } catch (e) {
    if (e instanceof MapConfirmationError) return { outcome: "refused", state, issues: e.confirmIssues };
    throw e;
  }
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
