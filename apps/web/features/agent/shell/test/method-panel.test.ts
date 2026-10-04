// "How Clipa thinks": the five boxes, the live item or the marked example under each, and the small knowledge graph. The model is
// pure (components/method-model.ts); the panel is rendered with react-dom/server. The .tsx components load through the test-only
// esbuild hooks in journey/tsx-hooks.mjs, registered here before the dynamic imports.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClipaStore } from '../clipa/presenter.ts';
import { createConductorStore } from '../conductor/store.ts';
import type { ConductorStore, SaidItem } from '../conductor/store.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { FeedItem } from '../state/types.ts';
import { buildGraph, describeGraph, EXAMPLE_SUMMARY, GRAPH_MAX_RULES, lastQuestion, mapCounts, methodBoxes, summarizeDraftMap, summarizeGenericMap, wrapText } from '../components/method-model.ts';
import type { MethodInput } from '../components/method-model.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { MethodPanel } = (await import('../components/MethodPanel.tsx')) as { MethodPanel: ComponentType };

interface Rig { store: Store; conductor: ConductorStore }
const rig = (): Rig => ({ store: createStore(), conductor: createConductorStore() });

function render(r: Rig): string {
  const controller = { store: r.store, conductorStore: r.conductor };
  const runtime = { controller, clipa: createClipaStore(), workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, createElement(MethodPanel)));
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const box = (html: string, id: string): string => new RegExp(`<li class="mp__box" data-box="${id}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? '';
const said = (cueId: string, kind: SaidItem['kind'], text: string, outcome: SaidItem['outcome'] = 'spoken'): SaidItem => ({ cueId, kind, text, atMs: 1000, outcome });

const emptyInput = (): MethodInput => ({ observations: [], events: [], feed: [], said: [], checkpoint: null, summary: null, conductorLeads: true });

/** The conductor's map for customer_07: two steps, a rule with the expert's words and an exception. */
const genericMap = {
  version: 2,
  confirmed: false,
  map: {
    processes: [{ id: 'p1', title: 'Delivery update' }],
    steps: [
      { id: 's1', goal: 'Read the customer note', action: 'read', evidenceIds: [] },
      { id: 's2', goal: 'Write the delivery update', action: 'type', evidenceIds: [] },
    ],
    guardrails: [{
      id: 'g1',
      condition: 'Customer 07 asked for text',
      requiredAction: 'write the address and window in the email',
      quote: 'Their phone blocks images.',
      exceptions: ['An image is fine when the details are also in text'],
      evidenceIds: [],
    }],
    gaps: [],
    teachBack: null,
  },
};

test('with nothing live, every box shows a short example, marked as one, and the graph is the customer_07 example', () => {
  const html = render(rig());
  assert.match(html, /<section class="mp" aria-labelledby="mp-title" data-testid="method-panel">/);
  assert.match(html, /<h2 class="mp__title" id="mp-title">How Clipa thinks<\/h2>/);
  assert.equal(count(html, '<li class="mp__box"'), 5);
  const titles = [...html.matchAll(/<h3 class="mp__name"><span class="mp__no" aria-hidden="true">(\d)<\/span>([^<]*)<\/h3>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(titles, [['1', 'Raw signals'], ['2', 'Events'], ['3', 'Reasoning'], ['4', 'Knowledge graph'], ['5', 'Teaching']]);
  assert.equal(count(html, 'data-source="example"'), 6, 'five boxes and the graph are examples');
  assert.equal(count(html, '<span class="mp__tag">example</span>'), 6);
  assert.doesNotMatch(html, /mp__tag--live/);
  assert.match(html, /<figure class="mp-graph" data-source="example">/);
  assert.match(html, /The customer_07 rule as a graph/);
});

test('each box says what it is, in the words of the method', () => {
  const html = render(rig());
  assert.match(box(html, 'signals'), /Screen frames, the pointer and speech\. Raw data: nothing is decided here\./);
  assert.match(box(html, 'events'), /What changed on screen, in words\./);
  assert.match(box(html, 'reasoning'), /When to speak: at a pause\. What to ask: the why behind the change\./);
  assert.match(box(html, 'knowledge'), /Process → step → decision → rule → exception, each linked to its evidence: the screen moment and the expert’s words\./);
  assert.match(box(html, 'teaching'), /The new hire is checked against the confirmed rules before Send\./);
  assert.match(html, /The screen and the mouse are raw data\. Reasoning runs over them\. What is learned ends up as a graph\./);
});

test('the live item replaces the example: the latest observation, Clipa\'s last question, the map\'s counts, the last warning', () => {
  const r = rig();
  r.store.dispatch({ type: 'OBSERVATION', row: { id: 'o1', sequence: 1, timestampMs: 1000, kind: 'screen_activity', source: 'vision', synthetic: false, summary: 'Old change', evidenceIds: [] } });
  r.store.dispatch({ type: 'OBSERVATION', row: { id: 'o2', sequence: 2, timestampMs: 2000, kind: 'screen_activity', source: 'vision', synthetic: false, summary: 'The address was typed into the email body', evidenceIds: [] } });
  r.store.dispatch({ type: 'OBSERVATION', row: { id: 'o3', sequence: 3, timestampMs: 3000, kind: 'input_activity', source: 'workspace', synthetic: false, summary: 'Typing stopped', evidenceIds: [] } });
  r.store.dispatch({ type: 'LOG', t: Date.now(), dir: 'recv', logType: 'USER', text: 'Their phone blocks images.' });
  r.store.dispatch({
    type: 'CHECKPOINT_RESULT',
    card: { checkpointId: 'cp1', status: 'warn', message: 'Customer 07 wants the address as text.', evidenceIds: [], atMs: 5000, deliveryError: null },
  });
  r.conductor.set({
    enabled: true,
    status: 'live',
    said: [said('c1', 'ask', 'Why the address as text?'), said('c2', 'say', 'Thanks.'), said('c3', 'ask', 'Is an extra image still fine?', 'skipped')],
    map: genericMap,
  });
  const html = render(r);
  assert.match(box(html, 'signals'), /data-source="live"[\s\S]*mp__tag--live">live<\/span>“Their phone blocks images\.”/);
  assert.match(box(html, 'events'), /The address was typed into the email body/, 'the newest observation that says something');
  assert.doesNotMatch(box(html, 'events'), /Typing stopped|Old change/);
  assert.match(box(html, 'reasoning'), /Why the address as text\?/, 'the newest question that reached the person');
  assert.doesNotMatch(box(html, 'reasoning'), /extra image/);
  assert.match(box(html, 'knowledge'), /2 steps, 1 rule, 1 exception/);
  assert.match(box(html, 'teaching'), /Stop before Send: Customer 07 wants the address as text\./);
  assert.equal(count(html, '<span class="mp__tag">example</span>'), 0, 'nothing is an example any more');
  assert.match(html, /<figure class="mp-graph" data-source="live">/);
});

test('invented observations are tagged synthetic in the events box', () => {
  const r = rig();
  r.store.dispatch({ type: 'OBSERVATION', row: { id: 'o1', sequence: 1, timestampMs: 1000, kind: 'screen_activity', source: 'vision', synthetic: true, summary: 'Sample change', evidenceIds: [] } });
  assert.match(box(render(r), 'events'), /Sample change<span class="mp__tag mp__tag--warn">synthetic<\/span>/);
});

test('the graph of a real map has the process, the rule, its exception and the expert\'s words; the page shows it as live', () => {
  const r = rig();
  r.conductor.set({ enabled: true, status: 'live', map: genericMap });
  const html = render(r);
  assert.match(html, /data-testid="knowledge-graph" data-nodes="4"/);
  assert.match(html, /class="mp-node mp-node--process" data-kind="process"/);
  assert.match(html, /class="mp-node mp-node--rule" data-kind="rule"/);
  assert.match(html, /class="mp-node mp-node--exception" data-kind="exception"/);
  assert.match(html, /class="mp-node mp-node--evidence" data-kind="evidence"/);
  assert.match(html, /Delivery update/, 'the map names its process');
  assert.match(html, /“Their phone blocks images\.”/);
  assert.match(html, /The current Work Map as a graph/);
  assert.doesNotMatch(html, /The customer_07 rule as a graph/);
});

test('without the conductor the in-browser brain\'s draft map feeds the knowledge box and the graph', () => {
  const r = rig();
  assert.equal(summarizeDraftMap({ steps: [] }), null);
  const summary = summarizeDraftMap({
    steps: [{ id: 's1', title: 'Write the update', kind: 'judgment', decision: 'text', reason: 'Her phone blocks images.', guardrails: [{ id: 'g1', text: 'Address as text', evidenceIds: [] }], evidenceIds: [], atMs: 1 }],
    guardrails: [{ id: 'g2', text: 'Ask before a refund', evidenceIds: [] }],
  });
  assert.deepEqual(summary?.rules.map((x) => [x.id, x.text, x.quote]), [['g1', 'Address as text', 'Her phone blocks images.'], ['g2', 'Ask before a refund', null]]);
  assert.equal(mapCounts(summary!), '1 step, 2 rules, 0 exceptions');
  void r;
});

test('the graph has at most ten nodes whatever the map holds, stays inside its box and never loses the example fallback', () => {
  const many = {
    process: 'A process with a long name that has to wrap onto the next line of its node and then stop',
    note: null,
    steps: 9,
    rules: Array.from({ length: 7 }, (_, i) => ({
      id: `g${i}`,
      text: `Rule number ${i}: a long condition and a long required action that will not fit on one line of the node`,
      quote: `The expert's words for rule ${i}, said at length so that they need three lines of the small node`,
      exceptions: [`Exception ${i} one`, `Exception ${i} two`],
    })),
  };
  const graph = buildGraph(many);
  assert.equal(graph.example, false);
  assert.equal(graph.nodes.length, 1 + GRAPH_MAX_RULES * 3);
  assert.ok(graph.nodes.length <= 10);
  for (const n of graph.nodes) {
    assert.ok(n.x >= 0 && n.x + n.w <= graph.width, `${n.id} is inside the width`);
    assert.ok(n.y >= 0 && n.y + n.h <= graph.height, `${n.id} is inside the height`);
    assert.ok(n.lines.length >= 1 && n.lines.length <= 3);
  }
  const ids = graph.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'unique node ids');
  assert.equal(graph.edges.length, GRAPH_MAX_RULES * 3, 'one edge per rule, exception and quote');
  // A map without a rule has nothing to draw as a graph: the example stands in, marked.
  assert.equal(buildGraph({ process: 'x', note: null, steps: 3, rules: [] }).example, true);
  assert.equal(buildGraph(null).example, true);
  assert.equal(buildGraph(null).nodes.length, 4);
  assert.match(describeGraph(buildGraph(null)), /^Example knowledge graph\./);
  assert.match(describeGraph(graph), /^Knowledge graph of the Work Map\./);
});

test('a map that is invented or from an earlier session says so next to its counts and its graph', () => {
  const r = rig();
  r.conductor.set({ enabled: true, status: 'live', map: { ...genericMap, origin: 'demo' } });
  const demo = render(r);
  assert.match(box(demo, 'knowledge'), /2 steps, 1 rule, 1 exception<span class="mp__tag mp__tag--warn">synthetic<\/span>/);
  assert.match(demo, /The current Work Map as a graph: each rule links to the expert’s words\.<span class="mp__tag mp__tag--warn">synthetic<\/span>/);
  r.conductor.set({ map: { ...genericMap, origin: 'earlier' } });
  assert.match(box(render(r), 'knowledge'), /<span class="mp__tag mp__tag--warn">earlier session<\/span>/);
  r.conductor.set({ map: { ...genericMap, origin: 'session' } });
  assert.doesNotMatch(box(render(r), 'knowledge'), /mp__tag--warn/, 'the session\'s own map carries no note');
  const draft = summarizeDraftMap({ synthetic: true, steps: [{ id: 's1', title: 'T', kind: 'step', decision: null, reason: null, guardrails: [{ id: 'g1', text: 'Rule', evidenceIds: [] }], evidenceIds: [], atMs: 1 }] });
  assert.equal(draft?.note, 'synthetic');
  assert.equal(buildGraph(draft).note, 'synthetic');
  assert.equal(buildGraph(null).note, null, 'the example is labelled example, not synthetic');
});

test('the example is the customer_07 rule with its exception and the expert\'s words', () => {
  const graph = buildGraph(null);
  const text = (kind: string): string => graph.nodes.find((n) => n.kind === kind)?.lines.join(' ') ?? '';
  assert.equal(text('rule'), 'Write the address and window in the email');
  assert.equal(text('evidence'), '“Their phone blocks images.”');
  assert.equal(text('exception'), 'An image is fine when the details are also in text');
  assert.equal(EXAMPLE_SUMMARY.rules[0]!.exceptions.length, 1);
});

test('wrapText breaks on words, keeps lines short and ends a long text with an ellipsis', () => {
  assert.deepEqual(wrapText('An image is fine when the details are also in text', 23, 3), ['An image is fine when', 'the details are also in', 'text']);
  // The ellipsis counts: a cut line is never longer than the width.
  assert.deepEqual(wrapText('one two three four five six seven eight nine ten', 10, 2), ['one two', 'three fou…']);
  assert.deepEqual(wrapText('one two three four five six seven eight nine ten', 12, 2), ['one two', 'three four…']);
  assert.deepEqual(wrapText('Supercalifragilisticexpialidocious', 10, 1), ['Supercali…']);
  assert.deepEqual(wrapText('   ', 10, 2), []);
});

test('the conductor\'s map is read defensively; a map with nothing in it is no map', () => {
  assert.equal(summarizeGenericMap(null), null);
  assert.equal(summarizeGenericMap({ version: 1, confirmed: false, map: 'nope' }), null);
  assert.equal(summarizeGenericMap({ version: 1, confirmed: false, map: { steps: [], guardrails: [] } }), null);
  const summary = summarizeGenericMap({ version: 1, confirmed: false, map: { steps: [{}], guardrails: [{ condition: 'Only a condition' }, 7, { requiredAction: 'Only an action', exceptions: ['ok', '', 3] }] } });
  assert.equal(summary?.steps, 1);
  assert.deepEqual(summary?.rules.map((x) => [x.text, x.exceptions]), [['Only a condition', []], ['Only an action', ['ok']]]);
});

test('Clipa\'s last question comes from the conductor\'s lines while it leads, else from the brain\'s feed', () => {
  const base = emptyInput();
  assert.equal(lastQuestion(base), null);
  assert.equal(lastQuestion({ ...base, said: [said('a', 'ask', 'First?'), said('b', 'warn', 'Careful.'), said('c', 'ask', 'Second?')] }), 'Second?');
  assert.equal(lastQuestion({ ...base, said: [said('a', 'ask', 'Never heard?', 'skipped')] }), null);
  const feedItem = (id: string, status: FeedItem['status'], text: string): FeedItem =>
    ({ id, decision: 'ASK_NOW', topic: 't', text, status, note: null, whyNow: '', evidenceIds: [], atMs: 1, answer: null });
  assert.equal(lastQuestion({ ...base, conductorLeads: false, feed: [feedItem('1', 'answered', 'Asked once?'), feedItem('2', 'deferred', 'Kept for Reflect?')] }), 'Asked once?');
  assert.equal(methodBoxes(emptyInput()).every((b) => b.live === null && b.example.length > 0), true);
});
