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
import { MapConfirmationError, confirmIssues, latestConfirmed, reduceMap, workingMap } from "./map.ts";
import type { ConfirmIssue, MapState } from "./map.ts";
import { isAnswered, labelFacts } from "./types.ts";
import type { MapGuardrail, Question, Topic, WorkMap } from "./types.ts";

export const MAX_FOLLOW_UPS = 4;

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
  for (const g of own) if (!g.scope.explicit && !answeredFor(map, "scope", g)) push(g, "scope");
  for (const g of own) if (g.exceptions.length === 0 && !answeredFor(map, "exception", g)) push(g, "exception");
  for (const g of stops) if (g.reason === null && !answeredFor(map, "why_stop", g)) push(g, "why_stop");
  for (const g of own) if (g.duration === null && !answeredFor(map, "duration", g)) push(g, "duration");
  for (const h of options.held ?? []) {
    if (isAnswered(map, h.topic, h.entityRef)) continue;
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

export type TeachBackReply = "confirm" | "correct";

/** The expert either confirms the teach-back or corrects it. A confirmation with a "but" is a correction. */
export function classifyReply(text: string): TeachBackReply {
  const confirms = /^\s*(yes|yep|yeah|correct|right|exactly|that's (right|correct)|confirmed)\b/i.test(text);
  const hedges = /\b(but|except|one thing|correction|almost|not quite|wrong)\b/i.test(text);
  return confirms && !hedges ? "confirm" : "correct";
}

export type TeachBackOutcome =
  | { outcome: "confirmed"; state: MapState; teachBack: null; issues: [] }
  /** The correction made a new version; the next teach-back asks the expert to confirm it. */
  | { outcome: "corrected"; state: MapState; teachBack: TeachBack; issues: [] }
  /** The map cannot be confirmed (an item lacks evidence or a quote); nothing changed. */
  | { outcome: "refused"; state: MapState; teachBack: null; issues: ConfirmIssue[] };

/** Applies the expert's reply to the teach-back: confirm, or correct (a new version, extracted behind the AnswerExtractor). */
export async function applyTeachBackReply(
  state: MapState,
  reply: { text: string; atMs: number; evidenceIds?: string[] },
  extractor: AnswerExtractor,
): Promise<TeachBackOutcome> {
  if (classifyReply(reply.text) === "confirm") {
    try {
      return { outcome: "confirmed", state: reduceMap(state, { type: "confirm", atMs: reply.atMs, quote: reply.text.trim() }), teachBack: null, issues: [] };
    } catch (e) {
      if (e instanceof MapConfirmationError) return { outcome: "refused", state, teachBack: null, issues: e.confirmIssues };
      throw e;
    }
  }
  const extraction = await extractor.extract({
    topic: "correction",
    text: reply.text,
    questionId: null,
    atMs: reply.atMs,
    evidenceIds: reply.evidenceIds ?? [],
    targetId: null,
    entityRef: null,
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
