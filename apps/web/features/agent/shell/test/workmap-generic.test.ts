// The conductor's generic Work Map on the Review board, and keyframes from generic screen_activity observations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenObservation } from '@apprentice/contracts';
import { fromGenericMap } from '../../workmap/generic.ts';
import { buildKeyframes, buildStoryboard } from '../../workmap/model.ts';
import { ConductorFace } from '../conductor/face.ts';
import type { FaceHost } from '../conductor/face.ts';
import type { ClientEvent, Target } from '../conductor/protocol.ts';
import { createConductorStore } from '../conductor/store.ts';
import { boxRect, resolveTarget, uiSelectors } from '../conductor/targets.ts';
import { FakeTimers } from './helpers.ts';

/** A generic screen observation (stream A's screen_activity kind), which the contracts union does not name yet. */
function activity(id: string, t: number, facts: Record<string, unknown>, evidenceIds: string[] = [`ev-${id}`]): ScreenObservation {
  return {
    schemaVersion: 1, id, sequence: t, timestampMs: t, source: 'vision', frameId: `f-${id}`, sourceRevision: null, kind: 'screen_activity',
    entityRef: null, evidenceIds, facts,
  } as unknown as ScreenObservation;
}

const OBS = [
  activity('o1', 1000, { app: 'Sheets', surface: 'invoice list', summary: 'Invoice 4471 is open', change: null }),
  activity('o2', 2000, { app: 'Sheets', surface: 'invoice list', summary: 'Invoice 4471 is open', change: null }),
  activity('o3', 3000, { app: 'Sheets', surface: 'invoice list', summary: 'Cost center changed', change: 'Cost center 4711 changed to 0400', pendingAction: 'Save' }),
  activity('o4', 4000, { app: 'Mail', surface: 'compose', summary: 'A reply is drafted', change: null }),
];

test('screen_activity observations become keyframes when the app, the surface or the change moves (no throw)', () => {
  const frames = buildKeyframes(OBS);
  assert.deepEqual(frames.map((f) => f.id), ['o1', 'o3', 'o4']);
  assert.equal(frames[0]?.surface, 'screen');
  assert.equal(frames[0]?.surfaceLabel, 'Sheets');
  assert.equal(frames[1]?.changes[0]?.label, 'Cost center 4711 changed to 0400');
  assert.ok(frames[1]?.facts.some((r) => r.key === 'pendingAction' && r.value === 'Save'));
  assert.equal(frames[2]?.changes[0]?.label, 'Mail: compose opened');
});

const GENERIC = {
  steps: [
    { id: 's1', kind: 'action', goal: 'Find the invoice', action: 'Opened invoice 4471', decision: null, evidenceIds: ['o1'] },
    { id: 's2', kind: 'judgment', goal: 'Book it right', action: 'Moved it to cost center 0400', decision: { summary: 'Capex, not opex', reason: 'equipment over 5,000 is always capex', quote: 'Equipment over five thousand is always capex.', quoteAtMs: 3500 }, evidenceIds: ['o3'] },
  ],
  guardrails: [
    { id: 'g1', condition: 'An invoice comes from the Czech subsidiary', requiredAction: 'Send it for a second approval', reason: null, quote: null, quoteAtMs: null, escalateTo: 'Controller', exceptions: [], evidenceIds: ['o3'] },
  ],
  gaps: [{ question: 'Is the December hold for every supplier?', targetId: 'g1', evidenceIds: ['o4'], regionIds: [] }],
  teachBack: 'You open the invoice, book equipment as capex and send Czech invoices for a second approval.',
  comments: [{ targetId: 's2', text: 'Check the 5,000 limit', atMs: 4000 }],
};

test('fromGenericMap gives the board a WorkMap, gaps with the conductor ids and evidence ids of the observations', () => {
  const board = fromGenericMap(GENERIC, { version: 4, confirmed: false, observations: OBS });
  assert.ok(board);
  assert.equal(board.map.version, 4);
  assert.equal(board.map.steps.length, 2);
  assert.deepEqual(board.map.steps[1]?.evidenceIds, ['ev-o3']);
  assert.equal(board.map.steps[1]?.status, 'inferred');
  assert.equal(board.map.guardrails[0]?.unexplained, true, 'no reason in the expert\'s words: never enforced');
  assert.deepEqual(board.gaps.map((g) => [g.id, g.targetId]), [['gap-1', 'g1']]);
  assert.equal(board.comments.length, 1);
  assert.ok(board.teachBack?.startsWith('You open the invoice'));
  const story = buildStoryboard({ map: board.map, observations: OBS, gaps: board.gaps });
  assert.equal(story.counts.steps, 2);
  assert.equal(story.counts.judgmentCalls, 1);
  assert.equal(story.guardrails[0]?.scope, 'Whenever the condition holds');
  assert.deepEqual(story.steps[1]?.frameIds, ['o3'], 'the step links to its keyframe');
  assert.equal(fromGenericMap('nope'), null);
  const confirmed = fromGenericMap(GENERIC, { confirmed: true });
  assert.equal(confirmed?.map.steps[0]?.status, 'confirmed');
});

function faceRig(options: { voice?: boolean; busy?: boolean; now?: number | null } = {}) {
  const timers = new FakeTimers();
  const store = createConductorStore();
  const sent: ClientEvent[] = [];
  const spoken: string[] = [];
  const pointed: Array<Target | null> = [];
  const contexts: string[] = [];
  const host: FaceHost = {
    speak: (text) => { if (options.voice === false) return false; spoken.push(text); return true; },
    context: (text) => { contexts.push(text); },
    personBusy: () => options.busy === true,
    bubble: () => {},
    point: (t) => { pointed.push(t); },
    pose: () => {},
    log: () => {},
    sessionNow: () => (options.now === undefined ? 0 : options.now),
    now: () => timers.now,
    send: (e) => { sent.push(e); },
    timers,
  };
  const face = new ConductorFace(host, store);
  return { face, store, sent, spoken, pointed, contexts, timers };
}

const env = (seq: number, c: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  seq, cueId: `c${seq}`, atMs: 0, mode: 'learn' as const, persona: 'expert' as const, for: 'all' as const, expiresAtMs: null, cue: c, ...extra,
}) as unknown as Parameters<ConductorFace['onCue']>[0];

test('face: an expired cue is skipped, a cue without voice is shown, a never-started speech is skipped after the timeout', () => {
  const r = faceRig({ now: 10_000 });
  r.face.onCue(env(1, { type: 'say', text: 'Too late' }, { expiresAtMs: 5000 }));
  assert.deepEqual(r.sent, [{ type: 'cue_done', cueId: 'c1', outcome: 'skipped' }]);
  assert.deepEqual(r.spoken, []);
  const quiet = faceRig({ voice: false });
  quiet.face.onCue(env(2, { type: 'ask', questionId: 'q', text: 'Why?', topic: 'reason', regions: [], evidenceIds: [] }));
  assert.deepEqual(quiet.sent, [{ type: 'cue_done', cueId: 'c2', outcome: 'shown' }]);
  assert.equal(quiet.store.getState().line?.text, 'Why?');
  const slow = faceRig();
  slow.face.onCue(env(3, { type: 'warn', guardrailId: 'g1', text: 'Stop: second approval first.', regions: [{ regionId: 'r1', label: 'Approve', box: [0.1, 0.1, 0.1, 0.1], evidenceId: null }], evidenceIds: [] }));
  assert.equal(slow.store.getState().pose, 'warn');
  assert.equal(slow.pointed.at(-1)?.kind, 'region');
  slow.timers.advance(12_000);
  assert.deepEqual(slow.sent, [{ type: 'cue_done', cueId: 'c3', outcome: 'skipped' }]);
});

test('face: a newer spoken cue interrupts the one still being said', () => {
  const r = faceRig();
  r.face.onCue(env(1, { type: 'say', text: 'First' }));
  r.face.onAgentSpeaking(true);
  r.face.onCue(env(2, { type: 'say', text: 'Second' }));
  assert.deepEqual(r.sent, [{ type: 'cue_done', cueId: 'c1', outcome: 'interrupted' }]);
  r.face.onAgentSpeaking(true);
  r.face.onAgentSpeaking(false);
  assert.deepEqual(r.sent.at(-1), { type: 'cue_done', cueId: 'c2', outcome: 'spoken' });
});

test('targets: UI selectors with mode and fallbacks; region boxes map onto the preview canvas', () => {
  assert.deepEqual(uiSelectors({ kind: 'ui', name: 'mode_tab', mode: 'review' }), [
    '[data-clipa-target="mode_tab"][data-mode="review"]', '[data-clipa-target="mode_tab"]', '#as-tab-review',
  ]);
  assert.deepEqual(boxRect({ left: 100, top: 50, width: 400, height: 200 }, [0.5, 0.25, 0.25, 0.5]), { left: 300, top: 100, width: 100, height: 100 });
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) };
  const root = { querySelector: (s: string) => (s.includes('canvas') ? canvas : null) };
  assert.deepEqual(resolveTarget(root, { kind: 'region', regionId: 'r1', label: 'x', box: [0.5, 0.5, 0.5, 0.5], evidenceId: null }), { left: 110, top: 70, width: 100, height: 50 });
  assert.equal(resolveTarget(root, { kind: 'ui', name: 'share' }), null);
});
