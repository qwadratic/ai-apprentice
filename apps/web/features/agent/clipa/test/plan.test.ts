import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateSpeechMs, planDecision, utteranceText } from '../src/plan.ts';
import type { ClipaDecision, ClipaTarget } from '../src/types.ts';

const BODY: ClipaTarget = { surface: 'email', hint: 'body' };
const SEND: ClipaTarget = { surface: 'email', hint: 'send' };

describe('decision plans', () => {
  it('ASK_NOW approaches the target, speaks and listens (the BrainDecision example of the spec)', () => {
    const decision: ClipaDecision = {
      decision: 'ASK_NOW',
      utterance: { text: 'You removed the screenshot and typed the address. Why for this client?', maxWords: 18 },
      expectsAnswer: true,
      clipa: { state: 'approach', target: BODY },
    };
    assert.deepEqual(planDecision(decision).steps, [
      { op: 'approach', target: BODY },
      { op: 'speak', text: 'You removed the screenshot and typed the address. Why for this client?' },
      { op: 'listen' },
    ]);
  });

  it('defaults to approach for ASK_NOW and PREDICT', () => {
    for (const verdict of ['ASK_NOW', 'PREDICT'] as const) {
      const plan = planDecision({ decision: verdict, utterance: 'What would Sabine do next?', clipa: { target: BODY } });
      assert.deepEqual(plan.steps.map((s) => s.op), ['approach', 'speak', 'listen'], verdict);
    }
  });

  it('does not listen when no answer is expected', () => {
    const plan = planDecision({ decision: 'ASK_NOW', utterance: 'Noted.', expectsAnswer: false, clipa: { target: BODY } });
    assert.deepEqual(plan.steps.map((s) => s.op), ['approach', 'speak']);
  });

  it('WARN defaults to the warning pose beside the target with the words in the bubble, and no listening', () => {
    const plan = planDecision({ decision: 'WARN', utterance: 'Sabine would stop here.', clipa: { target: SEND } });
    assert.deepEqual(plan.steps, [
      { op: 'warn', target: SEND },
      { op: 'speak', text: 'Sabine would stop here.' },
    ]);
  });

  it('an explicit pointing state points at the target', () => {
    const plan = planDecision({
      decision: 'WARN',
      utterance: 'Here is how she did it.',
      clipa: { state: 'pointing', target: { surface: 'evidence', hint: 'replay' } },
    });
    assert.deepEqual(plan.steps.map((s) => s.op), ['point', 'speak']);
  });

  it('DEFER and SKIP move nothing, whatever clipa says', () => {
    for (const verdict of ['DEFER', 'SKIP'] as const) {
      const plan = planDecision({ decision: verdict, utterance: 'ignored', clipa: { state: 'approach', target: BODY } });
      assert.deepEqual(plan.steps, [], verdict);
      assert.match(plan.note ?? '', new RegExp(verdict));
    }
  });

  it('ignores a verdict it does not know instead of guessing', () => {
    const plan = planDecision({ decision: 'MAYBE' } as unknown as ClipaDecision);
    assert.deepEqual(plan.steps, []);
    assert.match(plan.note ?? '', /unknown decision/);
  });

  it('maps explicit states to single commands', () => {
    const one = (state: NonNullable<ClipaDecision['clipa']>['state']): string[] =>
      planDecision({ decision: 'ASK_NOW', clipa: { ...(state === undefined ? {} : { state }), target: BODY } }).steps.map((s) => s.op);
    assert.deepEqual(one('listening'), ['listen']);
    assert.deepEqual(one('thinking'), ['think']);
    assert.deepEqual(one('ack'), ['ack']);
    assert.deepEqual(one('retreat'), ['retreat']);
    assert.deepEqual(one('dock'), ['retreat']);
    assert.deepEqual(one('off'), ['off']);
    assert.deepEqual(one('notice'), ['notice']);
    assert.deepEqual(one('approach'), ['approach']);
  });

  it('speaks in place when there is no target, and says so', () => {
    const plan = planDecision({ decision: 'ASK_NOW', utterance: 'Why this one?', clipa: { state: 'approach' } });
    assert.deepEqual(plan.steps.map((s) => s.op), ['speak', 'listen']);
    assert.match(plan.note ?? '', /no target/);
  });

  it('notice without a target does nothing', () => {
    const plan = planDecision({ decision: 'ASK_NOW', clipa: { state: 'notice' } });
    assert.deepEqual(plan.steps, []);
    assert.match(plan.note ?? '', /needs a target/);
  });

  it('reads the utterance as a string or an object and drops empty text', () => {
    assert.equal(utteranceText('  Why?  '), 'Why?');
    assert.equal(utteranceText({ text: 'Why?', maxWords: 3 }), 'Why?');
    assert.equal(utteranceText('   '), null);
    assert.equal(utteranceText(undefined), null);
    const plan = planDecision({ decision: 'ASK_NOW', utterance: '  ', clipa: { target: BODY } });
    assert.deepEqual(plan.steps.map((s) => s.op), ['approach']);
  });

  it('estimates speech time by words, within 1.2 and 14 s', () => {
    assert.equal(estimateSpeechMs(''), 1200);
    assert.equal(estimateSpeechMs('Why?'), 1200);
    const short = estimateSpeechMs('You removed the screenshot and typed the address');
    const long = estimateSpeechMs('You removed the screenshot and typed the address. Why for this client, and who asked you to?');
    assert.ok(short >= 1200 && long > short);
    assert.equal(estimateSpeechMs('word '.repeat(500)), 14000);
  });
});
