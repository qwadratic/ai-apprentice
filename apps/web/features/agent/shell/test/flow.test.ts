// The whole product loop in the shell, on fake timers, a fake voice and the sample observation source: Learn (the customer_07
// run), Review (follow-ups, then a teach-back that is corrected and confirmed) and Teach (cases T1-T4). The expert and the new
// hire are the scripted actors of fixtures/agent/sim; the brain is the real AgentBrain over packages/agent with heuristics only.
// Nothing about the customer rule is known to the shell or the brain: it all comes from the expert's scripted answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Brain } from '../brain/types.ts';
import { CHECKPOINT_TIMEOUT_MS } from '../controller.ts';
import type { FeedItem } from '../state/types.ts';
import { expertAnswer, expertTeachback, learnFixture, novicePredict } from './fixtures.ts';
import type { Rig, RecordedRequest } from './helpers.ts';
import { ScriptedBrain, createRig, must, settle } from './helpers.ts';
import { productRig } from './product-rig.ts';

type Answerer = (item: FeedItem, spoken: string) => string | null;

/**
 * Plays the conversation: time advances in half seconds; whatever the controller sends to the voice as [ASK] is "spoken" by the
 * agent (mode speaking, an agent transcript line), then the person answers with what `answer` returns for that question.
 */
async function converse(rig: Rig, state: { handled: number }, answer: Answerer, ms: number): Promise<void> {
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

const learnAnswers: Answerer = (item) => (['reason', 'essentials', 'guardrail'].includes(item.topic) ? expertAnswer(item.topic) : null);

function reviewAnswerer(): Answerer {
  let teachBacks = 0;
  return (item) => {
    if (item.topic === 'teach_back') {
      teachBacks += 1;
      return teachBacks === 1 ? expertTeachback('correction') : expertTeachback('confirm');
    }
    return expertAnswer(item.topic);
  };
}

const uploadedEvents = (calls: RecordedRequest[]): Array<{ type: string; text: string }> =>
  calls.filter((c) => c.url.endsWith('/events')).flatMap((c) => (c.body as { events: Array<{ type: string; text: string }> }).events);

/** Learn and Review as the expert would do them; returns the rig at a confirmed Work Map. */
async function learnAndReview(rig: Rig, state: { handled: number }): Promise<void> {
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  await converse(rig, state, learnAnswers, 90_000);
  await rig.controller.end();
  await rig.controller.start('review');
  await converse(rig, state, reviewAnswerer(), 90_000);
}

test('Learn: at least three questions at natural pauses, one about a guardrail, never while the expert types', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  await converse(rig, state, learnAnswers, 90_000);
  const s = rig.controller.store.getState();

  assert.equal(s.brain.wired, true);
  assert.equal(s.screen.source?.synthetic, true, 'the sample is labelled synthetic');
  const answered = s.feed.filter((f) => f.status === 'answered');
  assert.ok(answered.length >= 3, `${answered.length} answered questions`);
  assert.ok(answered.some((f) => f.topic === 'guardrail'), 'one question is about a guardrail');
  for (const f of answered) assert.ok(f.evidenceIds.length > 0, `${f.topic} is about a screen moment`);

  // The sample expert types in bursts (heartbeats of fixtures/agent/learn-customer07.json): nothing is asked within 2 s of the
  // last real input. (The workspace reports "stopped typing" about 2 s late, so the policy's own 3 s counts from the last heartbeat.)
  const heartbeats = learnFixture().observations.filter((o) => o['kind'] === 'input_activity');
  const spoken = s.decisions.filter((d) => d.spoken);
  assert.ok(spoken.length >= 3);
  for (const d of spoken) {
    const lastInput = Math.max(0, ...heartbeats.map((h) => Number((h['facts'] as Record<string, unknown>)['lastInputAtMs'])).filter((t) => t <= d.atMs));
    assert.ok(d.atMs - lastInput >= 2000, `${d.topic} asked ${d.atMs - lastInput} ms after the last input`);
  }
  assert.ok(s.decisions.some((d) => d.decision === 'DEFER' && /typing/.test(d.whyNow)), 'questions were deferred while typing, with the reason logged');
  assert.ok(s.decisions.every((d) => d.whyNow.length > 0), 'every decision says why');

  // The answers are in the map with the expert's words and the screen moments.
  assert.ok(s.draftMap.steps.length > 0);
  const guardrails = must(s.draftMap.guardrails);
  assert.ok(guardrails.length >= 2, 'a rule for the customer and a stop-and-ask guardrail');
  assert.ok(guardrails.every((g) => g.evidenceIds.length > 0 && g.text.includes('The expert:')));
  assert.ok(s.draftMap.steps.some((st) => st.kind === 'judgment' && st.reason !== null));
});

test('Review: at least three follow-ups, then a teach-back that is corrected (new version) and confirmed', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnAndReview(rig, state);
  const s = rig.controller.store.getState();

  const followUps = s.feed.filter((f) => f.status === 'answered' && f.topic !== 'teach_back' && f.atMs >= 0 && ['scope', 'exception', 'why_stop', 'duration', 'reason'].includes(f.topic));
  assert.ok(followUps.length >= 3, `${followUps.length} follow-ups`);
  assert.equal(s.review.gaps.length, 0, 'every gap is closed');
  assert.equal(s.review.teachBack.status, 'confirmed');
  assert.equal(s.draftMap.version, 2, 'the correction made version 2');
  assert.equal(s.draftMap.confirmed, true);
  // The teach-back was spoken twice (the second one after the correction), and the debrief closed.
  assert.equal(s.feed.filter((f) => f.topic === 'teach_back').length, 2);
  assert.ok(s.feed.some((f) => f.topic === 'review_done' && f.status === 'said'));
  const corrected = rig.voice.userMessages.filter((m) => /order number, delivery address and delivery window/.test(m));
  assert.ok(corrected.length >= 1, 'the second teach-back carries the correction');
});

test('Teach: T1 is warned with the expert quote, T2 allowed, T3 another customer clear, T4 unknown asks', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnAndReview(rig, state);

  const runCase = async (id: 't1' | 't2' | 't3' | 't4') => {
    await rig.controller.runSampleCase(id);
    await converse(rig, state, (item) => (item.topic === 'predict_next' ? novicePredict(id) : null), 9000);
    rig.controller.raiseSampleCheckpoint();
    await settle();
    await converse(rig, state, () => null, 3000);
    return must(rig.controller.store.getState().teach.checkpoint);
  };

  const t1 = await runCase('t1');
  assert.equal(t1.status, 'warn');
  assert.match(t1.message, /the expert said/i);
  assert.ok(t1.message.includes('asked me for it in writing'), 'the expert\'s own words are quoted');
  assert.ok(t1.evidenceIds.length > 0, 'a link to the expert\'s screen moment');
  const moment = await rig.controller.resolveEvidence(must(t1.evidenceIds[0]));
  assert.match(moment.assetRef, /^mock:/, 'the Learn evidence still resolves in Teach');
  assert.ok(rig.voice.userMessages.some((m) => m.startsWith('[ASK] Hold on before Send')), 'the warning is spoken before Send');
  assert.equal(rig.controller.store.getState().feed.some((f) => f.decision === 'WARN' && f.status === 'said'), true, JSON.stringify(rig.controller.store.getState().feed.map((f) => [f.decision, f.topic, f.status, f.note])));
  assert.ok(rig.voice.userMessages.some((m) => /^\[ASK\] For ORD-2057/.test(m)), 'the new hire is asked to predict first');

  const t2 = await runCase('t2');
  assert.equal(t2.status, 'clear');
  const t3 = await runCase('t3');
  assert.equal(t3.status, 'clear');
  assert.match(t3.message, /no personal rule for customer_03/);
  const t4 = await runCase('t4');
  assert.equal(t4.status, 'unknown');
  assert.match(t4.message, /will not guess/);
  assert.ok(rig.voice.userMessages.some((m) => /will not guess/.test(m)), 'the tutor says it does not know, out loud');

  const mastery = must(rig.controller.store.getState().teach.mastery);
  assert.ok(mastery.practise.some((l) => l.startsWith('T1')), 'T1 needed the stop');
  assert.ok(mastery.mastered.some((l) => l.startsWith('T3')));
});

test('Teach without a confirmed Work Map answers unknown, never clear', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await rig.controller.setSampleObservations(true);
  await rig.controller.runSampleCase('t1');
  await converse(rig, state, () => null, 6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  assert.equal(must(rig.controller.store.getState().teach.checkpoint).status, 'unknown');
});

test('answers and map versions are persisted through the session events route, not the visible log', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnAndReview(rig, state);
  rig.timers.advance(2500);
  await settle();
  const events = uploadedEvents(rig.calls);
  const answers = events.filter((e) => e.type === 'ANSWER');
  assert.ok(answers.length >= 6, `${answers.length} answers stored`);
  assert.ok(answers.some((e) => (JSON.parse(e.text) as { topic: string }).topic === 'guardrail'));
  const versions = events.filter((e) => e.type === 'MAP_VERSION').map((e) => JSON.parse(e.text) as { version: number; confirmed: boolean });
  assert.ok(versions.some((v) => v.version === 1 && !v.confirmed), 'the Learn draft');
  assert.ok(versions.some((v) => v.version === 2 && v.confirmed), 'the confirmed version');
  const visible = rig.controller.store.getState().events;
  assert.ok(visible.every((e) => e.type !== 'ANSWER' && e.type !== 'MAP_VERSION'), 'structured records stay out of the visible log');
});

test('the checkpoint reply arrives within 4 s: a brain that does not answer gets `unknown`', async () => {
  const brain = new ScriptedBrain();
  brain.checkpoint = () => new Promise(() => {}) as never; // never settles
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('teach');
  rig.timers.advance(6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  rig.timers.advance(CHECKPOINT_TIMEOUT_MS - 1);
  await settle();
  assert.equal(rig.controller.store.getState().teach.checkpoint, null, 'still waiting just before the timeout');
  rig.timers.advance(1);
  await settle();
  const card = must(rig.controller.store.getState().teach.checkpoint);
  assert.equal(card.status, 'unknown');
  assert.match(card.message, /did not answer in time/);
  assert.equal(card.deliveryError, null, 'the unknown reply reached the workspace');
  assert.ok(rig.controller.store.getState().events.some((e) => e.dir === 'err' && /did not answer the checkpoint within 4 s/.test(e.text)));
});

test('a brain that answers late does not overwrite the unknown reply', async () => {
  const brain = new ScriptedBrain();
  let release: (value: unknown) => void = () => {};
  brain.checkpoint = ((c: { id: string; revisions: { order: string; email: string } }) => new Promise((resolve) => {
    release = () => resolve({ schemaVersion: 1, checkpointId: c.id, status: 'clear', message: 'late', evidenceIds: [], basedOn: c.revisions });
  })) as never;
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('teach');
  rig.timers.advance(6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  rig.timers.advance(CHECKPOINT_TIMEOUT_MS);
  await settle();
  release(null);
  await settle();
  assert.equal(must(rig.controller.store.getState().teach.checkpoint).status, 'unknown');
});

test('a brain that throws on a checkpoint also gets `unknown`', async () => {
  const brain: Brain = new ScriptedBrain();
  brain.checkpoint = () => { throw new Error('boom'); };
  const rig = createRig({ brain });
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('teach');
  rig.timers.advance(6000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  assert.equal(must(rig.controller.store.getState().teach.checkpoint).status, 'unknown');
});

test('a spoken question that never reaches the person goes back to the brain\'s queue', async () => {
  const rig = productRig();
  await rig.controller.setSampleObservations(true);
  await rig.controller.start('learn');
  // The voice never gets to speak: after 12 s the question is handed back and asked again at the next pause.
  rig.timers.advance(40_000);
  const first = rig.voice.userMessages.length;
  assert.ok(first >= 1);
  rig.timers.advance(12_500);
  await settle();
  const s = rig.controller.store.getState();
  assert.ok(s.feed.some((f) => f.status === 'unspoken' && /did not start speaking/.test(f.note ?? '')));
  rig.timers.advance(10_000);
  assert.ok(rig.voice.userMessages.length > first, 'the question is asked again');
});
