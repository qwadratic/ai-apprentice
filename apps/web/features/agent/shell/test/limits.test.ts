import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionLimits } from '../limits.ts';
import { HIDDEN_LIMIT_MS, SESSION_LIMIT_MS } from '../session-clock.ts';
import { FakeTimers } from './helpers.ts';

function rig() {
  const timers = new FakeTimers();
  const reasons: string[] = [];
  const limits = new SessionLimits({ timers, onExpire: (r) => reasons.push(r) });
  return { timers, reasons, limits };
}

test('the session ends after 10 minutes', () => {
  const { timers, reasons, limits } = rig();
  limits.start(false);
  timers.advance(SESSION_LIMIT_MS - 1);
  assert.equal(reasons.length, 0);
  timers.advance(1);
  assert.deepEqual(reasons, ['Session auto-ended: the 10 minutes limit was reached.']);
  assert.equal(timers.pending(), 0);
});

test('a hidden tab ends the session after 2 minutes, showing it again cancels', () => {
  const { timers, reasons, limits } = rig();
  limits.start(false);
  limits.setHidden(true);
  timers.advance(HIDDEN_LIMIT_MS - 1000);
  limits.setHidden(false);
  timers.advance(HIDDEN_LIMIT_MS);
  assert.equal(reasons.length, 0);
  limits.setHidden(true);
  timers.advance(HIDDEN_LIMIT_MS);
  assert.match(reasons.join(), /hidden for more than 2 minutes/);
});

test('starting while the tab is hidden arms the hidden cap at once; stop clears every timer', () => {
  const { timers, reasons, limits } = rig();
  limits.start(true);
  assert.equal(timers.pending(), 2);
  limits.stop();
  assert.equal(timers.pending(), 0);
  timers.advance(SESSION_LIMIT_MS * 2);
  assert.equal(reasons.length, 0);
});
