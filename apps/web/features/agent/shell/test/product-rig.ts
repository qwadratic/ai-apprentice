// A rig with the product's wiring: the real AgentBrain over packages/agent and the sample scenarios (the customer_07 Learn run,
// the Teach cases), on fake timers and a fake voice. `converse` plays the conversation with the scripted expert and new hire.
import { AgentBrain } from '../brain/agent-brain.ts';
import { SAMPLE_CUSTOMERS } from '../screen/sample-scenarios.ts';
import type { FeedItem } from '../state/types.ts';
import { expertAnswer, expertTeachback } from './fixtures.ts';
import { createRig, modernApi, must, settle } from './helpers.ts';
import type { Rig, Responder } from './helpers.ts';

export function productRig(responders: Responder[] = [modernApi()]): Rig {
  return createRig({ scenarios: true, responders, createBrain: (log) => new AgentBrain({ log, customers: SAMPLE_CUSTOMERS }) });
}

export type Answerer = (item: FeedItem, spoken: string) => string | null;

/**
 * Plays the conversation: time advances in half seconds; whatever the controller sends to the voice as [ASK] is "spoken" by the
 * agent (mode speaking, an agent transcript line), then the person answers with what `answer` returns for that question.
 */
export async function converse(rig: Rig, state: { handled: number }, answer: Answerer, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    rig.timers.advance(500);
    await settle(3);
    while (state.handled < rig.voice.userMessages.length) {
      const spoken = must(rig.voice.userMessages[state.handled]).replace(/^\[ASK\]\s*/, '');
      state.handled += 1;
      rig.voice.mode('speaking');
      rig.voice.say('ai', spoken);
      rig.timers.advance(2500);
      rig.voice.mode('listening');
      const open = [...rig.controller.store.getState().feed].reverse().find((f) => f.status === 'asked');
      const reply = open ? answer(open, spoken) : null;
      if (reply !== null) {
        rig.timers.advance(1500);
        rig.voice.say('user', reply);
        await settle(40);
      }
    }
  }
}

export const learnAnswers: Answerer = (item) => (['reason', 'essentials', 'guardrail'].includes(item.topic) ? expertAnswer(item.topic) : null);

/** The scripted expert in Review: every follow-up answered; the first teach-back corrected, the second confirmed. */
export function reviewAnswerer(): Answerer {
  let teachBacks = 0;
  return (item) => {
    if (item.topic === 'teach_back') {
      teachBacks += 1;
      return teachBacks === 1 ? expertTeachback('correction') : expertTeachback('confirm');
    }
    return expertAnswer(item.topic);
  };
}

/** Learn (the sample customer_07 run), then Review with `answer`. */
export async function learnThenReview(rig: Rig, state: { handled: number }, answer: Answerer, reviewMs = 90_000): Promise<void> {
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  await converse(rig, state, learnAnswers, 90_000);
  await rig.controller.end();
  await rig.controller.start('review');
  await converse(rig, state, answer, reviewMs);
}
