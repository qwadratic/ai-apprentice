/*
 * Shared types of the Clipa package. Pure: no DOM types, so the node tests can import them.
 *
 * The lifecycle names follow the behaviour spec ("Clipa on screen", states Dock ... Off). The brain
 * decision shape follows its BrainDecision output: { decision, utterance, clipa: { state, target } }.
 */

/** The eleven states of the lifecycle. */
export const CLIPA_STATES = [
  'dock',
  'notice',
  'approach',
  'speaking',
  'listening',
  'thinking',
  'ack',
  'retreat',
  'warning',
  'pointing',
  'off',
] as const;
export type ClipaState = (typeof CLIPA_STATES)[number];

/** Where the brain wants Clipa to go: a surface of the workspace and an optional element hint inside it. */
export interface ClipaTarget {
  surface: string;
  hint?: string;
}

/** Anything with a rectangle in viewport coordinates; DOMRect and DOMRectReadOnly fit. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type BrainVerdict = 'ASK_NOW' | 'DEFER' | 'SKIP' | 'WARN' | 'PREDICT';

/** The part of a BrainDecision the director reads. Extra fields are allowed and ignored. */
export interface ClipaDecision {
  decision: BrainVerdict;
  utterance?: string | { text: string; maxWords?: number; delivery?: readonly string[] };
  expectsAnswer?: boolean;
  clipa?: { state?: ClipaState; target?: ClipaTarget };
}

/** One command of a decision's sequence. */
export type ClipaStep =
  | { op: 'notice'; target: ClipaTarget }
  | { op: 'approach'; target: ClipaTarget }
  | { op: 'warn'; target?: ClipaTarget }
  | { op: 'point'; target?: ClipaTarget }
  | { op: 'speak'; text: string }
  | { op: 'listen' }
  | { op: 'think' }
  | { op: 'ack' }
  | { op: 'retreat' }
  | { op: 'off' };

export type ClipaFailure =
  | 'illegal'
  | 'cancelled'
  | 'input-active'
  | 'no-target'
  | 'off'
  | 'dropped'
  | 'destroyed';

export type ClipaResult = { ok: true } | { ok: false; reason: ClipaFailure };

export type ClipaLogKind = 'illegal' | 'ignored' | 'waiting' | 'gave-up' | 'queued' | 'dropped' | 'deferred' | 'info';

export interface ClipaLogEntry {
  /** performance.now() at the time of the entry, in ms. */
  at: number;
  kind: ClipaLogKind;
  message: string;
}

export type FlightKind = 'approach' | 'retreat' | 'warn' | 'point' | 'off' | 'settle' | 'wake';

export type ClipaEvent =
  | { type: 'state'; at: number; from: ClipaState; to: ClipaState }
  | {
      type: 'flight';
      at: number;
      phase: 'start' | 'end';
      kind: FlightKind;
      /** Planned time at the start, measured time at the end. */
      durationMs: number;
      reduced: boolean;
      /** At the end: false when another move took over before this one arrived. */
      completed?: boolean;
    }
  | { type: 'log'; entry: ClipaLogEntry };

export type ClipaDock = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
