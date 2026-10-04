import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NullBrain } from '../brain/null-brain.ts';
import { CLIPA_STATES, createClipaStore, pointDirection } from '../clipa/presenter.ts';
import { must } from './helpers.ts';

test('the presenter has the eight states of the TASK-3.8 mapping', () => {
  assert.deepEqual([...CLIPA_STATES], ['idle', 'listening', 'thinking', 'speaking', 'warning', 'happy', 'pointing', 'off']);
});

test('the Clipa store holds state, bubble and target and notifies on change only', () => {
  const store = createClipaStore();
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  assert.deepEqual(store.getSnapshot(), { state: 'idle', bubble: '', target: null });
  store.setState('speaking');
  store.setState('speaking');
  store.say('Why did you type it?');
  store.say('Why did you type it?');
  store.setTarget({ x: 1, y: 2, width: 3, height: 4 });
  assert.equal(calls, 3);
  assert.deepEqual(store.getSnapshot(), { state: 'speaking', bubble: 'Why did you type it?', target: { x: 1, y: 2, width: 3, height: 4 } });
  store.say('');
  assert.equal(store.getSnapshot().bubble, '');
  off();
  store.setState('idle');
  assert.equal(calls, 4);
});

test('pointDirection faces the target', () => {
  const clipa = { x: 800, y: 300, width: 100, height: 120 };
  assert.equal(pointDirection(clipa, { x: 100, y: 330, width: 200, height: 40 }), 'left');
  assert.equal(pointDirection(clipa, { x: 1200, y: 330, width: 50, height: 40 }), 'right');
  assert.equal(pointDirection(clipa, { x: 100, y: 20, width: 200, height: 40 }), 'up-left');
  assert.equal(pointDirection(clipa, { x: 100, y: 700, width: 200, height: 40 }), 'down-left');
  assert.equal(pointDirection(clipa, { x: 1200, y: 20, width: 50, height: 40 }), 'up-right');
});

test('NullBrain logs, never asks and never says clear', () => {
  const lines: string[] = [];
  const brain = new NullBrain((l) => lines.push(l));
  assert.equal(brain.wired, false);
  assert.deepEqual(brain.tick(0), [], 'no input, no decision');
  brain.onStatus({ schemaVersion: 1, sessionId: 's', state: 'capturing' });
  brain.onTranscript({ role: 'user', text: 'hello', atMs: 1 });
  brain.onAnswer({ questionId: null, topic: null, text: 'ok', atMs: 2, kind: 'answer' });
  assert.equal(lines.length, 3);
  const decisions = brain.tick(1000);
  assert.deepEqual(decisions, [], 'status and transcript are not observations');
  brain.onObservation({
    schemaVersion: 1, id: 'o', sessionId: 's', sequence: 1, timestampMs: 10, source: 'vision', frameId: 'f', sourceRevision: 'r', evidenceIds: ['e'],
    kind: 'order_view', entityRef: null, facts: { customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null },
  });
  const later = brain.tick(2000);
  assert.equal(later.length, 1);
  assert.equal(must(later[0]).decision, 'SKIP');
  assert.equal(must(later[0]).utterance, undefined);
  assert.deepEqual(brain.tick(3000), []);
  assert.deepEqual(brain.review(), { gaps: [], teachBack: null, map: { steps: [] } });
  const reply = brain.checkpoint({ schemaVersion: 1, id: 'cp', sessionId: 's', timestampMs: 5, observationIds: [], revisions: { order: 'a', email: 'b' }, action: 'send' });
  assert.equal(reply.status, 'unknown');
  assert.deepEqual(reply.basedOn, { order: 'a', email: 'b' });
});
