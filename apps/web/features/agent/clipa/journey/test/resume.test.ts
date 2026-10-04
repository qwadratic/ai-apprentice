import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STORAGE_KEY } from '../engine.ts';
import { JOURNEY_STEPS } from '../journey.ts';
import { FakeClock, MemoryStorage, ThrowingStorage, flush, rig } from './helpers.ts';

const lineOf = (id: string): string => JOURNEY_STEPS.find((s) => s.id === id)?.line ?? '';

async function reachReview(storage: MemoryStorage, clock: FakeClock) {
  const first = rig({}, { storage, clock });
  first.bus.emit({ type: 'session_started', mode: 'learn' });
  first.bus.emit({ type: 'screen_capturing' });
  await flush();
  first.bus.emit({ type: 'mode_changed', mode: 'review' });
  await flush();
  first.journey.destroy();
  return first;
}

describe('the journey resumes after a reload', () => {
  it('stores the current step', async () => {
    const storage = new MemoryStorage();
    await reachReview(storage, new FakeClock());
    const saved = JSON.parse(storage.map.get(JOURNEY_STORAGE_KEY) ?? 'null') as { stepId: string; mode: string };
    assert.equal(saved.stepId, 'review-board');
    assert.equal(saved.mode, 'review');
  });

  it('comes back at the stored step and says it again once the session is up', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    await reachReview(storage, clock);
    const second = rig({}, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'review-board', 'restored before any event');
    second.bus.emit({ type: 'session_started', mode: 'review' });
    await flush();
    assert.equal(second.journey.getSnapshot().stepId, 'review-board');
    assert.deepEqual(second.director.lines, [lineOf('review-board')]);
    assert.equal(second.journey.getSnapshot().outcomes.learn, 'done');
  });

  it('sends a capture step back to the start after a reload, because the capture is gone', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig({}, { storage, clock });
    first.bus.emit({ type: 'session_started', mode: 'learn' });
    first.bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(first.journey.getSnapshot().stepId, 'learn');
    first.journey.destroy();

    const second = rig({}, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'open');
    second.bus.emit({ type: 'session_started', mode: 'learn' });
    await flush();
    assert.deepEqual(second.director.points, ['share-screen']);
    assert.match(second.director.lines[0] ?? '', /Welcome back/);
    second.bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(second.journey.getSnapshot().stepId, 'learn');
  });

  it('keeps a capture step when a capture is still live', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig({}, { storage, clock });
    first.bus.emit({ type: 'session_started', mode: 'learn' });
    first.bus.emit({ type: 'screen_capturing' });
    await flush();
    first.journey.destroy();
    const second = rig({ isCapturing: () => true }, { storage, clock });
    assert.equal(second.journey.getSnapshot().stepId, 'learn');
  });

  it('starts fresh from a corrupt, unknown, stale or finished entry', async () => {
    const cases: Array<[string, (clock: FakeClock) => string]> = [
      ['not json', () => '{nope'],
      ['wrong shape', () => JSON.stringify({ v: 1, stepId: 'review-board' })],
      ['unknown step', (clock) => JSON.stringify({ v: 1, stepId: 'gone', mode: 'learn', outcomes: {}, nudged: [], done: false, savedAt: clock.t })],
      ['stale', (clock) => JSON.stringify({ v: 1, stepId: 'review-board', mode: 'review', outcomes: {}, nudged: [], done: false, savedAt: clock.t - 7 * 3600 * 1000 })],
      ['finished', (clock) => JSON.stringify({ v: 1, stepId: 'summary', mode: 'summary', outcomes: {}, nudged: [], done: true, savedAt: clock.t })],
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
      const { bus, director, journey } = rig({ storage });
      bus.emit({ type: 'session_started', mode: 'learn' });
      await flush();
      bus.emit({ type: 'screen_capturing' });
      await flush();
      assert.equal(journey.getSnapshot().stepId, 'learn');
      assert.equal(director.lines.length, 2, 'open and learn were still said');
    }
  });

  it('forgets a finished journey, so the next visitor starts at the beginning', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig({ agentQuietMs: 0 }, { storage, clock });
    for (const event of [
      { type: 'session_started', mode: 'summary' },
      { type: 'screen_capturing' },
    ] as const) {
      first.bus.emit(event);
      await flush();
    }
    assert.equal(first.journey.getSnapshot().done, true);
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
