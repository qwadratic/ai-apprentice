import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStrip } from '../progress.ts';
import type { StripItem } from '../progress.ts';
import { createDomTargetResolver, createJourneyTargetResolver, journeyClipaTarget } from '../targets.ts';
import type { TargetElement, TargetRoot } from '../targets.ts';
import { flush, rig } from './helpers.ts';

const statuses = (items: StripItem[]): string => items.map((i) => `${i.label}:${i.status}`).join(' ');

describe('the progress strip model', () => {
  it('shows Share, Learn, Review, Teach, Summary', async () => {
    const { journey } = rig();
    assert.deepEqual(buildStrip(journey.getSnapshot()).map((i) => i.label), ['Share', 'Learn', 'Review', 'Teach', 'Summary']);
  });

  it('highlights the current phase and marks earlier ones done', async () => {
    const { bus, journey } = rig();
    assert.equal(statuses(buildStrip(journey.getSnapshot())), 'Share:current Learn:upcoming Review:upcoming Teach:upcoming Summary:upcoming');
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(statuses(buildStrip(journey.getSnapshot())), 'Share:done Learn:current Review:upcoming Teach:upcoming Summary:upcoming');
    bus.emit({ type: 'mode_changed', mode: 'review' });
    bus.emit({ type: 'teachback_confirmed' });
    assert.equal(statuses(buildStrip(journey.getSnapshot())), 'Share:done Learn:done Review:current Teach:upcoming Summary:upcoming');
    bus.emit({ type: 'mode_changed', mode: 'teach' });
    bus.emit({ type: 'sent' });
    assert.equal(
      statuses(buildStrip(journey.getSnapshot())),
      'Share:done Learn:done Review:done Teach:current Summary:upcoming',
      'Teach stays current until the app reaches the summary',
    );
    bus.emit({ type: 'mode_changed', mode: 'summary' });
    await flush();
    assert.equal(statuses(buildStrip(journey.getSnapshot())), 'Share:done Learn:done Review:done Teach:done Summary:done');
  });

  it('marks the phases a new hire never went through as skipped', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'teach' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    assert.equal(statuses(buildStrip(journey.getSnapshot())), 'Share:done Learn:skipped Review:skipped Teach:current Summary:upcoming');
  });

  it('counts live questions while Learn is current, up to the goal of three', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    bus.emit({ type: 'agent_asked' });
    bus.emit({ type: 'agent_asked' });
    assert.equal(buildStrip(journey.getSnapshot())[1]?.detail, '2 of 3 questions');
    for (let i = 0; i < 4; i += 1) bus.emit({ type: 'agent_asked' });
    assert.equal(buildStrip(journey.getSnapshot())[1]?.detail, '3 of 3 questions');
  });

  it('points "show me again" at the first step of the phase', async () => {
    const { journey } = rig();
    const items = buildStrip(journey.getSnapshot());
    assert.deepEqual(items.map((i) => i.firstStep), ['open', 'learn', 'review-board', 'teach', 'summary']);
  });

  it('is not destructive: replaying a done step leaves the journey where it was', async () => {
    const { bus, journey } = rig();
    bus.emit({ type: 'session_started', mode: 'learn' });
    bus.emit({ type: 'screen_capturing' });
    await flush();
    const before = journey.getSnapshot();
    journey.replay('open');
    await flush();
    const after = journey.getSnapshot();
    assert.equal(after.stepId, before.stepId);
    assert.deepEqual(after.outcomes, before.outcomes);
  });
});

function fakeRoot(entries: Record<string, Array<{ rect: { left: number; top: number; width: number; height: number }; hidden?: boolean }>>): {
  root: TargetRoot;
  selectors: string[];
} {
  const selectors: string[] = [];
  const root: TargetRoot = {
    querySelectorAll(selector) {
      selectors.push(selector);
      const match = /data-clipa-target="((?:[^"\\]|\\.)*)"/.exec(selector);
      const key = (match?.[1] ?? '').replace(/\\(.)/g, '$1');
      const items = entries[key] ?? [];
      return items.map(
        (item): TargetElement => ({
          getBoundingClientRect: () => item.rect,
          ...(item.hidden ? { hidden: true } : {}),
        }),
      );
    },
  };
  return { root, selectors };
}

describe('target resolvers', () => {
  it('finds the first visible element with the data-clipa-target value', () => {
    const { root } = fakeRoot({
      'board-gap': [
        { rect: { left: 1, top: 2, width: 0, height: 10 } },
        { rect: { left: 5, top: 6, width: 30, height: 12 }, hidden: true },
        { rect: { left: 7, top: 8, width: 40, height: 20 } },
        { rect: { left: 9, top: 9, width: 40, height: 20 } },
      ],
    });
    assert.deepEqual(createDomTargetResolver(root)('board-gap'), { left: 7, top: 8, width: 40, height: 20 });
  });

  it('answers null for a target that is not on the page', () => {
    const { root } = fakeRoot({});
    assert.equal(createDomTargetResolver(root)('send'), null);
  });

  it('quotes the value in the selector', () => {
    const { root, selectors } = fakeRoot({});
    createDomTargetResolver(root)('a"b');
    assert.equal(selectors[0], '[data-clipa-target="a\\"b"]');
  });

  it('answers journey targets itself and hands everything else to the shell resolver', () => {
    const byValue = (value: string) => (value === 'send' ? { left: 1, top: 1, width: 5, height: 5 } : null);
    const other = (target: { surface: string }) => (target.surface === 'workspace' ? { left: 9, top: 9, width: 9, height: 9 } : null);
    const resolve = createJourneyTargetResolver(byValue, other);
    assert.deepEqual(resolve(journeyClipaTarget('send')), { left: 1, top: 1, width: 5, height: 5 });
    assert.equal(resolve(journeyClipaTarget('missing')), null);
    assert.deepEqual(resolve({ surface: 'workspace' }), { left: 9, top: 9, width: 9, height: 9 });
    assert.equal(resolve({ surface: 'elsewhere' }), null);
    assert.equal(createJourneyTargetResolver(byValue)({ surface: 'workspace' }), null);
  });
});
