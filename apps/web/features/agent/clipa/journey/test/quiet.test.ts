import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STEPS } from '../journey.ts';
import { flush, rig } from './helpers.ts';

const openLine = JOURNEY_STEPS[0]?.line ?? '';

describe('typing, talking and off-record keep Clipa quiet', () => {
  it('holds the greeting while the person types, then says it once typing has stopped for a moment', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.calls, []);
    bus.emit({ type: 'typing', active: false });
    clock.advance(1000);
    await flush();
    assert.deepEqual(director.calls, [], 'still settling');
    clock.advance(600);
    await flush();
    assert.deepEqual(director.lines, [openLine]);
  });

  it('sends Clipa home the moment typing starts, and does not repeat a line she already said', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    assert.equal(director.state, 'pointing');
    director.clear();
    bus.emit({ type: 'typing', active: true });
    assert.deepEqual(director.calls, ['retreat']);
    bus.emit({ type: 'typing', active: false });
    clock.advance(5000);
    await flush();
    assert.deepEqual(director.calls, ['retreat'], 'no second greeting');
  });

  it('drops a flight that is still being set up when typing starts, and says the line later', async () => {
    const { bus, director, clock } = rig();
    let release = (): void => {};
    director.idleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bus.emit({ type: 'session_started' });
    await flush();
    bus.emit({ type: 'typing', active: true });
    director.idleGate = null;
    release();
    await flush();
    assert.deepEqual(director.points, [], 'the stale flight does not start');
    assert.deepEqual(director.lines, []);
    bus.emit({ type: 'typing', active: false });
    clock.advance(1600);
    await flush();
    assert.deepEqual(director.lines, [openLine]);
    assert.equal(director.lines.length, 1);
  });

  it('is quiet while the person talks and while the agent speaks', async () => {
    for (const by of ['person', 'agent'] as const) {
      const { bus, director, clock, journey } = rig();
      bus.emit({ type: 'talking', active: true, by });
      bus.emit({ type: 'session_started' });
      await flush();
      assert.deepEqual(director.calls, [], `silent while ${by} talks`);
      assert.equal(journey.getSnapshot().quiet, true);
      bus.emit({ type: 'talking', active: false, by });
      clock.advance(1600);
      await flush();
      assert.deepEqual(director.lines, [openLine]);
    }
  });

  it('treats talking without a speaker as the person', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'talking', active: true });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.calls, []);
  });

  it('goes silent off the record, tells the director, and resumes only when back on the record', async () => {
    const { bus, director, clock, journey } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    director.clear();
    bus.emit({ type: 'off_record', on: true });
    assert.deepEqual(director.calls, ['off:true']);
    assert.equal(journey.getSnapshot().offRecord, true);
    bus.emit({ type: 'screen_capturing' });
    clock.advance(60_000);
    await flush();
    assert.deepEqual(director.calls, ['off:true'], 'the Learn line waits while off the record');
    bus.emit({ type: 'off_record', on: false });
    clock.advance(1600);
    await flush();
    assert.equal(director.calls[1], 'off:false');
    assert.deepEqual(director.lines, [JOURNEY_STEPS[2]?.line]);
  });

  it('never moves the journey forward by itself while quiet, but still follows the events', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started' });
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'screen_capturing' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('stays out of the agent way after a question, then says what it held back', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'agent_asked' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.deepEqual(director.calls, [], 'the agent has the stage');
    clock.advance(11_000);
    await flush();
    assert.deepEqual(director.calls, []);
    clock.advance(3000);
    await flush();
    assert.deepEqual(director.lines, [JOURNEY_STEPS[2]?.line]);
  });

  it('waits for the director to be idle before it speaks (the agent question may still be on screen)', async () => {
    const { bus, director } = rig();
    let release = (): void => {};
    director.idleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.calls, []);
    director.idleGate = null;
    release();
    await flush();
    assert.deepEqual(director.lines, [openLine]);
  });

  it('retries a flight that another sequence cancelled, at most twice', async () => {
    const { bus, director, clock } = rig();
    director.failPoint = 'cancelled';
    bus.emit({ type: 'session_started' });
    await flush();
    for (let i = 0; i < 6; i += 1) {
      clock.advance(5000);
      await flush();
    }
    assert.equal(director.points.length, 3, 'one try and two retries');
    assert.deepEqual(director.lines, []);
  });

  it('does not touch the director for an agent-voiced step (teach-back, the checkpoint warning)', async () => {
    const { bus, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    bus.emit({ type: 'session_started', mode: 'review' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    director.clear();
    bus.emit({ type: 'teachback_started' });
    await flush();
    assert.deepEqual(director.calls, []);
    bus.emit({ type: 'teachback_confirmed' });
    bus.emit({ type: 'mode_changed', mode: 'teach' });
    await flush();
    director.clear();
    bus.emit({ type: 'checkpoint_warned' });
    await flush();
    assert.deepEqual(director.calls, [], 'the warning stays the agent own');
  });

  it('calls Clipa home in the middle of a flight when typing starts', async () => {
    const { bus, director } = rig();
    let arrive = (): void => {};
    director.pointGate = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    director.clear();
    bus.emit({ type: 'typing', active: true });
    assert.deepEqual(director.calls, ['retreat']);
    arrive();
    await flush();
    assert.deepEqual(director.lines, [], 'she never says the line she was flying to');
  });

  it('steps aside without moving Clipa while the agent speaks (the agent works her pose)', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    director.clear();
    bus.emit({ type: 'talking', active: true, by: 'agent' });
    assert.deepEqual(director.calls, []);
  });

  it('gives the agent a free stage when it asks: she leaves her control so the question is not queued behind her', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    await flush();
    assert.equal(director.state, 'pointing');
    director.clear();
    bus.emit({ type: 'agent_asked' });
    assert.deepEqual(director.calls, ['retreat']);
  });

  it('does not pull Clipa away from the agent own pose when it asks', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    await flush();
    director.state = 'speaking'; // the agent has already taken her over
    director.clear();
    bus.emit({ type: 'agent_asked' });
    assert.deepEqual(director.calls, []);
  });

  it('ignores repeated typing and talking events with the same value', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    director.clear();
    let changes = 0;
    journey.subscribe(() => {
      changes += 1;
    });
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'typing', active: true });
    assert.equal(changes, 1);
    assert.deepEqual(director.calls, ['retreat']);
  });
});
