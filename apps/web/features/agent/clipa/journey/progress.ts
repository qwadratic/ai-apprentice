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
  /** The first step of the phase: what "show me again" replays. */
  firstStep: JourneyStepId;
  /** A short extra, for example "2 of 3 questions" while Learn is current. */
  detail: string | null;
}

/** How many live questions the Learn phase asks for (doc-10: at least three). */
export const LEARN_QUESTION_GOAL = 3;

export function buildStrip(snapshot: JourneySnapshot, steps: readonly JourneyStep[] = JOURNEY_STEPS): StripItem[] {
  return JOURNEY_PHASES.map((phase): StripItem => {
    const own = steps.filter((step) => step.phase === phase);
    const first = own[0];
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
    return { phase, label: PHASE_LABELS[phase], status, firstStep: first ? first.id : steps[0]!.id, detail };
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
