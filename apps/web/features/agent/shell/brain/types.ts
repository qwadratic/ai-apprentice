// The brain seam. The shell owns the session, the voice and the screen; the brain owns the decisions
// (ask now, defer, skip, warn, predict), the Work Map and the tutor. The real policy, map and tutor live in
// packages/agent (TASK-3.29); this file is the small typed boundary the shell codes against.
// Decisions follow the BrainDecision JSON of the Clipa spec (section 6).
import type { ActionCheckpoint, CheckpointReply, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
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
  kind: 'answer' | 'confirm' | 'correct';
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
}

export interface DraftMap {
  steps: DraftStep[];
}

export interface ReviewOutput {
  gaps: GapItem[];
  /** The brain's teach-back, or null until there is enough to repeat back. */
  teachBack: string | null;
  map: DraftMap;
}

export interface Brain {
  readonly name: string;
  /** false for NullBrain: the views say that no policy is wired. */
  readonly wired: boolean;
  onObservation(o: ScreenObservation): void;
  onStatus(s: ScreenStatus): void;
  onTranscript(t: TranscriptTurn): void;
  /** Called about twice a second while a session is live. `signals` is optional for implementations that do not need it. */
  tick(nowMs: number, signals?: BrainSignals): BrainDecision[];
  onAnswer(a: AnswerInput): void;
  review(): ReviewOutput;
  /** Teach: the reply goes back to the workspace. Never answer `clear` without a confirmed rule. */
  checkpoint(c: ActionCheckpoint): CheckpointReply | Promise<CheckpointReply>;
}
