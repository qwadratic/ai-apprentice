// The journey rail's model: three stages (Show, Reflect, Pass it on) over the shell's modes (learn, review, teach), each
// active, done, next or open. Pure, so the node tests cover it; JourneyRail.tsx only draws it. The rail is a view of the
// shell state: picking a stage still calls controller.setMode, and sessions still start and end in SessionControls.
import { MODES } from '../state/types.ts';
import type { Mode, ShellState } from '../state/types.ts';

export interface StageInfo {
  /** The stage's name on the rail. */
  name: string;
  /** What happens there, in Clipa's words. */
  hint: string;
}

export const STAGES: Readonly<Record<Mode, StageInfo>> = {
  learn: { name: 'Show', hint: 'work as usual, I ask at pauses' },
  review: { name: 'Reflect', hint: 'talk to me to fix the map' },
  teach: { name: 'Pass it on', hint: 'a new hire tries, I step in before mistakes' },
};

/**
 * active: a session runs in this stage now. done: the stage has what it is for (Show: material for the map; Reflect: a
 * confirmed map; Pass it on: a mastery summary). next: the stage Clipa suggests after the current one. open: any other.
 */
export const STAGE_STATUSES = ['active', 'done', 'next', 'open'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** The wire from a stage to the following one: lit once the stage is done, live while it runs, dim before. */
export type WireState = 'lit' | 'live' | 'dim';

export interface RailStage {
  mode: Mode;
  /** 1-based position on the rail. */
  step: number;
  name: string;
  hint: string;
  status: StageStatus;
  /** The stage on screen (the selected tab). Clipa sits on the rail here. */
  selected: boolean;
  /** The wire to the next stage; null for the last stage. */
  wire: WireState | null;
}

/** The part of the shell state the rail reads. */
export type RailInput = Pick<ShellState, 'mode' | 'phase' | 'session' | 'feed' | 'draftMap' | 'review' | 'teach'>;

/** The mode a session is running in now, or null. */
export function liveMode(s: Pick<ShellState, 'phase' | 'session'>): Mode | null {
  return (s.phase === 'live' || s.phase === 'starting') && s.session ? s.session.mode : null;
}

/** Whether a stage has what it is for. Read defensively: the conductor client may leave parts of the state empty. */
export function stageDone(s: RailInput, mode: Mode): boolean {
  const endedHere = s.phase === 'ended' && s.session?.mode === mode;
  switch (mode) {
    case 'learn':
      return endedHere || (s.draftMap?.steps?.length ?? 0) > 0 || (s.feed ?? []).some((item) => item.status === 'answered');
    case 'review':
      return s.draftMap?.confirmed === true || s.review?.teachBack?.status === 'confirmed';
    case 'teach':
      return endedHere || (s.teach?.mastery ?? null) !== null;
  }
}

/** A journey phase named by Clipa (the conductor's guide cue, read defensively) as a stage, or null. */
export function stageOfPhase(phase: unknown): Mode | null {
  if (typeof phase !== 'string') return null;
  const p = phase.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (p === 'learn' || p === 'show' || p === 'share') return 'learn';
  if (p === 'review' || p === 'reflect' || p === 'review-board' || p === 'teachback') return 'review';
  if (p === 'teach' || p === 'pass-it-on' || p === 'summary') return 'teach';
  return null;
}

/**
 * The three stages for the rail. `suggested`: the stage Clipa points the person to (the conductor's guide), which wins
 * the "next" mark unless it runs or is done. Without it, next is the first stage after the running one (or from the
 * start) that is not done yet.
 */
export function railStages(s: RailInput, suggested: Mode | null = null): RailStage[] {
  const live = liveMode(s);
  const done = MODES.map((m) => m !== live && stageDone(s, m));
  const liveIndex = live === null ? -1 : MODES.indexOf(live);

  let nextIndex = -1;
  const suggestedIndex = suggested === null ? -1 : MODES.indexOf(suggested);
  if (suggestedIndex >= 0 && suggestedIndex !== liveIndex && !done[suggestedIndex]) {
    nextIndex = suggestedIndex;
  } else {
    for (let i = liveIndex + 1; i < MODES.length; i += 1) {
      if (!done[i]) {
        nextIndex = i;
        break;
      }
    }
  }

  return MODES.map((mode, i): RailStage => {
    const status: StageStatus = i === liveIndex ? 'active' : done[i] ? 'done' : i === nextIndex ? 'next' : 'open';
    const wire: WireState | null = i === MODES.length - 1 ? null : done[i] ? 'lit' : i === liveIndex ? 'live' : 'dim';
    return { mode, step: i + 1, name: STAGES[mode].name, hint: STAGES[mode].hint, status, selected: s.mode === mode, wire };
  });
}

const STATUS_WORDS: Readonly<Record<StageStatus, string>> = {
  active: 'live now',
  done: 'done',
  next: 'next',
  open: 'open',
};

/** Words for screen readers and for people who do not see the colour. */
export function statusWord(status: StageStatus): string {
  return STATUS_WORDS[status];
}

/** The stage the arrow keys, Home and End move to from `current`, or null for any other key. Wraps around. */
export function stageForKey(key: string, current: Mode): Mode | null {
  const i = MODES.indexOf(current);
  switch (key) {
    case 'ArrowRight':
      return MODES[(i + 1) % MODES.length] ?? null;
    case 'ArrowLeft':
      return MODES[(i + MODES.length - 1) % MODES.length] ?? null;
    case 'Home':
      return MODES[0] ?? null;
    case 'End':
      return MODES[MODES.length - 1] ?? null;
    default:
      return null;
  }
}

/** What Clipa says under the rail: her current line, else the conductor's guide text, else the selected stage's hint. */
export function railCaption(bubble: string, guideText: string | null, selected: Mode): string {
  if (bubble.trim() !== '') return bubble.trim();
  if (guideText !== null && guideText.trim() !== '') return guideText.trim();
  const stage = STAGES[selected];
  return `${stage.name}: ${stage.hint}.`;
}
