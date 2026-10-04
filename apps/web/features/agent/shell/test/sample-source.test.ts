import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionCheckpoint, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import { SAMPLE_LABEL, SAMPLE_TICK_MS, SampleObservationSource } from '../screen/sample-source.ts';
import { FakeTimers, must } from './helpers.ts';

function rig() {
  const timers = new FakeTimers();
  const clock = { base: 1_700_000_000_000 };
  const now = () => clock.base + timers.now;
  const source = new SampleObservationSource(now, timers);
  const observations: ScreenObservation[] = [];
  const statuses: ScreenStatus[] = [];
  const checkpoints: ActionCheckpoint[] = [];
  source.onObservation((o) => observations.push(o));
  source.onStatus((s) => statuses.push(s));
  source.onCheckpoint((c) => checkpoints.push(c));
  return { timers, now, source, observations, statuses, checkpoints, epoch: now() };
}

test('the sample source is labelled synthetic', () => {
  const { source } = rig();
  assert.equal(source.synthetic, true);
  assert.match(source.label, /synthetic/);
  assert.equal(source.label, SAMPLE_LABEL);
});

test('observations follow the wall clock from the session epoch, in order', async () => {
  const r = rig();
  r.timers.advance(40);
  await r.source.start({ sessionId: 'sess-a', sessionEpochMs: r.epoch + 40 });
  assert.deepEqual(r.statuses.map((s) => s.state), ['capturing']);
  r.timers.advance(999);
  assert.equal(r.observations.length, 0);
  r.timers.advance(SAMPLE_TICK_MS);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0]?.kind, 'order_view');
  r.timers.advance(10_000);
  assert.deepEqual(r.observations.map((o) => o.id), ['order-1', 'input-1', 'email-1', 'ticket-1']);
  assert.ok(r.observations.every((o) => o.sessionId === 'sess-a'));
  assert.ok(!r.observations.some((o) => o.id === 'order-unknown'), 'the untracked order is left out');
});

test('a sample checkpoint can be raised any time after the email preview', async () => {
  const r = rig();
  await r.source.start({ sessionId: 's', sessionEpochMs: r.epoch });
  assert.throws(() => r.source.raiseSampleCheckpoint(), /Checkpoint requires/);
  r.timers.advance(30_000);
  r.source.raiseSampleCheckpoint();
  const cp = must(r.checkpoints[0]);
  assert.equal(cp.action, 'send');
  assert.deepEqual(cp.revisions, { order: 'order-r1', email: 'email-r1' });
  await r.source.replyToCheckpoint({
    schemaVersion: 1, checkpointId: cp.id, status: 'unknown', message: 'Not judged', evidenceIds: [], basedOn: cp.revisions,
  });
});

test('evidence resolves after the observation is published and stays resolvable after stop', async () => {
  const r = rig();
  await r.source.start({ sessionId: 's', sessionEpochMs: r.epoch });
  await assert.rejects(() => r.source.resolveEvidence('evidence-1'));
  r.timers.advance(2000);
  const evidence = await r.source.resolveEvidence('evidence-1');
  assert.match(evidence.assetRef, /^mock:\/\//, 'mock assets are labels, never real capture');
  await r.source.stop();
  assert.equal((await r.source.resolveEvidence('evidence-1')).startMs, evidence.startMs);
});

test('stop and dispose end the timer, nothing is emitted afterwards', async () => {
  const r = rig();
  await r.source.start({ sessionId: 's', sessionEpochMs: r.epoch });
  r.timers.advance(1200);
  const count = r.observations.length;
  await r.source.stop();
  assert.equal(r.timers.pending(), 0);
  r.timers.advance(20_000);
  assert.equal(r.observations.length, count);
  r.source.dispose();
  r.source.dispose();
});
