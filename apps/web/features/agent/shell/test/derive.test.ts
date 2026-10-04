import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action } from '../state/reducer.ts';
import { initialState, reduce } from '../state/reducer.ts';
import { deriveClipaState, recordChip, screenChip, sessionChip, statusChips, summarizeLatency, voiceChip } from '../state/derive.ts';
import type { DecisionEntry, SessionInfo, ShellState } from '../state/types.ts';

const session: SessionInfo = {
  id: 's-1', mode: 'learn', epochMs: 0, legacyRoutes: false, deadlineMs: 600_000, clockSkewMs: 0, conversationId: null,
};
const run = (state: ShellState, ...actions: Action[]): ShellState => actions.reduce(reduce, state);
const live = () => run(initialState(), { type: 'SESSION_STARTING', mode: 'learn' }, { type: 'SESSION_READY', session });
const card = (status: 'clear' | 'warn' | 'unknown') => ({ checkpointId: 'cp', status, message: 'm', evidenceIds: [], atMs: 0, deliveryError: null });

test('Clipa is idle before anything starts', () => {
  assert.equal(deriveClipaState(initialState()), 'idle');
  assert.equal(deriveClipaState(live()), 'idle');
});

test('Clipa follows the voice: listening, thinking, speaking', () => {
  const listening = run(live(), { type: 'VOICE_PHASE', phase: 'listening' });
  assert.equal(deriveClipaState(listening), 'listening');
  assert.equal(deriveClipaState(reduce(listening, { type: 'VOICE_THINKING', thinking: true })), 'thinking');
  const speaking = run(listening, { type: 'VOICE_THINKING', thinking: true }, { type: 'VOICE_PHASE', phase: 'speaking' });
  assert.equal(deriveClipaState(speaking), 'speaking');
});

test('off the record wins over everything', () => {
  const busy = run(live(), { type: 'VOICE_PHASE', phase: 'speaking' }, { type: 'CHECKPOINT_RESULT', card: card('warn') }, { type: 'REPLAY_OPEN', evidenceId: 'ev' });
  assert.equal(deriveClipaState(busy), 'pointing', 'replaying a moment outranks the checkpoint warning and the speech');
  assert.equal(deriveClipaState(reduce(busy, { type: 'OFF_RECORD_SET', on: true })), 'off');
});

test('an error banner or a failed start shows warning', () => {
  assert.equal(deriveClipaState(run(initialState(), { type: 'BANNER_SET', banner: { kind: 'error', text: 'x' } })), 'warning');
  assert.equal(deriveClipaState(run(initialState(), { type: 'SESSION_STARTING', mode: 'learn' }, { type: 'SESSION_FAILED', message: 'x' })), 'warning');
  assert.equal(deriveClipaState(run(initialState(), { type: 'BANNER_SET', banner: { kind: 'warn', text: 'x' } })), 'idle', 'a warning banner is not an error');
});

test('Teach: warn -> warning, clear -> happy, unknown -> unchanged', () => {
  assert.equal(deriveClipaState(run(live(), { type: 'CHECKPOINT_RESULT', card: card('warn') })), 'warning');
  assert.equal(deriveClipaState(run(live(), { type: 'CHECKPOINT_RESULT', card: card('clear') })), 'happy');
  assert.equal(deriveClipaState(run(live(), { type: 'CHECKPOINT_RESULT', card: card('unknown') })), 'idle');
});

test('mastered with nothing left to practise -> happy', () => {
  assert.equal(deriveClipaState(run(live(), { type: 'MASTERY_SET', mastery: { mastered: ['a'], practise: [] } })), 'happy');
  assert.equal(deriveClipaState(run(live(), { type: 'MASTERY_SET', mastery: { mastered: ['a'], practise: ['b'] } })), 'idle');
});

test('replaying an evidence moment -> pointing, closing it goes back', () => {
  const open = run(live(), { type: 'REPLAY_OPEN', evidenceId: 'ev-1' });
  assert.equal(deriveClipaState(open), 'pointing');
  assert.equal(deriveClipaState(reduce(open, { type: 'REPLAY_CLOSE' })), 'idle');
});

test('a spoken decision can ask Clipa to look like a warning while it speaks', () => {
  const speaking = run(live(), { type: 'VOICE_PHASE', phase: 'speaking' }, { type: 'CLIPA_HINT', hint: 'warning' });
  assert.equal(deriveClipaState(speaking), 'warning');
  assert.equal(deriveClipaState(run(live(), { type: 'VOICE_PHASE', phase: 'speaking' })), 'speaking');
});

test('every Clipa state of the mapping is reachable', () => {
  const seen = new Set([
    deriveClipaState(initialState()),
    deriveClipaState(run(live(), { type: 'VOICE_PHASE', phase: 'listening' })),
    deriveClipaState(run(live(), { type: 'VOICE_PHASE', phase: 'speaking' })),
    deriveClipaState(run(live(), { type: 'VOICE_THINKING', thinking: true })),
    deriveClipaState(run(live(), { type: 'CHECKPOINT_RESULT', card: card('warn') })),
    deriveClipaState(run(live(), { type: 'CHECKPOINT_RESULT', card: card('clear') })),
    deriveClipaState(run(live(), { type: 'REPLAY_OPEN', evidenceId: 'e' })),
    deriveClipaState(run(live(), { type: 'OFF_RECORD_SET', on: true })),
  ]);
  assert.deepEqual([...seen].sort(), ['happy', 'idle', 'listening', 'off', 'pointing', 'speaking', 'thinking', 'warning']);
});

test('status chips: screen says synthetic for the sample source and never claims analysis for local capture', () => {
  const sample = run(live(), { type: 'SCREEN_SOURCE', source: { label: 'Sample', synthetic: true } }, { type: 'SCREEN_STATUS', state: 'capturing', reason: null });
  assert.equal(screenChip(sample).value, 'sample, synthetic: capturing');
  const local = run(initialState(), { type: 'CAPTURE_SNAPSHOT', capture: { state: 'capturing', reason: null } });
  assert.match(screenChip(local).value, /not analysed/);
  assert.equal(screenChip(initialState()).value, 'no screen shared');
  assert.equal(screenChip(reduce(sample, { type: 'OFF_RECORD_SET', on: true })).value, 'off the record');
});

test('status chips: voice, session countdown, record', () => {
  assert.equal(voiceChip(initialState()).value, 'not started');
  assert.equal(voiceChip(run(live(), { type: 'VOICE_PHASE', phase: 'speaking' })).value, 'live, speaking');
  assert.equal(voiceChip(run(live(), { type: 'VOICE_PHASE', phase: 'offline', error: 'x' })).tone, 'bad');
  assert.equal(sessionChip(live(), 540_000).value, 'live, 1:00 left');
  assert.equal(sessionChip(initialState(), 0).value, 'none');
  assert.equal(recordChip(live()).value, 'on the record');
  assert.equal(recordChip(initialState()).value, 'not recording');
  assert.equal(recordChip(run(live(), { type: 'OFF_RECORD_SET', on: true })).value, 'off the record');
  assert.deepEqual(statusChips(live(), 0).map((c) => c.label), ['Screen', 'Voice', 'Session', 'Record']);
});

test('latency summary: last and median of the measured decisions', () => {
  const entry = (latencyMs: number | null): DecisionEntry => ({
    id: 'd', atMs: 0, decision: 'ASK_NOW', topic: 't', kind: 'k', whyNow: 'w', text: 'q', evidenceIds: [], spoken: true, latencyMs, note: null,
  });
  assert.deepEqual(summarizeLatency([]), { count: 0, lastMs: null, medianMs: null });
  assert.deepEqual(summarizeLatency([entry(null)]), { count: 0, lastMs: null, medianMs: null });
  assert.deepEqual(summarizeLatency([entry(900), entry(null), entry(300), entry(600)]), { count: 3, lastMs: 600, medianMs: 600 });
  assert.deepEqual(summarizeLatency([entry(100), entry(300)]), { count: 2, lastMs: 300, medianMs: 200 });
});
