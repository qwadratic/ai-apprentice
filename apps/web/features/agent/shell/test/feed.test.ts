// The live feed's logic (TASK-3.51): what goes in, the order, the fold into "+N earlier", the relative time and the map ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaidItem } from '../conductor/store.ts';
import {
  FEED_EXPANDED_MAX, FEED_KINDS, FEED_LABEL, FEED_VISIBLE, advanceLedger, collectFeed, digestDraftMap, digestGenericMap,
  emptyLedger, foldFeed, isFresh, mapChangeEntries, relativeTime,
} from '../feed/model.ts';
import type { FeedEntry, FeedSources } from '../feed/model.ts';
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import type { FeedItem, LogLine, ObservationRow } from '../state/types.ts';

const EPOCH = 1_000_000;
const NOW = EPOCH + 120_000;

function obs(id: string, timestampMs: number, summary: string, kind = 'screen_activity', synthetic = false): ObservationRow {
  return { id, sequence: 0, timestampMs, kind, source: 'vision', synthetic, summary, evidenceIds: [] };
}
function said(cueId: string, kind: SaidItem['kind'], text: string, atMs: number, outcome: SaidItem['outcome'] = 'spoken'): SaidItem {
  return { cueId, kind, text, atMs, outcome };
}
function user(id: number, t: number, text: string): LogLine {
  return { id, t, dir: 'recv', type: 'USER', text };
}
function sources(patch: Partial<FeedSources> = {}): FeedSources {
  return {
    session: { epochMs: EPOCH, deadlineMs: EPOCH + SESSION_LIMIT_MS },
    observations: [], questions: [], said: [], events: [], checkpoint: null, mapChanges: [], conductorLeads: true,
    ...patch,
  };
}
const kinds = (entries: readonly FeedEntry[]): string[] => entries.map((e) => e.kind);

test('no session, no feed', () => {
  assert.deepEqual(collectFeed(sources({ session: null, observations: [obs('o1', 1000, 'Order 7 open')] }), NOW), []);
});

test('one stream, newest first: screen, question, answer, warning, map change', () => {
  const entries = collectFeed(sources({
    observations: [obs('o1', 10_000, 'Order table open'), obs('o2', 40_000, 'Email draft: 1 attachment')],
    said: [said('c1', 'ask', 'Why the text instead of the image?', 50_000), said('c2', 'warn', 'Customer 07 wants text.', 90_000)],
    events: [user(1, EPOCH + 60_000, 'She asked for text, the image does not open on her phone.'), { id: 2, t: EPOCH + 61_000, dir: 'recv', type: 'AGENT', text: 'Thanks.' }],
    mapChanges: [{ id: 'map:1:rule-g1', kind: 'rule', text: 'Customer 07: address as text', atMs: EPOCH + 70_000 }],
  }), NOW);
  assert.deepEqual(kinds(entries), ['warn', 'rule', 'answer', 'ask', 'screen', 'screen']);
  assert.equal(entries[2]!.text, 'She asked for text, the image does not open on her phone.');
  assert.ok(!entries.some((e) => e.text === 'Thanks.'), 'Clipa\'s own transcript is not an answer');
});

test('at the same moment the later-made item comes first', () => {
  const entries = collectFeed(sources({
    observations: [obs('o1', 5000, 'Ticket 12 open')],
    said: [said('c1', 'say', 'Got it.', 5000)],
  }), NOW);
  assert.deepEqual(kinds(entries), ['say', 'screen']);
});

test('typing is not a change, and the same screen line in a row folds into one item with a count', () => {
  const entries = collectFeed(sources({
    observations: [
      obs('o1', 1000, 'Email draft open'),
      obs('o2', 2000, 'Input on email: typing', 'input_activity'),
      obs('o3', 3000, 'Email draft open'),
      obs('o4', 4000, 'Email draft open'),
      obs('o5', 5000, 'Ticket open'),
      obs('o6', 6000, 'Email draft open'),
    ],
  }), NOW);
  assert.deepEqual(entries.map((e) => [e.id, e.repeat ?? 1]), [['obs:o6', 1], ['obs:o5', 1], ['obs:o1', 3]]);
  assert.equal(entries[2]!.atMs, EPOCH + 4000, 'the folded item carries the newest time');
});

test('lines that never reached the person stay out; the brain path uses its own questions and answers', () => {
  const skipped = collectFeed(sources({ said: [said('c1', 'ask', 'Too late', 1000, 'skipped'), said('c2', 'ask', 'Asked', 2000, 'pending')] }), NOW);
  assert.deepEqual(skipped.map((e) => e.text), ['Asked']);

  const q = (id: string, status: FeedItem['status'], atMs: number, answer: FeedItem['answer'] = null): FeedItem => ({
    id, decision: 'ASK_NOW', topic: 't', text: `question ${id}`, status, note: null, whyNow: '', evidenceIds: [], atMs, answer,
  });
  const brain = collectFeed(sources({
    conductorLeads: false,
    questions: [q('q1', 'answered', 1000, { text: 'Because she asked.', atMs: 4000 }), q('q2', 'deferred', 5000), q('q3', 'unspoken', 6000), q('q4', 'said', 7000)],
    said: [said('c1', 'ask', 'conductor line', 8000)],
    events: [user(1, EPOCH + 9000, 'transcript line')],
  }), NOW);
  assert.deepEqual(brain.map((e) => [e.kind, e.text, e.label ?? null]), [
    ['say', 'question q4', null],
    ['answer', 'Because she asked.', 'Answer captured'],
    ['ask', 'question q1', null],
  ]);
});

test('the checkpoint before Send is a warning or a check', () => {
  const card = (status: 'clear' | 'warn' | 'unknown') => ({ checkpointId: `cp-${status}`, status, message: `m-${status}`, evidenceIds: [], atMs: 1000, deliveryError: null });
  assert.deepEqual(collectFeed(sources({ checkpoint: card('warn') }), NOW).map((e) => [e.kind, e.label, e.tone]), [['warn', 'Stop before Send', 'warn']]);
  assert.deepEqual(collectFeed(sources({ checkpoint: card('clear') }), NOW).map((e) => [e.kind, e.label, e.tone]), [['check', 'Clear to send', 'ok']]);
  assert.deepEqual(collectFeed(sources({ checkpoint: card('unknown') }), NOW).map((e) => [e.kind, e.label]), [['check', 'Not sure']]);
});

test('the feed belongs to the running stage: items from before its Start stay out; nothing is in the future', () => {
  // A later stage of the same journey: the session epoch is the journey's, the stage started 100 s in.
  const stageStart = EPOCH + 100_000;
  const entries = collectFeed(sources({
    session: { epochMs: EPOCH, deadlineMs: stageStart + SESSION_LIMIT_MS },
    observations: [obs('old', 20_000, 'from Show'), obs('new', 105_000, 'from this stage'), obs('ahead', 500_000, 'clock ahead')],
  }), NOW);
  assert.deepEqual(entries.map((e) => e.text), ['clock ahead', 'from this stage']);
  assert.equal(entries[0]!.atMs, NOW, 'a time ahead of the page clock is clamped to now');
});

test('the newest few show; the rest fold into "+N earlier" and expand on demand, capped', () => {
  const many = (n: number): FeedEntry[] => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: 'screen' as const, text: `t${i}`, atMs: n - i }));
  const folded = foldFeed(many(8), false);
  assert.equal(folded.shown.length, FEED_VISIBLE);
  assert.equal(folded.earlier, 3);
  assert.equal(folded.canFold, false);
  assert.deepEqual(folded.shown.map((e) => e.id), ['e0', 'e1', 'e2', 'e3', 'e4'], 'the newest stay on top');

  const open = foldFeed(many(8), true);
  assert.equal(open.shown.length, 8);
  assert.equal(open.earlier, 0);
  assert.equal(open.canFold, true);

  assert.equal(foldFeed(many(80), true).shown.length, FEED_EXPANDED_MAX);
  assert.deepEqual(foldFeed(many(4), true), { shown: many(4), earlier: 0, canFold: false }, 'nothing to fold');
  assert.equal(foldFeed(many(8), false, 3).earlier, 5, 'a smaller window (Reflect)');
});

test('relative time is short and never negative', () => {
  assert.equal(relativeTime(10_000, 10_000), 'now');
  assert.equal(relativeTime(10_000, 5_100), 'now');
  assert.equal(relativeTime(10_000, 20_000), 'now');
  assert.equal(relativeTime(22_000, 10_000), '12 s');
  assert.equal(relativeTime(69_000, 10_000), '59 s');
  assert.equal(relativeTime(70_000, 10_000), '1 min');
  assert.equal(relativeTime(10_000 + 3_600_000, 10_000), '1 h');
  assert.equal(isFresh({ id: 'a', kind: 'ask', text: '', atMs: 1000 }, 2000), true);
  assert.equal(isFresh({ id: 'a', kind: 'ask', text: '', atMs: 1000 }, 4000), false);
});

test('every kind has a label', () => {
  for (const kind of FEED_KINDS) assert.ok(FEED_LABEL[kind].length > 0, kind);
});

test('the conductor map and the draft map read as digests', () => {
  assert.equal(digestGenericMap(null), null);
  assert.equal(digestGenericMap({ version: 1, confirmed: false, map: { steps: [], guardrails: [] } }), null, 'an empty map is no map');
  const d = digestGenericMap({
    version: 2,
    confirmed: true,
    map: {
      steps: [{ id: 's1', goal: 'Copy the address', action: 'paste' }, { id: 's2', action: 'Send' }, 'junk'],
      guardrails: [{ id: 'g1', condition: 'Customer 07', requiredAction: 'send the address as text' }],
    },
  });
  assert.deepEqual(d?.steps, [{ id: 's1', title: 'Copy the address' }, { id: 's2', title: 'Send' }]);
  assert.deepEqual(d?.rules, [{ id: 'g1', text: 'Customer 07: send the address as text' }]);
  assert.equal(d?.confirmed, true);

  const draft = digestDraftMap({
    steps: [{ id: 'a', title: 'Open order', kind: 'step', decision: null, reason: null, guardrails: [{ id: 'g', text: 'Text for 07', evidenceIds: [] }], evidenceIds: [], atMs: null }],
    guardrails: [{ id: 'g', text: 'Text for 07', evidenceIds: [] }, { id: 'h', text: 'Ask when unknown', evidenceIds: [] }],
  });
  assert.deepEqual(draft?.rules.map((r) => r.id), ['g', 'h'], 'a guardrail listed twice counts once');
  assert.equal(digestDraftMap({ steps: [] }), null);
});

test('map changes: ready once, then rules learned, steps added, changes, removals and the confirmation', () => {
  const map = (steps: Array<[string, string]>, rules: Array<[string, string]>, confirmed = false) =>
    digestGenericMap({ version: 1, confirmed, map: { steps: steps.map(([id, goal]) => ({ id, goal })), guardrails: rules.map(([id, condition]) => ({ id, condition })) } })!;

  const first = map([['s1', 'Open order'], ['s2', 'Write email']], [['g1', 'Text for 07']]);
  assert.deepEqual(mapChangeEntries(null, first, 5, 1).map((e) => [e.kind, e.text]), [['map', 'Ready: 2 steps, 1 rule.']]);

  const second = map([['s1', 'Open the order'], ['s2', 'Write email'], ['s3', 'Close ticket']], [['g1', 'Text for 07'], ['g2', 'Ask when unknown']]);
  assert.deepEqual(mapChangeEntries(first, second, 6, 2).map((e) => [e.kind, e.label ?? null, e.text]), [
    ['rule', null, 'Ask when unknown'],
    ['map', 'Step added', 'Close ticket'],
    ['map', 'Changed', 'Open the order'],
  ]);

  const third = map([['s1', 'Open the order'], ['s3', 'Close ticket']], [['g1', 'Text for 07'], ['g2', 'Ask when unknown']], true);
  assert.deepEqual(mapChangeEntries(second, third, 7, 3).map((e) => [e.label ?? null, e.text]), [
    ['Removed', 'Write email'],
    ['Confirmed', 'You confirmed the Work Map.'],
  ]);

  const many = map([['s1', 'Open order'], ['s2', 'Write email']], [['g1', 'Text for 07'], ['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]);
  assert.deepEqual(mapChangeEntries(first, many, 8, 4).map((e) => [e.kind, e.text]), [['rule', '4 new rules in the map.']]);
});

test('the ledger keeps map changes newest first, ignores repeats and starts over after an empty map', () => {
  const map = (rules: string[]) => digestGenericMap({ version: 1, confirmed: false, map: { steps: [{ id: 's1', goal: 'Open order' }], guardrails: rules.map((id) => ({ id, condition: id })) } });
  let ledger = emptyLedger();
  ledger = advanceLedger(ledger, map(['g1']), 100);
  const same = advanceLedger(ledger, map(['g1']), 200);
  assert.equal(same, ledger, 'the same map changes nothing');
  ledger = advanceLedger(ledger, map(['g1', 'g2']), 300);
  assert.deepEqual(ledger.entries.map((e) => [e.kind, e.text, e.atMs]), [['rule', 'g2', 300], ['map', 'Ready: 1 step, 1 rule.', 100]]);
  assert.equal(new Set(ledger.entries.map((e) => e.id)).size, ledger.entries.length, 'ids are unique');

  const cleared = advanceLedger(ledger, null, 400);
  assert.equal(cleared.prev, null);
  assert.equal(cleared.entries.length, 2, 'the items stay');
  const again = advanceLedger(cleared, map(['g9']), 500);
  assert.equal(again.entries[0]!.text, 'Ready: 1 step, 1 rule.');
});
