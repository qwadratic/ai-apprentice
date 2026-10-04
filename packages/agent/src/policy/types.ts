// What the policy logs and returns. Every decision is a BrainDecision: the decision, the reasons, the four quiet
// channels at that moment, the evidence it rests on and a plain sentence for why now. JSON-safe (no Infinity, no undefined),
// so a session can be written to the log, replayed and tested.
import type { Question, Topic } from "../knowledge/types.ts";
import type { Mode, PolicyDecision } from "../schema.ts";
import type { Prediction } from "../tutor/predict.ts";
import type { PersonaId } from "./personas.ts";
import type { BrainUtterance } from "./topics.ts";

export type PolicyReason =
  // Why the pause is natural (ASK_NOW, PREDICT).
  | "natural_pause"
  // The four quiet channels, plus the open question and the off-the-record switch.
  | "off_record"
  | "typing"
  | "human_speaking"
  | "agent_speaking"
  | "screen_not_stable"
  | "question_open"
  // Budget and cooldown (Learn).
  | "budget"
  | "cooldown"
  | "bypass_budget"
  | "bypass_cooldown"
  // The candidate itself.
  | "duplicate_topic"
  | "answered_in_map"
  | "visible_on_screen"
  | "stale"
  | "cancelled"
  | "wrong_mode"
  // Teach.
  | "checkpoint_clear"
  | "checkpoint_warn"
  | "checkpoint_unknown"
  | "no_decision_point"
  | "already_predicted"
  | "persona_predicts_before_send";

export interface QuietThresholds {
  inputPauseMs: number;
  screenStableMs: number;
  humanQuietMs: number;
}

/** The four channels of a natural pause. null means "never happened yet", which counts as quiet. */
export interface QuietSnapshot {
  atMs: number;
  /** Time since the last input event of the workspace. */
  inputIdleMs: number | null;
  /** Time since the last significant change on screen. */
  screenStableMs: number | null;
  humanSpeaking: boolean;
  /** Time since the human's last phrase ended. */
  humanQuietForMs: number | null;
  agentSpeaking: boolean;
  offRecord: boolean;
  thresholds: QuietThresholds;
  /** Per channel: is it quiet for the persona's threshold? */
  channels: { input: boolean; screen: boolean; human: boolean; agent: boolean };
  /** All four channels quiet and not off the record. */
  natural: boolean;
}

export interface BudgetSnapshot {
  /** Questions asked inside the rolling window. */
  asked: number;
  max: number;
  windowMs: number;
  cooldownMs: number;
  /** Milliseconds until the cooldown ends; 0 when it is over. */
  cooldownLeftMs: number;
}

export interface BrainDecision {
  seq: number;
  atMs: number;
  mode: Mode;
  persona: PersonaId;
  decision: PolicyDecision;
  reasons: PolicyReason[];
  /** One plain sentence: what happened on screen and why this moment (or why not). */
  whyNow: string;
  quiet: QuietSnapshot;
  evidenceIds: string[];
  topic: Topic | "predict_next" | "checkpoint" | null;
  candidateId: string | null;
  budget: BudgetSnapshot;
  /** ASK_NOW and PREDICT: the id to pass to finishQuestion or cancelQuestion. */
  questionId: string | null;
  /** ASK_NOW: the question to ask. */
  question: Question | null;
  /** ASK_NOW and PREDICT: what to say. */
  utterance: BrainUtterance | null;
  /** PREDICT: what the map expects. */
  prediction: Prediction | null;
  /** DEFER: wait for the next pause, or hold for Review. */
  deferTo: "next_pause" | "review" | null;
  /** DEFER to Review: when the held item expires. */
  expiresAtMs: number | null;
  /** WARN: speak at once, or queue behind the speech that is going on. */
  deliver: "now" | "after_speech" | null;
}

export interface ReviewItem {
  candidateId: string;
  topic: Topic;
  entityRef: string | null;
  evidenceIds: string[];
  /** What happened on screen. */
  note: string;
  heldAtMs: number;
  expiresAtMs: number;
}
