// The declutter (UI focus): the page says each thing once. The current instruction is Clipa's bubble only; the status chips are in
// the Debug drawer and the page keeps a compact pill; the Start card is one button and one sentence; Clipa's card in the side
// column shows only for a real cue. Rendered with react-dom/server; the .tsx components load through the test-only esbuild hooks in
// journey/tsx-hooks.mjs, registered here before the dynamic imports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClipaStore } from '../clipa/presenter.ts';
import type { ClipaStore } from '../clipa/presenter.ts';
import { createConductorStore } from '../conductor/store.ts';
import type { ConductorStore } from '../conductor/store.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { Mode } from '../state/types.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
type Props = Record<string, unknown>;
const { StatusBar } = (await import('../components/StatusBar.tsx')) as { StatusBar: ComponentType };
const { StatusChips, StatusPanel } = (await import('../components/StatusChips.tsx')) as { StatusChips: ComponentType; StatusPanel: ComponentType };
const { SessionControls } = (await import('../components/SessionControls.tsx')) as { SessionControls: ComponentType };
const { ClipaNow } = (await import('../feed/ClipaNow.tsx')) as { ClipaNow: ComponentType<Props> };
const { JourneyRail } = (await import('../journey/JourneyRail.tsx')) as { JourneyRail: ComponentType };
const { LearnView } = (await import('../views/LearnView.tsx')) as { LearnView: ComponentType };

interface Rig { store: Store; conductor: ConductorStore; clipa: ClipaStore }
const rig = (): Rig => ({ store: createStore(), conductor: createConductorStore(), clipa: createClipaStore() });

function render(r: Rig, element: ReturnType<typeof createElement>): string {
  const controller = {
    store: r.store,
    conductorStore: r.conductor,
    setMode: (mode: Mode) => r.store.dispatch({ type: 'MODE_SET', mode }),
    isMicMuted: () => false,
    setMicMuted: () => {},
  };
  const runtime = { controller, clipa: r.clipa, workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, element));
}

function live(r: Rig, mode: Mode = 'learn'): void {
  const epochMs = Date.now() - 30_000;
  r.store.dispatch({ type: 'MODE_SET', mode });
  r.store.dispatch({
    type: 'SESSION_READY',
    session: { id: 'sess-1', mode, epochMs, legacyRoutes: false, deadlineMs: epochMs + SESSION_LIMIT_MS, clockSkewMs: null, conversationId: null },
  });
  r.conductor.set({ enabled: true, status: 'live' });
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const GUIDE = 'Press Start in Show, then share your whole screen and work as usual.';

test('the page keeps one status: a compact Recording pill while a session records, nothing before it', () => {
  const r = rig();
  assert.equal(render(r, createElement(StatusBar)), '', 'nothing to say before a session');
  live(r);
  const html = render(r, createElement(StatusBar));
  assert.match(html, /<p class="as-pill as-pill--rec" role="status" data-testid="status-pill" data-state="recording"><span class="as-pill__dot" aria-hidden="true"><\/span>Recording<\/p>/);
  assert.doesNotMatch(html, /as-chip|Screen|Voice|Session/, 'no chips on the page');
});

test('off the record stays in view as its own pill, instead of the Recording one', () => {
  const r = rig();
  live(r);
  r.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
  const html = render(r, createElement(StatusBar));
  assert.match(html, /data-testid="status-pill" data-state="off"/);
  assert.match(html, />Off the record</);
  assert.doesNotMatch(html, /Recording/);
});

test('the four chips (Screen, Voice, Session, Record) are in the Debug drawer\'s Status tab, each with its words', () => {
  const r = rig();
  live(r);
  const html = render(r, createElement(StatusChips));
  assert.match(html, /data-testid="status-chips"/);
  assert.deepEqual([...html.matchAll(/class="as-chip__label">([^<]+)</g)].map((m) => m[1]), ['Screen', 'Voice', 'Session', 'Record']);
  assert.match(html, /class="as-chip__value">on the record</);
  const panel = render(r, createElement(StatusPanel));
  assert.match(panel, /data-testid="status-panel"/);
  assert.match(panel, /data-testid="status-chips"/);
  const drawer = readFileSync(new URL('../components/DebugDrawer.tsx', import.meta.url), 'utf8');
  assert.match(drawer, /\{ id: 'status', label: 'Status' \},\s*\{ id: 'clipa'/, 'Status is the first tab');
  assert.match(drawer, /tab === 'status' && <StatusPanel \/>/);
});

test('the Start card: the button and one sentence; what recording means is folded into "Options and limits"', () => {
  const r = rig();
  const html = render(r, createElement(SessionControls));
  assert.match(html, />Start Show</);
  assert.match(html, /<p class="as-session__hint">Do the task and talk as you work\. Clipa asks at natural pauses\.<\/p>/);
  assert.equal(count(html, '<button'), 1);
  // The recording and privacy paragraph keeps its meaning but now sits inside the collapsed details, after the summary.
  const details = /<details class="as-details">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
  assert.match(details, /^<summary class="as-details__summary">Options and limits<\/summary>/);
  assert.match(details, /Start records the session&#x27;s events, transcript and audio on our server and opens the microphone\. <strong>Off the record<\/strong> stops\s+both channels; it does not recall what was already sent\./);
  assert.doesNotMatch(html.replace(/<details[\s\S]*?<\/details>/, ''), /Start records|as-disclosure/, 'it is not on the card any more');
  assert.doesNotMatch(html, /open=""/, 'the details are collapsed');
  // Off the record stays visible on the card.
  r.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
  assert.match(render(r, createElement(SessionControls)), /Off the record: nothing is captured, spoken or sent\./);
});

test('the other stages keep one sentence each under their Start button', () => {
  for (const [mode, sentence] of [['review', 'A spoken debrief: open questions, then a teach-back you confirm or correct.'], ['teach', 'A new hire works on a new case.']] as const) {
    const r = rig();
    r.store.dispatch({ type: 'MODE_SET', mode });
    assert.match(render(r, createElement(SessionControls)), new RegExp(`<p class="as-session__hint">${sentence}`));
  }
});

test('the instruction is Clipa\'s bubble only: the rail keeps "Clipa is with you" and carries the line for screen readers alone', () => {
  const r = rig();
  r.clipa.say(GUIDE);
  r.clipa.setGuide?.({ phase: 'learn', step: 'start', text: GUIDE });
  const html = render(r, createElement(JourneyRail));
  assert.match(html, /Clipa <span class="as-rail__state">is with you<\/span>/);
  assert.match(html, /<span class="as-rail__line as-sr" data-testid="clipa-line">Press Start in Show, then share your whole screen and work as usual\.<\/span>/);
  assert.equal(count(html, 'as-rail__line"'), 0, 'no visible caption line');
});

test('Clipa\'s card in the side column is hidden while it only repeats the guide, and shows for a real cue', () => {
  const r = rig();
  live(r);
  const idle = render(r, createElement(ClipaNow, { idle: 'Work as usual.' }));
  assert.match(idle, /data-kind="idle" hidden=""/, 'no cue: hidden');
  r.conductor.set({ line: { cueId: 'g1', kind: 'guide', text: GUIDE, step: 'start' } });
  const guide = render(r, createElement(ClipaNow, { idle: 'Work as usual.' }));
  assert.match(guide, /data-kind="guide" hidden=""/, 'the guide is in the bubble, not here');
  for (const kind of ['ask', 'warn', 'say', 'teachback'] as const) {
    r.conductor.set({ line: { cueId: `c-${kind}`, kind, text: `A ${kind} line.`, step: null } });
    const html = render(r, createElement(ClipaNow, { idle: '' }));
    assert.match(html, new RegExp(`data-kind="${kind}"`), kind);
    assert.doesNotMatch(html, /hidden=""/, `${kind} is a real cue: the card shows`);
  }
});

test('off the record hides the card too (the pill and the session card say so), and the in-browser brain\'s question shows it', () => {
  const r = rig();
  live(r);
  r.store.dispatch({ type: 'OFF_RECORD_SET', on: true });
  assert.match(render(r, createElement(ClipaNow, { idle: '' })), /data-kind="off" hidden=""/);

  const brain = rig();
  brain.store.dispatch({ type: 'MODE_SET', mode: 'learn' });
  brain.store.dispatch({
    type: 'FEED_ADD',
    item: { id: 'q1', decision: 'ASK_NOW', topic: 'reason', text: 'Why the address as text?', status: 'asked', note: null, whyNow: 'pause', evidenceIds: [], atMs: 1000, answer: null },
  });
  const html = render(brain, createElement(ClipaNow, { idle: 'Work as usual.' }));
  assert.match(html, /data-kind="ask"/);
  assert.doesNotMatch(html, /hidden=""/);
  assert.match(html, /Why the address as text\?/);
});

test('Show says the instruction once: with only the guide to say, the side column has no visible Clipa card or repeat', () => {
  const r = rig();
  live(r);
  r.conductor.set({ line: { cueId: 'g1', kind: 'guide', text: GUIDE, step: 'start' } });
  r.clipa.say(GUIDE);
  r.clipa.setGuide?.({ phase: 'learn', step: 'start', text: GUIDE });
  const view = render(r, createElement(LearnView));
  assert.match(view, /<section class="as-now" aria-label="Clipa now" data-testid="clipa-now"[^>]*hidden=""/);
  const rail = render(r, createElement(JourneyRail));
  // Outside the hidden card and the screen-reader copy, the sentence is on the page zero times: only the bubble (Clipa's layer) shows it.
  const visible = (html: string): string => html.replace(/<section class="as-now"[\s\S]*?<\/section>/g, '').replace(/<span class="as-rail__line as-sr"[\s\S]*?<\/span>/g, '');
  assert.equal(count(visible(view) + visible(rail), 'Press Start in Show'), 0);
});

test('the Screen card no longer repeats "Press Start first" (the bubble says it once)', () => {
  const source = readFileSync(new URL('../slots/ScreenSlot.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Press Start first/);
  assert.match(source, /\{live && \(/, 'the notes that carry information (masked frames, vision) stay while a session runs');
  assert.match(source, /Frames are masked here first, then read by vision on our server\./);
});

test('before Start the side column does not tell the person to start or share: the card is hidden and the feed only says what will appear', () => {
  const r = rig();
  const view = render(r, createElement(LearnView));
  const visible = view.replace(/<section class="as-now"[\s\S]*?<\/section>/g, '');
  assert.match(visible, /class="as-live__empty">Nothing yet\. Screen changes, questions and your answers will appear here\.</);
  assert.doesNotMatch(visible, /share your (whole )?screen|Press Start|start Show/i);
});
