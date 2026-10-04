import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STEPS } from '../journey.ts';
import type { JourneyStepId } from '../journey.ts';
import { flush, rig } from './helpers.ts';

const line = (id: JourneyStepId, key: 'line' = 'line'): string => {
  const step = JOURNEY_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step[key];
};

describe('the journey follows the app events', () => {
  it('waits for the session, then greets and points at Share screen', async () => {
    const { bus, director, journey, said } = rig();
    await flush();
    assert.deepEqual(director.calls, [], 'nothing before session_started');
    bus.emit({ type: 'session_started', mode: 'learn' });
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    assert.deepEqual(director.lines, [line('open')]);
    assert.deepEqual(said, [line('open')]);
    assert.equal(journey.getSnapshot().stepId, 'open');
  });

  it('walks the whole demo: expert Learn, Review, teach-back, hand-off, new hire Teach, summary', async () => {
    const { bus, director, journey, clock } = rig();
    const step = () => journey.getSnapshot().stepId;

    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'share_requested' });
    await flush();
    assert.equal(step(), 'share');
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(step(), 'learn');
    assert.ok(director.points.includes('screen-preview'));

    for (let i = 0; i < 3; i += 1) bus.emit({ type: 'agent_asked', guardrail: i === 1 });
    assert.equal(step(), 'learn', 'questions do not move the journey');
    assert.equal(journey.getSnapshot().questions, 3);
    assert.equal(journey.getSnapshot().guardrailQuestions, 1);

    bus.emit({ type: 'mode_changed', mode: 'review' });
    assert.equal(step(), 'review-board');
    bus.emit({ type: 'teachback_started' });
    assert.equal(step(), 'teach-back');
    bus.emit({ type: 'teachback_confirmed' });
    assert.equal(step(), 'handoff');
    bus.emit({ type: 'mode_changed', mode: 'teach' });
    assert.equal(step(), 'teach');
    bus.emit({ type: 'checkpoint_warned' });
    assert.equal(step(), 'teach-fix');
    bus.emit({ type: 'sent' });
    assert.equal(step(), 'summary');
    assert.equal(journey.getSnapshot().active, false, 'the summary waits for its mode');
    bus.emit({ type: 'mode_changed', mode: 'summary' });
    clock.advance(14_000); // the agent asked questions a moment ago, so Clipa waits before the summary
    await flush();
    assert.equal(journey.getSnapshot().done, true);
    assert.equal(director.lines.at(-1), line('summary'));
  });

  it('flies to each step target and says that step line, in order (agent-voiced steps stay quiet)', async () => {
    const { bus, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    const events = [
      { type: 'session_started', mode: 'learn' },
      { type: 'share_requested' },
      { type: 'screen_capturing' },
      { type: 'mode_changed', mode: 'review' },
      { type: 'teachback_started' },
      { type: 'teachback_confirmed' },
      { type: 'mode_changed', mode: 'teach' },
      { type: 'checkpoint_warned' },
      { type: 'sent' },
      { type: 'mode_changed', mode: 'summary' },
    ] as const;
    for (const event of events) {
      bus.emit(event);
      await flush();
    }
    assert.deepEqual(director.points, [
      'share-screen',
      'share-screen',
      'screen-preview',
      'board-gap',
      'mode-teach',
      'workspace',
      'mastery-summary',
    ]);
    assert.deepEqual(director.lines, [
      line('open'),
      line('share'),
      line('learn'),
      line('review-board'),
      line('handoff'),
      line('teach'),
      line('summary'),
    ]);
  });

  it('does not advance on timers alone', async () => {
    const { bus, clock, journey } = rig();
    bus.emit({ type: 'session_started' });
    await flush();
    clock.advance(10 * 60 * 60 * 1000);
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
  });

  it('ignores events that end a later step (Send while the expert is still in Learn)', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'learn');
    bus.emit({ type: 'sent' });
    bus.emit({ type: 'checkpoint_warned' });
    bus.emit({ type: 'teachback_confirmed' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('lets one event end several steps (capture at the first step goes straight to Learn)', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'learn');
    assert.equal(journey.getSnapshot().outcomes.open, 'done');
    assert.equal(journey.getSnapshot().outcomes.share, 'done');
  });

  it('skips the expert steps for a new hire who starts in Teach', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'teach' });
    bus.emit({ type: 'camera_capturing' });
    await flush();
    const snap = journey.getSnapshot();
    assert.equal(snap.stepId, 'teach');
    assert.equal(snap.persona, 'newHire');
    assert.equal(snap.outcomes.learn, 'skipped');
    assert.equal(snap.outcomes['review-board'], 'skipped');
    assert.equal(director.lines.at(-1), line('teach'));
  });

  it('sends a straight allowed Send in Teach to the summary without a warning', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'teach' });
    bus.emit({ type: 'screen_capturing' });
    bus.emit({ type: 'sent' });
    assert.equal(journey.getSnapshot().stepId, 'summary');
  });

  it('speaks in place when none of the targets is on the page', async () => {
    const { bus, director } = rig({}, { present: new Set() });
    bus.emit({ type: 'session_started', mode: 'learn' });
    await flush();
    assert.deepEqual(director.points, ['-']);
    assert.deepEqual(director.lines, [line('open')]);
  });

  it('uses the fallback target when the primary one is missing', async () => {
    const { bus, director, present } = rig();
    present.delete('board-gap');
    bus.emit({ type: 'session_started', mode: 'review' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(director.points.at(-1), 'review-board');
  });

  it('tells the person to check the masks when the picker has returned', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'share_requested' });
    await flush();
    bus.emit({ type: 'mask_review' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'share');
    assert.equal(journey.getSnapshot().variant, 'maskReview');
    assert.equal(director.points.at(-1), 'mask-confirm');
    assert.match(director.lines.at(-1) ?? '', /privacy masks/);
  });

  it('goes back to the Share step when sharing is refused, and explains', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'share_requested' });
    await flush();
    bus.emit({ type: 'screen_unavailable', reason: 'denied' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
    assert.equal(director.points.at(-1), 'share-screen');
    assert.match(director.lines.at(-1) ?? '', /didn't start/);
    bus.emit({ type: 'share_requested' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('goes back to Share when the capture is lost during Learn, but not during Review', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    bus.emit({ type: 'screen_unavailable', reason: 'lost' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
    assert.equal(journey.getSnapshot().variant, 'lost');

    const review = rig();
    review.bus.emit({ type: 'session_started', mode: 'review' });
    review.bus.emit({ type: 'screen_capturing' });
    await flush();
    review.bus.emit({ type: 'screen_unavailable', reason: 'lost' });
    assert.equal(review.journey.getSnapshot().stepId, 'review-board');
  });

  it('replays a finished step without moving, and refuses one that is not finished', async () => {
    const { bus, director, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    director.clear();
    assert.equal(journey.replay('review-board'), false, 'not done yet');
    assert.equal(journey.replay('open'), true);
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    assert.deepEqual(director.lines, [line('open')]);
    assert.equal(journey.getSnapshot().stepId, 'learn', 'replay moves nothing');
  });

  it('starts over on reset', async () => {
    const { bus, director, journey, storage } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    journey.reset();
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
    assert.equal(director.lines.at(-1), line('open'));
    assert.deepEqual(journey.getSnapshot().outcomes, {});
    assert.ok(storage.map.size <= 1);
  });

  it('notifies subscribers with a new snapshot object on every change', async () => {
    const { bus, journey } = rig();
    let calls = 0;
    const off = journey.subscribe(() => {
      calls += 1;
    });
    const before = journey.getSnapshot();
    bus.emit({ type: 'session_started' });
    await flush();
    assert.notEqual(journey.getSnapshot(), before);
    assert.ok(calls > 0);
    const seen = calls;
    off();
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(calls, seen);
  });
});
