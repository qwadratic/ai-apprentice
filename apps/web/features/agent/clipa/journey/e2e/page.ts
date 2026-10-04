/*
 * The page of the browser check (run.ts): the real Clipa director and the real journey engine on a stand-in for the
 * shell (the same data-clipa-target attributes). The runner emits the shell's events through window.journeyE2E.bus and
 * reads back what Clipa actually did in the DOM.
 */
import { createClipaDirector } from '../../src/index.ts';
import type { ClipaDecision, ClipaDirector, ClipaEvent, ClipaLogEntry } from '../../src/index.ts';
import {
  JOURNEY_STORAGE_KEY,
  createDomTargetResolver,
  createJourney,
  createJourneyEventBus,
  createJourneyTargetResolver,
  journeyTargets,
} from '../index.ts';
import type { Journey, JourneyEventBus } from '../index.ts';

interface BoxJson {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RecordedEvent {
  t: number;
  event: ClipaEvent;
  /** The person was typing (or had typed in the last 1.2 s) when this happened. */
  typing: boolean;
}

export interface JourneyE2E {
  bus: JourneyEventBus;
  journey: Journey;
  director: ClipaDirector;
  said: string[];
  logs: ClipaLogEntry[];
  events: RecordedEvent[];
  ask(text: string, hint: string): Promise<unknown>;
  snapshot(): string;
}

declare global {
  interface Window {
    journeyE2E?: JourneyE2E;
  }
}

const box = (el: Element | null): BoxJson | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
};

const TYPING_QUIET_MS = 1200;
let lastKeyAt = Number.NEGATIVE_INFINITY;
let typingTimer = 0;
const isTyping = (): boolean => performance.now() - lastKeyAt < TYPING_QUIET_MS;

const byValue = createDomTargetResolver(document);
const bus = createJourneyEventBus();
const logs: ClipaLogEntry[] = [];
const events: RecordedEvent[] = [];
const said: string[] = [];

const director = createClipaDirector({
  root: document.body,
  dock: 'bottom-right',
  resolveTarget: createJourneyTargetResolver(byValue),
  isInputActive: isTyping,
  onLog: (entry) => logs.push(entry),
});
director.subscribe((event) => events.push({ t: performance.now(), event, typing: isTyping() }));

const journey = createJourney({
  director,
  events: bus,
  resolveTarget: byValue,
  capabilities: { screen: true, camera: false },
  isSynthetic: () => false,
  quietSettleMs: 300,
  agentQuietMs: 600,
  onSay: (line) => said.push(line),
});

// Real key presses are the shell's `typing` event: true on the first key, false after a quiet moment.
document.addEventListener(
  'keydown',
  () => {
    lastKeyAt = performance.now();
    bus.emit({ type: 'typing', active: true });
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => bus.emit({ type: 'typing', active: false }), TYPING_QUIET_MS);
  },
  true,
);

function snapshot(): string {
  const snap = journey.getSnapshot();
  const targets: Record<string, BoxJson | null> = {};
  for (const name of journeyTargets()) targets[name] = box(document.querySelector(`[data-clipa-target="${name}"]`));
  return JSON.stringify({
    step: snap.stepId,
    done: snap.done,
    variant: snap.variant,
    runId: snap.runId,
    state: director.state,
    visual: director.element.getAttribute('state'),
    bubble: document.querySelector('.clipa-bubble.on .box')?.textContent ?? null,
    actor: box(director.element),
    opacity: Number.parseFloat(getComputedStyle(document.querySelector('.clipa-actor') ?? document.body).opacity),
    viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    targets,
    saved: (() => {
      try {
        return window.sessionStorage.getItem(JOURNEY_STORAGE_KEY);
      } catch {
        return null;
      }
    })(),
    said,
    illegal: logs.filter((l) => l.kind === 'illegal').map((l) => l.message),
    flights: events.flatMap((e) =>
      e.event.type === 'flight' && e.event.phase === 'start'
        ? [{ t: e.t, kind: e.event.kind, reduced: e.event.reduced, typing: e.typing }]
        : [],
    ),
    states: events.flatMap((e) => (e.event.type === 'state' ? [{ t: e.t, to: e.event.to, typing: e.typing }] : [])),
  });
}

window.journeyE2E = {
  bus,
  journey,
  director,
  said,
  logs,
  events,
  // The agent asks a question: the shell's presenter plays the decision through the same director.
  ask(text, hint) {
    const decision: ClipaDecision = {
      decision: 'ASK_NOW',
      utterance: text,
      clipa: { state: 'approach', target: { surface: 'journey', hint } },
    };
    return director.apply(decision, { durationMs: 1500 });
  },
  snapshot,
};
