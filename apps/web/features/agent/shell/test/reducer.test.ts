import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action } from '../state/reducer.ts';
import { initialState, reduce } from '../state/reducer.ts';
import { createStore } from '../state/store.ts';
import type { DecisionEntry, FeedItem, SessionInfo, ShellState } from '../state/types.ts';
import { LIMITS } from '../state/types.ts';

const session: SessionInfo = {
  id: 's-1', mode: 'learn', epochMs: 1000, legacyRoutes: false, deadlineMs: 601_000, clockSkewMs: 0, conversationId: null,
};
const item = (id: string, status: FeedItem['status'] = 'asked'): FeedItem => ({
  id, decision: 'ASK_NOW', topic: 't', text: 'Why?', status, note: null, whyNow: 'quiet', evidenceIds: ['ev-1'], atMs: 10, answer: null,
});
const decision = (id: string): DecisionEntry => ({
  id, atMs: 1, decision: 'SKIP', topic: 't', kind: 'k', whyNow: 'because', text: null, evidenceIds: [], spoken: false, latencyMs: null, note: null,
});
const run = (state: ShellState, ...actions: Action[]): ShellState => actions.reduce(reduce, state);

function busyState(): ShellState {
  return run(
    initialState(),
    { type: 'SESSION_STARTING', mode: 'learn' },
    { type: 'SESSION_READY', session },
    { type: 'VOICE_PHASE', phase: 'listening' },
    { type: 'FEED_ADD', item: item('d-1') },
    { type: 'FEED_ANSWER', id: 'd-1', text: 'Because', atMs: 20 },
    { type: 'FEED_ADD', item: item('d-2', 'deferred') },
    { type: 'DECISION', entry: decision('d-1') },
    { type: 'OBSERVATION', row: { id: 'o-1', sequence: 1, timestampMs: 5, kind: 'order_view', source: 'vision', synthetic: true, summary: 'Order', evidenceIds: ['ev-1'] } },
    { type: 'LOG', t: 1, dir: 'sys', logType: 'SYS', text: 'hello' },
  );
}

test('switching the mode keeps the whole session state', () => {
  const before = busyState();
  for (const mode of ['review', 'teach', 'learn'] as const) {
    const after = reduce(before, { type: 'MODE_SET', mode });
    assert.equal(after.mode, mode);
    assert.equal(after.session, before.session);
    assert.equal(after.phase, 'live');
    assert.equal(after.voice, before.voice);
    assert.equal(after.feed, before.feed);
    assert.equal(after.decisions, before.decisions);
    assert.equal(after.observations, before.observations);
    assert.equal(after.events, before.events);
    assert.equal(after.draftMap, before.draftMap);
    assert.equal(after.offRecord, before.offRecord);
  }
  assert.equal(reduce(before, { type: 'MODE_SET', mode: 'learn' }), before, 'same mode returns the same object');
});

test('the question feed goes asked -> answered, and deferred stays deferred', () => {
  const s = busyState();
  assert.deepEqual(s.feed.map((f) => [f.id, f.status]), [['d-1', 'answered'], ['d-2', 'deferred']]);
  assert.deepEqual(s.feed[0]?.answer, { text: 'Because', atMs: 20 });
  assert.equal(reduce(s, { type: 'FEED_ADD', item: item('d-1') }), s, 'a feed id is added once');
  const later = reduce(s, { type: 'FEED_STATUS', id: 'd-2', status: 'unspoken', note: 'not spoken: voice' });
  assert.equal(later.feed[1]?.status, 'unspoken');
  assert.equal(later.feed[1]?.note, 'not spoken: voice');
});

test('a new Learn session starts clean, a Review or Teach start keeps the Learn data', () => {
  const ended = run(busyState(), { type: 'SESSION_ENDED', reason: 'done' });
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.feed.length, 2);
  const review = reduce(ended, { type: 'SESSION_STARTING', mode: 'review' });
  assert.equal(review.feed.length, 2);
  assert.equal(review.decisions.length, 1);
  const learn = reduce(ended, { type: 'SESSION_STARTING', mode: 'learn' });
  assert.equal(learn.feed.length, 0);
  assert.equal(learn.decisions.length, 0);
  assert.equal(learn.observations.length, 0);
  assert.equal(learn.phase, 'starting');
});

test('off the record: Clipa hint and thinking are dropped, the flag is set and cleared', () => {
  const base = run(busyState(), { type: 'CLIPA_HINT', hint: 'warning' }, { type: 'VOICE_THINKING', thinking: true });
  const off = reduce(base, { type: 'OFF_RECORD_SET', on: true });
  assert.equal(off.offRecord, true);
  assert.equal(off.clipaHint, null);
  assert.equal(off.voice.thinking, false);
  assert.equal(reduce(off, { type: 'OFF_RECORD_SET', on: false }).offRecord, false);
});

test('the session ends with the voice ended and the screen stopped', () => {
  const s = run(
    busyState(),
    { type: 'SCREEN_SOURCE', source: { label: 'x', synthetic: true } },
    { type: 'SCREEN_STATUS', state: 'capturing', reason: null },
    { type: 'SESSION_ENDED', reason: 'done' },
  );
  assert.equal(s.voice.phase, 'ended');
  assert.equal(s.screen.source, null);
  assert.equal(s.screen.state, 'stopped');
  const offline = run(initialState(), { type: 'VOICE_PHASE', phase: 'offline', error: 'x' }, { type: 'SESSION_ENDED', reason: 'r' });
  assert.equal(offline.voice.phase, 'offline');
});

test('a failed start shows an error banner; starting again clears it', () => {
  const failed = run(initialState(), { type: 'SESSION_STARTING', mode: 'learn' }, { type: 'SESSION_FAILED', message: 'Cannot reach' });
  assert.equal(failed.phase, 'error');
  assert.deepEqual(failed.banner, { kind: 'error', text: 'Cannot reach' });
  assert.equal(reduce(failed, { type: 'SESSION_STARTING', mode: 'learn' }).banner, null);
});

test('latency attaches to its decision, the speaking phase ends thinking', () => {
  const s = run(busyState(), { type: 'DECISION_LATENCY', id: 'd-1', latencyMs: 640 });
  assert.equal(s.decisions[0]?.latencyMs, 640);
  const thinking = run(busyState(), { type: 'VOICE_THINKING', thinking: true });
  assert.equal(thinking.voice.thinking, true);
  assert.equal(reduce(thinking, { type: 'VOICE_PHASE', phase: 'speaking' }).voice.thinking, false);
});

test('review: teach-back confirm and correct, and a refresh does not undo them', () => {
  const loaded = reduce(initialState(), { type: 'REVIEW_SET', gaps: [], teachBack: 'Send the address as text.' });
  assert.equal(loaded.review.teachBack.status, 'pending');
  const confirmed = reduce(loaded, { type: 'TEACHBACK_CONFIRM' });
  assert.equal(confirmed.review.teachBack.status, 'confirmed');
  const refreshed = reduce(confirmed, { type: 'REVIEW_SET', gaps: [], teachBack: 'Send the address as text.' });
  assert.equal(refreshed.review.teachBack, confirmed.review.teachBack);
  const corrected = reduce(loaded, { type: 'TEACHBACK_CORRECT', text: 'Only for this customer.' });
  assert.equal(corrected.review.teachBack.status, 'corrected');
  assert.equal(corrected.review.teachBack.correction, 'Only for this customer.');
  const changed = reduce(corrected, { type: 'REVIEW_SET', gaps: [], teachBack: 'A new teach-back.' });
  assert.equal(changed.review.teachBack.status, 'pending');
  assert.equal(reduce(initialState(), { type: 'TEACHBACK_CONFIRM' }).review.teachBack.status, 'none');
});

test('checkpoint result and a failed delivery', () => {
  const card = { checkpointId: 'cp-1', status: 'unknown' as const, message: 'Not judged', evidenceIds: [], atMs: 5, deliveryError: null };
  const s = reduce(initialState(), { type: 'CHECKPOINT_RESULT', card });
  assert.equal(s.teach.checkpoint?.status, 'unknown');
  const failed = reduce(s, { type: 'CHECKPOINT_DELIVERY_FAILED', checkpointId: 'cp-1', error: 'stale' });
  assert.equal(failed.teach.checkpoint?.deliveryError, 'stale');
  assert.equal(reduce(s, { type: 'CHECKPOINT_DELIVERY_FAILED', checkpointId: 'other', error: 'x' }), s);
});

test('lists are capped', () => {
  let s = initialState();
  for (let i = 0; i < LIMITS.events + 25; i += 1) s = reduce(s, { type: 'LOG', t: i, dir: 'sys', logType: 'SYS', text: `line ${i}` });
  assert.equal(s.events.length, LIMITS.events);
  assert.equal(s.events[0]?.text, 'line 25');
  assert.equal(s.events.at(-1)?.id, LIMITS.events + 25);
  for (let i = 0; i < LIMITS.decisions + 5; i += 1) s = reduce(s, { type: 'DECISION', entry: decision(`d-${i}`) });
  assert.equal(s.decisions.length, LIMITS.decisions);
});

test('the store notifies only on a real change', () => {
  const store = createStore('quiet');
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  assert.equal(store.getState().persona, 'quiet');
  store.dispatch({ type: 'MODE_SET', mode: 'learn' });
  assert.equal(calls, 0);
  store.dispatch({ type: 'MODE_SET', mode: 'teach' });
  assert.equal(calls, 1);
  off();
  store.dispatch({ type: 'MODE_SET', mode: 'review' });
  assert.equal(calls, 1);
});
