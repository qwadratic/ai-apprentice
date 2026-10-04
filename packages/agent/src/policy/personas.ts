// Personas: how Clipa talks. A persona is a set of parameters for the policy and hints for the voice, not a separate agent
// (spec section 4). Starting values, to be tuned on real runs.

export const PERSONA_IDS = ["strict", "plain", "thorough", "quiet"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

/** How Teach asks the new hire to predict the next decision. */
export type PredictStyle = "one_word" | "two_choices" | "what_and_why" | "before_send";

export interface Persona {
  id: PersonaId;
  label: string;
  /** Learn questions per 10 minutes: the budget is the upper bound. */
  questionsPer10Min: { min: number; max: number };
  /** Typing channel: no input for this long counts as quiet. */
  inputPauseMs: number;
  /** Screen channel: no significant change for this long counts as quiet. */
  screenStableMs: number;
  /** Human speech channel: this long after the end of a phrase counts as quiet. */
  humanQuietMs: number;
  /** Minimum gap between the end of one question and the next. */
  cooldownMs: number;
  /** Longest spoken line, in words. */
  maxWords: number;
  /** Offers hints and "what if" prompts on its own. */
  suggests: "no" | "sometimes" | "in_review";
  smallTalk: "none" | "short" | "yes";
  predictStyle: PredictStyle;
  /** Intonation tags for models that understand them. */
  deliveryTags: string[];
  voice: { stability: "high" | "medium"; style: "low" | "medium" };
}

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = {
  strict: {
    id: "strict",
    label: "Strict",
    questionsPer10Min: { min: 2, max: 3 },
    inputPauseMs: 5000,
    screenStableMs: 3000,
    humanQuietMs: 1200,
    cooldownMs: 8000,
    maxWords: 12,
    suggests: "no",
    smallTalk: "none",
    predictStyle: "one_word",
    deliveryTags: ["matter-of-fact"],
    voice: { stability: "high", style: "low" },
  },
  plain: {
    id: "plain",
    label: "Plain",
    questionsPer10Min: { min: 3, max: 4 },
    inputPauseMs: 3000,
    screenStableMs: 2000,
    humanQuietMs: 1200,
    cooldownMs: 5000,
    maxWords: 18,
    suggests: "sometimes",
    smallTalk: "short",
    predictStyle: "two_choices",
    deliveryTags: ["warmly", "curious"],
    voice: { stability: "medium", style: "medium" },
  },
  thorough: {
    id: "thorough",
    label: "Thorough",
    questionsPer10Min: { min: 4, max: 5 },
    inputPauseMs: 2500,
    screenStableMs: 1500,
    humanQuietMs: 1200,
    cooldownMs: 4000,
    maxWords: 25,
    suggests: "in_review",
    smallTalk: "yes",
    predictStyle: "what_and_why",
    deliveryTags: ["thoughtful", "curious"],
    voice: { stability: "medium", style: "medium" },
  },
  quiet: {
    id: "quiet",
    label: "Quiet",
    questionsPer10Min: { min: 1, max: 2 },
    inputPauseMs: 6000,
    screenStableMs: 3000,
    humanQuietMs: 1200,
    cooldownMs: 12000,
    maxWords: 10,
    suggests: "no",
    smallTalk: "none",
    predictStyle: "before_send",
    deliveryTags: [],
    voice: { stability: "high", style: "low" },
  },
};

export const DEFAULT_PERSONA: PersonaId = "plain";

export function getPersona(id: PersonaId = DEFAULT_PERSONA): Persona {
  return PERSONAS[id];
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}
