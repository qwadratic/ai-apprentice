// Component tests: the board rendered to static markup with react-dom/server (run with --import ./register.mjs for .tsx).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkMapBoard } from '../WorkMapBoard.tsx';
import type { WorkMapBoardProps } from '../WorkMapBoard.tsx';
import { snapshot } from './fixtures.ts';

function render(stage: 'draft' | 'confirmed', extra: Partial<WorkMapBoardProps> = {}): string {
  const s = snapshot(stage);
  const props: WorkMapBoardProps = { map: s.map, observations: s.observations, evidence: s.evidence, gaps: s.gaps, blockers: s.blockers, ...extra };
  return renderToStaticMarkup(createElement(WorkMapBoard, props));
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const countValue = (html: string, name: string): string | null => new RegExp(`data-count="${name}">(\\d+)<`).exec(html)?.[1] ?? null;

test('the board root is the Clipa target and the header shows the counts and version', () => {
  const html = render('draft');
  assert.equal(count(html, 'data-clipa-target="review-board"'), 1);
  assert.equal(countValue(html, 'steps'), '6');
  assert.equal(countValue(html, 'judgment-calls'), '3');
  assert.equal(countValue(html, 'guardrails'), '2');
  assert.equal(countValue(html, 'open-gaps'), '4');
  assert.match(html, /Map v1 · draft/);
  assert.match(render('confirmed'), /Map v2 · confirmed/);
});

test('keyframes render in time order with mm:ss times and the "What the agent saw" facts', () => {
  const html = render('draft');
  const times = [...html.matchAll(/data-at-ms="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(times.length >= 6);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.match(html, /What the agent saw/);
  assert.match(html, /<dt>customerRef<\/dt><dd>customer_07<\/dd>/);
  assert.match(html, /Image attachment removed/);
  assert.match(html, /00:11/);
});

test('three card kinds: steps, guardrails and gaps', () => {
  const html = render('draft');
  assert.equal(count(html, 'data-card="step:'), 6);
  assert.equal(count(html, 'data-card="guardrail:'), 2);
  assert.equal(count(html, 'data-card="gap:'), 4);
  assert.match(html, /wm-card--judgment/);
  assert.match(html, /Customer_07 asked me for it in writing/);
  assert.match(html, /Expert · 00:12/);
});

test('only the first open gap is the board-gap target; no gaps once confirmed', () => {
  const html = render('draft');
  assert.equal(count(html, 'data-clipa-target="board-gap"'), 1);
  const first = /<article[^>]*data-card="gap:([^"]+)"[^>]*data-clipa-target="board-gap"/.exec(html);
  assert.equal(first?.[1], 'q-R-1');
  const done = render('confirmed');
  assert.equal(count(done, 'data-clipa-target="board-gap"'), 0);
  assert.equal(count(done, 'data-card="gap:'), 0);
});

test('an item without evidence or quote shows the validator message and a disabled confirm hook', () => {
  const html = render('confirmed', { onConfirmRequest: () => {} });
  assert.match(html, /Cannot be confirmed:<\/strong> guardrail g3 lacks evidence/);
  const g3 = /<article[^>]*data-card="guardrail:g3"[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
  assert.match(g3, /<button type="button" class="wm-btn" disabled="">Confirm in Review<\/button>/);
  assert.match(g3, /Reason unknown: kept as a habit/);
  const g1 = /<article[^>]*data-card="guardrail:g1"[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
  assert.doesNotMatch(g1, /Cannot be confirmed/);
  assert.doesNotMatch(g1, /Confirm in Review/, 'a confirmed item offers no confirm hook');
});

test('synthetic labels: the session badge only when the data is synthetic', () => {
  assert.match(render('draft', { synthetic: true }), /Synthetic session/);
  assert.doesNotMatch(render('draft'), /Synthetic session/);
});

test('without resolved media every thumbnail is an honest placeholder', () => {
  const html = render('draft');
  assert.ok(count(html, 'Frame unavailable') > 0);
  assert.equal(count(html, '<img'), 0);
});

test('an initial selection marks the card and its frames', () => {
  const html = render('draft', { initialSelection: 'step:step-4' });
  assert.match(html, /class="wm-card wm-card--step wm-card--judgment is-selected"[^>]*data-card="step:step-4"/);
  assert.match(html, /class="wm-frame is-related[^"]*" data-frame-id="obs-005"/);
});
