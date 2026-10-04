import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STORAGE_KEY } from '../engine.ts';
import { JOURNEY_STEPS } from '../journey.ts';
import { FakeClock, MemoryStorage, ThrowingStorage, flush, rig } from './helpers.ts';

const lineOf = (id: string): string => JOURNEY_STEPS.find((s) => s.id === id)?.line ?? '';
const fast = { agentQuietMs: 0, quietSettleMs: 0 } as const;

async function reach(storage: MemoryStorage, clock: FakeClock, ...events: Parameters<ReturnType<typeof rig>['play']>) {
  const first = rig(fast, { storage, clock });
  await first.play(...events);
  first.journey.destroy();
  return first;
}

describe('the journey resumes after a reload', () => {
  it('stores the current step, keyed by run', async () => {
    const storage = new MemoryStorage();
    await reach(storage, new FakeClock(), { type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' }, { type: 'session_ended', mode: 'learn' });
    const saved = JSON.parse(storage.map.get(JOURNEY_STORAGE_KEY) ?? 'null') as { stepId: string; runId: string };
    assert.equal(saved.stepId, 'start-review');
    assert.ok(saved.runId.length > 0);
  });

  it('after a reload during Review the person goes back to Start Review, because the session is gone', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reach(
      storage,
      clock,
      { type: 'app_ready' },
      { type: 'session_live', mode: 'learn' },
      { type: 'screen_capturing' },
      { type: 'session_ended', mode: 'learn' },
      { type: 'mode_changed', mode: 'review' },
      { type: 'session_live', mode: 'review' },
    );
    const second = rig(fast, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'start-review', 'restored before any event');
    await second.play({ type: 'app_ready', mode: 'review' });
    assert.deepEqual(second.director.lines, ['Welcome back: press Start Review to carry on.']);
    assert.equal(second.director.points.at(-1), 'session-start');
    assert.equal(second.journey.getSnapshot().outcomes.learn, 'done');
    await second.play({ type: 'session_live', mode: 'review' });
    assert.equal(second.journey.getSnapshot().stepId, 'review-board');
  });

  it('after a reload during Learn the person goes back to Start Learn', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reach(storage, clock, { type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    const second = rig(fast, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'open');
    await second.play({ type: 'app_ready' });
    assert.deepEqual(second.director.points, ['session-start']);
    assert.match(second.director.lines[0] ?? '', /Welcome back/);
    await second.play({ type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    assert.equal(second.journey.getSnapshot().stepId, 'learn');
  });

  it('a reload in Teach never sends the new hire to share a screen; it goes back to Start Teach', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reach(storage, clock, { type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' }, { type: 'checkpoint_warned' });
    const second = rig(fast, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'start-teach');
    await second.play({ type: 'app_ready', mode: 'teach' });
    assert.deepEqual(second.director.lines, ['Welcome back: press Start Teach to carry on.']);
    assert.ok(!second.director.points.includes('share-screen'));
  });

  it('a reload after the Review session ended resumes at the hand-over', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reach(
      storage,
      clock,
      { type: 'app_ready', mode: 'review' },
      { type: 'session_live', mode: 'review' },
      { type: 'teachback_confirmed' },
      { type: 'session_ended', mode: 'review' },
    );
    const second = rig(fast, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'handoff');
    await second.play({ type: 'app_ready' });
    assert.equal(second.director.lines.at(-1), lineOf('handoff'));
  });

  it('a fresh page with nothing stored always starts at step 1', async () => {
    const { journey, play, director } = rig();
    assert.equal(journey.getSnapshot().stepId, 'open');
    await play({ type: 'app_ready' });
    assert.equal(director.lines[0], lineOf('open'));
  });

  it('forgets a rehearsal that is too old, so the pitch starts at step 1', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reach(storage, clock, { type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' }, { type: 'session_ended', mode: 'learn' });
    clock.advance(31 * 60 * 1000);
    const second = rig(fast, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'open');
    assert.equal(storage.map.has(JOURNEY_STORAGE_KEY), false, 'the stale entry is dropped');
  });

  it('a new Learn session clears the saved position of the earlier run', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig(fast, { storage, clock });
    await first.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' }, { type: 'session_ended', mode: 'learn' }, { type: 'session_live', mode: 'learn' });
    const saved = JSON.parse(storage.map.get(JOURNEY_STORAGE_KEY) ?? 'null') as { stepId: string };
    assert.equal(saved.stepId, 'share', 'the entry now describes the new run');
  });

  it('starts fresh from a corrupt, unknown, wrong-version or finished entry', async () => {
    const cases: Array<[string, (clock: FakeClock) => string]> = [
      ['not json', () => '{nope'],
      ['wrong shape', () => JSON.stringify({ v: 2, stepId: 'review-board' })],
      ['old version', (clock) => JSON.stringify({ v: 1, stepId: 'review-board', mode: 'review', outcomes: {}, nudged: [], done: false, savedAt: clock.t })],
      ['unknown step', (clock) => JSON.stringify({ v: 2, runId: 'r', stepId: 'gone', outcomes: {}, nudged: [], savedAt: clock.t })],
    ];
    for (const [name, make] of cases) {
      const clock = new FakeClock();
      const storage = new MemoryStorage();
      storage.setItem(JOURNEY_STORAGE_KEY, make(clock));
      const { journey } = rig({}, { storage, clock });
      assert.equal(journey.getSnapshot().stepId, 'open', name);
    }
  });

  it('works when storage is blocked or missing', async () => {
    for (const storage of [new ThrowingStorage(), null]) {
      const { play, director, journey } = rig({ storage });
      await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' });
      assert.equal(journey.getSnapshot().stepId, 'share');
      assert.equal(director.lines.length, 2, 'open and share were still said');
    }
  });

  it('is done at the summary: the saved position is cleared, so the next visitor starts at the beginning', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig(fast, { storage, clock });
    await first.play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' }, { type: 'sent' }, { type: 'session_ended', mode: 'teach' });
    assert.equal(first.journey.getSnapshot().done, true);
    assert.equal(storage.map.has(JOURNEY_STORAGE_KEY), false);
    first.journey.destroy();
    const second = rig({}, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'open');
    assert.equal(second.journey.getSnapshot().done, false);
  });

  it('clears the stored position on reset', async () => {
    const storage = new MemoryStorage();
    const { journey } = rig({}, { storage });
    journey.reset();
    const saved = JSON.parse(storage.map.get(JOURNEY_STORAGE_KEY) ?? 'null') as { stepId: string } | null;
    assert.equal(saved?.stepId, 'open');
  });
});
