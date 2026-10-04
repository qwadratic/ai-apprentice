/*
 * The model behind the progress strip: Share, Learn, Review, Teach, Summary, each done, current, skipped or
 * upcoming. Pure, so the node tests cover it; ProgressStrip.tsx only draws it.
 */
import type { JourneySnapshot } from './engine.ts';
import { JOURNEY_PHASES, JOURNEY_STEPS, PHASE_LABELS } from './journey.ts';
import type { JourneyPhase, JourneyStep, JourneyStepId } from './journey.ts';

export type PhaseStatus = 'done' | 'current' | 'skipped' | 'upcoming';

export interface StripItem {
  phase: JourneyPhase;
  label: string;
  status: PhaseStatus;
  /** The step "show me again" replays: the one that points at the phase's own control. */
  replayStep: JourneyStepId;
  /** A short extra, for example "2 of 3 questions" while Learn is current. */
  detail: string | null;
}

/** How many live questions the Learn phase asks for (doc-10: at least three). */
export const LEARN_QUESTION_GOAL = 3;

const REPLAY_STEP: Readonly<Record<JourneyPhase, JourneyStepId>> = {
  share: 'share',
  learn: 'learn',
  review: 'review-board',
  teach: 'teach',
  summary: 'summary',
};

export function buildStrip(snapshot: JourneySnapshot, table: readonly JourneyStep[] = JOURNEY_STEPS): StripItem[] {
  const known = new Set<JourneyStepId>(snapshot.stepIds);
  return JOURNEY_PHASES.map((phase): StripItem => {
    const own = table.filter((step) => step.phase === phase && known.has(step.id));
    const outcomes = own.map((step) => snapshot.outcomes[step.id]);
    let status: PhaseStatus;
    if (snapshot.done) status = 'done';
    else if (snapshot.phase === phase) status = 'current';
    else if (outcomes.length > 0 && outcomes.every((o) => o === 'done')) status = 'done';
    else if (outcomes.length > 0 && outcomes.every((o) => o !== undefined)) status = 'skipped';
    else status = 'upcoming';

    let detail: string | null = null;
    if (phase === 'learn' && status === 'current' && snapshot.questions > 0) {
      detail = `${Math.min(snapshot.questions, LEARN_QUESTION_GOAL)} of ${LEARN_QUESTION_GOAL} questions`;
    }
    return { phase, label: PHASE_LABELS[phase], status, replayStep: REPLAY_STEP[phase], detail };
  });
}

const STATUS_WORDS: Readonly<Record<PhaseStatus, string>> = {
  done: 'done',
  current: 'current step',
  skipped: 'skipped',
  upcoming: 'coming up',
};

/** Words for screen readers and for people who do not see the colour. */
export function statusWord(status: PhaseStatus): string {
  return STATUS_WORDS[status];
}
