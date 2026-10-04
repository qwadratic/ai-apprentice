import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindWorkspaceSession} from '../runtimeSession.ts';
import {createInputActivityReporter} from '../activity.ts';

test('delayed capture keeps the app epoch and queued activity on one timeline', () => {
  let now = 11_000;
  const session = {sessionId: 'session-1', sessionEpochMs: 10_000};
  const binding = bindWorkspaceSession(() => session);
  let callback: (() => void) | undefined;
  const activities: Array<{lastInputAtMs: number; idleMs: number}> = [];
  const reporter = createInputActivityReporter(value => activities.push(value), {
    now: () => now - binding.session.sessionEpochMs,
    setTimer: value => {callback = value; return 1;}, clearTimer: () => {},
  });
  reporter.input('email');
  now = 16_000;
  assert.deepEqual(binding.atCapture(), session);
  callback?.();
  assert.deepEqual(activities.map(value => [value.lastInputAtMs, value.idleMs]), [[1000, 0], [1000, 5000]]);
  reporter.dispose();
});

test('a provider cannot replace the epoch or session inside the mounted workspace', () => {
  let current = {sessionId: 'session-1', sessionEpochMs: 100};
  const binding = bindWorkspaceSession(() => current);
  current = {...current, sessionEpochMs: 200};
  assert.throws(() => binding.atCapture(), /Prepare a new session/);
  current = {sessionId: 'session-2', sessionEpochMs: 100};
  assert.throws(() => binding.atCapture(), /Prepare a new session/);
  current = {sessionId: 'session-1', sessionEpochMs: 100};
  const result = binding.atCapture(); result.sessionEpochMs = 999;
  assert.equal(binding.atCapture().sessionEpochMs, 100);
});
