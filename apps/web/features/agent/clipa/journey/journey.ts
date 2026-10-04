/*
 * The demo journey as data (backlog doc-10, "Demo journey v1"), written against how the shell really works: a mode is a
 * tab, a session is what the Start button makes, and nothing (screen share, microphone, the agent) works until the
 * session of that mode is live. So the journey walks Start and End explicitly:
 *
 *   open (Start Learn) -> share -> learn (work) -> start-review -> review-board -> teach-back -> end-review
 *   -> handoff -> start-teach -> [share-teach] -> teach -> teach-fix -> end-teach (End Teach) -> summary
 *
 * The handoff to the new hire comes only after the Review session has ended, so the new hire's speech never lands in
 * the expert's transcript. The engine reads this table; nothing here runs.
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
  | 'start-review'
  | 'review-board'
  | 'teach-back'
  | 'end-review'
  | 'handoff'
  | 'start-teach'
  | 'share-teach'
  | 'teach'
  | 'teach-fix'
  | 'end-teach'
  | 'summary';

/** Alternative wording of a step: another device, a refused picker, a reload, the wrong tab, sample data. */
export type JourneyVariant =
  | 'camera'
  | 'none'
  | 'denied'
  | 'deniedCamera'
  | 'lost'
  | 'maskReview'
  | 'resume'
  | 'wrongTab'
  | 'synthetic';

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
  /** A Start step: when this tab is not the selected one, Clipa points at the tab first (variant `wrongTab`). */
  tab?: JourneyMode;
  /** The step is the screen-share step: refusals and the mask review reword it. */
  capture?: boolean;
  /** The step exists only when the shell turns that feature on (createJourney option). */
  optional?: 'captureInTeach';
  /** Where the journey restarts after a reload, when no session is live any more. Default: this step. */
  resume?: JourneyStepId;
  /**
   * Enter condition. Every step starts as soon as the one before it has ended. `on` adds a gate: the step is not
   * announced until one of these events has been seen on this page load (the first step waits for the page).
   */
  enter: { on?: readonly EventMatcher[] };
  /** The events that end the step. */
  exit: readonly EventMatcher[];
  /** The events that make the step pointless without the person doing it (they are already further on). */
  skip?: readonly EventMatcher[];
  /** One gentle re-nudge, at most, after the person has left the step alone for this long. */
  nudge?: { afterMs: number; line?: string; target?: string };
  variants?: Partial<Record<JourneyVariant, JourneyText>>;
}

export const MAX_LINE_WORDS = 14;

const live = (mode: JourneyMode): EventMatcher => ({ type: 'session_live', mode });
const ended = (mode: JourneyMode): EventMatcher => ({ type: 'session_ended', mode });

const SHARE_EXIT: readonly EventMatcher[] = [{ type: 'screen_capturing' }, { type: 'camera_capturing' }];
const NO_SHARE: JourneyText = { inPlace: true, line: "This device can't share a screen, so please use a laptop." };

/** The wording of a screen-share step: the same in Learn and (when the shell shares there) in Teach. */
const SHARE_VARIANTS: NonNullable<JourneyStep['variants']> = {
  camera: { target: 'use-camera', line: 'Point the camera at your screen, then start sharing.' },
  none: NO_SHARE,
  maskReview: { target: 'mask-confirm', line: 'Check the privacy masks, then confirm to start sharing.' },
  denied: { line: "Sharing didn't start; click Share screen to try again." },
  deniedCamera: { line: "Sharing didn't start; try Share screen again, or use the camera." },
  lost: { line: 'Sharing stopped; click Share screen to carry on.' },
};

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  {
    id: 'open',
    phase: 'share',
    persona: 'any',
    target: 'session-start',
    line: "Hi, I'm Clipa: press Start Learn, then share the window you work in.",
    voice: 'clipa',
    tab: 'learn',
    enter: { on: [{ type: 'app_ready' }] },
    exit: [live('learn')],
    nudge: { afterMs: 30_000, line: "Whenever you're ready, press Start Learn." },
    variants: {
      wrongTab: { target: 'mode-learn', line: "Hi, I'm Clipa: open the Learn tab first, then press Start." },
      none: NO_SHARE,
      camera: { line: "Screen sharing isn't available here, so we'll point the camera at your screen." },
      resume: { line: 'Welcome back: press Start Learn, then share your screen again.' },
    },
  },
  {
    id: 'share',
    phase: 'share',
    persona: 'any',
    target: 'share-screen',
    line: 'Choose the window with your task; I only see what you share.',
    voice: 'clipa',
    capture: true,
    resume: 'open',
    enter: {},
    exit: SHARE_EXIT,
    // Without a shared window the sample observations run (the shell labels them synthetic): the agent asks anyway.
    skip: [{ type: 'agent_asked' }, ended('learn'), live('review')],
    nudge: { afterMs: 45_000, line: 'Choose a window, then confirm to start sharing.' },
    variants: SHARE_VARIANTS,
  },
  {
    id: 'learn',
    phase: 'learn',
    persona: 'expert',
    target: 'screen-preview',
    fallbackTarget: 'workspace',
    line: "That preview is what I see; just work, and I'll ask at pauses.",
    voice: 'clipa',
    resume: 'open',
    enter: {},
    exit: [ended('learn')],
    skip: [live('review')],
    nudge: { afterMs: 150_000, line: 'When the task is done, press End session.', target: 'session-end' },
    variants: {
      synthetic: { target: 'workspace', line: "I follow sample events, not your screen; just work and I'll ask at pauses." },
    },
  },
  {
    id: 'start-review',
    phase: 'review',
    persona: 'expert',
    target: 'session-start',
    line: "Press Start Review, and I'll ask what is still unclear.",
    voice: 'clipa',
    tab: 'review',
    enter: {},
    exit: [live('review')],
    nudge: { afterMs: 30_000, line: "Whenever you're ready, press Start Review." },
    variants: {
      wrongTab: { target: 'mode-review', line: 'Open the Review tab first, then press Start.' },
      resume: { line: 'Welcome back: press Start Review to carry on.' },
    },
  },
  {
    id: 'review-board',
    phase: 'review',
    persona: 'expert',
    target: 'board-gap',
    fallbackTarget: 'review-board',
    line: "These are the open gaps; I'll ask about them by voice.",
    voice: 'clipa',
    resume: 'start-review',
    enter: {},
    exit: [{ type: 'teachback_started' }, { type: 'teachback_confirmed' }],
    skip: [ended('review'), live('teach')],
    nudge: { afterMs: 45_000, line: "Answer by voice, and I'll update the map as we go." },
  },
  {
    id: 'teach-back',
    phase: 'review',
    persona: 'expert',
    target: 'teachback',
    fallbackTarget: 'review-board',
    line: 'Check my summary and confirm it, or correct what I got wrong.',
    voice: 'agent',
    resume: 'start-review',
    enter: {},
    exit: [{ type: 'teachback_confirmed' }],
    skip: [ended('review'), live('teach')],
    nudge: { afterMs: 40_000, line: 'Confirm my summary, or correct whatever I got wrong.' },
  },
  {
    id: 'end-review',
    phase: 'review',
    persona: 'expert',
    target: 'session-end',
    line: 'Confirmed, thanks; press End session to finish Review.',
    voice: 'clipa',
    resume: 'handoff',
    enter: {},
    exit: [ended('review')],
    skip: [live('teach')],
    nudge: { afterMs: 30_000, line: "Press End session when you're done with Review." },
  },
  {
    id: 'handoff',
    phase: 'review',
    persona: 'expert',
    target: 'mode-teach',
    line: 'Review is finished; hand over to the new hire and open Teach.',
    voice: 'clipa',
    enter: {},
    exit: [{ type: 'mode_changed', mode: 'teach' }, live('teach')],
    nudge: { afterMs: 30_000, line: 'Open Teach when the new hire is ready.' },
  },
  {
    id: 'start-teach',
    phase: 'teach',
    persona: 'newHire',
    target: 'session-start',
    line: "Press Start Teach, and I'll watch you work the new case.",
    voice: 'clipa',
    tab: 'teach',
    enter: {},
    exit: [live('teach')],
    nudge: { afterMs: 30_000, line: "Whenever you're ready, press Start Teach." },
    variants: {
      wrongTab: { target: 'mode-teach', line: 'Open the Teach tab first, then press Start.' },
      resume: { line: 'Welcome back: press Start Teach to carry on.' },
    },
  },
  {
    id: 'share-teach',
    phase: 'teach',
    persona: 'newHire',
    target: 'share-screen',
    line: "Share the window where you work the case; I'll watch it.",
    voice: 'clipa',
    capture: true,
    optional: 'captureInTeach',
    resume: 'start-teach',
    enter: {},
    exit: SHARE_EXIT,
    skip: [{ type: 'checkpoint_warned' }, { type: 'sent' }, ended('teach'), { type: 'teach_finished' }],
    nudge: { afterMs: 45_000, line: 'Choose a window, then confirm to start sharing.' },
    variants: SHARE_VARIANTS,
  },
  {
    id: 'teach',
    phase: 'teach',
    persona: 'newHire',
    target: 'workspace',
    line: "Here's a new case: say what you'd do next, then try it.",
    voice: 'clipa',
    resume: 'start-teach',
    enter: {},
    exit: [{ type: 'checkpoint_warned' }, { type: 'sent' }],
    skip: [ended('teach'), { type: 'teach_finished' }],
    nudge: { afterMs: 45_000, line: 'Tell me your next step, then try it in the workspace.' },
  },
  {
    id: 'teach-fix',
    phase: 'teach',
    persona: 'newHire',
    target: 'send',
    line: 'Fix the draft as the tutor said, then press Send again.',
    voice: 'agent',
    resume: 'start-teach',
    enter: {},
    exit: [{ type: 'sent' }],
    skip: [ended('teach'), { type: 'teach_finished' }],
    nudge: { afterMs: 30_000 },
  },
  {
    id: 'end-teach',
    phase: 'teach',
    persona: 'newHire',
    target: 'session-end',
    line: "Well done; press End session to see what you've mastered.",
    voice: 'clipa',
    resume: 'start-teach',
    enter: {},
    exit: [ended('teach'), { type: 'teach_finished' }],
    nudge: { afterMs: 30_000 },
  },
  {
    id: 'summary',
    phase: 'summary',
    persona: 'any',
    target: 'mastery-summary',
    line: "Here's what you've mastered and what to practise.",
    voice: 'clipa',
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
