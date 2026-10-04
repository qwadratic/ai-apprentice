// Clipa feels alive on the web: the new conductor cues are read leniently, the thought bubble renders (react-dom/server) and
// sits beside Clipa inside the viewport, and the drift toward the cursor is damped and capped.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DRIFT, driftStep, driftTarget } from '../clipa/drift.ts';
import { parseCue } from '../conductor/protocol.ts';
import { createConductorStore } from '../conductor/store.ts';
import type { ConductorStore } from '../conductor/store.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { ClipaThought, thoughtPosition } = (await import('../conductor/ClipaThought.tsx')) as {
  ClipaThought: ComponentType;
  thoughtPosition: (clipa: { left: number; top: number; width: number; height: number }, bubble: { w: number; h: number }, viewport: { w: number; h: number }) => { left: number; top: number; side: string };
};

function render(store: ConductorStore): string {
  const runtime = { controller: { conductorStore: store } } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, createElement(ClipaThought)));
}

test('the new cues are read leniently: thought, attention and stage', () => {
  assert.deepEqual(parseCue({ type: 'thought', text: '  Looking at Mail  ' }), { type: 'thought', text: 'Looking at Mail' });
  assert.equal(parseCue({ type: 'thought', text: '   ' }), null);
  assert.deepEqual(parseCue({ type: 'attention', target: { kind: 'ui', name: 'mode_tab', mode: 'teach' } }), { type: 'attention', target: { kind: 'ui', name: 'mode_tab', mode: 'teach' } });
  assert.deepEqual(parseCue({ type: 'attention' }), { type: 'attention', target: null });
  assert.deepEqual(parseCue({ type: 'stage', mode: 'review' }), { type: 'stage', mode: 'review' });
  assert.equal(parseCue({ type: 'stage', mode: 'summary' }), null);
});

test('the thought bubble renders the thought in italic beside Clipa, hidden from screen readers; nothing when empty or paused', () => {
  const store = createConductorStore();
  assert.equal(render(store), '');
  store.set({ thought: { cueId: 'c7-abc', text: 'Putting your map together…' } });
  const html = render(store);
  assert.match(html, /class="as-thought"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Putting your map together…/);
  assert.equal(html.split('as-thought__dot--').length - 1, 2, 'two trailing dots');
  store.set({ paused: true });
  assert.equal(render(store), '', 'off the record: no thought');
});

test('the thought bubble goes above Clipa on the side with room, inside the viewport', () => {
  const viewport = { w: 1200, h: 800 };
  const bubble = { w: 200, h: 30 };
  const docked = thoughtPosition({ left: 1100, top: 700, width: 77, height: 96 }, bubble, viewport);
  assert.equal(docked.side, 'left');
  assert.ok(docked.left + bubble.w <= 1100 + 77 && docked.top + bubble.h <= 700, 'above-left of her head');
  const leftEdge = thoughtPosition({ left: 4, top: 300, width: 77, height: 96 }, bubble, viewport);
  assert.equal(leftEdge.side, 'right');
  assert.ok(leftEdge.left >= 8);
  const top = thoughtPosition({ left: 600, top: 2, width: 77, height: 96 }, bubble, viewport);
  assert.ok(top.top >= 2 + 96, 'below her when there is no room above');
});

test('drift: toward the cursor, capped, heavily damped, zero without a cursor', () => {
  const rest = { x: 1000, y: 700 };
  const far = driftTarget(rest, { x: 0, y: 700 });
  assert.ok(Math.abs(far.x + DRIFT.maxPx) < 1e-9 && far.y === 0, 'a far cursor pulls her to the cap, never further');
  const near = driftTarget(rest, { x: 1000, y: 600 });
  assert.ok(Math.abs(near.y + 10) < 1e-9, 'a near cursor pulls her only a little');
  assert.deepEqual(driftTarget(rest, null), { x: 0, y: 0 });
  let offset = { x: 0, y: 0 };
  const frames: number[] = [];
  for (let i = 0; i < 180; i++) { offset = driftStep(offset, far, 16); frames.push(offset.x); }
  assert.ok(frames.every((x, i) => i === 0 || x <= frames[i - 1]!), 'moves one way only: no jitter, no overshoot');
  assert.ok(frames.every((x) => x >= far.x), 'never past the cap');
  assert.ok(Math.abs(frames[5]!) < DRIFT.maxPx * 0.2, 'heavily damped: slow to start');
  assert.ok(Math.abs(frames.at(-1)! - far.x) < 1.5, 'there within about three seconds');
});
