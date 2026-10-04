// The journey rail (TASK-3.47): stage states from the shell state, keys, Clipa's caption, and the defensive read of the
// Clipa store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClipaView } from '../clipa/view.ts';
import { railCaption, railStages, stageDone, stageForKey, stageOfPhase, STAGES, statusWord } from '../journey/rail.ts';
import type { RailInput } from '../journey/rail.ts';
import { initialState } from '../state/reducer.ts';
import type { FeedItem, Mode, SessionInfo, ShellState } from '../state/types.ts';

function session(mode: Mode): SessionInfo {
  return { id: 's-1', mode, epochMs: 0, legacyRoutes: false, deadlineMs: 600_000, clockSkewMs: null, conversationId: null };
}

function answered(): FeedItem {
  return {
    id: 'q1', decision: 'ASK_NOW', topic: 'reason', text: 'Why text?', status: 'answered', note: null, whyNow: 'pause',
    evidenceIds: [], atMs: 1, answer: { text: 'She asked for it', atMs: 2 },
  } as FeedItem;
}

function state(patch: Partial<ShellState> = {}): ShellState {
  return { ...initialState(), ...patch };
}

const statuses = (s: RailInput, suggested: Mode | null = null): string[] => railStages(s, suggested).map((st) => st.status);

test('the stages are Show, Reflect and Pass it on over learn, review and teach', () => {
  const stages = railStages(state());
  assert.deepEqual(stages.map((s) => [s.mode, s.name, s.step]), [['learn', 'Show', 1], ['review', 'Reflect', 2], ['teach', 'Pass it on', 3]]);
  assert.equal(STAGES.learn.hint, 'work as usual, I ask at pauses');
  assert.equal(STAGES.review.hint, 'talk to me to fix the map');
  assert.equal(STAGES.teach.hint, 'a new hire tries, I step in before mistakes');
});

test('a fresh shell: Show is next and selected, the other stages are open, no wire is lit', () => {
  const stages = railStages(state());
  assert.deepEqual(stages.map((s) => s.status), ['next', 'open', 'open']);
  assert.deepEqual(stages.map((s) => s.selected), [true, false, false]);
  assert.deepEqual(stages.map((s) => s.wire), ['dim', 'dim', null]);
});

test('a live session marks its stage active, its wire live, and the stage after it next', () => {
  const s = state({ phase: 'live', session: session('learn') });
  assert.deepEqual(statuses(s), ['active', 'next', 'open']);
  assert.deepEqual(railStages(s).map((st) => st.wire), ['live', 'dim', null]);
  assert.deepEqual(statuses(state({ phase: 'starting', session: session('teach') })), ['open', 'open', 'active'], 'nothing comes after the last stage');
});

test('Show is done after an answered question, a draft step or an ended Learn session; then Reflect is next', () => {
  const step = { id: 'st1' } as unknown as ShellState['draftMap']['steps'][number];
  for (const s of [
    state({ feed: [answered()] }),
    state({ draftMap: { steps: [step] } }),
    state({ phase: 'ended', session: session('learn') }),
  ]) {
    assert.equal(stageDone(s, 'learn'), true);
    assert.deepEqual(statuses(s), ['done', 'next', 'open']);
    assert.equal(railStages(s)[0]?.wire, 'lit');
  }
});

test('Reflect is done only with a confirmed map or teach-back; Pass it on with a mastery summary', () => {
  const base = initialState();
  const confirmed = state({ feed: [answered()], review: { ...base.review, teachBack: { ...base.review.teachBack, text: 'You send text', status: 'confirmed' } } });
  assert.deepEqual(statuses(confirmed), ['done', 'done', 'next']);
  const corrected = state({ review: { ...base.review, teachBack: { ...base.review.teachBack, text: 'x', status: 'corrected' } } });
  assert.equal(stageDone(corrected, 'review'), false, 'a correction is not a confirmation');
  assert.equal(stageDone(state({ phase: 'ended', session: session('review') }), 'review'), false, 'ending Reflect early does not finish it');
  const mastered = state({ teach: { ...base.teach, mastery: { mastered: ['T1'], practise: [] } } });
  assert.equal(stageDone(mastered, 'teach'), true);
  const all = state({ ...confirmed, teach: mastered.teach });
  assert.deepEqual(statuses(all), ['done', 'done', 'done']);
});

test('a running stage is never also done, and selection follows the mode', () => {
  const s = state({ mode: 'review', phase: 'live', session: session('learn'), feed: [answered()] });
  const stages = railStages(s);
  assert.deepEqual(stages.map((st) => st.status), ['active', 'next', 'open']);
  assert.deepEqual(stages.map((st) => st.selected), [false, true, false]);
});

test('the stage Clipa suggests wins the next mark unless it runs or is done', () => {
  assert.deepEqual(statuses(state(), 'teach'), ['open', 'open', 'next']);
  assert.deepEqual(statuses(state({ phase: 'live', session: session('teach') }), 'teach'), ['open', 'open', 'active']);
  assert.deepEqual(statuses(state({ feed: [answered()] }), 'learn'), ['done', 'next', 'open'], 'a done stage is not suggested');
  assert.equal(stageOfPhase('reflect'), 'review');
  assert.equal(stageOfPhase('Pass it on'), 'teach');
  assert.equal(stageOfPhase('share'), 'learn');
  assert.equal(stageOfPhase('summary'), 'teach');
  assert.equal(stageOfPhase('nonsense'), null);
  assert.equal(stageOfPhase(42), null);
});

test('arrow keys wrap around the rail, Home and End jump, other keys do nothing', () => {
  assert.equal(stageForKey('ArrowRight', 'learn'), 'review');
  assert.equal(stageForKey('ArrowRight', 'teach'), 'learn');
  assert.equal(stageForKey('ArrowLeft', 'learn'), 'teach');
  assert.equal(stageForKey('Home', 'teach'), 'learn');
  assert.equal(stageForKey('End', 'learn'), 'teach');
  assert.equal(stageForKey('ArrowDown', 'learn'), null);
  assert.equal(stageForKey('a', 'learn'), null);
  assert.equal(statusWord('active'), 'live now');
});

test('the caption under the rail is Clipa\'s line, else the guide text, else the stage hint', () => {
  assert.equal(railCaption('  Why text instead of the image? ', 'Share your screen', 'learn'), 'Why text instead of the image?');
  assert.equal(railCaption('', 'Share your screen', 'learn'), 'Share your screen');
  assert.equal(railCaption('', null, 'review'), STAGES.review.line);
  assert.match(STAGES.learn.line, /ask why at the pauses/);
});

test('the Clipa store is read defensively: unknown states and missing fields fall back', () => {
  assert.deepEqual(readClipaView({ state: 'listening', bubble: 'Why?', target: null }), { state: 'listening', bubble: 'Why?', guide: null });
  assert.deepEqual(readClipaView({ state: 'dancing' }), { state: 'idle', bubble: '', guide: null });
  assert.deepEqual(readClipaView(null), { state: 'idle', bubble: '', guide: null });
  assert.deepEqual(
    readClipaView({ state: 'speaking', bubble: '', guide: { phase: 'review', step: 'review_board', text: 'Look at the map', target: { kind: 'ui' } } }),
    { state: 'speaking', bubble: '', guide: { phase: 'review', step: 'review_board', text: 'Look at the map' } },
  );
  assert.deepEqual(readClipaView({ guide: { phase: 3, text: '' } }).guide, { phase: null, step: null, text: null });
});
