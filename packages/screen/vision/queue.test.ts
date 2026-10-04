import test from 'node:test';
import assert from 'node:assert/strict';
import {VisionQueue} from './queue.ts';
import type {VisionEvidenceRef, VisionFrame, VisionQueueEvent} from './queue.ts';

interface Frame extends VisionFrame {readonly content: string}
interface Result {readonly visible: string}
interface Observation {readonly visible: string; readonly frameId: string; readonly sequence: number; readonly evidenceId: string}
interface Evidence extends VisionEvidenceRef {readonly frameId: string}
interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function setup(options: {readonly maxConcurrent?: number; readonly sampleIntervalMs?: number} = {}) {
  let time = 100_000;
  const calls: Array<Deferred<unknown> & {frame: Frame; signal: AbortSignal; surface: 'order' | 'email' | 'ticket' | null}> = [];
  const published: Observation[] = []; const events: VisionQueueEvent[] = []; const timers: Array<() => void> = [];
  const saved: Frame[] = [];
  const queue = new VisionQueue<Frame, Result, Observation, Evidence, number>({
    analyze(frame, {signal, surface}) { const call = {...deferred<unknown>(), frame, signal, surface}; calls.push(call); return call.promise; },
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).join(',') !== 'visible' || typeof (value as {visible?: unknown}).visible !== 'string') {
        throw Object.assign(new Error('invalid'), {code: 'invalid_model_output'});
      }
      return value as Result;
    },
    makeObservation(value, context) { return {visible: value.visible, frameId: context.frameId,
      sequence: context.sequence, evidenceId: context.evidence.id}; },
    evidence: {async save(frame) { saved.push(frame); return {id: frame.frameId, assetRef: `/e/${frame.frameId}`, frameId: frame.frameId}; },
      async resolve(id) { return {id, assetRef: `/e/${id}`, frameId: id}; }},
    publish: observation => published.push(observation), onEvent: event => events.push(event),
    fingerprint: frame => frame.content, now: () => time, sampleIntervalMs: options.sampleIntervalMs ?? 0,
    maxConcurrent: options.maxConcurrent, schedule(callback) { timers.push(callback); return timers.length - 1; },
    cancelTimer() {}, requestTimeoutMs: 65_000, maxResultAgeMs: 75_000,
  });
  queue.start({sessionId: 'session', sessionEpochMs: 100_000});
  const frame = (n: number, content = String(n)): Frame => {
    time = Math.max(time, 100_000 + n);
    return {sessionId: 'session', frameId: `f${n}`, timestampMs: n, processed: true, content};
  };
  return {queue, frame, calls, published, events, timers, saved, advance(ms: number) { time += ms; }};
}

test('one active request and one replaceable pending frame bound a burst', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); for (let n = 2; n <= 100; n++) h.queue.offer(h.frame(n));
  assert.equal(h.queue.snapshot().active, 1); assert.equal(h.queue.snapshot().queued, 1);
  h.calls[0]?.resolve({visible: 'old'}); await tick(); assert.equal(h.calls[1]?.frame.frameId, 'f100');
  h.calls[1]?.resolve({visible: 'new'}); await tick(); assert.deepEqual(h.published.map(value => value.frameId), ['f1', 'f100']);
});
test('deduplication, sampling and capture ordering are independent', async () => {
  const h = setup({sampleIntervalMs: 1500});
  assert.equal(h.queue.offer(h.frame(0, 'same')), 'accepted');
  assert.equal(h.queue.offer(h.frame(100, 'other')), 'sampled_out');
  assert.equal(h.queue.offer(h.frame(1500, 'same')), 'duplicate');
  assert.equal(h.queue.offer(h.frame(1501, 'other')), 'accepted');
  assert.equal(h.queue.offer(h.frame(1400)), 'out_of_order');
  h.calls[0]?.resolve({visible: 'one'}); await tick(); h.calls[1]?.resolve({visible: 'two'}); await tick();
});
test('identical processed pixels can be acquired separately for order and email surfaces', async () => {
  const h = setup({maxConcurrent: 2});
  assert.equal(h.queue.offer(h.frame(1, 'same'), {surface: 'order'}), 'accepted');
  assert.equal(h.queue.offer(h.frame(2, 'same'), {surface: 'email'}), 'accepted');
  assert.equal(h.queue.offer(h.frame(3, 'same'), {surface: 'order'}), 'duplicate');
  assert.deepEqual(h.calls.map(call => call.surface), ['order', 'email']);
  h.calls[0]?.resolve({visible: 'order'}); h.calls[1]?.resolve({visible: 'email'}); await tick();
});
test('pause cancels active work, clears pending work and rejects late results', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2)); h.queue.pause();
  assert.equal(h.calls[0]?.signal.aborted, true); assert.equal(h.queue.snapshot().queued, 0);
  h.calls[0]?.resolve({visible: 'late'}); await tick(); assert.equal(h.published.length, 0);
  h.queue.resume(); h.queue.offer(h.frame(3)); h.calls[1]?.resolve({visible: 'current'}); await tick(); assert.equal(h.published.length, 1);
});
test('new session invalidates old response and persistence', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.start({sessionId: 'next', sessionEpochMs: 100_000});
  h.calls[0]?.resolve({visible: 'late'}); await tick(); assert.equal(h.published.length, 0); assert.equal(h.saved.length, 0);
});
test('newer response wins when concurrency is two', async () => {
  const h = setup({maxConcurrent: 2}); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2));
  h.calls[1]?.resolve({visible: 'new'}); await tick(); h.calls[0]?.resolve({visible: 'old'}); await tick();
  assert.deepEqual(h.published.map(value => value.frameId), ['f2']);
});
test('slow historical response survives a newer pending frame but expires after 75 seconds', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2)); h.advance(60_000);
  h.calls[0]?.resolve({visible: 'slow'}); await tick(); assert.equal(h.published.length, 1);
  h.advance(16_000); h.calls[1]?.resolve({visible: 'expired'}); await tick(); assert.equal(h.published.length, 1);
});
test('invalid output never stores or publishes and can be retried with identical pixels', async () => {
  const h = setup(); h.queue.offer(h.frame(1, 'same')); h.calls[0]?.resolve({inventedRule: true}); await tick();
  assert.equal(h.saved.length, 0); assert.equal(h.published.length, 0);
  assert.equal(h.queue.offer(h.frame(2, 'same')), 'accepted');
});
test('Evidence resolves before publication', async () => {
  const gate = deferred<Evidence>(); const h = setup();
  const queue = new VisionQueue<Frame, Result, Observation, Evidence>({
    analyze: async () => ({visible: 'email'}), validate: value => value as Result,
    makeObservation: (value, context) => ({visible: value.visible, frameId: context.frameId,
      sequence: context.sequence, evidenceId: context.evidence.id}), fingerprint: value => value.content,
    evidence: {async save(frame) { return {id: frame.frameId, assetRef: '/pending', frameId: frame.frameId}; }, resolve: () => gate.promise},
    publish: value => h.published.push(value), sampleIntervalMs: 0, now: () => 100_001,
  });
  queue.start({sessionId: 'session', sessionEpochMs: 100_000}); queue.offer(h.frame(1)); await tick();
  assert.equal(h.published.length, 0); gate.resolve({id: 'f1', assetRef: '/ready', frameId: 'f1'}); await tick();
  assert.equal(h.published.length, 1);
});
test('timeout aborts without admitting another request until transport settles', async () => {
  const h = setup(); h.queue.offer(h.frame(1)); h.queue.offer(h.frame(2)); h.timers[0]?.();
  assert.equal(h.calls[0]?.signal.aborted, true); assert.equal(h.calls.length, 1);
  h.calls[0]?.resolve({visible: 'late'}); await tick(); assert.equal(h.calls.length, 2);
});
test('small browser/server clock skew is accepted while excessive future time is invalid', () => {
  const h = setup(); assert.equal(h.queue.offer({...h.frame(1), timestampMs: 4000}), 'accepted');
  const other = setup(); assert.equal(other.queue.offer({...other.frame(1), timestampMs: 6000}), 'invalid');
});
