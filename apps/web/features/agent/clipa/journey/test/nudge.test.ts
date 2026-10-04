import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STORAGE_KEY } from '../engine.ts';
import { JOURNEY_STEPS } from '../journey.ts';
import { FakeClock, MemoryStorage, flush, rig } from './helpers.ts';

const open = JOURNEY_STEPS[0];
const nudgeLine = open?.nudge?.line ?? '';
const nudgeMs = open?.nudge?.afterMs ?? 0;

describe('the gentle re-nudge', () => {
  it('nudges once when the person leaves a step alone, and never a second time', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    director.clear();
    clock.advance(nudgeMs - 1000);
    await flush();
    assert.deepEqual(director.calls, [], 'not yet');
    clock.advance(1500);
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    assert.deepEqual(director.lines, [nudgeLine]);
    clock.advance(10 * 60 * 1000);
    await flush();
    assert.equal(director.lines.length, 1, 'only one re-nudge for the step');
  });

  it('does not nudge a step the person has already finished', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    bus.emit({ type: 'share_requested' });
    await flush();
    director.clear();
    clock.advance(nudgeMs + 1000);
    await flush();
    assert.ok(!director.lines.includes(nudgeLine), 'the old step has no nudge any more');
  });

  it('holds the nudge while the person types and says it after the quiet settles', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    director.clear();
    bus.emit({ type: 'typing', active: true });
    director.clear();
    clock.advance(nudgeMs + 1000);
    await flush();
    assert.deepEqual(director.calls, [], 'no nudge while typing');
    bus.emit({ type: 'typing', active: false });
    clock.advance(2000);
    await flush();
    assert.deepEqual(director.lines, [nudgeLine]);
    clock.advance(10 * 60 * 1000);
    await flush();
    assert.equal(director.lines.length, 1);
  });

  it('holds the nudge off the record and while the person talks', async () => {
    for (const quiet of [
      { type: 'off_record', on: true },
      { type: 'talking', active: true },
    ] as const) {
      const { bus, director, clock } = rig();
      bus.emit({ type: 'session_started' });
      await flush();
      bus.emit(quiet);
      director.clear();
      clock.advance(nudgeMs + 5000);
      await flush();
      assert.deepEqual(director.lines, []);
    }
  });

  it('does not repeat a nudge after a reload', async () => {
    const storage = new MemoryStorage();
    const clock = new FakeClock();
    const first = rig({}, { storage, clock });
    first.bus.emit({ type: 'session_started' });
    await flush();
    clock.advance(nudgeMs + 1000);
    await flush();
    const saved = JSON.parse(storage.map.get(JOURNEY_STORAGE_KEY) ?? '{}') as { nudged: string[] };
    assert.deepEqual(saved.nudged, ['open']);
    first.journey.destroy();

    const second = rig({}, { storage, clock });
    second.bus.emit({ type: 'session_started' });
    await flush();
    second.director.clear();
    clock.advance(10 * 60 * 1000);
    await flush();
    assert.deepEqual(second.director.lines, [], 'the step was nudged before the reload');
  });

  it('arms the nudge of an agent-voiced step at once (teach-back)', async () => {
    const { bus, director, clock } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    bus.emit({ type: 'session_started', mode: 'review' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    bus.emit({ type: 'teachback_started' });
    await flush();
    director.clear();
    const teachBack = JOURNEY_STEPS.find((s) => s.id === 'teach-back');
    clock.advance((teachBack?.nudge?.afterMs ?? 0) + 1000);
    await flush();
    assert.deepEqual(director.lines, [teachBack?.nudge?.line]);
    assert.deepEqual(director.points, ['teachback']);
  });

  it('cancels the timer when the step changes', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    bus.emit({ type: 'screen_capturing' });
    await flush();
    director.clear();
    clock.advance(nudgeMs + 1000);
    await flush();
    assert.ok(!director.lines.includes(nudgeLine));
  });
});
