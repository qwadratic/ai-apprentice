import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionQueue } from './queue.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  let time = 100000;
  const calls = [], published = [], events = [], timers = [], saves = [];
  const evidence = {
    async save(frame) { saves.push(frame); return { id: frame.frameId }; },
    async resolve(id) { return { id, assetRef: `/synthetic/${id}` }; },
  };
  const queue = new VisionQueue({
    analyze(frame, { signal }) { const call = { ...deferred(), frame, signal }; calls.push(call); return call.promise; },
    validate(value) {
      if (!value || Object.keys(value).join(',') !== 'visible' || typeof value.visible !== 'string') {
        throw Object.assign(new Error('invalid'), { code: 'invalid_model_output' });
      }
      return value;
    },
    makeObservation(value, context) { return { value, ...context }; },
    evidence, publish: observation => published.push(observation), onEvent: event => events.push(event),
    fingerprint: frame => frame.content, now: () => time, sampleIntervalMs: 0,
    schedule: callback => { timers.push(callback); return callback; }, cancelTimer: () => {}, ...options,
  });
  queue.start({ sessionId: 'synthetic-session', sessionEpochMs: 100000 });
  function frame(n, content = `${n}`) {
    time = Math.max(time, 100000 + n);
    return { sessionId: 'synthetic-session', frameId: `f${n}`, timestampMs: n, processed: true, content };
  }
  return { queue, frame, calls, published, events, timers, saves, evidence,
    advance: ms => { time += ms; } };
}

test('one active and one latest pending frame bound a burst; latency uses capture time', async () => {
  const h = setup();
  h.queue.offer(h.frame(1));
  for (let n = 2; n <= 100; n++) h.queue.offer(h.frame(n));
  assert.deepEqual(h.queue.snapshot(), { state: 'capturing', sessionId: 'synthetic-session', active: 1, queued: 1, sequence: 0 });
  h.calls[0].resolve({ visible: 'email' });
  await tick();
  assert.equal(h.published[0].frameId, 'f1');
  assert.equal(h.events[0].latencyMs, 99);
  assert.equal(h.calls[1].frame.frameId, 'f100');
  h.calls[1].resolve({ visible: 'email' });
  await tick();
  assert.equal(h.published[1].sequence, 2);
});

test('deduplication, sampling and capture ordering are independent', async () => {
  const h = setup({ sampleIntervalMs: 1500 });
  assert.equal(h.queue.offer(h.frame(0, 'same')), 'accepted');
  assert.equal(h.queue.offer(h.frame(100, 'other')), 'sampled_out');
  assert.equal(h.queue.offer(h.frame(1500, 'same')), 'duplicate');
  assert.equal(h.queue.offer(h.frame(1501, 'other')), 'accepted');
  assert.equal(h.queue.offer(h.frame(1400)), 'out_of_order');
  h.calls[0].resolve({ visible: 'email' }); await tick();
  h.calls[1].resolve({ visible: 'email' }); await tick();
});

test('pause cancels active and clears pending; resume retains physical request bound', async () => {
  const h = setup();
  h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.queue.pause();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.queue.snapshot().queued, 0);
  assert.equal(h.queue.offer(h.frame(3)), 'inactive');
  h.queue.resume(); h.queue.offer(h.frame(4));
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ visible: 'old' }); await tick();
  assert.equal(h.published.length, 0);
  assert.equal(h.calls[1].frame.frameId, 'f4');
  h.calls[1].resolve({ visible: 'new' }); await tick();
  assert.equal(h.published.length, 1);
});

test('switching sessions and restarting the same session invalidate old responses', async () => {
  for (const sessionId of ['other-session', 'synthetic-session']) {
    const h = setup(); h.queue.offer(h.frame(1));
    h.queue.start({ sessionId, sessionEpochMs: 100000 });
    h.calls[0].resolve({ visible: 'old' }); await tick();
    assert.equal(h.published.length, 0);
    assert.equal(h.saves.length, 0);
  }
});

test('slow valid responses survive newer queued frames; expired responses do not publish', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.advance(60000); h.calls[0].resolve({ visible: 'slow' }); await tick();
  assert.equal(h.published.length, 1);
  h.advance(16000); h.calls[1].resolve({ visible: 'expired' }); await tick();
  assert.equal(h.published.length, 1);
  assert.equal(h.events.at(-1).reason, 'stale');
});

test('out-of-order model responses cannot replace a newer published observation', async () => {
  const h = setup({ maxConcurrent: 2 });
  h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.calls[1].resolve({ visible: 'new' }); await tick();
  h.calls[0].resolve({ visible: 'old' }); await tick();
  assert.deepEqual(h.published.map(value => value.frameId), ['f2']);
  assert.equal(h.events.at(-1).reason, 'out_of_order');
});

test('invalid model output never stores or publishes; same content can be retried', async () => {
  const h = setup(); h.queue.offer(h.frame(1, 'same'));
  h.calls[0].resolve({ inventedRule: 'never send' }); await tick();
  assert.equal(h.published.length, 0); assert.equal(h.saves.length, 0);
  assert.equal(h.events[0].code, 'invalid_model_output');
  assert.equal(h.queue.offer(h.frame(2, 'same')), 'accepted');
  h.calls[1].resolve({ visible: 'email' }); await tick();
});

test('Evidence must resolve before publication, including pause during resolution', async () => {
  const gate = deferred();
  const h = setup({ evidence: { async save() { return { id: 'f1' }; }, resolve() { return gate.promise; } } });
  h.queue.offer(h.frame(1)); h.calls[0].resolve({ visible: 'email' }); await tick();
  assert.equal(h.published.length, 0);
  h.queue.pause(); gate.resolve({ id: 'f1', assetRef: '/synthetic/f1' }); await tick();
  assert.equal(h.published.length, 0);
});

test('missing Evidence, model failures and a validator returning false are visible failures', async () => {
  const cases = [
    { evidence: { async save() { return { id: 'f1' }; }, async resolve() { return null; } } },
    { validate: () => false },
    { reject: true },
  ];
  for (const item of cases) {
    const h = setup(item); h.queue.offer(h.frame(1));
    if (item.reject) h.calls[0].reject(new Error('private provider payload'));
    else h.calls[0].resolve({ visible: 'email' });
    await tick(); assert.equal(h.published.length, 0);
    assert.equal(h.events[0].type, 'error');
    assert.equal(JSON.stringify(h.events).includes('private provider payload'), false);
  }
});

test('timeout aborts and reports immediately but holds slot until transport settles', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.timers[0]();
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.events[0].code, 'timeout');
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ visible: 'late' }); await tick();
  assert.equal(h.published.length, 0); assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ visible: 'current' }); await tick();
});

test('unprocessed, future and expired inputs are rejected without model calls', () => {
  const h = setup();
  assert.equal(h.queue.offer({ ...h.frame(1), processed: false }), 'invalid');
  assert.equal(h.queue.offer({ ...h.frame(1), timestampMs: 999999 }), 'invalid');
  h.advance(76000); assert.equal(h.queue.offer(h.frame(1)), 'stale');
  assert.equal(h.calls.length, 0);
});

test('queued frames that expire while waiting emit a discard without starting another request', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.advance(76000); h.calls[0].resolve({ visible: 'old' }); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.queue.snapshot().queued, 0);
  assert.equal(h.events.filter(event => event.reason === 'stale').length, 2);
});

test('settled timeout releases deduplication for a same-content retry', async () => {
  const h = setup(); h.queue.offer(h.frame(1, 'same')); h.timers[0]();
  h.calls[0].resolve({ visible: 'late' }); await tick();
  assert.equal(h.queue.offer(h.frame(2, 'same')), 'accepted');
  h.calls[1].resolve({ visible: 'retry' }); await tick();
  assert.equal(h.published.length, 1);
});

test('promise-returning validator cannot publish an unvalidated observation', async () => {
  const h = setup({ validate: () => Promise.resolve({ visible: 'email' }) });
  h.queue.offer(h.frame(1)); h.calls[0].resolve({ visible: 'email' }); await tick();
  assert.equal(h.published.length, 0); assert.equal(h.events[0].code, 'invalid_model_output');
});

test('reentrant session switch during publication does not corrupt new-session sequence', async () => {
  let h;
  h = setup({ publish: () => h.queue.start({ sessionId: 'next-session', sessionEpochMs: 100000 }) });
  h.queue.offer(h.frame(1)); h.calls[0].resolve({ visible: 'email' }); await tick();
  assert.equal(h.queue.snapshot().sessionId, 'next-session');
  assert.equal(h.queue.snapshot().sequence, 0);
});

test('delayed answer after draft revision change is history, never current checkpoint evidence', async () => {
  const h = setup();
  h.queue.setSourceRevision('draft-1');
  h.queue.offer(h.frame(1, 'same'), { sourceRevision: 'draft-1' });
  h.queue.setSourceRevision('draft-2');
  h.calls[0].resolve({ visible: 'previous draft' }); await tick();
  assert.equal(h.published.length, 1);
  assert.equal(h.events[0].checkpointEligible, false);
  assert.equal(h.queue.canUseForCheckpoint({ sessionId: 'synthetic-session', frameId: 'f1', sourceRevision: 'draft-1' }), false);
  assert.equal(h.queue.canUseForCheckpoint({ sessionId: 'synthetic-session', frameId: 'f1', sourceRevision: 'draft-2' }), false);
  assert.equal(h.queue.offer(h.frame(2, 'same'), { sourceRevision: 'draft-2' }), 'accepted');
  h.calls[1].resolve({ visible: 'current draft' }); await tick();
  assert.equal(h.events.at(-1).checkpointEligible, true);
  assert.equal(h.queue.canUseForCheckpoint({ sessionId: 'synthetic-session', frameId: 'f2', sourceRevision: 'draft-2' }), true);
});

test('published checkpoint provenance is invalidated by source changes, age, pause and stop', async () => {
  for (const change of [h => h.queue.setSourceRevision('draft-2'), h => h.advance(2501),
    h => h.queue.pause(), h => h.queue.stop()]) {
    const h = setup(); h.queue.setSourceRevision('draft-1');
    const reference = { sessionId: 'synthetic-session', frameId: 'f1', sourceRevision: 'draft-1' };
    h.queue.offer(h.frame(1), { sourceRevision: 'draft-1' });
    h.calls[0].resolve({ visible: 'email' }); await tick();
    assert.equal(h.queue.canUseForCheckpoint(reference), true);
    assert.equal(h.queue.canUseForCheckpoint({ ...reference, sessionId: 'other' }), false);
    change(h); assert.equal(h.queue.canUseForCheckpoint(reference), false);
  }
});

test('reusing an old revision label cannot revive a response from before an intermediate edit', async () => {
  const h = setup(); h.queue.setSourceRevision('draft-1');
  h.queue.offer(h.frame(1), { sourceRevision: 'draft-1' });
  h.queue.setSourceRevision('draft-2'); h.queue.setSourceRevision('draft-1');
  h.calls[0].resolve({ visible: 'email' }); await tick();
  assert.equal(h.events[0].checkpointEligible, false);
});

test('75-second history validity does not establish checkpoint freshness even for a stable source', async () => {
  const h = setup(); h.queue.setSourceRevision('draft-1');
  h.queue.offer(h.frame(1), { sourceRevision: 'draft-1' });
  h.advance(60000); h.calls[0].resolve({ visible: 'slow email' }); await tick();
  assert.equal(h.published.length, 1); assert.equal(h.events[0].checkpointEligible, false);
});

test('untracked revision fails closed; stop invalidates delayed responses without persistence', async () => {
  const h = setup(); h.queue.offer(h.frame(1));
  h.calls[0].resolve({ visible: 'email' }); await tick();
  assert.equal(h.events[0].checkpointEligible, false);
  const g = setup(); g.queue.offer(g.frame(1)); g.queue.stop();
  g.calls[0].resolve({ visible: 'late email' }); await tick();
  assert.equal(g.published.length, 0); assert.equal(g.saves.length, 0);
  assert.throws(() => g.queue.resume(), /paused session/);
});
