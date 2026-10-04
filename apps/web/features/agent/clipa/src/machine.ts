/*
 * The lifecycle state machine. Pure: no DOM, no timers, so it is unit-tested in node.
 *
 * The table is the spec's diagram (Dock -> Notice -> Approach -> Speaking -> Listening -> Thinking ->
 * Ack -> Retreat -> Dock; Dock -> Warning -> Pointing -> Retreat; Dock <-> Off) plus the shortcuts the
 * brain needs in practice:
 *   - a warning may preempt Clipa in any active state (WARN skips the question budget);
 *   - Clipa may speak or listen in place at the dock (a spoken debrief needs no flight);
 *   - Notice may be cancelled back to Dock (typing resumed before take-off);
 *   - Off is reachable from every state and leaves only to Dock.
 * Anything else is illegal: request() returns { ok: false } and changes nothing, the caller logs it.
 */
import type { ClipaState } from './types.ts';
import { CLIPA_STATES } from './types.ts';

export const TRANSITIONS: Readonly<Record<ClipaState, readonly ClipaState[]>> = {
  dock: ['notice', 'approach', 'speaking', 'listening', 'warning', 'pointing', 'off'],
  notice: ['approach', 'dock', 'warning', 'pointing', 'off'],
  approach: ['speaking', 'listening', 'warning', 'pointing', 'retreat', 'off'],
  speaking: ['listening', 'thinking', 'ack', 'warning', 'pointing', 'retreat', 'off'],
  listening: ['speaking', 'thinking', 'ack', 'warning', 'pointing', 'retreat', 'off'],
  thinking: ['speaking', 'listening', 'ack', 'warning', 'pointing', 'retreat', 'off'],
  ack: ['speaking', 'listening', 'warning', 'pointing', 'retreat', 'off'],
  retreat: ['dock', 'off'],
  warning: ['pointing', 'retreat', 'off'],
  pointing: ['warning', 'retreat', 'off'],
  off: ['dock'],
};

/** Staying in these states is a legal no-op: a new utterance, new level or new target, not a transition. */
export const REPEATABLE: readonly ClipaState[] = ['speaking', 'listening', 'warning', 'pointing'];

/** States in which Clipa is out of the dock corner, beside a target or on the way. */
export const ACTIVE_STATES: readonly ClipaState[] = [
  'approach',
  'speaking',
  'listening',
  'thinking',
  'ack',
  'warning',
  'pointing',
];

export function isActive(state: ClipaState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function canTransition(from: ClipaState, to: ClipaState): boolean {
  if (from === to) return REPEATABLE.includes(to);
  return TRANSITIONS[from].includes(to);
}

/** True when `dock` can be reached from `from`; every state must satisfy this (no dead ends). */
export function reachesDock(from: ClipaState): boolean {
  const seen = new Set<ClipaState>([from]);
  const queue: ClipaState[] = [from];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (next === 'dock') return true;
    for (const to of TRANSITIONS[next]) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return false;
}

export type TransitionResult =
  | { ok: true; from: ClipaState; to: ClipaState; changed: boolean }
  | { ok: false; from: ClipaState; to: ClipaState; reason: string };

export interface TransitionRecord {
  from: ClipaState;
  to: ClipaState;
}

export interface ClipaMachine {
  readonly state: ClipaState;
  /** The last 100 accepted transitions, oldest first. */
  readonly history: readonly TransitionRecord[];
  /** Moves to `to` when legal. An illegal request changes nothing and says why. */
  request(to: ClipaState): TransitionResult;
  /** Listener runs after every accepted change of state. Returns the unsubscribe function. */
  subscribe(listener: (from: ClipaState, to: ClipaState) => void): () => void;
}

export function createMachine(initial: ClipaState = 'dock'): ClipaMachine {
  if (!CLIPA_STATES.includes(initial)) throw new Error(`unknown Clipa state: ${String(initial)}`);
  let state: ClipaState = initial;
  const history: TransitionRecord[] = [];
  const listeners = new Set<(from: ClipaState, to: ClipaState) => void>();

  return {
    get state(): ClipaState {
      return state;
    },
    get history(): readonly TransitionRecord[] {
      return history;
    },
    request(to: ClipaState): TransitionResult {
      const from = state;
      if (!canTransition(from, to)) {
        return { ok: false, from, to, reason: `${from} -> ${to} is not a legal transition` };
      }
      if (from === to) return { ok: true, from, to, changed: false };
      state = to;
      history.push({ from, to });
      if (history.length > 100) history.shift();
      for (const listener of [...listeners]) listener(from, to);
      return { ok: true, from, to, changed: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
