// What the page shows of Clipa, read from the shell's Clipa store. The store is shared with the conductor client
// (TASK-3.46), which may add fields, so everything beyond `state` and `bubble` is read defensively:
//   guide?: { phase?: string; step?: string; text?: string }  the conductor's current journey step (the `guide` cue),
//   set with store.setGuide(...) and cleared with store.setGuide(null).
import { CLIPA_STATES } from './presenter.ts';
import type { ClipaState } from './presenter.ts';

export interface ClipaGuide {
  phase: string | null;
  step: string | null;
  text: string | null;
}

export interface ClipaView {
  state: ClipaState;
  bubble: string;
  guide: ClipaGuide | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

export function readClipaView(snapshot: unknown): ClipaView {
  const s = (snapshot !== null && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>;
  const raw = s['state'];
  const state = typeof raw === 'string' && (CLIPA_STATES as readonly string[]).includes(raw) ? (raw as ClipaState) : 'idle';
  const bubble = typeof s['bubble'] === 'string' ? s['bubble'] : '';
  const g = s['guide'];
  let guide: ClipaGuide | null = null;
  if (g !== null && typeof g === 'object') {
    const r = g as Record<string, unknown>;
    guide = { phase: text(r['phase']), step: text(r['step']), text: text(r['text']) };
  }
  return { state, bubble, guide };
}

/** Clipa's state in words, for the status line under the rail. */
export const CLIPA_STATE_WORDS: Readonly<Record<ClipaState, string>> = {
  idle: 'is with you',
  listening: 'is listening',
  thinking: 'is thinking',
  speaking: 'is speaking',
  warning: 'is warning',
  happy: 'is happy',
  pointing: 'is pointing',
  off: 'is off the record',
};
