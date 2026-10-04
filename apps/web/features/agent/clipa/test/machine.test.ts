import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_STATES,
  REPEATABLE,
  TRANSITIONS,
  canTransition,
  createMachine,
  isActive,
  reachesDock,
} from '../src/machine.ts';
import { CLIPA_STATES } from '../src/types.ts';
import type { ClipaState } from '../src/types.ts';

/** Walks the machine along `path` (starting from its own state) and returns every result. */
function walk(path: readonly ClipaState[], from: ClipaState = 'dock') {
  const machine = createMachine(from);
  const results = path.map((to) => machine.request(to));
  return { machine, results };
}

describe('lifecycle state machine', () => {
  it('has the eleven states of the spec', () => {
    assert.deepEqual(
      [...CLIPA_STATES].sort(),
      ['ack', 'approach', 'dock', 'listening', 'notice', 'off', 'pointing', 'retreat', 'speaking', 'thinking', 'warning'],
    );
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...CLIPA_STATES].sort());
  });

  it('runs the question path: dock -> notice -> approach -> speaking -> listening -> thinking -> ack -> retreat -> dock', () => {
    const path: ClipaState[] = ['notice', 'approach', 'speaking', 'listening', 'thinking', 'ack', 'retreat', 'dock'];
    const { machine, results } = walk(path);
    assert.ok(results.every((r) => r.ok));
    assert.equal(machine.state, 'dock');
    assert.deepEqual(machine.history.map((h) => h.to), path);
  });

  it('runs the warning path: dock -> warning -> pointing -> retreat -> dock', () => {
    const { machine, results } = walk(['warning', 'pointing', 'retreat', 'dock']);
    assert.ok(results.every((r) => r.ok));
    assert.equal(machine.state, 'dock');
  });

  it('goes off from the dock and comes back', () => {
    const { machine, results } = walk(['off', 'dock']);
    assert.ok(results.every((r) => r.ok));
    assert.equal(machine.state, 'dock');
  });

  it('lets a listening Clipa retreat when the person starts typing (spec: Listening -> Retreat)', () => {
    assert.equal(canTransition('listening', 'retreat'), true);
  });

  it('lets off-record cancel anything: every state can go to off, and off leaves only to dock', () => {
    for (const from of CLIPA_STATES) {
      if (from === 'off') continue;
      assert.equal(canTransition(from, 'off'), true, `${from} -> off`);
    }
    for (const to of CLIPA_STATES) {
      assert.equal(canTransition('off', to), to === 'dock', `off -> ${to}`);
    }
  });

  it('lets a warning preempt every active state', () => {
    for (const from of ACTIVE_STATES) assert.equal(canTransition(from, 'warning'), true, `${from} -> warning`);
    assert.equal(canTransition('retreat', 'warning'), false, 'a retreat finishes first');
  });

  it('ignores illegal requests: nothing changes, no listener runs, no history entry', () => {
    const machine = createMachine('dock');
    const seen: string[] = [];
    machine.subscribe((from, to) => seen.push(`${from}>${to}`));
    for (const to of ['thinking', 'ack', 'retreat', 'dock'] as const) {
      const result = machine.request(to);
      assert.equal(result.ok, false, `dock -> ${to}`);
      if (!result.ok) assert.match(result.reason, /not a legal transition/);
    }
    assert.equal(machine.state, 'dock');
    assert.equal(machine.history.length, 0);
    assert.deepEqual(seen, []);
  });

  it('does not let a retreating Clipa start something new before she is home', () => {
    for (const to of CLIPA_STATES) {
      assert.equal(canTransition('retreat', to), to === 'dock' || to === 'off', `retreat -> ${to}`);
    }
  });

  it('treats repeating speaking, listening, warning and pointing as legal no-ops', () => {
    for (const state of CLIPA_STATES) {
      assert.equal(canTransition(state, state), REPEATABLE.includes(state), `${state} -> ${state}`);
    }
    const machine = createMachine('listening');
    const seen: string[] = [];
    machine.subscribe((from, to) => seen.push(`${from}>${to}`));
    const result = machine.request('listening');
    assert.deepEqual(result, { ok: true, from: 'listening', to: 'listening', changed: false });
    assert.deepEqual(seen, []);
    assert.equal(machine.history.length, 0);
  });

  it('allows speaking and listening in place at the dock, but not thinking or ack', () => {
    assert.equal(canTransition('dock', 'speaking'), true);
    assert.equal(canTransition('dock', 'listening'), true);
    assert.equal(canTransition('dock', 'thinking'), false);
    assert.equal(canTransition('dock', 'ack'), false);
  });

  it('lets notice be cancelled back to the dock before take-off', () => {
    assert.equal(canTransition('notice', 'dock'), true);
  });

  it('has no dead ends: every state reaches the dock', () => {
    for (const state of CLIPA_STATES) assert.equal(reachesDock(state), true, state);
  });

  it('only lists known states and no duplicates in the table', () => {
    for (const from of CLIPA_STATES) {
      const targets = TRANSITIONS[from];
      assert.equal(new Set(targets).size, targets.length, `${from} has duplicate targets`);
      for (const to of targets) assert.ok(CLIPA_STATES.includes(to), `${from} -> ${String(to)}`);
    }
  });

  it('calls subscribers once per accepted change, in order, until they unsubscribe', () => {
    const machine = createMachine('dock');
    const seen: string[] = [];
    const off = machine.subscribe((from, to) => seen.push(`${from}>${to}`));
    machine.request('notice');
    machine.request('approach');
    off();
    machine.request('retreat');
    assert.deepEqual(seen, ['dock>notice', 'notice>approach']);
    assert.equal(machine.state, 'retreat');
  });

  it('keeps the last 100 transitions', () => {
    const machine = createMachine('dock');
    for (let i = 0; i < 80; i++) {
      machine.request('off');
      machine.request('dock');
    }
    assert.equal(machine.history.length, 100);
    assert.equal(machine.state, 'dock');
  });

  it('rejects an unknown initial state', () => {
    assert.throws(() => createMachine('flying' as ClipaState), /unknown Clipa state/);
  });

  it('knows which states are out of the dock corner', () => {
    assert.equal(isActive('dock'), false);
    assert.equal(isActive('off'), false);
    assert.equal(isActive('retreat'), false);
    assert.equal(isActive('notice'), false);
    for (const state of ['approach', 'speaking', 'listening', 'thinking', 'ack', 'warning', 'pointing'] as const) {
      assert.equal(isActive(state), true, state);
    }
  });
});
