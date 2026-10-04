/*
 * The demo journey as data (backlog doc-10, "Demo journey v1"). The engine reads this table; nothing here runs.
 *
 * Each step has a target (the value of a data-clipa-target attribute the shell puts on a control), one line in
 * Clipa's voice (one short sentence, at most 14 words), the condition that starts it and the event(s) that end it.
 * A step that names a `mode` is announced only once the app is in that mode or a later one.
 */
import type { EventMatcher, JourneyMode } from './events.ts';

export const JOURNEY_PHASES = ['share', 'learn', 'review', 'teach', 'summary'] as const;
export type JourneyPhase = (typeof JOURNEY_PHASES)[number];

export const PHASE_LABELS: Readonly<Record<JourneyPhase, string>> = {
  share: 'Share',
  learn: 'Learn',
  review: 'Review',
  teach: 'Teach',
  summary: 'Summary',
};

export type JourneyPersona = 'expert' | 'newHire' | 'any';

export type JourneyStepId =
  | 'open'
  | 'share'
  | 'learn'
  | 'review-board'
  | 'teach-back'
  | 'handoff'
  | 'teach'
  | 'teach-fix'
  | 'summary';

/** Alternative wording of a step: another device, a refused picker, a reload. */
export type JourneyVariant = 'camera' | 'none' | 'denied' | 'deniedCamera' | 'lost' | 'maskReview' | 'resume';

export interface JourneyText {
  /** A data-clipa-target value. Without it the variant keeps the step's own target. */
  target?: string;
  /** Clipa says the line where she is, without flying to a control (nothing on the page can help). */
  inPlace?: boolean;
  line: string;
}

export interface JourneyStep {
  id: JourneyStepId;
  phase: JourneyPhase;
  persona: JourneyPersona;
  /** Where Clipa flies: the value of data-clipa-target on the control. */
  target: string;
  /** Used when the target is not on the page (for example no open gap is left to highlight). */
  fallbackTarget?: string;
  /** One short sentence, at most 14 words. */
  line: string;
  /**
   * Who speaks when the step starts. 'clipa': she flies to the target and says the line. 'agent': the voice agent
   * is speaking at this moment (teach-back, the checkpoint warning), so Clipa stays out of its way and the line is
   * only used for the one gentle re-nudge.
   */
  voice: 'clipa' | 'agent';
  /** The step is announced only once the app is in this mode or a later one. */
  mode?: JourneyMode;
  /** True when the step is meaningless without a live capture, so a reload sends the journey back to the start. */
  needsCapture: boolean;
  /**
   * Enter condition. Every step starts as soon as the one before it has ended. `on` adds a gate: the step is not
   * announced until one of these events has been seen on this page load (the first step waits for the session).
   */
  enter: { on?: readonly EventMatcher[] };
  /** The events that end the step. A `mode_changed` matcher also fires when the app is already in that mode or later. */
  exit: readonly EventMatcher[];
  /** One gentle re-nudge, at most, after the person has left the step alone for this long. */
  nudge?: { afterMs: number; line?: string; target?: string };
  variants?: Partial<Record<JourneyVariant, JourneyText>>;
}

export const MAX_LINE_WORDS = 14;

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  {
    id: 'open',
    phase: 'share',
    persona: 'any',
    target: 'share-screen',
    line: "Hi, I'm Clipa: share the window you work in, and I'll watch quietly.",
    voice: 'clipa',
    needsCapture: false,
    enter: { on: [{ type: 'session_started' }] },
    exit: [{ type: 'share_requested' }, { type: 'mask_review' }, { type: 'screen_capturing' }, { type: 'camera_capturing' }],
    nudge: { afterMs: 30_000, line: "Whenever you're ready, click Share screen." },
    variants: {
      camera: { target: 'use-camera', line: "Screen sharing isn't available here, so point the camera at your screen." },
      none: { inPlace: true, line: "This device can't share a screen or camera, so please use a laptop." },
      denied: { line: "Sharing didn't start; click Share screen to try again." },
      deniedCamera: { line: "Sharing didn't start; try Share screen again, or use the camera." },
      lost: { line: 'Sharing stopped; click Share screen to carry on.' },
      resume: { line: "Welcome back: share your screen again and we'll carry on." },
    },
  },
  {
    id: 'share',
    phase: 'share',
    persona: 'any',
    target: 'share-screen',
    line: 'Pick the window with your task; I only see what you share.',
    voice: 'clipa',
    needsCapture: false,
    enter: {},
    exit: [{ type: 'screen_capturing' }, { type: 'camera_capturing' }],
    nudge: { afterMs: 60_000, line: 'Choose a window, then confirm to start sharing.' },
    variants: {
      camera: { target: 'use-camera', line: 'Point the camera at your screen, then start sharing.' },
      maskReview: { target: 'mask-confirm', line: 'Check the privacy masks, then confirm to start sharing.' },
    },
  },
  {
    id: 'learn',
    phase: 'learn',
    persona: 'expert',
    target: 'screen-preview',
    fallbackTarget: 'workspace',
    line: "That preview is what I see; just work, and I'll ask at pauses.",
    voice: 'clipa',
    mode: 'learn',
    needsCapture: true,
    enter: {},
    exit: [{ type: 'mode_changed', mode: 'review' }],
    nudge: { afterMs: 150_000, line: "When you've finished the task, open Review.", target: 'mode-review' },
  },
  {
    id: 'review-board',
    phase: 'review',
    persona: 'expert',
    target: 'board-gap',
    fallbackTarget: 'review-board',
    line: "Open gaps are highlighted; click one and tell me what's missing.",
    voice: 'clipa',
    mode: 'review',
    needsCapture: false,
    enter: {},
    exit: [{ type: 'teachback_started' }, { type: 'teachback_confirmed' }],
    nudge: { afterMs: 45_000, line: 'Pick a highlighted gap and answer by voice or button.' },
  },
  {
    id: 'teach-back',
    phase: 'review',
    persona: 'expert',
    target: 'teachback',
    fallbackTarget: 'review-board',
    line: 'Check my summary and confirm it, or correct what I got wrong.',
    voice: 'agent',
    mode: 'review',
    needsCapture: false,
    enter: {},
    exit: [{ type: 'teachback_confirmed' }],
    nudge: { afterMs: 40_000, line: 'Confirm my summary, or correct whatever I got wrong.' },
  },
  {
    id: 'handoff',
    phase: 'review',
    persona: 'expert',
    target: 'mode-teach',
    line: 'Thanks, now open Teach so the new hire can try a case.',
    voice: 'clipa',
    mode: 'review',
    needsCapture: false,
    enter: {},
    exit: [{ type: 'mode_changed', mode: 'teach' }],
    nudge: { afterMs: 30_000, line: 'Open Teach when the new hire is ready.' },
  },
  {
    id: 'teach',
    phase: 'teach',
    persona: 'newHire',
    target: 'workspace',
    line: "Here's a new case: say what you'd do next, then try it.",
    voice: 'clipa',
    mode: 'teach',
    needsCapture: true,
    enter: {},
    exit: [{ type: 'checkpoint_warned' }, { type: 'sent' }],
    nudge: { afterMs: 45_000, line: 'Tell me your next step, then try it in the workspace.' },
  },
  {
    id: 'teach-fix',
    phase: 'teach',
    persona: 'newHire',
    target: 'send',
    line: 'Fix the draft as the tutor said, then press Send again.',
    voice: 'agent',
    mode: 'teach',
    needsCapture: true,
    enter: {},
    exit: [{ type: 'sent' }],
    nudge: { afterMs: 30_000 },
  },
  {
    id: 'summary',
    phase: 'summary',
    persona: 'any',
    target: 'mastery-summary',
    line: "Here's what you've mastered and what to practise; export the map anytime.",
    voice: 'clipa',
    mode: 'summary',
    needsCapture: false,
    enter: {},
    exit: [],
  },
];

export function stepIndex(id: JourneyStepId, steps: readonly JourneyStep[] = JOURNEY_STEPS): number {
  return steps.findIndex((step) => step.id === id);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Every data-clipa-target value the table (and its variants and nudges) can ask for, sorted. */
export function journeyTargets(steps: readonly JourneyStep[] = JOURNEY_STEPS): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    found.add(step.target);
    if (step.fallbackTarget) found.add(step.fallbackTarget);
    if (step.nudge?.target) found.add(step.nudge.target);
    for (const variant of Object.values(step.variants ?? {})) if (variant?.target) found.add(variant.target);
  }
  return [...found].sort();
}
