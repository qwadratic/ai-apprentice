// The header with the journey rail, rendered with react-dom/server (TASK-3.47). The .tsx components load through the test-only
// esbuild hooks in journey/tsx-hooks.mjs, registered here before the dynamic imports.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClipaStore } from '../clipa/presenter.ts';
import type { ClipaStore } from '../clipa/presenter.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { Mode } from '../state/types.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { Header } = (await import('../components/Header.tsx')) as { Header: ComponentType<{ debugOpen: boolean; onToggleDebug: () => void }> };

function runtime(store: Store, clipa: ClipaStore, autoLead = true): ShellRuntime {
  const controller = {
    store,
    setMode: (mode: Mode) => store.dispatch({ type: 'MODE_SET', mode }),
    setPersona: () => {},
    isMicMuted: () => false,
    setMicMuted: () => {},
    isAutoLead: () => autoLead,
    setAutoLead: () => {},
    goOffRecord: async () => {},
    backOnRecord: () => {},
  };
  return { controller, clipa, workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
}

function render(store: Store = createStore(), clipa: ClipaStore = createClipaStore(), autoLead = true): string {
  return renderToStaticMarkup(
    createElement(ShellContext.Provider, { value: runtime(store, clipa, autoLead) }, createElement(Header, { debugOpen: false, onToggleDebug: () => {} })),
  );
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const tag = (html: string, id: string): string => new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

test('the header holds the logo, the rail and the tools; the rail is a tablist of three stages', () => {
  const html = render();
  assert.match(html, /<header class="as-header"/);
  assert.match(html, /class="as-logo" role="img" aria-label="Clipa"/);
  assert.match(html, /<svg class="as-logo__word" width="93" height="64"/, 'the logo is drawn 64 px tall');
  assert.match(html, /<nav class="as-rail" aria-label="Journey">/);
  assert.equal(count(html, 'role="tablist"'), 1);
  assert.equal(count(html, 'role="tab"'), 3);
  for (const name of ['Show', 'Reflect', 'Pass it on']) assert.match(html, new RegExp(`class="as-stage__name">${name}`));
  assert.match(html, /work as usual, I ask at pauses/);
  assert.match(html, />Off the record</);
  assert.match(html, />Debug</);
  assert.match(html, /<details class="as-menu">/, 'the tone sits in a small menu');
});

test('the header has the Lead me through switch: pressed when on, plain when off', () => {
  assert.match(render(), /class="as-btn as-btn--auto is-on" aria-pressed="true" data-testid="auto-lead"[^>]*>Lead me through: on</);
  assert.match(render(createStore(), createClipaStore(), false), /class="as-btn as-btn--auto" aria-pressed="false" data-testid="auto-lead"[^>]*>Lead me through: off</);
});

test('the selected stage is the only tab stop, controls its panel and carries Clipa\'s seat', () => {
  const html = render();
  const show = tag(html, 'as-tab-learn');
  assert.match(show, /aria-selected="true"/);
  assert.match(show, /tabindex="0"/);
  assert.match(show, /aria-controls="as-mode-panel-learn"/);
  assert.match(show, /data-status="next"/);
  assert.match(tag(html, 'as-tab-review'), /tabindex="-1"/);
  assert.match(tag(html, 'as-tab-teach'), /aria-selected="false"/);
  assert.equal(count(html, 'data-clipa-dock=""'), 1, 'one seat for Clipa');
  assert.match(html, /class="as-stage__node" data-clipa-dock="" data-clipa-target="mode_tab"/, 'the seat is on the selected stage, which is also next');
  assert.equal(count(html, 'data-clipa-target="stage-'), 3);
  assert.match(html, /Clipa <span class="as-rail__state">is with you<\/span>/);
});

test('a mode change moves the seat; a live session shows on its stage; Clipa\'s line replaces the hint', () => {
  const store = createStore();
  store.dispatch({ type: 'MODE_SET', mode: 'review' });
  const clipa = createClipaStore();
  clipa.setState('listening');
  clipa.say('Why did you write it as text?');
  const html = render(store, clipa);
  assert.match(tag(html, 'as-tab-review'), /aria-selected="true"/);
  assert.match(html, /id="as-tab-review"[\s\S]*?<span class="as-stage__node" data-clipa-dock="">/);
  assert.match(html, /is listening/);
  assert.match(html, /data-testid="clipa-line">Why did you write it as text\?</);
  assert.doesNotMatch(html, /as-stage__live/);
});

test('the conductor\'s guide (store.setGuide) marks its stage next and speaks under the rail; a live session shows on its stage', () => {
  const store = createStore();
  store.dispatch({ type: 'SESSION_STARTING', mode: 'learn' });
  store.dispatch({ type: 'SESSION_READY', session: { id: 's-1', mode: 'learn', epochMs: 0, legacyRoutes: false, deadlineMs: 1, clockSkewMs: null, conversationId: null } });
  assert.equal(store.getState().phase, 'live');
  const clipa = createClipaStore();
  clipa.setGuide?.({ phase: 'teach', step: 'teach_start', text: 'Hand over to the new hire.' });
  const html = render(store, clipa);
  assert.match(tag(html, 'as-tab-learn'), /data-status="active"/);
  assert.match(tag(html, 'as-tab-learn'), /data-wire="live"/);
  assert.match(html, /id="as-tab-learn"[\s\S]*?<span class="as-stage__live" aria-hidden="true">live<\/span>/);
  assert.match(tag(html, 'as-tab-review'), /data-status="open"/);
  assert.match(tag(html, 'as-tab-teach'), /data-status="next"/);
  assert.match(html, /data-testid="clipa-line">Hand over to the new hire\.</);
  clipa.setGuide?.(null);
  assert.match(render(store, clipa), /data-testid="clipa-line">Share your screen and work as usual/);
});
