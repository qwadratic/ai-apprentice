// The map's business processes on the Reflect board (TASK-3.53): fromGenericMap reads `processes` and each item's `processId`
// defensively, and the board groups steps and rules under the process titles only when the map names two or more. The board
// loads through the test-only esbuild hooks in journey/tsx-hooks.mjs, registered here before the dynamic import.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromGenericMap } from '../../workmap/generic.ts';
import type { GenericBoard } from '../../workmap/generic.ts';
import type { WorkMapBoardProps } from '../../workmap/WorkMapBoard.tsx';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { WorkMapBoard } = (await import('../../workmap/WorkMapBoard.tsx')) as { WorkMapBoard: ComponentType<WorkMapBoardProps> };

const step = (id: string, action: string, processId?: unknown): Record<string, unknown> => ({
  id, kind: 'action', goal: `Goal of ${id}`, action, decision: null, evidenceIds: [], ...(processId === undefined ? {} : { processId }),
});
const rule = (id: string, condition: string, processId?: unknown): Record<string, unknown> => ({
  id, condition, requiredAction: 'Ask the customer for text', reason: 'They asked for it in writing', quote: null, quoteAtMs: null,
  escalateTo: null, exceptions: [], evidenceIds: [], ...(processId === undefined ? {} : { processId }),
});

/** Synthetic two-process map: an email and an order table; s3 names no process, s4 an unknown one. */
function twoProcessMap(processes: unknown): Record<string, unknown> {
  return {
    processes,
    steps: [
      step('s1', 'Opened the order table', 'p-table'),
      step('s2', 'Copied the address into the email body', 'p-mail'),
      step('s3', 'Checked the delivery time'),
      step('s4', 'Sent the email', 'p-missing'),
    ],
    guardrails: [rule('g1', 'customer_07 gets an email', 'p-mail'), rule('g2', 'An order row has no delivery time', null)],
    gaps: [],
    teachBack: 'You copy the order data into the email as text for customer_07.',
  };
}
const TWO = [
  { id: 'p-mail', title: 'Customer email', summary: 'Reply with the order data' },
  { id: 'p-table', title: 'Order table', summary: 'Look up the order' },
];

function board(raw: unknown): GenericBoard {
  const b = fromGenericMap(raw, { version: 2, observations: [] });
  assert.ok(b !== null);
  return b;
}
function render(b: GenericBoard, withProcesses: boolean): string {
  return renderToStaticMarkup(createElement(WorkMapBoard, { map: b.map, observations: [], gaps: b.gaps, ...(withProcesses ? { processes: b.processes } : {}) }));
}

test('two processes: steps and rules are grouped in the order of processes; unknown or missing processId goes to the first', () => {
  const b = board(twoProcessMap(TWO));
  assert.deepEqual(b.processes, [
    { id: 'p-mail', title: 'Customer email', stepIds: ['s2', 's3', 's4'], guardrailIds: ['g1', 'g2'] },
    { id: 'p-table', title: 'Order table', stepIds: ['s1'], guardrailIds: [] },
  ]);

  const html = render(b, true);
  const at = (needle: string): number => html.indexOf(needle);
  // Steps column: the email heading, its steps, then the table heading and its step.
  const mail = at('data-process="p-mail"');
  const table = at('data-process="p-table"');
  assert.ok(mail >= 0 && table > mail);
  assert.match(html, /<h4 class="wm-process__title">Customer email<\/h4>/);
  assert.match(html, /<h4 class="wm-process__title">Order table<\/h4>/);
  for (const id of ['s2', 's3', 's4']) assert.ok(at(`data-card="step:${id}"`) > mail && at(`data-card="step:${id}"`) < table, id);
  assert.ok(at('data-card="step:s1"') > table);
  // Guardrails column: only the email process has rules, so only its heading shows there.
  const rules = html.slice(at('id="wm-guard-h"'));
  assert.equal(rules.split('data-process="p-mail"').length - 1, 1);
  assert.equal(rules.split('data-process="p-table"').length - 1, 0);
  assert.ok(rules.indexOf('data-card="guardrail:g1"') > rules.indexOf('data-process="p-mail"'));
  // Every card is still on the board exactly once.
  assert.equal(html.split('data-card="step:').length - 1, 4);
  assert.equal(html.split('data-card="guardrail:').length - 1, 2);
});

test('zero or one process: no grouping, and the board renders exactly as without processes', () => {
  for (const processes of [undefined, [], [TWO[0]]]) {
    const b = board(twoProcessMap(processes));
    assert.deepEqual(b.processes, []);
    const html = render(b, true);
    assert.equal(html, render(b, false));
    assert.doesNotMatch(html, /wm-process/);
    assert.equal(html.split('data-card="step:').length - 1, 4);
  }
  // A map from before processes existed (no processes key, no processId) reads as before.
  const old = board({ steps: [step('s1', 'Opened the order table')], guardrails: [rule('g1', 'customer_07 gets an email')], gaps: [], teachBack: null });
  assert.deepEqual(old.processes, []);
  assert.doesNotMatch(render(old, true), /wm-process/);
});

test('malformed processes are ignored; repeated ids count once; at most three processes', () => {
  for (const bad of ['p-mail', 42, null, { id: 'p-mail', title: 'Customer email' }]) assert.deepEqual(board(twoProcessMap(bad)).processes, []);
  const junk = [null, 'p-x', { id: 7, title: 'Seven' }, { id: 'p-y' }, { id: 'p-z', title: '   ' }, TWO[0], { id: 'p-mail', title: 'Again' }];
  // Only one well-formed, distinct process is left: no grouping.
  assert.deepEqual(board(twoProcessMap(junk)).processes, []);
  const mixed = board(twoProcessMap([...junk, TWO[1]]));
  assert.deepEqual(mixed.processes.map((p) => p.title), ['Customer email', 'Order table']);
  const many = board(twoProcessMap([...TWO, { id: 'p3', title: 'Ticket' }, { id: 'p4', title: 'Fourth' }]));
  assert.deepEqual(many.processes.map((p) => p.id), ['p-mail', 'p-table', 'p3']);
  // A step or rule with a non-string processId goes to the first process.
  const odd = board({ ...twoProcessMap(TWO), steps: [step('s1', 'Opened the order table', { id: 'p-table' }), step('s2', 'Sent it', 5)] });
  assert.deepEqual(odd.processes[0]?.stepIds, ['s1', 's2']);
});
