// The live feed and the stage views, rendered with react-dom/server (TASK-3.51). The .tsx components load through the test-only
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
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { Mode } from '../state/types.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
type Props = Record<string, unknown>;
const { LiveFeed } = (await import('../feed/LiveFeed.tsx')) as { LiveFeed: ComponentType<Props> };
const { ClipaNow } = (await import('../feed/ClipaNow.tsx')) as { ClipaNow: ComponentType<Props> };
const { LearnView } = (await import('../views/LearnView.tsx')) as { LearnView: ComponentType };
const { TeachView } = (await import('../views/TeachView.tsx')) as { TeachView: ComponentType };
const { ReviewView } = (await import('../views/ReviewView.tsx')) as { ReviewView: ComponentType };
const { SessionControls } = (await import('../components/SessionControls.tsx')) as { SessionControls: ComponentType };

interface Rig { store: Store; conductor: ConductorStore }

function rig(): Rig {
  return { store: createStore(), conductor: createConductorStore() };
}

function render(r: Rig, element: ReturnType<typeof createElement>): string {
  const controller = { store: r.store, conductorStore: r.conductor };
  const runtime = { controller, clipa: createClipaStore(), workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, element));
}

/** A live stage that started `agoMs` ago, with the conductor leading. */
function live(r: Rig, mode: Mode = 'learn', agoMs = 60_000): number {
  const epochMs = Date.now() - agoMs;
  r.store.dispatch({ type: 'MODE_SET', mode });
  r.store.dispatch({
    type: 'SESSION_READY',
    session: { id: 'sess-1', mode, epochMs, legacyRoutes: false, deadlineMs: epochMs + SESSION_LIMIT_MS, clockSkewMs: null, conversationId: null },
  });
  r.conductor.set({ enabled: true, status: 'live' });
  return epochMs;
}

function observe(r: Rig, n: number, synthetic = false): void {
  for (let i = 0; i < n; i += 1) {
    r.store.dispatch({
      type: 'OBSERVATION',
      row: { id: `o${i}`, sequence: i, timestampMs: 1000 * (i + 1), kind: 'screen_activity', source: 'vision', synthetic, summary: `Screen change ${i}`, evidenceIds: [] },
    });
  }
}

const said = (cueId: string, kind: SaidItem['kind'], text: string, atMs: number): SaidItem => ({ cueId, kind, text, atMs, outcome: 'spoken' });
const count = (html: string, needle: string): number => html.split(needle).length - 1;

test('before a stage starts the feed says what to do next, in one line', () => {
  const html = render(rig(), createElement(LiveFeed, { empty: 'Nothing yet: start Show and share your screen.' }));
  assert.match(html, /data-testid="live-feed"/);
  assert.match(html, /data-running="false"/);
  assert.match(html, /class="as-live__empty">Nothing yet: start Show and share your screen\.</);
  assert.match(html, />Not running</);
  assert.doesNotMatch(html, /as-live__list/);
});

test('a running stage: newest on top, five items, the rest behind "+N earlier", a live dot and relative times', () => {
  const r = rig();
  live(r);
  observe(r, 6);
  r.conductor.set({ said: [said('c1', 'ask', 'Why the address as text?', 59_000)] });
  r.store.dispatch({ type: 'LOG', t: Date.now() - 2000, dir: 'recv', logType: 'USER', text: 'She reads mail on her phone.' });
  const html = render(r, createElement(LiveFeed, { empty: 'empty' }));
  assert.match(html, /data-running="true"/);
  assert.match(html, /<span class="as-live__dot" aria-hidden="true"><\/span>Live</);
  assert.equal(count(html, '<li class="as-live__item'), 5);
  assert.match(html, />\+3 earlier</);
  assert.match(html, /class="as-live__label">You said<\/span>/);
  assert.match(html, /<q>She reads mail on her phone\.<\/q>/);
  const first = /<li class="as-live__item[^"]*" data-kind="(\w+)"/.exec(html);
  assert.equal(first?.[1], 'ask', 'the question is the newest item');
  assert.match(html, /<li class="as-live__item is-fresh" data-kind="ask"/, 'the newest item is lit');
  assert.equal(count(html, 'is-fresh'), 1, 'only the newest item is lit');
  assert.match(html, /<time class="as-live__time">now<\/time>/);
  assert.match(html, /<time class="as-live__time">5\d s<\/time>/, 'older items show seconds');
  assert.match(html, /class="as-live__label">Clipa asked</);
  assert.match(html, /class="as-live__label">Screen</);
  assert.match(html, /<svg class="as-icon"/);
  assert.match(html, /aria-live="polite"/);
});

test('invented observations are labelled Synthetic data', () => {
  const r = rig();
  live(r);
  observe(r, 2, true);
  assert.match(render(r, createElement(LiveFeed, { empty: '' })), /as-tag--warn">Synthetic data</);
});

test('off the record greys the feed and says nothing new is captured', () => {
  const r = rig();
  live(r);
  observe(r, 1);
  r.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
  const html = render(r, createElement(LiveFeed, { empty: '' }));
  assert.match(html, /data-running="false" data-off-record="true"/);
  assert.match(html, />Off the record</);
  assert.match(html, /Nothing new is captured while you are off the record\./);
});

test('Clipa\'s line: the conductor\'s current line, else the next step in one line', () => {
  const r = rig();
  live(r);
  assert.match(render(r, createElement(ClipaNow, { idle: 'Work as usual.' })), /as-now__line as-now__line--idle"[^>]*>Work as usual\.</);
  r.conductor.set({ line: { cueId: 'c9', kind: 'ask', text: 'Why did you paste the address?', step: null }, pose: 'speak' });
  const html = render(r, createElement(ClipaNow, { idle: 'Work as usual.' }));
  assert.match(html, /data-tone="speak" data-kind="ask"/);
  assert.match(html, /class="as-now__state">speaking</);
  assert.match(html, /class="as-now__line"[^>]*>Why did you paste the address\?</);
  r.conductor.set({ line: { cueId: 'c10', kind: 'teachback', text: 'A long teach-back. '.repeat(40), step: null } });
  const tb = render(r, createElement(ClipaNow, { idle: '' }));
  assert.match(tb, />Here is what I understood\. Confirm it or correct it\.</, 'the teach-back itself stays in its card');
  assert.doesNotMatch(tb, /A long teach-back/);
});

test('Show: Clipa\'s line and the live feed; the long lists are gone from the main view', () => {
  const r = rig();
  live(r);
  observe(r, 3);
  const html = render(r, createElement(LearnView));
  assert.match(html, /data-testid="clipa-now"/);
  assert.match(html, /data-testid="live-feed"/);
  assert.doesNotMatch(html, /What the screen showed/);
  assert.doesNotMatch(html, /What Clipa asked/);
  assert.doesNotMatch(html, /sess-1/, 'no session id in the main view');
});

test('Pass it on: a warning before Send is the column\'s main card', () => {
  const r = rig();
  live(r, 'teach');
  r.store.dispatch({
    type: 'CHECKPOINT_RESULT',
    card: { checkpointId: 'cp1', status: 'warn', message: 'Customer 07 wants the address as text.', evidenceIds: [], atMs: 50_000, deliveryError: null },
  });
  const html = render(r, createElement(TeachView));
  assert.match(html, /class="as-alert as-alert--warn"/);
  assert.match(html, /class="as-alert__title" id="as-cp-title">Stop before you send</);
  assert.match(html, /Customer 07 wants the address as text\./);
  assert.match(html, /data-testid="teach-honesty"/, 'the honest limit stays');
  assert.ok(html.indexOf('as-alert') < html.indexOf('data-testid="live-feed"'), 'the warning comes before the feed');
});

test('Reflect: the open questions and the teach-back first, then the board; no version in the main view', () => {
  const r = rig();
  live(r, 'review');
  r.conductor.set({
    map: {
      version: 3,
      confirmed: false,
      map: {
        steps: [{ id: 's1', goal: 'Copy the address into the email', action: 'paste', evidenceIds: [] }],
        guardrails: [{ id: 'g1', condition: 'Customer 07', requiredAction: 'address as text', evidenceIds: [] }],
        gaps: [{ id: 'gap-1', text: 'Is an extra image still fine?' }],
        teachBack: 'For customer 07 you copy the address as text.',
      },
    },
  });
  const html = render(r, createElement(ReviewView));
  assert.match(html, /data-testid="view-review-conductor"/);
  assert.match(html, /class="as-focus"/);
  assert.match(html, /Teach-back/);
  assert.match(html, /For customer 07 you copy the address as text\./);
  assert.match(html, />Confirm</);
  assert.doesNotMatch(html, /version 3/i, 'the map version is in Debug');
});

test('the session card has one main button and no session id', () => {
  const r = rig();
  live(r);
  const html = render(r, createElement(SessionControls));
  assert.match(html, /End Show/);
  assert.doesNotMatch(html, /sess-1/);
  assert.match(html, /Off the record<\/strong> stops/);
  assert.equal(count(html, '<button'), 1);
});
