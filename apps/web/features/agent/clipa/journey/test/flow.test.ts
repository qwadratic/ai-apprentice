import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_STORAGE_KEY } from '../engine.ts';
import { JOURNEY_STEPS } from '../journey.ts';
import type { JourneyStepId } from '../journey.ts';
import { flush, rig } from './helpers.ts';

const line = (id: JourneyStepId): string => {
  const step = JOURNEY_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step.line;
};

describe('the journey follows the shell Start and End', () => {
  it('says nothing until the page is ready, then greets and points at Start', async () => {
    const { bus, director, journey, said } = rig();
    bus.emit({ type: 'mode_changed', mode: 'learn' });
    await flush();
    assert.deepEqual(director.calls, [], 'nothing before app_ready');
    bus.emit({ type: 'app_ready', mode: 'learn' });
    await flush();
    assert.deepEqual(director.points, ['session-start']);
    assert.deepEqual(director.lines, [line('open')]);
    assert.deepEqual(said, [line('open')]);
    assert.equal(journey.getSnapshot().stepId, 'open');
  });

  it('walks the whole demo with Start and End for each session', async () => {
    const { play, director, journey, storage } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    const step = () => journey.getSnapshot().stepId;
    const at = async (id: JourneyStepId, ...events: Parameters<typeof play>) => {
      await play(...events);
      assert.equal(step(), id);
    };

    await at('open', { type: 'app_ready', mode: 'learn' });
    await at('share', { type: 'session_live', mode: 'learn' });
    await at('learn', { type: 'screen_capturing' });
    await play({ type: 'agent_asked' }, { type: 'agent_asked', guardrail: true }, { type: 'agent_asked' });
    assert.equal(step(), 'learn', 'questions do not move the journey');
    assert.equal(journey.getSnapshot().questions, 3);
    assert.equal(journey.getSnapshot().guardrailQuestions, 1);
    await at('start-review', { type: 'session_ended', mode: 'learn' });
    await at('start-review', { type: 'mode_changed', mode: 'review' });
    await at('review-board', { type: 'session_live', mode: 'review' });
    await at('teach-back', { type: 'teachback_started' });
    await at('end-review', { type: 'teachback_confirmed' });
    await at('handoff', { type: 'session_ended', mode: 'review' });
    await at('start-teach', { type: 'mode_changed', mode: 'teach' });
    await at('teach', { type: 'session_live', mode: 'teach' });
    await at('teach-fix', { type: 'checkpoint_warned' });
    await at('end-teach', { type: 'sent' });
    assert.equal(journey.getSnapshot().done, false);
    await at('summary', { type: 'session_ended', mode: 'teach' });
    assert.equal(journey.getSnapshot().done, true);
    assert.equal(director.lines.at(-1), line('summary'));
    assert.equal(storage.map.has(JOURNEY_STORAGE_KEY), false, 'a finished journey leaves no saved position');
  });

  it('flies to each step target and says that step line (agent-voiced steps stay quiet)', async () => {
    const { play, director } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play(
      { type: 'app_ready', mode: 'learn' },
      { type: 'session_live', mode: 'learn' },
      { type: 'screen_capturing' },
      { type: 'session_ended', mode: 'learn' },
      { type: 'mode_changed', mode: 'review' },
      { type: 'session_live', mode: 'review' },
      { type: 'teachback_started' },
      { type: 'teachback_confirmed' },
      { type: 'session_ended', mode: 'review' },
      { type: 'mode_changed', mode: 'teach' },
      { type: 'session_live', mode: 'teach' },
      { type: 'checkpoint_warned' },
      { type: 'sent' },
      { type: 'session_ended', mode: 'teach' },
    );
    assert.deepEqual(director.points, [
      'session-start',
      'share-screen',
      'screen-preview',
      'mode-review', // the Review tab is not selected yet: she points at the tab first
      'session-start',
      'board-gap',
      'session-end',
      'mode-teach',
      'session-start',
      'workspace',
      'session-end',
      'mastery-summary',
    ]);
    assert.deepEqual(director.lines, [
      line('open'),
      line('share'),
      line('learn'),
      'Open the Review tab first, then press Start.',
      line('start-review'),
      line('review-board'),
      line('end-review'),
      line('handoff'),
      line('start-teach'),
      line('teach'),
      line('end-teach'),
      line('summary'),
    ]);
  });

  it('does not advance on timers alone', async () => {
    const { play, clock, journey } = rig();
    await play({ type: 'app_ready' });
    clock.advance(10 * 60 * 60 * 1000);
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
  });

  it('ignores events that end a later step (Send while the expert is still in Learn)', async () => {
    const { play, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
    await play({ type: 'sent' }, { type: 'checkpoint_warned' }, { type: 'teachback_confirmed' }, { type: 'session_ended', mode: 'review' });
    assert.equal(journey.getSnapshot().stepId, 'start-review', 'only the end of Learn moved it');
  });

  it('skips Share when the agent asks before any window is shared, and does not claim to see the screen', async () => {
    const { play, director, journey } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'agent_asked' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
    assert.equal(journey.getSnapshot().outcomes.share, 'skipped');
    assert.match(director.lines.at(-1) ?? '', /sample events, not your screen/);
    assert.equal(director.points.at(-1), 'workspace');
  });

  it('takes the synthetic flag from the shell when it has one', async () => {
    const real = rig({ agentQuietMs: 0, quietSettleMs: 0, isSynthetic: () => false });
    await real.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'agent_asked' });
    assert.equal(real.director.lines.at(-1), line('learn'));
    const fake = rig({ isSynthetic: () => true });
    await fake.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    assert.match(fake.director.lines.at(-1) ?? '', /sample events/);
  });

  it('jumps a new hire who starts Teach straight to the Teach steps', async () => {
    const { play, director, journey } = rig();
    await play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' });
    const snap = journey.getSnapshot();
    assert.equal(snap.stepId, 'teach');
    assert.equal(snap.persona, 'newHire');
    assert.equal(snap.outcomes.learn, 'skipped');
    assert.equal(snap.outcomes['review-board'], 'skipped');
    assert.equal(director.lines.at(-1), line('teach'));
  });

  it('sends a straight allowed Send in Teach to the end of Teach, and the end of the session to the summary', async () => {
    const { play, journey } = rig();
    await play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' }, { type: 'sent' });
    assert.equal(journey.getSnapshot().stepId, 'end-teach');
    await play({ type: 'teach_finished' });
    assert.equal(journey.getSnapshot().stepId, 'summary');
  });

  it('adds a share step in Teach only when the shell captures there', async () => {
    const off = rig();
    await off.play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' });
    assert.ok(!off.journey.getSnapshot().stepIds.includes('share-teach'));
    assert.equal(off.journey.getSnapshot().stepId, 'teach', 'a reload in Teach never sends the new hire to share a screen');

    const on = rig({ captureInTeach: true });
    await on.play({ type: 'app_ready', mode: 'teach' }, { type: 'session_live', mode: 'teach' });
    assert.equal(on.journey.getSnapshot().stepId, 'share-teach');
    assert.equal(on.director.points.at(-1), 'share-screen');
    await on.play({ type: 'screen_capturing' });
    assert.equal(on.journey.getSnapshot().stepId, 'teach');
  });

  it('points at the right tab first and re-says the step when the tab changes', async () => {
    const { play, director, journey } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready', mode: 'learn' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' }, { type: 'session_ended', mode: 'learn' });
    assert.equal(journey.getSnapshot().variant, 'wrongTab');
    assert.equal(director.points.at(-1), 'mode-review');
    await play({ type: 'mode_changed', mode: 'review' });
    assert.equal(journey.getSnapshot().variant, null);
    assert.equal(director.points.at(-1), 'session-start');
    assert.equal(director.lines.at(-1), line('start-review'));
  });

  it('does not advance on the end of a session that went off the record', async () => {
    const { play, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    await play({ type: 'off_record', on: true }, { type: 'session_ended', mode: 'learn' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
    await play({ type: 'session_ended', mode: 'learn', reason: 'off_record' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('starts a new run when a Learn session starts after the journey got past it', async () => {
    const { play, journey, storage } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' }, { type: 'session_ended', mode: 'learn' });
    const firstRun = journey.getSnapshot().runId;
    assert.equal(journey.getSnapshot().stepId, 'start-review');
    await play({ type: 'session_live', mode: 'learn' });
    assert.notEqual(journey.getSnapshot().runId, firstRun);
    assert.equal(journey.getSnapshot().stepId, 'share', 'the second rehearsal starts again after Start Learn');
    assert.deepEqual(journey.getSnapshot().outcomes, { open: 'done' });
    assert.ok(storage.map.size <= 1);
  });

  it('tells the person to check the masks when the picker has returned', async () => {
    const { play, director, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'mask_review' });
    assert.equal(journey.getSnapshot().stepId, 'share');
    assert.equal(journey.getSnapshot().variant, 'maskReview');
    assert.equal(director.points.at(-1), 'mask-confirm');
    assert.match(director.lines.at(-1) ?? '', /privacy masks/);
  });

  it('stays on Share when sharing is refused, and explains', async () => {
    const { play, director, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'share_requested' });
    await play({ type: 'screen_unavailable', reason: 'denied' });
    assert.equal(journey.getSnapshot().stepId, 'share');
    assert.equal(director.points.at(-1), 'share-screen');
    assert.match(director.lines.at(-1) ?? '', /didn't start/);
    await play({ type: 'share_requested' }, { type: 'screen_capturing' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('does not send the expert back to Share when the capture drops during Learn', async () => {
    const { play, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    await play({ type: 'screen_unavailable', reason: 'lost' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('speaks in place when none of the targets is on the page', async () => {
    const { play, director } = rig({}, { present: new Set() });
    await play({ type: 'app_ready' });
    assert.deepEqual(director.points, ['-']);
    assert.deepEqual(director.lines, [line('open')]);
  });

  it('uses the fallback target when the primary one is missing', async () => {
    const { play, director, present } = rig({ agentQuietMs: 0, quietSettleMs: 0 });
    present.delete('board-gap');
    await play({ type: 'app_ready', mode: 'review' }, { type: 'session_live', mode: 'review' });
    assert.equal(director.points.at(-1), 'review-board');
  });

  it('replays a finished step without moving, and refuses one that is not finished', async () => {
    const { play, director, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    director.clear();
    assert.equal(journey.replay('review-board'), false, 'not done yet');
    assert.equal(journey.replay('share'), true);
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    assert.deepEqual(director.lines, [line('share')]);
    assert.equal(journey.getSnapshot().stepId, 'learn', 'replay moves nothing');
  });

  it('refuses a replay when its control is not on the page', async () => {
    const { play, journey, present } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    present.delete('share-screen');
    assert.equal(journey.replay('share'), false);
  });

  it('starts over on reset', async () => {
    const { play, director, journey } = rig();
    await play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_capturing' });
    journey.reset();
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'open');
    assert.equal(director.lines.at(-1), line('open'));
    assert.deepEqual(journey.getSnapshot().outcomes, {});
  });

  it('notifies subscribers with a new snapshot object on every change', async () => {
    const { play, bus, journey } = rig();
    let calls = 0;
    const off = journey.subscribe(() => {
      calls += 1;
    });
    const before = journey.getSnapshot();
    await play({ type: 'app_ready' });
    assert.notEqual(journey.getSnapshot(), before);
    assert.ok(calls > 0);
    const seen = calls;
    off();
    bus.emit({ type: 'session_live', mode: 'learn' });
    await flush();
    assert.equal(calls, seen);
  });
});
