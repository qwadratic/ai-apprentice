import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STEPS } from '../journey.ts';
import type { JourneyStepId } from '../journey.ts';
import { flush, rig } from './helpers.ts';

const line = (id: JourneyStepId): string => JOURNEY_STEPS.find((s) => s.id === id)?.line ?? '';
const openLine = line('open');

describe('typing, talking and off-record keep Clipa quiet', () => {
  it('holds the greeting while the person types, then says it once typing has stopped for a moment', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'app_ready' });
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
    bus.emit({ type: 'app_ready' });
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

  it('S6: a typing edge during take-off sends her home and the stale line is never said', async () => {
    const { bus, director, clock } = rig();
    let arrive = (): void => {};
    director.pointGate = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    bus.emit({ type: 'app_ready' });
    await flush();
    assert.deepEqual(director.points, ['session-start']);
    assert.equal(director.state, 'pointing', 'she is in the air');
    director.clear();
    bus.emit({ type: 'typing', active: true });
    assert.deepEqual(director.calls, ['retreat']);
    arrive();
    await flush();
    assert.equal(director.state, 'dock');
    assert.deepEqual(director.lines, [], 'she never says the line she was flying to');
    bus.emit({ type: 'typing', active: false });
    clock.advance(1600);
    await flush();
    assert.deepEqual(director.lines, [openLine], 'it comes once typing has been over for a moment');
  });

  it('S6: when the director was holding the flight for the typing, she is sent home the moment she arrives', async () => {
    const { bus, director } = rig();
    director.pointMode = 'waitQuiet';
    let release = (): void => {};
    director.pointGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bus.emit({ type: 'app_ready' });
    await flush();
    bus.emit({ type: 'typing', active: true });
    director.clear();
    release();
    await flush();
    assert.deepEqual(director.lines, []);
    assert.deepEqual(director.calls, ['retreat'], 'the stale flight is called back');
    assert.equal(director.state, 'dock');
  });

  it('is quiet while the person talks and while the agent speaks', async () => {
    for (const by of ['person', 'agent'] as const) {
      const { bus, director, clock, journey } = rig();
      bus.emit({ type: 'talking', active: true, by });
      bus.emit({ type: 'app_ready' });
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
    bus.emit({ type: 'app_ready' });
    await flush();
    assert.deepEqual(director.calls, []);
  });

  it('goes silent off the record, tells the director, and resumes only when back on the record', async () => {
    const { bus, director, clock, journey } = rig();
    await flush();
    bus.emit({ type: 'app_ready' });
    await flush();
    director.clear();
    bus.emit({ type: 'off_record', on: true });
    assert.equal(director.calls[0], 'off:true');
    assert.equal(journey.getSnapshot().offRecord, true);
    bus.emit({ type: 'session_live', mode: 'learn' });
    clock.advance(60_000);
    await flush();
    assert.ok(!director.calls.includes(`speak:${line('share')}`), 'the Share line waits while off the record');
    bus.emit({ type: 'off_record', on: false });
    clock.advance(1600);
    await flush();
    assert.ok(director.calls.includes('off:false'));
    assert.deepEqual(director.lines, [line('share')]);
  });

  it('never moves the journey forward by itself while quiet, but still follows the events', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'app_ready' });
    bus.emit({ type: 'typing', active: true });
    bus.emit({ type: 'session_live', mode: 'learn' });
    assert.equal(journey.getSnapshot().stepId, 'share');
  });

  it('stays out of the agent way after a question, then says what it held back', async () => {
    const { bus, director, clock } = rig();
    bus.emit({ type: 'app_ready', mode: 'learn' });
    await flush();
    bus.emit({ type: 'agent_asked' });
    bus.emit({ type: 'session_live', mode: 'learn' });
    await flush();
    director.clear();
    clock.advance(11_000);
    await flush();
    assert.deepEqual(director.lines, [], 'the agent has the stage');
    clock.advance(3000);
    await flush();
    assert.deepEqual(director.lines, [line('share')]);
  });

  it('waits for the director to be idle before it speaks (the agent question may still be on screen)', async () => {
    const { bus, director } = rig();
    director.state = 'listening'; // the agent asked a moment ago
    bus.emit({ type: 'app_ready' });
    await flush();
    assert.deepEqual(director.calls, []);
    director.state = 'dock';
    await flush();
    assert.deepEqual(director.lines, [openLine]);
  });

  it('never waits for idle() while she points: at its own control it moves her on, at the agent it tries again later', async () => {
    const own = rig();
    await own.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' });
    assert.deepEqual(own.director.lines, [openLine, line('share')], 'she moved from one control to the next without going home');

    const other = rig();
    other.director.state = 'pointing'; // the agent replays the expert's moment
    await other.play({ type: 'app_ready' });
    assert.deepEqual(other.director.calls, [], 'the agent pose is not preempted, and nothing hangs');
    other.director.state = 'dock';
    other.clock.advance(5000);
    await flush();
    assert.deepEqual(other.director.lines, [openLine], 'a retry found her home');
  });

  it('retries a flight that another sequence cancelled, at most twice', async () => {
    const { bus, director, clock } = rig();
    director.failPoint = 'cancelled';
    bus.emit({ type: 'app_ready' });
    await flush();
    for (let i = 0; i < 6; i += 1) {
      clock.advance(5000);
      await flush();
    }
    assert.equal(director.points.length, 3, 'one try and two retries');
    assert.deepEqual(director.lines, []);
  });

  it('S2: after the agent talks, the next line still comes, and typing sends her home', async () => {
    const { bus, director, clock, play } = rig();
    await play({ type: 'app_ready' });
    assert.equal(director.state, 'pointing');
    director.clear();
    bus.emit({ type: 'talking', active: true, by: 'agent' });
    assert.deepEqual(director.calls, ['retreat'], 'she does not stay behind at the control while the agent talks');
    bus.emit({ type: 'talking', active: false, by: 'agent' });
    clock.advance(1600);
    await flush();
    await play({ type: 'session_live', mode: 'learn' });
    assert.deepEqual(director.lines, [line('share')], 'the Share line still comes');
    assert.equal(director.state, 'pointing');
    director.clear();
    bus.emit({ type: 'typing', active: true });
    assert.deepEqual(director.calls, ['retreat']);
    assert.equal(director.state, 'dock');
  });

  it('S3: the hand-over line comes after the teach-back and the end of Review', async () => {
    const { play, director, journey } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play(
      { type: 'app_ready', mode: 'review' },
      { type: 'session_live', mode: 'review' },
      { type: 'talking', active: true, by: 'agent' }, // the agent speaks the teach-back
      { type: 'teachback_started' },
    );
    assert.equal(journey.getSnapshot().stepId, 'teach-back');
    assert.equal(director.state, 'dock', 'she does not stay at the gap while the agent speaks the teach-back');
    await play({ type: 'talking', active: false, by: 'agent' }, { type: 'teachback_confirmed' });
    assert.equal(director.lines.at(-1), line('end-review'));
    await play({ type: 'session_ended', mode: 'review' });
    assert.equal(director.lines.at(-1), line('handoff'));
    assert.equal(director.points.at(-1), 'mode-teach');
  });

  it('lets go of Clipa when the teach-back starts, so she does not stand at the gap', async () => {
    const { play, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready', mode: 'review' }, { type: 'session_live', mode: 'review' });
    assert.equal(director.state, 'pointing');
    director.clear();
    await play({ type: 'teachback_started' });
    assert.deepEqual(director.calls, ['retreat']);
  });

  it('does not retreat the agent warning when the checkpoint warns (the WARN decision flies her itself)', async () => {
    const { play, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' });
    director.clear();
    await play({ type: 'checkpoint_warned' });
    assert.deepEqual(director.calls, []);
  });

  it('calls Clipa home when Send goes through after a warning (the warning is moot)', async () => {
    const { play, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' }, { type: 'checkpoint_warned' });
    director.state = 'warning'; // the WARN decision is on screen
    director.clear();
    await play({ type: 'sent' });
    assert.equal(director.calls[0], 'retreat');
    assert.equal(director.lines.at(-1), line('end-teach'));
  });

  it('gives the agent a free stage when it asks: she leaves her control so the question is not queued behind her', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'app_ready', mode: 'learn' });
    await flush();
    assert.equal(director.state, 'pointing');
    director.clear();
    bus.emit({ type: 'agent_asked' });
    assert.deepEqual(director.calls, ['retreat']);
  });

  it('does not pull Clipa away from the agent own pose when it asks', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'app_ready', mode: 'learn' });
    await flush();
    director.state = 'speaking'; // the agent has already taken her over
    director.clear();
    bus.emit({ type: 'agent_asked' });
    assert.deepEqual(director.calls, []);
  });

  it('steps aside without moving Clipa while the agent speaks, if she is not at one of our controls', async () => {
    const { bus, director } = rig();
    bus.emit({ type: 'app_ready' });
    await flush();
    director.state = 'speaking';
    director.clear();
    bus.emit({ type: 'talking', active: true, by: 'agent' });
    assert.deepEqual(director.calls, []);
  });

  it('ignores repeated typing and talking events with the same value', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'app_ready' });
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
