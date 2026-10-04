// What each persona does in the workspace, as data: a list of steps that driver.ts runs like a person would.
//
// The workspace actions are timed by the persona (it opens the order, looks, removes the image, types, pauses). The
// persona's spoken ANSWERS are not: they are cued by the agent's questions (driver.onAgentAsk), never placed on a timeline.
// A `pause` is where the persona goes quiet on purpose, so the agent's quiet detection can see a natural pause and ask.
// Texts may use {orderId}, {customer}, {address} and {window}: the driver reads them from the screen when the step runs.
//
// Case ids are the demo workspace's (apps/web/features/demo-workspace/cases.ts): 'practice' is the Learn order,
// 'new-image' is T1 (same customer, image only), 'new-text-image' T2, 'other' T3, 'unknown' T4.
import type { CheckStatus, TextTarget } from './workspace-actions.ts';

export type TaskStep =
  | { do: 'open'; case: string }
  /** Reads the screen without touching it. */
  | { do: 'look'; ms: number }
  /**
   * A natural pause. Waits `ms`, then up to `graceMs` more for the agent to start talking, then until the agent has
   * finished and the persona has finished its own answer. The agent's quiet detection needs several seconds of quiet.
   */
  | { do: 'pause'; ms: number; graceMs?: number }
  | { do: 'remove_image' }
  | { do: 'attach_image' }
  | { do: 'type'; target: TextTarget; text: string; mode: 'replace' | 'append' }
  /** Presses Preview and waits for the check. */
  | { do: 'preview' }
  | { do: 'ack' }
  | { do: 'send' }
  | { do: 'resolve' }
  /** A spoken reaction (a line keyed by topic), only if the agent spoke since the last open or Preview. */
  | { do: 'react'; topic: string; ifAgentSpoke: true }
  | { do: 'if_check'; status: readonly CheckStatus[]; then: readonly TaskStep[]; else?: readonly TaskStep[] };

export interface TaskScript {
  id: string;
  persona: 'expert' | 'newHire';
  /** One line for the log and the banner. */
  title: string;
  steps: readonly TaskStep[];
}

const FULL_TEXT =
  'Hello,\n\nYour delivery is scheduled for {window}.\nDelivery address: {address}.\n\nKind regards,\nDemo operations';
const FULL_TEXT_WITH_ORDER =
  'Hello,\n\nOrder {orderId}: your delivery is scheduled for {window}.\nDelivery address: {address}.\n\nKind regards,\nDemo operations';

/** Learn: the customer_07 order. The persona removes the image and writes the details out, and answers what it is asked. */
export const EXPERT_LEARN: TaskScript = {
  id: 'expert-learn',
  persona: 'expert',
  title: 'Learn: the delivery email for customer_07, details as text instead of the picture',
  steps: [
    { do: 'open', case: 'practice' },
    { do: 'look', ms: 3500 },
    { do: 'remove_image' },
    { do: 'pause', ms: 7000, graceMs: 4000 },
    { do: 'type', target: 'body', text: FULL_TEXT, mode: 'replace' },
    { do: 'pause', ms: 7000, graceMs: 4000 },
    { do: 'preview' },
    { do: 'pause', ms: 7000, graceMs: 4000 },
    { do: 'if_check', status: ['warn', 'unknown'], then: [{ do: 'ack' }] },
    { do: 'send' },
    { do: 'look', ms: 1500 },
    { do: 'type', target: 'ticket', text: 'ORD-2041: delivery details sent as text.', mode: 'replace' },
    { do: 'look', ms: 1200 },
    { do: 'resolve' },
    { do: 'pause', ms: 4000, graceMs: 2000 },
  ],
};

/** Teach T1: same customer, a new order, image only. The new hire reaches for the usual picture, gets the warning and fixes it. */
export const NEW_HIRE_T1: TaskScript = {
  id: 'new-hire-t1',
  persona: 'newHire',
  title: 'Teach T1: new order for the same customer, image only; the tutor holds the new hire before Send',
  steps: [
    { do: 'open', case: 'new-image' },
    { do: 'look', ms: 3000 },
    // The tutor asks what the new hire would do; the persona answers when asked.
    { do: 'pause', ms: 4000, graceMs: 7000 },
    { do: 'preview' },
    {
      do: 'if_check',
      status: ['warn', 'unknown'],
      then: [
        // The tutor explains the stop with the expert's words and asks why; the persona answers when asked and reacts.
        { do: 'pause', ms: 3000, graceMs: 6000 },
        { do: 'react', topic: 'ack', ifAgentSpoke: true },
        { do: 'type', target: 'body', text: FULL_TEXT_WITH_ORDER, mode: 'replace' },
        { do: 'preview' },
        { do: 'if_check', status: ['warn', 'unknown'], then: [{ do: 'pause', ms: 3000, graceMs: 4000 }] },
      ],
    },
    { do: 'if_check', status: ['clear'], then: [{ do: 'send' }, { do: 'look', ms: 1500 }, { do: 'resolve' }] },
    { do: 'pause', ms: 3000, graceMs: 5000 },
  ],
};

/** Teach T2: full text plus the image. Allowed; the tutor must not stop it. */
export const NEW_HIRE_T2: TaskScript = {
  id: 'new-hire-t2',
  persona: 'newHire',
  title: 'Teach T2: full text and the image; allowed',
  steps: [
    { do: 'open', case: 'new-text-image' },
    { do: 'look', ms: 3000 },
    { do: 'pause', ms: 4000, graceMs: 7000 },
    { do: 'preview' },
    { do: 'if_check', status: ['clear'], then: [{ do: 'send' }, { do: 'look', ms: 1500 }, { do: 'resolve' }] },
    { do: 'pause', ms: 3000, graceMs: 4000 },
  ],
};

/** Teach T3: another customer. The personal rule must not be applied. */
export const NEW_HIRE_T3: TaskScript = {
  id: 'new-hire-t3',
  persona: 'newHire',
  title: 'Teach T3: another customer, usual picture; the personal rule does not apply',
  steps: [
    { do: 'open', case: 'other' },
    { do: 'look', ms: 3000 },
    { do: 'pause', ms: 4000, graceMs: 7000 },
    { do: 'preview' },
    { do: 'if_check', status: ['clear'], then: [{ do: 'send' }, { do: 'look', ms: 1500 }, { do: 'resolve' }] },
    { do: 'pause', ms: 3000, graceMs: 4000 },
  ],
};

/** Teach T4: an unidentified customer. The tutor says it is unknown; the new hire does not send. */
export const NEW_HIRE_T4: TaskScript = {
  id: 'new-hire-t4',
  persona: 'newHire',
  title: 'Teach T4: unidentified customer; the new hire asks and does not send',
  steps: [
    { do: 'open', case: 'unknown' },
    { do: 'look', ms: 3000 },
    { do: 'pause', ms: 4000, graceMs: 7000 },
    { do: 'preview' },
    { do: 'pause', ms: 4000, graceMs: 5000 },
  ],
};

export const TASKS: Readonly<Record<string, TaskScript>> = {
  [EXPERT_LEARN.id]: EXPERT_LEARN,
  [NEW_HIRE_T1.id]: NEW_HIRE_T1,
  [NEW_HIRE_T2.id]: NEW_HIRE_T2,
  [NEW_HIRE_T3.id]: NEW_HIRE_T3,
  [NEW_HIRE_T4.id]: NEW_HIRE_T4,
};
