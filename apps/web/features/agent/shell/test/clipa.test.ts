// Clipa in the shell: the motion director is driven by decisions and by the derived state, and it never starts a flight while the
// person types. The director itself needs a browser (its own package ships a headless e2e for the typing guard); these tests cover
// the shell's side: what the guard counts as typing, how a decision becomes a director sequence, which derived states move her,
// and where she can fly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClipaDecision, ClipaResult, ClipaState as DirectorState, ClipaTarget } from '../../clipa/src/index.ts';
import type { BrainDecision } from '../brain/types.ts';
import { commandsFor, createDirectorPresenter, directorState, toClipaDecision } from '../clipa/director-presenter.ts';
import type { DirectorLike } from '../clipa/director-presenter.ts';
import { HEARTBEAT_TTL_MS, INPUT_QUIET_MS, InputGuard, watchPageInput } from '../clipa/input-guard.ts';
import { createClipaStore } from '../clipa/presenter.ts';
import { HINT_ATTR, SURFACE_ATTR, resolveClipaTarget, selectorsFor } from '../clipa/targets.ts';
import { CLIPA_MARKS, markClipaTargets } from '../clipa/workspace-marks.ts';
import { SpeechGate } from '../voice/speech-gate.ts';
import { must } from './helpers.ts';

const ok: ClipaResult = { ok: true };

class FakeDirector implements DirectorLike {
  state: DirectorState = 'dock';
  calls: string[] = [];
  applied: ClipaDecision[] = [];
  durations: Array<number | undefined> = [];
  async apply(decision: ClipaDecision, options?: { durationMs?: number }): Promise<ClipaResult> {
    this.calls.push('apply'); this.applied.push(decision); this.durations.push(options?.durationMs);
    return ok;
  }
  async setOff(off: boolean): Promise<ClipaResult> { this.calls.push(off ? 'off' : 'on'); return ok; }
  async listen(): Promise<ClipaResult> { this.calls.push('listen'); return ok; }
  async ack(): Promise<ClipaResult> { this.calls.push('ack'); return ok; }
  async retreat(): Promise<ClipaResult> { this.calls.push('retreat'); return ok; }
  async warn(target?: ClipaTarget): Promise<ClipaResult> { this.calls.push(`warn${target ? ':target' : ''}`); return ok; }
  async point(target?: ClipaTarget): Promise<ClipaResult> { this.calls.push(`point:${target?.surface ?? ''}`); return ok; }
  destroy(): void { this.calls.push('destroy'); }
}

const warn: BrainDecision = {
  decision: 'WARN', topic: 'checkpoint', kind: 'guardrail', whyNow: 'x', evidenceIds: ['e1'], utterance: { text: 'Hold on before Send.' },
  expectsAnswer: false, clipa: { state: 'warning', target: { surface: 'email', hint: 'send' } },
};
const ask: BrainDecision = {
  decision: 'ASK_NOW', topic: 'reason', kind: 'reason', whyNow: 'x', evidenceIds: ['e1'], utterance: { text: 'Why did you remove the image?', maxWords: 18 },
  expectsAnswer: true, clipa: { state: 'approach', target: { surface: 'email', hint: 'attachments' } },
};

// ---- the input guard: never move while the person types -------------------------------------------------------------

test('the guard counts a key press as typing for a moment, and a typing heartbeat until it stops or expires', () => {
  let t = 1000;
  const guard = new InputGuard(() => t);
  assert.equal(guard.isActive(), false);
  guard.noteInput();
  assert.equal(guard.isActive(), true);
  t += INPUT_QUIET_MS - 1;
  assert.equal(guard.isActive(), true);
  t += 1;
  assert.equal(guard.isActive(), false);

  guard.setTyping(true);
  t += HEARTBEAT_TTL_MS - 1;
  assert.equal(guard.isActive(), true, 'a typing heartbeat from the workspace holds Clipa');
  t += 1;
  assert.equal(guard.isActive(), false, 'a heartbeat that is not repeated expires');
  guard.setTyping(true);
  guard.setTyping(false);
  assert.equal(guard.isActive(), false, '"stopped typing" releases her at once');
});

test('page key presses and input events reach the guard; removing the watcher stops it', () => {
  let t = 0;
  const guard = new InputGuard(() => t);
  const handlers = new Map<string, () => void>();
  const target = {
    addEventListener: (type: string, fn: () => void) => { handlers.set(type, fn); },
    removeEventListener: (type: string) => { handlers.delete(type); },
  };
  const stop = watchPageInput(guard, target);
  assert.deepEqual([...handlers.keys()].sort(), ['input', 'keydown']);
  must(handlers.get('keydown'))();
  assert.equal(guard.isActive(), true);
  stop();
  assert.equal(handlers.size, 0);
});

test('the presenter hands workspace typing to the guard the director reads', () => {
  let t = 0;
  const guard = new InputGuard(() => t);
  const presenter = createDirectorPresenter({ store: createClipaStore(), director: new FakeDirector(), guard });
  assert.equal(guard.isActive(), false);
  presenter.noteInput?.(true);
  assert.equal(guard.isActive(), true);
  presenter.noteInput?.(false);
  assert.equal(guard.isActive(), false);
});

// ---- decisions and states ---------------------------------------------------------------------------------------------------------

test('a decision becomes what the director reads: verdict, text, target and the cue as a director state', () => {
  assert.deepEqual(toClipaDecision(warn), {
    decision: 'WARN', utterance: { text: 'Hold on before Send.' }, expectsAnswer: false, clipa: { state: 'warning', target: { surface: 'email', hint: 'send' } },
  });
  assert.deepEqual(toClipaDecision(ask).clipa, { state: 'approach', target: { surface: 'email', hint: 'attachments' } });
  assert.equal(directorState('idle'), 'dock');
  assert.equal(directorState('happy'), 'ack');
  assert.equal(directorState('pointing'), 'pointing');
});

test('a spoken decision is played through director.apply; a question flies to its target, a warning to Send', () => {
  const director = new FakeDirector();
  const presenter = createDirectorPresenter({ store: createClipaStore(), director, guard: new InputGuard(() => 0) });
  presenter.play?.(ask);
  presenter.play?.(warn);
  assert.deepEqual(director.calls, ['apply', 'apply']);
  assert.equal(must(director.applied[0]).clipa?.target?.hint, 'attachments');
  assert.equal(must(director.applied[1]).clipa?.target?.hint, 'send');
  assert.equal(must(director.applied[1]).clipa?.state, 'warning');
  assert.ok(must(director.durations[0]) > 4000, 'the mouth moves for the estimated speech plus a margin, and stops when the voice does');
});

test('derived states: only the ones that mean something move her; a playing sequence is never cancelled by them', () => {
  assert.deepEqual(commandsFor('off', 'listening', 'speaking', false), ['off']);
  assert.deepEqual(commandsFor('listening', 'off', 'dock', false), ['on'], 'back on the record');
  assert.deepEqual(commandsFor('listening', 'idle', 'dock', false), [], 'a docked Clipa stays docked while the voice only listens');
  assert.deepEqual(commandsFor('listening', 'speaking', 'speaking', true), ['listen'], 'the agent finished: rings instead of the mouth, even mid-sequence');
  assert.deepEqual(commandsFor('warning', 'listening', 'dock', true), [], 'a WARN decision that is flying to Send is not cancelled');
  assert.deepEqual(commandsFor('warning', 'listening', 'dock', false), ['warn'], 'an error warns in place');
  assert.deepEqual(commandsFor('warning', 'listening', 'warning', false), []);
  assert.deepEqual(commandsFor('pointing', 'listening', 'dock', false), ['point']);
  assert.deepEqual(commandsFor('happy', 'listening', 'listening', false), ['ack']);
  assert.deepEqual(commandsFor('happy', 'listening', 'dock', false), [], 'she does not wake up just to celebrate');
});

test('the presenter runs the commands and keeps the store (the accessible copy of the bubble) in step', () => {
  const store = createClipaStore();
  const director = new FakeDirector();
  const presenter = createDirectorPresenter({ store, director, guard: new InputGuard(() => 0) });
  presenter.setState('listening');
  assert.equal(store.getSnapshot().state, 'listening');
  presenter.say('Why?');
  assert.equal(store.getSnapshot().bubble, 'Why?');
  presenter.setState('off');
  presenter.setState('idle');
  assert.deepEqual(director.calls, ['off', 'on']);
  presenter.ack?.();
  presenter.dispose();
  assert.deepEqual(director.calls.slice(-2), ['ack', 'destroy']);
});

// ---- where she can fly ----------------------------------------------------------------------------------------------------------------

test('targets resolve from the hint to the surface to the workspace; hidden elements do not count', () => {
  assert.deepEqual(selectorsFor({ surface: 'email', hint: 'send' }), [
    `[${SURFACE_ATTR}="email"][${HINT_ATTR}="send"]`, `[${SURFACE_ATTR}="email"]:not([${HINT_ATTR}])`, `[${SURFACE_ATTR}="workspace"]`,
  ]);
  const box = { left: 10, top: 20, width: 100, height: 30 };
  const gone = { left: 0, top: 0, width: 0, height: 0 };
  const elements: Record<string, { getBoundingClientRect(): typeof box }> = {};
  const root = { querySelector: (sel: string) => (elements[sel] ?? null) as Element | null };
  assert.equal(resolveClipaTarget(root, { surface: 'email', hint: 'send' }), null);
  elements[`[${SURFACE_ATTR}="workspace"]`] = { getBoundingClientRect: () => box };
  assert.equal(resolveClipaTarget(root, { surface: 'email', hint: 'send' }), box, 'falls back to the workspace');
  elements[`[${SURFACE_ATTR}="email"][${HINT_ATTR}="send"]`] = { getBoundingClientRect: () => gone };
  assert.equal(resolveClipaTarget(root, { surface: 'email', hint: 'send' }), box, 'a zero-size element is skipped');
  const send = { left: 300, top: 400, width: 90, height: 28 };
  elements[`[${SURFACE_ATTR}="email"][${HINT_ATTR}="send"]`] = { getBoundingClientRect: () => send };
  assert.equal(resolveClipaTarget(root, { surface: 'email', hint: 'send' }), send);
});

test('the demo workspace\'s own elements get the Clipa marks, attributes only', () => {
  const attrs = new Map<string, Record<string, string>>();
  const root = {
    querySelector: (selector: string) => (selector === '[data-view="attachments"]' ? null : { setAttribute: (k: string, v: string) => { attrs.set(selector, { ...attrs.get(selector), [k]: v }); } }),
  };
  assert.equal(markClipaTargets(root), CLIPA_MARKS.length - 1, 'a missing element is skipped');
  assert.deepEqual(attrs.get('[data-action="send"]'), { [SURFACE_ATTR]: 'email', [HINT_ATTR]: 'send' });
  assert.deepEqual(attrs.get('[data-surface="order"]'), { [SURFACE_ATTR]: 'order' });
});

// ---- speech ---------------------------------------------------------------------------------------------------------------------------

test('the speech gate: speech starts on a high score, ends after the hangover, and noise is not speech', () => {
  const gate = new SpeechGate({ threshold: 0.6, hangoverMs: 800, noiseAfterMs: 5000 });
  assert.equal(gate.isSpeaking(0), false);
  gate.onScore(0.2, 100);
  assert.equal(gate.isSpeaking(100), false);
  gate.onScore(0.9, 200);
  assert.equal(gate.isSpeaking(300), true);
  assert.equal(gate.isSpeaking(1000), true, 'a breath between words is not a pause');
  assert.equal(gate.isSpeaking(1100), false);
  for (let t = 2000; t <= 9000; t += 400) gate.onScore(0.95, t);
  assert.equal(gate.isSpeaking(9000), false, 'a score that stays high for seconds is treated as noise');
});
