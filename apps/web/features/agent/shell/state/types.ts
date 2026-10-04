// Shell state: one plain object, changed only by the reducer. Nothing secret lives here: the session token and
// the signed URL stay inside the controller and the API module.
import type { CheckpointStatus, ScreenState } from '@apprentice/contracts';
import type { DecisionKind, DraftMap, GapItem } from '../brain/types.ts';
import type { TeachCaseId } from '../screen/sample-scenarios.ts';

export const MODES = ['learn', 'review', 'teach'] as const;
export type Mode = (typeof MODES)[number];

/** The visible stage names of the journey (Show, Reflect, Pass it on); in code the modes stay learn, review, teach. */
export const MODE_LABELS: Record<Mode, string> = { learn: 'Show', review: 'Reflect', teach: 'Pass it on' };

export const PERSONAS = ['strict', 'plain', 'thorough', 'quiet'] as const;
export type Persona = (typeof PERSONAS)[number];

/** The policy's persona: question budget, pause thresholds, word limit and prediction style. Read when a session starts. */
export const PERSONA_INFO: Record<Persona, { label: string; hint: string }> = {
  strict: { label: 'Strict', hint: 'Few, short questions' },
  plain: { label: 'Plain', hint: 'Friendly and brief (default)' },
  thorough: { label: 'Thorough', hint: 'More questions, follow-ups' },
  quiet: { label: 'Quiet', hint: 'Asks as little as possible' },
};
export const DEFAULT_PERSONA: Persona = 'plain';

export type SessionPhase = 'idle' | 'starting' | 'live' | 'ending' | 'ended' | 'error';
export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'speaking' | 'offline' | 'ended';

export interface SessionInfo {
  id: string;
  mode: Mode;
  /** The one timeline origin: Date.now() at the start click. */
  epochMs: number;
  /** TEMPORARY: the server still runs the placeholder API (legacy routes, no token). */
  legacyRoutes: boolean;
  /** Date.now() at which the session auto-ends. */
  deadlineMs: number;
  /** Estimated server clock minus browser clock, or null (placeholder API). */
  clockSkewMs: number | null;
  conversationId: string | null;
}

export interface Banner {
  kind: 'error' | 'warn' | 'info';
  text: string;
}

export interface ObservationRow {
  id: string;
  sequence: number;
  timestampMs: number;
  kind: string;
  source: 'vision' | 'workspace';
  /** true: the observation came from the sample source (invented data, not the person's screen). */
  synthetic: boolean;
  summary: string;
  evidenceIds: string[];
}

/** `said`: spoken to the person and needs no answer (a warning, feedback on a prediction, the debrief's closing words). */
export type FeedStatus = 'asked' | 'answered' | 'deferred' | 'unspoken' | 'said';

export interface FeedItem {
  id: string;
  decision: DecisionKind;
  topic: string;
  text: string;
  status: FeedStatus;
  /** Why it is not spoken, when status is `unspoken` or `deferred`. */
  note: string | null;
  whyNow: string;
  evidenceIds: string[];
  atMs: number;
  answer: { text: string; atMs: number } | null;
  /** The session the item was asked in: a later session never takes its answer. */
  sessionId?: string;
}

export interface DecisionEntry {
  id: string;
  atMs: number;
  decision: DecisionKind;
  topic: string;
  kind: string;
  whyNow: string;
  text: string | null;
  evidenceIds: string[];
  /** The decision became speech. */
  spoken: boolean;
  /** Milliseconds from the latest screen observation to the first agent audio after this question. */
  latencyMs: number | null;
  note: string | null;
}

export interface LogLine {
  id: number;
  t: number;
  dir: 'sent' | 'recv' | 'sys' | 'err';
  type: string;
  text: string;
}

export type TeachBackStatus = 'none' | 'pending' | 'confirmed' | 'corrected';

export interface ReviewState {
  gaps: GapItem[];
  teachBack: {
    text: string | null;
    status: TeachBackStatus;
    correction: string | null;
    /** The fingerprint of the text on screen: confirm and correct carry it, so they count for exactly this version. */
    digest: string | null;
  };
  /** The review could not understand the expert twice: Skip joins Confirm and Correct. */
  buttons: boolean;
  /** What the last reply did not do (unclear, stale, refused, skipped), in plain words. */
  notice: string | null;
}

export interface CheckpointCard {
  checkpointId: string;
  status: CheckpointStatus;
  message: string;
  evidenceIds: string[];
  atMs: number;
  /** Set when the reply could not be delivered to the workspace. */
  deliveryError: string | null;
}

export interface MasteryState {
  mastered: string[];
  practise: string[];
  /** Cases the tutor could not judge: neither mastered nor to practise. */
  notJudged?: string[];
}

export interface CaptureInfo {
  /** Local capture state (the processed preview). Frames are not analysed or sent: vision is not wired. */
  state: 'idle' | 'selecting' | 'paused' | 'capturing' | 'stopped' | 'error';
  reason: string | null;
}

export interface ScreenInfo {
  sampleOn: boolean;
  /** Label of the running observation source, or null. */
  source: { label: string; synthetic: boolean } | null;
  state: ScreenState | 'none';
  reason: string | null;
  capture: CaptureInfo;
}

export interface VoiceInfo {
  phase: VoicePhase;
  /** A question was sent and the agent has not started speaking yet. */
  thinking: boolean;
  error: string | null;
}

export interface ShellState {
  mode: Mode;
  persona: Persona;
  offRecord: boolean;
  phase: SessionPhase;
  session: SessionInfo | null;
  voice: VoiceInfo;
  screen: ScreenInfo;
  banner: Banner | null;
  brain: { name: string; wired: boolean };
  observations: ObservationRow[];
  feed: FeedItem[];
  draftMap: DraftMap;
  review: ReviewState;
  /** `sampleCase`: which sample case the next Teach session plays (the sample source only). */
  teach: { checkpoint: CheckpointCard | null; mastery: MasteryState | null; sampleCase: TeachCaseId };
  replay: { evidenceId: string | null };
  /** A spoken question that is waiting for the answer: lets Clipa show a hint from the decision. */
  clipaHint: 'warning' | 'pointing' | null;
  decisions: DecisionEntry[];
  events: LogLine[];
  nextLogId: number;
}

export const LIMITS = { observations: 60, decisions: 200, events: 400, feed: 100 } as const;
