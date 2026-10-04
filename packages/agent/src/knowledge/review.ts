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

const FILLER = /^(?:(?:well|so|um|uh|er|hmm|oh|ah|okay|ok|alright|all right|yeah|yes|yep|yup|sure)\b[\s,.!-]*)+/i;
const AFFIRM = /\b(yes|yep|yeah|yup|correct|right|exactly|confirmed?|sounds (good|right|correct)|looks (good|right|correct)|that works|that's (right|correct|it|good|fine|perfect)|perfect|spot on|agreed|go ahead|good|fine|okay|ok|sure)\b/i;
// Words that turn an agreement into a correction.
const HEDGE =
  /\b(but|except|one thing|correction|almost|not quite|wrong|actually|however|missing|forgot|also|add|instead|incorrect)\b|\b(not|isn't|aren't|wasn't) (quite |exactly |really |entirely )?(right|correct|true|good|fine|accurate|it|what)\b|^\W*no\b(?!\s+(problem|worries|issue|doubt))/i;
const UNSURE = /\b(not sure|don't know|do not know|no idea|hmm+|repeat|again|pardon|what\?|come again)\b/i;

/**
 * The expert confirms the teach-back, corrects it, or the reply cannot be told. Agreement can come first ("Okay, that's
 * correct", "Uh, yes, that's right", "Sounds good"); a "but", an addition or a negation turns it into a correction; a reply
 * with no agreement and no content ("Hmm", "I'm not sure") is unclear. Keyword heuristic; see LlmReplyClassifier for the model-backed one.
 */
export function classifyReply(text: string): TeachBackReply {
  const body = text.trim().replace(FILLER, (m) => (AFFIRM.test(m) ? m : ""));
  const words = body.split(/\s+/).filter(Boolean).length;
  if (HEDGE.test(body)) return "correct";
  if (UNSURE.test(body)) return "unclear";
  if (AFFIRM.test(body) && words <= 25) return "confirm";
  if (words <= 2) return "unclear";
  return "correct";
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
    return Promise.resolve({ verdict: classifyReply(reply), correction: null });
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
