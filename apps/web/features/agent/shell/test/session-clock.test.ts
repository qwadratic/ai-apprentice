import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN_LIMIT_MS, SESSION_LIMIT_MS, deadlineOf, elapsedMs, estimateClockSkew, formatClock, remainingMs } from '../session-clock.ts';

test('the caps are 10 minutes and 2 minutes hidden', () => {
  assert.equal(SESSION_LIMIT_MS, 600_000);
  assert.equal(HIDDEN_LIMIT_MS, 120_000);
});

test('elapsed counts from the epoch and never goes negative', () => {
  assert.equal(elapsedMs(1000, 4500), 3500);
  assert.equal(elapsedMs(1000, 900), 0);
});

test('deadline and remaining', () => {
  assert.equal(deadlineOf(1000), 601_000);
  assert.equal(remainingMs(1000, 1000), 600_000);
  assert.equal(remainingMs(1000, 301_000), 300_000);
  assert.equal(remainingMs(1000, 700_000), 0);
});

test('formatClock rounds up to whole seconds', () => {
  assert.equal(formatClock(600_000), '10:00');
  assert.equal(formatClock(59_001), '1:00');
  assert.equal(formatClock(61_000), '1:01');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-5), '0:00');
});

test('clock skew assumes the server stamped the middle of the round trip', () => {
  assert.equal(estimateClockSkew(1000, 1200, 6100), 5000);
  assert.equal(estimateClockSkew(1000, 1200, 1100), 0);
});
