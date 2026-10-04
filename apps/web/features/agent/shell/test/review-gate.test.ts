// The confirmation gate in the shell (packages/agent, TASK-3.29): Teach applies a rule only after the expert confirmed a teach-back
// that states exactly it. A correction makes a new provisional version; a confirmation carries the digest of the version it
// confirms; a stale confirmation confirms nothing; two unclear replies hand over to the buttons.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBrain } from '../brain/agent-brain.ts';
import type { AnswerResult, BrainSignals } from '../brain/types.ts';
import { SAMPLE_CUSTOMERS, buildScenario } from '../screen/sample-scenarios.ts';
import { expertAnswer, expertTeachback, novicePredict } from './fixtures.ts';
import type { Rig } from './helpers.ts';
import { must, settle } from './helpers.ts';
import { converse, learnThenReview, productRig } from './product-rig.ts';
import type { Answerer } from './product-rig.ts';

const teachCheckpoint = async (rig: Rig, state: { handled: number }, id: 't1' | 't2' | 't3' | 't4') => {
  await rig.controller.runSampleCase(id);
  await converse(rig, state, (item) => (item.topic === 'predict_next' ? novicePredict(id) : null), 9000);
  rig.controller.raiseSampleCheckpoint();
  await settle();
  return must(rig.controller.store.getState().teach.checkpoint);
};

/** Follow-ups answered by the scripted expert; the teach-back replies come from `replies`, in order, then silence. */
const withTeachBackReplies = (replies: string[]): Answerer => {
  let n = 0;
  return (item) => {
    if (item.topic !== 'teach_back') return expertAnswer(item.topic);
    n += 1;
    return replies[n - 1] ?? null;
  };
};

test('the teach-back on screen states scope, fields, exception and reason, and carries a digest', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  const tb = rig.controller.store.getState().review.teachBack;
  const text = must(tb.text);
  assert.match(text, /Scope: only for customer_07/);
  assert.match(text, /delivery address and delivery window/);
  assert.match(text, /Exception: /, 'the exception the expert gave');
  assert.match(text, /Reason: /);
  assert.ok(must(tb.digest).length > 0);
  assert.equal(tb.status, 'pending');
});

test('before any confirmation Teach answers unknown for every case, with the reason said out loud', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  assert.equal(rig.controller.store.getState().review.teachBack.status, 'pending');
  for (const id of ['t1', 't2', 't3', 't4'] as const) {
    const card = await teachCheckpoint(rig, state, id);
    assert.equal(card.status, 'unknown', id);
    assert.match(card.message, /not confirmed|no confirmed|do not know/i, id);
  }
});

test('a correction is provisional: Teach stays unknown until the new teach-back is confirmed', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([expertTeachback('correction')]), 90_000);
  const s = rig.controller.store.getState();
  assert.equal(s.draftMap.version, 2);
  assert.equal(s.draftMap.confirmed, false);
  assert.equal(s.review.teachBack.status, 'pending', 'the new version waits for its own confirmation');
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'unknown');
});

test('after a confirmed teach-back Teach applies the rule (T1 warns)', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([expertTeachback('correction'), expertTeachback('confirm')]), 90_000);
  assert.equal(rig.controller.store.getState().review.teachBack.status, 'confirmed');
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'warn');
});

test('two unclear replies bring the buttons; the rule stays provisional until Confirm is pressed', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies(['Hmm.', "I'm not sure."]), 90_000);
  const s = rig.controller.store.getState();
  assert.equal(s.review.buttons, true, 'Skip is offered next to Confirm and Correct');
  assert.match(s.review.notice ?? '', /could not tell/, 'the unclear reply is surfaced');
  assert.equal(s.review.teachBack.status, 'pending');
  assert.equal(s.feed.filter((f) => f.topic === 'teach_back').length, 2, 'asked, asked again once, then no more');
  assert.ok(rig.voice.userMessages.some((m) => /use the buttons: Confirm, Correct or Skip/.test(m)));
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'unknown', 'unclear is not a confirmation');

  // The person confirms with the button: it carries the digest of the teach-back on screen.
  await rig.controller.start('review');
  rig.controller.setMode('review');
  const digest = must(rig.controller.store.getState().review.teachBack.digest);
  assert.ok(digest.length > 0);
  rig.controller.confirmTeachBack();
  await settle(40);
  assert.equal(rig.controller.store.getState().review.teachBack.status, 'confirmed');
  assert.equal(rig.controller.store.getState().draftMap.confirmed, true);
  await rig.controller.end();
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'warn');
});

test('Skip leaves the rule provisional: Teach never applies it', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies(['Hmm.', 'Er, hmm.']), 90_000);
  rig.controller.skipTeachBack();
  await settle(40);
  rig.timers.advance(1000);
  await settle(5);
  const s = rig.controller.store.getState();
  assert.match(s.review.notice ?? '', /Skipped/);
  assert.equal(s.review.teachBack.status, 'pending');
  assert.ok(rig.voice.userMessages.some((m) => /^\[ASK\] Skipped\./.test(m)), 'the debrief says so');
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'unknown');
});

test('a confirmation that carries the digest of an older teach-back is stale and confirms nothing', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  const result = (await rig.brain.onAnswer({ questionId: null, topic: 'teach_back', text: '', atMs: 99_000, kind: 'confirm', digest: 'deadbeef' })) as AnswerResult;
  assert.deepEqual(result, { teachBack: 'stale', changed: true });
  const review = rig.brain.review();
  assert.equal(review.map.confirmed, false);
  assert.notEqual(review.teachBackDigest, 'deadbeef');
  assert.equal((await teachCheckpoint(rig, state, 't1')).status, 'unknown');
});

test('a stale confirm in the shell is surfaced, the new teach-back is shown and the next confirm is accepted', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  rig.controller.setMode('review'); // the Review view is on screen: its teach-back counts as stated
  const shownDigest = must(rig.controller.store.getState().review.teachBack.digest);
  // The map moves on while the old teach-back is still on screen (a late answer changes it).
  await rig.brain.onAnswer({ questionId: null, topic: 'teach_back', text: expertTeachback('correction'), atMs: 70_000, kind: 'correct', digest: shownDigest });
  const before = rig.controller.store.getState();
  assert.equal(before.review.teachBack.digest, shownDigest, 'the screen still shows the old teach-back');
  rig.controller.confirmTeachBack();
  await settle(40);
  const s = rig.controller.store.getState();
  assert.match(s.review.notice ?? '', /changed since you read it/);
  assert.notEqual(s.review.teachBack.digest, shownDigest, 'the current teach-back replaced it');
  assert.notEqual(s.review.teachBack.status, 'confirmed');
  rig.controller.confirmTeachBack();
  await settle(40);
  assert.equal(rig.controller.store.getState().review.teachBack.status, 'confirmed');
  assert.equal(rig.controller.store.getState().draftMap.confirmed, true);
});

test('a teach-back counts only once it is stated: a correction needs its new teach-back spoken or shown before a confirm counts', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  // The first teach-back was spoken. A typed correction makes a new provisional version and a new teach-back that nobody has heard.
  const first = rig.brain.review(false);
  const corrected = (await rig.brain.onAnswer({ questionId: null, topic: 'teach_back', text: expertTeachback('correction'), atMs: 70_000, kind: 'correct', digest: first.teachBackDigest })) as AnswerResult;
  assert.equal(corrected.teachBack, 'corrected');
  const next = rig.brain.review(false);
  assert.notEqual(next.teachBackDigest, first.teachBackDigest);
  // A confirm for the new teach-back before it was stated is stale, even though its digest is the current one.
  const early = (await rig.brain.onAnswer({ questionId: null, topic: 'teach_back', text: '', atMs: 71_000, kind: 'confirm', digest: next.teachBackDigest })) as AnswerResult;
  assert.equal(early.teachBack, 'stale');
  assert.equal(rig.brain.review(false).map.confirmed, false);
  // Showing it states it (review(true) is what the Review view does); now the confirm counts.
  rig.brain.review(true);
  const late = (await rig.brain.onAnswer({ questionId: null, topic: 'teach_back', text: '', atMs: 72_000, kind: 'confirm', digest: next.teachBackDigest })) as AnswerResult;
  assert.equal(late.teachBack, 'confirmed');
  assert.equal(rig.brain.review(false).map.confirmed, true);
});

/** A brain taken through Learn and the Review follow-ups, stopped right before it would say the teach-back. */
async function brainAtTheTeachBack(): Promise<AgentBrain> {
  const brain = new AgentBrain({ log: () => {}, customers: SAMPLE_CUSTOMERS });
  const base: BrainSignals = { sessionId: 's1', mode: 'learn', persona: 'plain', offRecord: false, voiceConnected: true, agentSpeaking: false, humanSpeaking: false, asked: 0 };
  brain.begin({ sessionId: 's1', mode: 'learn', persona: 'plain', llm: null });
  const pending = [...buildScenario('learn', 's1').observations];
  for (let ms = 0; ms <= 90_000; ms += 500) {
    while (pending.length > 0 && must(pending[0]).timestampMs <= ms) brain.onObservation(must(pending.shift()));
    for (const d of brain.tick(ms, base)) {
      if (d.decision === 'ASK_NOW' && d.expectsAnswer) await brain.onAnswer({ questionId: null, topic: d.topic, text: expertAnswer(d.topic), atMs: ms, kind: 'answer' });
    }
  }
  brain.begin({ sessionId: 's2', mode: 'review', persona: 'plain', llm: null });
  for (let ms = 100_000; brain.review(false).gaps.length > 0 && ms < 200_000; ms += 2000) {
    for (const d of brain.tick(ms, { ...base, sessionId: 's2', mode: 'review' })) {
      if (d.decision === 'ASK_NOW' && d.expectsAnswer) await brain.onAnswer({ questionId: null, topic: d.topic, text: expertAnswer(d.topic), atMs: ms, kind: 'answer' });
    }
  }
  assert.equal(brain.review(false).gaps.length, 0);
  return brain;
}

test('a teach-back that was neither spoken nor shown cannot be confirmed; showing it (the Review view) states it', async () => {
  const brain = await brainAtTheTeachBack();
  const digest = must(brain.review(false).teachBackDigest);
  // Reloading the draft map for another view (shown = false) states nothing: nobody read it.
  const early = (await brain.onAnswer({ questionId: null, topic: 'teach_back', text: '', atMs: 300_000, kind: 'confirm', digest })) as AnswerResult;
  assert.equal(early.teachBack, 'stale');
  assert.equal(brain.review(false).map.confirmed, false);
  brain.review(true);
  const ok = (await brain.onAnswer({ questionId: null, topic: 'teach_back', text: '', atMs: 301_000, kind: 'confirm', digest })) as AnswerResult;
  assert.equal(ok.teachBack, 'confirmed');
  assert.equal(brain.review(false).map.confirmed, true);
});

test('the teach-back text is shown verbatim, including what is assumed from the screen', async () => {
  const brain = await brainAtTheTeachBack();
  const review = brain.review(true);
  const text = must(review.teachBack);
  assert.match(text, /Scope: only for customer_07/);
  assert.match(text, /Reason: /);
  const guardrails = must(review.map.guardrails);
  assert.ok(guardrails.some((g) => g.text.includes('The expert:')));
});

test('a case the tutor could not judge is "not judged", never mastered, and its title is not doubled', async () => {
  const rig = productRig();
  const state = { handled: 0 };
  await learnThenReview(rig, state, withTeachBackReplies([]), 60_000);
  const card = await teachCheckpoint(rig, state, 't1');
  assert.equal(card.status, 'unknown');
  const m = must(rig.controller.store.getState().teach.mastery);
  assert.deepEqual(m.mastered, [], 'nothing is mastered without a judgement');
  assert.deepEqual(m.practise, []);
  assert.equal(m.notJudged?.length, 1);
  assert.match(must(m.notJudged?.[0]), /not judged/);
  assert.doesNotMatch(must(m.notJudged?.[0]), /T1 T1/);
});
