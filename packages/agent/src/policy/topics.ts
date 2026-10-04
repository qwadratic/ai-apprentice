// Question text from small templates keyed by what changed on screen (Learn) or by what is still unclear (Review).
// A question is about a reason, a limit or an exception and points at an evidence moment. Templates describe what is
// visible and ask why; they never state a rule, and they take nothing from the expert's answers. Each template has
// variants from longest to shortest; the persona's word limit picks the longest one that fits.
import type { Topic } from "../knowledge/types.ts";
import { wordCount } from "./personas.ts";

/** What changed on screen that may be worth a question. decision_point is the Teach counterpart: a fork on the map. */
export type CandidateKind =
  | "attachment_removed"
  | "attachment_added"
  | "body_text_why"
  | "body_text_added"
  | "recipient_changed"
  | "preview_opened"
  | "ticket_done"
  | "decision_point";

/** The topic a Learn candidate asks about; null means visible and routine, nothing to ask. */
export const KIND_TOPIC: Readonly<Record<CandidateKind, Topic | null>> = {
  attachment_removed: "reason",
  attachment_added: null,
  body_text_why: "reason",
  body_text_added: "essentials",
  recipient_changed: "reason",
  preview_opened: "guardrail",
  ticket_done: null,
  decision_point: null,
};

export interface QuestionContext {
  entityRef: string | null;
  orderId: string | null;
  /** What was removed or added, e.g. "image". */
  detail: string | null;
}

type Variants = (ctx: QuestionContext) => string[];

const forWho = (ctx: QuestionContext): string => (ctx.entityRef ? ` for ${ctx.entityRef}` : "");
const what = (ctx: QuestionContext): string => ctx.detail ?? "image";

const LEARN_VARIANTS: Readonly<Record<CandidateKind, Variants | null>> = {
  attachment_removed: (ctx) => [
    `I noticed you took the ${what(ctx)} attachment off this email${forWho(ctx)}. What made you do that, and does it always go that way?`,
    `You took the ${what(ctx)} attachment off the email${forWho(ctx)}. What made you do that?`,
    `Why did you remove the ${what(ctx)} attachment${forWho(ctx)}?`,
    `Why remove the ${what(ctx)} attachment?`,
  ],
  body_text_why: (ctx) => [
    `You wrote details from ${ctx.orderId ?? "the order"} into your message${forWho(ctx)}. What made you do that, and does it always go that way?`,
    `You wrote details from ${ctx.orderId ?? "the order"} into your message${forWho(ctx)}. What made you do that?`,
    `Why did you write those details into the message${forWho(ctx)}?`,
    "Why write those details into the message?",
  ],
  body_text_added: (ctx) => [
    `You typed details from ${ctx.orderId ?? "the order"} straight into your message. Which of those details matter most, and why those?`,
    `You typed details from ${ctx.orderId ?? "the order"} into your message. Which of those details matter most?`,
    `Which details from ${ctx.orderId ?? "the order"} matter most?`,
    "Which details matter most?",
  ],
  recipient_changed: (ctx) => [
    `You changed the recipient${forWho(ctx)}. What made you do that, and is it always so?`,
    `You changed the recipient${forWho(ctx)}. What made you do that?`,
    `Why change the recipient${forWho(ctx)}?`,
    "Why change the recipient?",
  ],
  preview_opened: () => [
    "Before you press Send: is there anything that would make you stop and check with someone first, and who would that be?",
    "Before you press Send: is there anything that would make you stop and check with someone?",
    "Anything that would make you stop before Send?",
    "Would anything make you stop before Send?",
  ],
  // Visible on screen and routine: nothing to ask.
  attachment_added: null,
  ticket_done: null,
  decision_point: null,
};

function fit(variants: readonly string[], maxWords: number): string {
  const found = variants.find((v) => wordCount(v) <= maxWords);
  return found ?? variants[variants.length - 1] ?? "";
}

/** The Learn question for a change, within the word limit, or null when the change is not worth a question. */
export function renderLearnQuestion(kind: CandidateKind, ctx: QuestionContext, maxWords: number): string | null {
  const variants = LEARN_VARIANTS[kind];
  return variants ? fit(variants(ctx), maxWords) : null;
}

/** Every variant of a Learn template, longest first, for tests that check the word limits. */
export function learnVariants(kind: CandidateKind, ctx: QuestionContext): string[] {
  return LEARN_VARIANTS[kind]?.(ctx) ?? [];
}

/** Review follow-ups by what is still missing. */
export type GapTopic = "reason" | "scope" | "exception" | "why_stop" | "duration";

const GAP_VARIANTS: Readonly<Record<GapTopic, (who: string) => string[]>> = {
  // The reason was missed or not given during the task: ask it again, plainly.
  reason: (who) => [`What is the reason you handle ${who} this way?`, `Why do you handle ${who} this way?`, "Why do you do it this way?"],
  scope: (who) => [
    `Is this only for ${who}, or do other customers get the same treatment?`,
    `Only ${who}, or others too?`,
  ],
  exception: () => [
    "Is there an exception? For example, would an extra attachment still be fine?",
    "Any exceptions to this?",
  ],
  why_stop: () => ["You said you stop and ask in that situation. Why is that?", "Why would you stop there?"],
  duration: (who) => [
    `Does this hold for ${who} until further notice, and who decides when it changes?`,
    "Until when, and who decides?",
  ],
};

export function renderGapQuestion(topic: GapTopic, who: string, maxWords: number): string {
  return fit(GAP_VARIANTS[topic](who), maxWords);
}

export function gapVariants(topic: GapTopic, who: string): string[] {
  return GAP_VARIANTS[topic](who);
}

/** What the voice agent speaks: the intonation tags and the text. */
export interface BrainUtterance {
  text: string;
  /** Intonation tags such as "curious"; empty for models that read them aloud. */
  delivery: string[];
  maxWords: number;
}

/** The line handed to the voice agent: "[ASK] [curious] text". The agent repeats what follows [ASK] word for word. */
export function formatAskLine(u: BrainUtterance): string {
  const tags = u.delivery.map((t) => `[${t}]`).join(" ");
  return `[ASK] ${tags ? `${tags} ` : ""}${u.text}`;
}
