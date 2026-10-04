// The brain seam. The shell owns the session, the voice and the screen; the brain owns the decisions
// (ask now, defer, skip, warn, predict), the Work Map and the tutor. The real policy, map and tutor live in
// packages/agent (TASK-3.29); this file is the small typed boundary the shell codes against.
// Decisions follow the BrainDecision JSON of the Clipa spec (section 6).
import type { ActionCheckpoint, CheckpointReply, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import type { LlmClient } from '@apprentice/agent';
import type { ClipaState } from '../clipa/presenter.ts';
import type { Mode, Persona } from '../state/types.ts';

export const DECISION_KINDS = ['ASK_NOW', 'DEFER', 'SKIP', 'WARN', 'PREDICT'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Decisions that are spoken to the person (the others only go to the log or to the Review queue). */
export function isSpoken(kind: DecisionKind): boolean {
  return kind === 'ASK_NOW' || kind === 'WARN' || kind === 'PREDICT';
}

/** Where Clipa should go, symbolically. The shell resolves it to a rectangle. */
export interface ClipaTargetRef {
  surface: string;
  hint?: string;
}

export interface BrainDecision {
  decision: DecisionKind;
  topic: string;
  /** reason, limit, exception, stop_and_ask, ... */
  kind: string;
  /** Plain-words reason for this decision: shown in the debug drawer. */
  whyNow: string;
  evidenceIds: string[];
  /** The policy's id of the question this decision asks (ASK_NOW, PREDICT): lets the shell hand a question back when it was not spoken. */
  questionId?: string;
  utterance?: { text: string; delivery?: string[]; maxWords?: number };
  /** The Clipa lifecycle cue (the spec also names approach, notice, ack and retreat; the shell ignores those). */
  clipa?: { state?: ClipaState | 'notice' | 'approach' | 'ack' | 'retreat'; target?: ClipaTargetRef };
  expectsAnswer?: boolean;
}

/** What the shell knows and the brain should not have to track: voice, off-record, persona, mode. */
export interface BrainSignals {
  sessionId: string;
  mode: Mode;
  persona: Persona;
  offRecord: boolean;
  voiceConnected: boolean;
  agentSpeaking: boolean;
  /** The person is speaking right now (voice activity), or has just finished a phrase. */
  humanSpeaking: boolean;
  /** Spoken decisions of this session so far. */
  asked: number;
}

export interface TranscriptTurn {
  role: 'agent' | 'user';
  text: string;
  /** Milliseconds since sessionEpochMs. */
  atMs: number;
}

export interface AnswerInput {
  /** The feed item this answers, or null for the teach-back. */
  questionId: string | null;
  topic: string | null;
  text: string;
  atMs: number;
  kind: 'answer' | 'confirm' | 'correct' | 'skip';
  /**
   * The digest of the teach-back that is on screen (ReviewOutput.teachBackDigest). A confirmation, a correction by button or a
   * spoken reply counts for exactly that version: if the map moved on since, the brain answers `stale` and confirms nothing.
   */
  digest?: string | null;
}

export interface GapItem {
  id: string;
  topic: string;
  question: string;
  evidenceIds: string[];
}

export interface GuardrailRef {
  id: string;
  text: string;
  evidenceIds: string[];
}

export interface DraftStep {
  id: string;
  title: string;
  kind: 'step' | 'judgment';
  decision: string | null;
  /** The reason in the expert's words. */
  reason: string | null;
  guardrails: GuardrailRef[];
  /** Screen moments of this step (ScreenEvidence ids). */
  evidenceIds: string[];
  atMs: number | null;
  /** The step comes from the sample source (invented data). */
  synthetic?: boolean;
}

export interface DraftMap {
  steps: DraftStep[];
  /** Built from the sample source (invented data), not from the person's screen. */
  synthetic?: boolean;
  /** Version of the Work Map this draft shows. A correction in Review makes the next number. */
  version?: number;
  /** The expert confirmed this version. */
  confirmed?: boolean;
  /** Every guardrail of the map, also those that no step lists (stop-and-ask rules). */
  guardrails?: GuardrailRef[];
}

/** What the brain needs for one session. Learn begins a new Work Map; Review and Teach read the one Learn made. */
export interface BrainSession {
  sessionId: string;
  mode: Mode;
  persona: Persona;
  /** The model-backed route for this session, or null (placeholder API, tests): the brain then uses its heuristics. */
  llm: LlmClient | null;
  /** Teach: the sample case that is played, so the mastery summary can name it. */
  caseId?: string | null;
  caseTitle?: string | null;
}

/** What the brain tells the shell about an answer that changed the teach-back. */
export interface AnswerResult {
  teachBack?: 'confirmed' | 'corrected' | 'unclear' | 'refused' | 'stale' | 'skipped' | 'needs_words';
  /** The Work Map or the review changed: reload them. */
  changed?: boolean;
}

/** One Teach outcome line for the mastery card. */
export interface MasteryLines {
  mastered: string[];
  practise: string[];
  /** Cases the tutor could not judge (no confirmed map, `unknown`, an unanswered prediction): neither mastered nor to practise. */
  notJudged?: string[];
}

export interface ReviewOutput {
  gaps: GapItem[];
  /** The brain's teach-back (scope, fields, exception, reason), or null until there is enough to repeat back. */
  teachBack: string | null;
  /** The fingerprint of what the teach-back states: a confirmation must carry it (AnswerInput.digest). */
  teachBackDigest?: string | null;
  /** The review could not understand the expert twice: Confirm / Correct / Skip buttons are offered for the open item. */
  buttons?: boolean;
  map: DraftMap;
}

export interface Brain {
  readonly name: string;
  /** false for NullBrain: the views say that no policy is wired. */
  readonly wired: boolean;
  /** A session starts (Learn, Review or Teach). Optional: test brains need not implement it. */
  begin?(session: BrainSession): void;
  /** A spoken decision reached the voice: a teach-back counts as stated from here. */
  onSpoken?(decision: BrainDecision): void;
  /** The source of observations changed (the sample or the person's real screen). */
  setSource?(synthetic: boolean): void;
  /** A spoken decision never reached the person (the voice is gone, the agent was speaking): the question goes back to the queue. */
  onNotSpoken?(decision: BrainDecision): void;
  /** Teach: what has been mastered so far, or null. */
  mastery?(): MasteryLines | null;
  onObservation(o: ScreenObservation): void;
  onStatus(s: ScreenStatus): void;
  onTranscript(t: TranscriptTurn): void;
  /** Called about twice a second while a session is live. `signals` is optional for implementations that do not need it. */
  tick(nowMs: number, signals?: BrainSignals): BrainDecision[];
  /** The answer may be read by a model, so it can be asynchronous; the map is refreshed when it settles. */
  onAnswer(a: AnswerInput): AnswerResult | void | Promise<AnswerResult | void>;
  /** `shown`: the teach-back is on the person's screen, so the brain counts it as stated (a confirmation counts only for what was stated). */
  review(shown?: boolean): ReviewOutput;
  /** Teach: the reply goes back to the workspace. Never answer `clear` without a confirmed rule. */
  checkpoint(c: ActionCheckpoint): CheckpointReply | Promise<CheckpointReply>;
}
