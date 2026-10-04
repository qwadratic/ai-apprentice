import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenObservation } from '@apprentice/contracts';
import { buildKeyframes, buildStoryboard, formatClock } from '../model.ts';
import { syntheticEvidenceResolver, syntheticFrameUrl } from '../synthetic-frames.ts';
import { mutable, snapshot } from './fixtures.ts';

const board = (stage: 'draft' | 'confirmed') => {
  const s = snapshot(stage);
  return buildStoryboard({ map: s.map, observations: s.observations, evidence: s.evidence, gaps: s.gaps, blockers: s.blockers });
};

test('formatClock gives mm:ss from sessionEpochMs offsets', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(11_000), '00:11');
  assert.equal(formatClock(94_500), '01:34');
  assert.equal(formatClock(-5), '00:00');
});

test('keyframes are the vision observations where something changed, in time order', () => {
  const s = snapshot('draft');
  const shuffled = [...s.observations].reverse();
  const frames = buildKeyframes(shuffled, s.evidence);
  const times = frames.map((f) => f.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(frames.map((f) => f.index), frames.map((_, i) => i + 1));
  assert.ok(frames.every((f) => f.surface !== ('input_activity' as string)), 'heartbeats never become frames');
  assert.equal(frames[0]?.surface, 'order_view');
  assert.equal(frames[0]?.changes[0]?.kind, 'order_opened');
});

test('the brain-level changes of the customer_07 session are named', () => {
  const kinds = board('draft').keyframes.flatMap((f) => f.changes.map((c) => c.kind));
  for (const k of ['order_opened', 'email_started', 'attachment_added', 'attachment_removed', 'body_text_added', 'preview_opened'] as const) {
    assert.ok(kinds.includes(k), `missing change ${k}`);
  }
  const removed = board('draft').keyframes.find((f) => f.changes.some((c) => c.kind === 'attachment_removed'));
  assert.equal(removed?.changes.find((c) => c.kind === 'attachment_removed')?.label, 'Image attachment removed');
  const typed = board('draft').keyframes.find((f) => f.changes.some((c) => c.kind === 'body_text_added'));
  assert.match(typed?.changes.find((c) => c.kind === 'body_text_added')?.label ?? '', /delivery address.*typed into the email/i);
});

test('each keyframe carries the normalised vision facts, with its kind first', () => {
  const frames = board('draft').keyframes;
  const order = frames.find((f) => f.surface === 'order_view');
  assert.deepEqual(order?.facts.map((r) => r.key), ['kind', 'customerRef', 'orderId', 'deliveryAddress', 'deliveryWindow']);
  assert.equal(order?.facts.find((r) => r.key === 'customerRef')?.value, 'customer_07');
  const email = frames.find((f) => f.changes.some((c) => c.kind === 'attachment_added'));
  assert.match(email?.facts.find((r) => r.key === 'attachments')?.value ?? '', /^image/);
  assert.equal(email?.facts[0]?.value, 'email_draft');
});

test('ticket observations become ticket keyframes', () => {
  const base = { schemaVersion: 1 as const, sessionId: 's', source: 'vision' as const, frameId: 'f', sourceRevision: null, entityRef: 'customer_07' };
  const obs: ScreenObservation[] = [
    { ...base, id: 't1', sequence: 1, timestampMs: 1000, evidenceIds: ['e1'], kind: 'ticket', facts: { ticketId: 'TCK-1', orderId: 'ORD-2041', customerRef: 'customer_07', status: 'open', summary: '' } },
    { ...base, id: 't2', sequence: 2, timestampMs: 3000, evidenceIds: ['e2'], kind: 'ticket', facts: { ticketId: 'TCK-1', orderId: 'ORD-2041', customerRef: 'customer_07', status: 'done', summary: 'details sent' } },
  ];
  const frames = buildKeyframes(obs);
  assert.deepEqual(frames.map((f) => f.changes.map((c) => c.kind)), [['ticket_opened'], ['ticket_note', 'ticket_done']]);
  assert.equal(frames[1]?.facts.find((r) => r.key === 'status')?.value, 'done');
});

test('counts: steps, judgment calls, guardrails and open gaps', () => {
  const draft = board('draft');
  assert.deepEqual(draft.counts, { steps: 6, judgmentCalls: 3, guardrails: 2, openGaps: 4 });
  const confirmed = board('confirmed');
  assert.deepEqual(confirmed.counts, { steps: 6, judgmentCalls: 3, guardrails: 3, openGaps: 0 });
  assert.equal(confirmed.version, 2);
  assert.equal(confirmed.confirmed, true);
  assert.equal(draft.confirmed, false);
  assert.ok(draft.pipeline.observations >= draft.keyframes.length);
  assert.equal(draft.pipeline.mapItems, 8);
});

test('step cards are in time order and link to their keyframes and the expert quote', () => {
  const b = board('confirmed');
  const times = b.steps.map((s) => s.atMs);
  assert.deepEqual(times, [...times].sort((a, b2) => a - b2));
  const removal = b.steps.find((s) => s.action === 'Removed the image attachment');
  assert.ok(removal);
  assert.equal(removal.judgment, true);
  assert.equal(removal.status, 'confirmed');
  assert.match(removal.quote ?? '', /phone blocks pictures/);
  assert.equal(removal.quoteAtMs, 12_900);
  assert.equal(removal.scope, 'Only customer_07');
  assert.deepEqual(removal.requiredFields.map((f) => f.label), ['order number', 'delivery address', 'delivery window']);
  assert.ok(removal.frameIds.length > 0);
  assert.ok(removal.moment);
  assert.equal(removal.moment.evidenceId, 'ev-f-0005');
});

test('every confirmed step and guardrail has a quote and a screen moment', () => {
  const b = board('confirmed');
  for (const c of [...b.steps, ...b.guardrails]) {
    if (c.status !== 'confirmed' || (c.kind === 'step' && !c.judgment)) continue;
    assert.ok(c.quote, `${c.id} has a quote`);
    assert.ok(c.moment, `${c.id} has a screen moment`);
    assert.ok(c.frameIds.length > 0, `${c.id} links to a keyframe`);
  }
});

test('draft statuses map to provisional and draft; assumed facts are marked', () => {
  const s = mutable('draft');
  const g1 = s.map.guardrails.find((g) => g.id === 'g1') as unknown as { assumedFacts: string[] };
  g1.assumedFacts = ['deliveryWindow'];
  const b = buildStoryboard({ map: s.map, observations: s.observations, evidence: s.evidence, gaps: s.gaps });
  assert.equal(b.steps[0]?.status, 'draft');
  assert.equal(b.steps.find((x) => x.judgment)?.status, 'provisional');
  const card = b.guardrails.find((g) => g.id === 'g1');
  assert.deepEqual(card?.requiredFields, [
    { label: 'delivery address', assumed: false },
    { label: 'delivery window', assumed: true },
  ]);
  assert.equal(card?.scope, 'Only customer_07 (assumed from the screen)');
});

test('a guardrail or step without evidence or quote cannot be confirmed and carries the validator message', () => {
  const b = board('confirmed');
  const habit = b.guardrails.find((g) => g.id === 'g3');
  assert.equal(habit?.confirmable, false);
  assert.equal(habit?.blocker, 'guardrail g3 lacks evidence');
  assert.equal(habit?.unexplained, true);

  const s = mutable('draft');
  const step = s.map.steps.find((x) => x.id === 'step-5') as unknown as { decision: { quote: string | null; evidenceIds: string[] } };
  step.decision.quote = null;
  step.decision.evidenceIds = [];
  const b2 = buildStoryboard({ map: s.map, observations: s.observations, evidence: s.evidence });
  const card = b2.steps.find((x) => x.id === 'step-5');
  assert.equal(card?.confirmable, false);
  assert.equal(card?.blocker, 'step step-5 lacks evidence and quote');
  const fine = b2.steps.find((x) => x.id === 'step-4');
  assert.equal(fine?.confirmable, true);
  assert.equal(fine?.blocker, null);
});

test('blockers handed in by Review win over the derived rule', () => {
  const s = snapshot('draft');
  const b = buildStoryboard({ map: s.map, observations: s.observations, blockers: [{ kind: 'guardrail', id: 'g1', missing: ['quote'] }] });
  assert.equal(b.guardrails.find((g) => g.id === 'g1')?.blocker, 'guardrail g1 lacks quote');
});

test('gaps link to the frames they ask about; only the first is the Clipa target', () => {
  const b = board('draft');
  assert.equal(b.gaps.length, 4);
  assert.deepEqual(b.gaps.map((g) => g.first), [true, false, false, false]);
  for (const g of b.gaps) assert.ok(g.frameIds.length > 0, `${g.id} links to a frame`);
  const scope = b.gaps.find((g) => g.topic === 'scope');
  assert.equal(scope?.topicLabel, 'Who it applies to');
  const withGap = b.keyframes.filter((f) => f.gapIds.length > 0);
  assert.ok(withGap.length > 0);
});

test('synthetic frames: an SVG for every vision observation, marked synthetic by the resolver', async () => {
  const s = snapshot('draft');
  for (const o of s.observations) {
    const url = syntheticFrameUrl(o);
    if (o.kind === 'input_activity') assert.equal(url, null);
    else assert.match(url ?? '', /^data:image\/svg\+xml/);
  }
  assert.match(decodeURIComponent(syntheticFrameUrl(s.observations[0] as ScreenObservation) ?? ''), /Synthetic sketch/);
  const resolve = syntheticEvidenceResolver(s.observations, s.evidence);
  const r = await resolve('ev-f-0005');
  assert.equal(r?.synthetic, true);
  assert.equal(r?.startMs, 11_000);
  assert.equal(await resolve('no-such-id'), null);
});
