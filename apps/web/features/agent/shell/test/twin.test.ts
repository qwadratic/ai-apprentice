// The email digital twin ("Northwind Mail"): the link to it in the start panel, the static page itself (self-contained, nothing
// sent or stored), and the way Clipa's "recognised" cue reaches the page: parsed, kept by the face without a word, listed in the feed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClipaStore } from '../clipa/presenter.ts';
import { ConductorFace } from '../conductor/face.ts';
import type { FaceHost } from '../conductor/face.ts';
import { parseCue, parseCueEnvelope } from '../conductor/protocol.ts';
import type { ClientEvent } from '../conductor/protocol.ts';
import { MAX_RECOGNISED, createConductorStore } from '../conductor/store.ts';
import type { ConductorStore, RecognisedItem } from '../conductor/store.ts';
import { FEED_LABEL, collectFeed } from '../feed/model.ts';
import type { FeedSources } from '../feed/model.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { Mode } from '../state/types.ts';
import { TWIN_MAIL_URL } from '../twin.ts';
import { FakeTimers } from './helpers.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
type Props = Record<string, unknown>;
const { SessionControls } = (await import('../components/SessionControls.tsx')) as { SessionControls: ComponentType };
const { LiveFeed } = (await import('../feed/LiveFeed.tsx')) as { LiveFeed: ComponentType<Props> };

interface Rig { store: Store; conductor: ConductorStore }
const rig = (): Rig => ({ store: createStore(), conductor: createConductorStore() });

function render(r: Rig, element: ReturnType<typeof createElement>): string {
  const controller = { store: r.store, conductorStore: r.conductor, isMicMuted: () => false, setMicMuted: () => {} };
  const runtime = { controller, clipa: createClipaStore(), workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, element));
}

/** A live stage that started `agoMs` ago, with the conductor leading. */
function live(r: Rig, mode: Mode = 'learn', agoMs = 60_000): void {
  const epochMs = Date.now() - agoMs;
  r.store.dispatch({ type: 'MODE_SET', mode });
  r.store.dispatch({
    type: 'SESSION_READY',
    session: { id: 'sess-1', mode, epochMs, legacyRoutes: false, deadlineMs: epochMs + SESSION_LIMIT_MS, clockSkewMs: null, conversationId: null },
  });
  r.conductor.set({ enabled: true, status: 'live' });
}

// ---- the link ------------------------------------------------------------------------------------------------------------------
test('the start panel offers the email twin in a new tab, in "Options and limits", for every stage', () => {
  assert.equal(TWIN_MAIL_URL, '/twin/mail/index.html', 'built from the Vite base (the root here)');
  for (const mode of ['learn', 'review', 'teach'] as const) {
    const r = rig();
    r.store.dispatch({ type: 'MODE_SET', mode });
    const html = render(r, createElement(SessionControls));
    assert.match(html, /<a class="as-twin-link" data-testid="twin-link" href="\/twin\/mail\/index\.html" target="_blank" rel="noopener noreferrer">Open the email twin in a new tab<\/a>/, mode);
    assert.ok(html.indexOf('Options and limits') < html.indexOf('data-testid="twin-link"'), `${mode}: inside the collapsed options`);
    assert.match(html, /synthetic data; Send is simulated\)/, mode);
  }
});

// ---- the page itself -----------------------------------------------------------------------------------------------------------
const twinFile = (name: string): string => readFileSync(new URL(`../../../../public/twin/mail/${name}`, import.meta.url), 'utf8');

test('the twin is a self-contained static page: no framework, no network, nothing stored, synthetic and labelled so', () => {
  const html = twinFile('index.html');
  const js = twinFile('twin.js');
  const css = twinFile('twin.css');
  assert.match(html, /<title>Northwind Mail<\/title>/);
  assert.match(html, /<footer class="footer">Digital twin · synthetic data<\/footer>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/twin\.css">/, 'relative assets: it works under any base path');
  assert.match(html, /<script src="\.\/twin\.js"><\/script>/);
  for (const field of ['to', 'subject', 'body']) assert.match(html, new RegExp(`data-field="${field}"`), field);
  assert.match(html, /data-action="preview">Preview</);
  assert.match(html, /data-action="send">Send</);
  assert.match(html, /id="chips"/, 'an attachment chip row');
  assert.match(html, /role="status"/, 'the toast is announced');
  for (const [name, source] of [['index.html', html], ['twin.js', js], ['twin.css', css]] as const) {
    assert.doesNotMatch(source, /https?:\/\//i, `${name}: no external address`);
    assert.doesNotMatch(source, /@import|url\(\s*['"]?(?!data:)/i, `${name}: no external stylesheet or image`);
  }
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.|import\s*\(|\beval\s*\(/, 'no network');
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State/, 'nothing stored, nothing in the URL');
  assert.doesNotMatch(html + js, /<script[^>]+src="https?:|gmail|google/i);
  assert.match(js, /Sent \(simulated\)/);
});

test('the twin has the four cases, by menu and by ?case=', () => {
  const js = twinFile('twin.js');
  assert.match(js, /new URLSearchParams\(window\.location\.search\)\.get\('case'\)/);
  const cases: Array<[RegExp, string]> = [
    [/id: 'a'[^}]*to: 'billing@lumen-bakery\.example', subject: 'Invoice INV-2231'/s, 'a: invoice to Lumen Bakery'],
    [/Payment terms: Net 14\.',\s*attachments: \[\{ name: 'INV-2231\.pdf'/, 'a: the body ends with the terms'],
    [/id: 'b'[^}]*to: 'billing@north-pier\.example', subject: 'Invoice INV-2232'/s, 'b: invoice to North Pier'],
    [/id: 'c'[^}]*to: 'customer_07', subject: 'Delivery update[^']*', body: '',\s*attachments: \[\{ name: 'delivery-summary\.png'/s, 'c: delivery update, empty message, one image'],
    [/id: 'd', label: '\(d\) Blank compose', to: '', subject: '', body: '', attachments: \[\]/, 'd: blank'],
  ];
  for (const [pattern, what] of cases) assert.match(js, pattern, what);
  // Both invoice cases end in Net 14: (b) is the case where nothing has to change.
  assert.equal(js.match(/Payment terms: Net 14\./g)?.length, 2);
});

// ---- the recognised cue --------------------------------------------------------------------------------------------------------
test('parseCue: a recognised cue is read leniently; one without a title is ignored', () => {
  assert.deepEqual(parseCue({ type: 'recognised', title: 'Invoice email: payment terms', text: 'Recognised: Invoice email: payment terms (from an earlier session)', steps: 4, rules: 1, synthetic: true }), {
    type: 'recognised', title: 'Invoice email: payment terms', text: 'Recognised: Invoice email: payment terms (from an earlier session)', steps: 4, rules: 1, synthetic: true,
  });
  assert.deepEqual(parseCue({ type: 'recognised', title: 'X', steps: -3, rules: 'many', extra: 1 }), { type: 'recognised', title: 'X', text: 'Recognised: X', steps: 0, rules: 0, synthetic: false });
  assert.equal(parseCue({ type: 'recognised', title: '   ', text: 'x' }), null);
  assert.equal(parseCue({ type: 'recognised', text: 'x' }), null);
  const env = parseCueEnvelope({ seq: 3, cueId: 'c3', for: 'web', cue: { type: 'recognised', title: 'X', text: 'Recognised: X', steps: 1, rules: 0, synthetic: false } });
  assert.equal(env?.cue.type, 'recognised');
  assert.equal(env?.for, 'web');
});

function faceRig() {
  const timers = new FakeTimers();
  const store = createConductorStore();
  const sent: ClientEvent[] = [];
  const spoken: string[] = [];
  const logs: Array<[string, string]> = [];
  const host: FaceHost = {
    speak: (text) => { spoken.push(text); return true; },
    context: () => {},
    personBusy: () => false,
    present: () => {},
    guide: () => {},
    pose: () => {},
    log: (type, text) => { logs.push([type, text]); },
    sessionNow: () => 0,
    now: () => timers.now,
    send: (e) => { sent.push(e); },
    timers,
  };
  return { face: new ConductorFace(host, store), store, sent, spoken, logs };
}
const envelope = (seq: number, cue: Record<string, unknown>) => ({
  seq, cueId: `c${seq}`, atMs: seq * 1000, mode: 'learn' as const, persona: 'expert' as const, for: 'web' as const, expiresAtMs: null, cue,
}) as unknown as Parameters<ConductorFace['onCue']>[0];
const recognised = (title: string, synthetic = true) => ({ type: 'recognised', title, text: `Recognised: ${title} (from an earlier session)`, steps: 4, rules: 1, synthetic });

test('face: a recognised cue is kept for the feed and never spoken, never answered, never put in Clipa\'s bubble', () => {
  const r = faceRig();
  r.face.onCue(envelope(1, recognised('Invoice email: payment terms')));
  assert.deepEqual(r.store.getState().recognised, [{ cueId: 'c1', title: 'Invoice email: payment terms', atMs: 1000, steps: 4, rules: 1, synthetic: true }]);
  assert.deepEqual(r.spoken, [], 'silent');
  assert.deepEqual(r.sent, [], 'there is nothing to report back about it');
  assert.equal(r.store.getState().line, null, 'not a line of Clipa\'s own');
  assert.deepEqual(r.logs, [['RECOGNISED', 'Invoice email: payment terms']]);
  // Replayed history and the off-the-record pause keep nothing.
  r.face.historyUntil = 5;
  r.face.onCue(envelope(3, recognised('Replayed')));
  r.face.historyUntil = -1;
  r.store.set({ paused: true });
  r.face.onCue(envelope(6, recognised('Off the record')));
  assert.deepEqual(r.store.getState().recognised.map((x) => x.title), ['Invoice email: payment terms']);
});

test('face: the newest recognised items are kept, up to a cap', () => {
  const r = faceRig();
  for (let i = 1; i <= MAX_RECOGNISED + 3; i++) r.face.onCue(envelope(i, recognised(`Process ${i}`)));
  const titles = r.store.getState().recognised.map((x) => x.title);
  assert.equal(titles.length, MAX_RECOGNISED);
  assert.equal(titles.at(-1), `Process ${MAX_RECOGNISED + 3}`);
  assert.equal(titles[0], 'Process 4');
});

// ---- the feed ------------------------------------------------------------------------------------------------------------------
const EPOCH = 1_000_000;
const NOW = EPOCH + 120_000;
const feedSources = (recognisedItems: readonly RecognisedItem[]): FeedSources => ({
  session: { epochMs: EPOCH, deadlineMs: EPOCH + SESSION_LIMIT_MS },
  observations: [], questions: [], said: [{ cueId: 'a1', kind: 'ask', text: 'Why Net 30?', atMs: 80_000, outcome: 'spoken' }], events: [], checkpoint: null, mapChanges: [],
  conductorLeads: true, recognised: recognisedItems,
});

test('feed: a recognised process is one line "Recognised", from an earlier session, marked synthetic when the session was seeded', () => {
  assert.equal(FEED_LABEL.recognised, 'Recognised');
  const entries = collectFeed(feedSources([
    { cueId: 'c1', title: 'Invoice email: payment terms', atMs: 30_000, steps: 4, rules: 1, synthetic: true },
    { cueId: 'c2', title: 'Budget update', atMs: 50_000, steps: 2, rules: 1, synthetic: false },
  ]), NOW);
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['ask', 'Why Net 30?'],
    ['recognised', 'Budget update (from an earlier session)'],
    ['recognised', 'Invoice email: payment terms (from an earlier session)'],
  ]);
  assert.equal(entries[2]?.synthetic, true);
  assert.equal(entries[1]?.synthetic, undefined, 'a real earlier session is not labelled synthetic');
  assert.deepEqual(collectFeed(feedSources([]), NOW).map((e) => e.kind), ['ask']);
});

test('the live feed shows "Recognised: <process> (from an earlier session)" with a Synthetic data tag for a seeded one', () => {
  const r = rig();
  live(r);
  r.conductor.set({ recognised: [{ cueId: 'c1', title: 'Invoice email: payment terms', atMs: 20_000, steps: 4, rules: 1, synthetic: true }] });
  const html = render(r, createElement(LiveFeed, { empty: 'empty' }));
  assert.match(html, /<li class="as-live__item[^"]*" data-kind="recognised"/);
  assert.match(html, /class="as-live__label">Recognised<\/span>/);
  assert.match(html, /class="as-live__text">Invoice email: payment terms \(from an earlier session\)<\/p>/);
  assert.match(html, /as-tag--warn">Synthetic data</);
  // A process from a real session carries no synthetic tag.
  const real = rig();
  live(real);
  real.conductor.set({ recognised: [{ cueId: 'c1', title: 'Budget update', atMs: 20_000, steps: 2, rules: 1, synthetic: false }] });
  const realHtml = render(real, createElement(LiveFeed, { empty: 'empty' }));
  assert.match(realHtml, /data-kind="recognised"/);
  assert.doesNotMatch(realHtml, /Synthetic data/);
});
