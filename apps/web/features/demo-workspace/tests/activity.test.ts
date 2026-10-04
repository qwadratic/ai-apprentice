import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputActivityReporter, type ActivityClock, type WorkspaceActivity } from '../activity.ts';
import { createWorkspace } from '../workspace.ts';

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ActivityClock = {
    now: () => now,
    setTimer(callback, delayMs) { const id = ++sequence; timers.set(id, { at: now + delayMs, callback }); return id; },
    clearTimer(handle) { timers.delete(handle as number); },
  };
  return {
    clock,
    pending: () => [...timers.values()],
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = until;
    },
  };
}

test('typing heartbeat every 2 s, idle after 2 s silence, idle tail stops at 10 s', () => {
  const timer = fakeClock();
  const events: { at: number; activity: WorkspaceActivity }[] = [];
  const reporter = createInputActivityReporter(activity => events.push({ at: timer.clock.now(), activity }), timer.clock);
  timer.advance(3000); assert.equal(events.length, 0);
  reporter.input('email');
  timer.advance(500); reporter.input('email');
  timer.advance(500); reporter.input('email');
  timer.advance(1000); // A scheduled typing heartbeat while input is still recent.
  timer.advance(1000); // Two seconds since the last actual input: enter idle.
  timer.advance(8000); // End the bounded idle tail.
  assert.deepEqual(events.map(event => [event.at, event.activity.typing, event.activity.lastInputAtMs, event.activity.idleMs]), [
    [3000, true, 3000, 0], [5000, true, 4000, 1000], [6000, false, 4000, 2000], [8000, false, 4000, 4000],
    [10000, false, 4000, 6000], [12000, false, 4000, 8000], [14000, false, 4000, 10000],
  ]);
  assert.equal(timer.pending().length, 0); timer.advance(30000); assert.equal(events.length, 7);
  assert.ok(events.every(event => event.activity.surface === 'email'));
  reporter.dispose();
});

test('surface changes are explicit and restarting from idle emits typing immediately', () => {
  const timer = fakeClock(); const events: WorkspaceActivity[] = [];
  const reporter = createInputActivityReporter(activity => events.push(activity), timer.clock);
  reporter.input('order'); timer.advance(500); reporter.input('email');
  assert.deepEqual(events, [
    { surface: 'order', typing: true, lastInputAtMs: 0, idleMs: 0 },
    { surface: 'email', typing: true, lastInputAtMs: 500, idleMs: 0 },
  ]);
  timer.advance(2000); assert.deepEqual(events.at(-1), { surface: 'email', typing: false, lastInputAtMs: 500, idleMs: 2000 });
  reporter.input('ticket'); assert.deepEqual(events.at(-1), { surface: 'ticket', typing: true, lastInputAtMs: 2500, idleMs: 0 });
  reporter.dispose();
});

test('pause and dispose suppress saved timer callbacks; resume never replays activity', () => {
  const timer = fakeClock(); const events: WorkspaceActivity[] = [];
  const reporter = createInputActivityReporter(activity => events.push(activity), timer.clock);
  reporter.input('email'); const cancelled = timer.pending()[0]!.callback;
  reporter.pause(); reporter.input('ticket'); cancelled(); timer.advance(20000);
  assert.equal(events.length, 1); assert.equal(timer.pending().length, 0);
  reporter.resume(); timer.advance(20000); assert.equal(events.length, 1);
  reporter.input('order'); const disposed = timer.pending()[0]!.callback;
  reporter.dispose(); disposed(); reporter.resume(); reporter.input('ticket'); timer.advance(20000);
  assert.equal(events.length, 2); assert.equal(timer.pending().length, 0);
});

test('reset and session changes clear the previous task activity without reporting it', () => {
  const timer = fakeClock(); const events: WorkspaceActivity[] = [];
  const workspace = createWorkspace({ sessionId: 'first', activityClock: timer.clock, onInputActivity: event => events.push(event) });
  workspace.inputActivity('order'); const oldTask = timer.pending()[0]!.callback;
  workspace.reset('spare-new'); oldTask(); timer.advance(20000);
  assert.equal(events.length, 1); assert.equal(workspace.getState().draft.customerRef, 'customer_12');
  workspace.inputActivity('email'); const oldSession = timer.pending()[0]!.callback;
  workspace.setSession('second'); oldSession(); timer.advance(20000);
  assert.equal(events.length, 2); assert.equal(timer.pending().length, 0); workspace.dispose();
});

test('off-record blocks Preview and Send, stops activity, survives reset and resumes only on new input', async () => {
  const timer = fakeClock(); const events: WorkspaceActivity[] = []; let observations = 0;
  const workspace = createWorkspace({
    sessionId: 'first', activityClock: timer.clock, onInputActivity: event => events.push(event),
    checkpoint: { async check() { observations++; return { status: 'clear', message: 'Clear.', evidenceIds: [] }; } },
  });
  workspace.inputActivity('email'); await workspace.preview(); assert.equal(workspace.canSend(), true);
  workspace.setOffRecord(true); assert.equal(workspace.canSend(), false);
  workspace.inputActivity('ticket'); timer.advance(20000); assert.equal(events.length, 1);
  await workspace.preview(); assert.equal(observations, 1); assert.equal(workspace.getState().check.status, 'error');
  workspace.reset(); assert.equal(workspace.getState().offRecord, true); workspace.inputActivity('order'); assert.equal(events.length, 1);
  workspace.setOffRecord(false); timer.advance(20000); assert.equal(events.length, 1); assert.equal(workspace.canSend(), false);
  workspace.inputActivity('ticket'); assert.deepEqual(events.at(-1), { surface: 'ticket', typing: true, lastInputAtMs: 40000, idleMs: 0 });
  workspace.dispose(); timer.advance(20000); assert.equal(events.length, 2);
});
