/*
 * Demo page for the Clipa director (static/index.html). Buttons drive every state, "Play auto sequence" runs the
 * scripted tour, "Simulate typing" shows the director refusing to move.
 *
 * Query parameters: ?giveup=1500 sets inputGiveUpMs, ?reduced=1 starts with reduced motion forced on.
 * window.clipaDemo exposes the director and the recorded events for the headless run (scripts/e2e.ts).
 */
import { createClipaDirector } from './index.ts';
import type { ClipaDecision, ClipaDirector, ClipaEvent, ClipaResult, ClipaTarget, RectLike } from './index.ts';

export interface ClipaDemoApi {
  director: ClipaDirector;
  events: ClipaEvent[];
  /** The element the director last asked about, so a test can check that Clipa stays off it. */
  targetEl(): Element | null;
  runAuto(): Promise<void>;
}

declare global {
  interface Window {
    clipaDemo?: ClipaDemoApi;
  }
}

function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`demo: #${id} is missing or not a ${ctor.name}`);
  return el;
}

const statePill = byId('statePill', HTMLElement);
const inputPill = byId('inputPill', HTMLElement);
const caption = byId('caption', HTMLElement);
const logEl = byId('log', HTMLOListElement);
const targetSel = byId('targetSel', HTMLSelectElement);
const levelEl = byId('level', HTMLInputElement);
const typingEl = byId('typing', HTMLInputElement);
const reducedEl = byId('reduced', HTMLInputElement);
const offBtn = byId('offBtn', HTMLButtonElement);
const autoBtn = byId('autoBtn', HTMLButtonElement);
const exampleEl = byId('example', HTMLSelectElement);
const decisionEl = byId('decision', HTMLTextAreaElement);
const applyBtn = byId('applyBtn', HTMLButtonElement);

const params = new URLSearchParams(location.search);
const giveUpParam = Number(params.get('giveup'));

// ---- input activity: the checkbox, or real keystrokes in the page ---------------------------------------------

let lastKeyAt = -Infinity;
document.addEventListener('keydown', () => {
  lastKeyAt = performance.now();
});
const isInputActive = (): boolean => typingEl.checked || performance.now() - lastKeyAt < 1200;

// ---- targets: {surface, hint} -> the element's viewport rect -----------------------------------------------------

let lastTarget: Element | null = null;
function resolveTarget(target: ClipaTarget): RectLike | null {
  const surface = CSS.escape(target.surface);
  const selector = target.hint
    ? `[data-clipa-surface="${surface}"][data-clipa-hint="${CSS.escape(target.hint)}"]`
    : `[data-clipa-surface="${surface}"]:not([data-clipa-hint])`;
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  lastTarget = el;
  return rect;
}
function selectedTarget(): ClipaTarget {
  const [surface = 'email', hint] = targetSel.value.split('/');
  return hint ? { surface, hint } : { surface };
}
const SEND: ClipaTarget = { surface: 'email', hint: 'send' };
const REPLAY: ClipaTarget = { surface: 'evidence', hint: 'replay' };
const BODY: ClipaTarget = { surface: 'email', hint: 'body' };

// ---- the director and the on-page log ------------------------------------------------------------------------------

const events: ClipaEvent[] = [];
const startedAt = performance.now();
function addLog(cls: string, text: string): void {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1).padStart(5)}s  ${text}`;
  logEl.prepend(li);
  while (logEl.children.length > 60) logEl.lastElementChild?.remove();
}

const director = createClipaDirector({
  root: document.body,
  dock: 'bottom-right',
  resolveTarget,
  isInputActive,
  ...(Number.isFinite(giveUpParam) && giveUpParam > 0 ? { inputGiveUpMs: giveUpParam } : {}),
  onLog: (entry) => addLog(entry.kind, `${entry.kind}: ${entry.message}`),
});

director.subscribe((event) => {
  events.push(event);
  if (event.type === 'state') {
    statePill.textContent = event.to;
    statePill.classList.toggle('warn', event.to === 'warning');
    addLog('state', `state ${event.from} -> ${event.to}`);
  } else if (event.type === 'flight' && event.phase === 'end') {
    addLog('flight', `${event.kind} ${Math.round(event.durationMs)} ms${event.reduced ? ' (fade)' : ''}${event.completed === false ? ' (superseded)' : ''}`);
  }
});

function setInputPill(): void {
  const active = isInputActive();
  inputPill.textContent = active ? 'input active' : 'input idle';
  inputPill.classList.toggle('warn', active);
  inputPill.classList.toggle('muted', !active);
}
setInterval(setInputPill, 150);
setInputPill();

if (params.get('reduced') === '1') {
  reducedEl.checked = true;
  director.setReducedMotion(true);
}
reducedEl.addEventListener('change', () => director.setReducedMotion(reducedEl.checked ? true : 'auto'));

// ---- manual controls -----------------------------------------------------------------------------------------------

const SAMPLE_QUESTION = 'You removed the screenshot and typed the address. Why for this client?';

function report(name: string, result: ClipaResult): void {
  if (!result.ok) addLog('illegal', `${name} -> ${result.reason}`);
}

async function act(name: string): Promise<void> {
  switch (name) {
    case 'notice':
      return report(name, await director.notice(selectedTarget()));
    case 'approach':
      return report(name, await director.approach(selectedTarget()));
    case 'speak':
      return report(name, await director.speak(SAMPLE_QUESTION, { durationMs: 2600, listenAfter: true }));
    case 'listen':
      return report(name, await director.listen(Number(levelEl.value)));
    case 'think':
      return report(name, await director.think());
    case 'ack':
      return report(name, await director.ack());
    case 'retreat':
      return report(name, await director.retreat());
    case 'warn':
      return report(name, await director.warn(SEND));
    case 'point':
      return report(name, await director.point(REPLAY));
    case 'off': {
      const turnOn = offBtn.getAttribute('aria-pressed') !== 'true';
      offBtn.setAttribute('aria-pressed', String(turnOn));
      offBtn.textContent = turnOn ? 'Back on air' : 'Off record';
      return report(name, await director.setOff(turnOn));
    }
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
  button.addEventListener('click', () => void act(button.dataset['act'] ?? ''));
}
// The slider is a stand-in for the voice-activity detector: while she listens, the rings follow it.
levelEl.addEventListener('input', () => {
  if (director.state === 'listening') void director.listen(Number(levelEl.value));
});

const EXAMPLES: Record<string, ClipaDecision & { topic?: string }> = {
  ask: {
    decision: 'ASK_NOW',
    topic: 'why_text_body',
    utterance: { text: SAMPLE_QUESTION },
    expectsAnswer: true,
    clipa: { state: 'approach', target: BODY },
  },
  warn: {
    decision: 'WARN',
    utterance: { text: 'Sabine would stop here. customer_07 asked for the address as text.' },
    clipa: { state: 'warning', target: SEND },
  },
  point: {
    decision: 'WARN',
    utterance: { text: 'Here is how Sabine did it.' },
    clipa: { state: 'pointing', target: REPLAY },
  },
  defer: { decision: 'DEFER', clipa: { state: 'dock' } },
};
function loadExample(): void {
  decisionEl.value = JSON.stringify(EXAMPLES[exampleEl.value] ?? EXAMPLES['ask'], null, 2);
}
exampleEl.addEventListener('change', loadExample);
loadExample();

function isDecision(value: unknown): value is ClipaDecision {
  return typeof value === 'object' && value !== null && typeof (value as { decision?: unknown }).decision === 'string';
}
applyBtn.addEventListener('click', () => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decisionEl.value);
  } catch (error) {
    addLog('illegal', `decision JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isDecision(parsed)) {
    addLog('illegal', 'decision JSON needs a "decision" field');
    return;
  }
  void director.apply(parsed).then((result) => report('apply', result));
});

// ---- the scripted tour -------------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake voice-activity level: a slow breathing curve with a faster flutter, 0..1, at 30 frames a second. */
async function fakeVoice(ms: number): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const t = (performance.now() - t0) / 1000;
    const level = 0.5 + 0.32 * Math.sin(t * 5.2) + 0.18 * Math.sin(t * 13.7 + 1);
    levelEl.value = level.toFixed(2);
    await director.listen(Math.min(1, Math.max(0, level)));
    await sleep(33);
  }
  await director.listen(0.05);
}

async function runAuto(): Promise<void> {
  autoBtn.disabled = true;
  try {
    caption.textContent = 'Dock: small and half-transparent in the corner, blinking now and then.';
    await sleep(1500);

    caption.textContent = 'Notice: she looks at the mail body, then Approach: a curved flight to its side.';
    await director.notice(BODY);
    await director.approach(BODY);
    caption.textContent = 'Speaking: a bubble away from the field, the mouth moves with the voice.';
    await director.speak(SAMPLE_QUESTION, { durationMs: 2800 });
    caption.textContent = 'Listening: the ring follows the voice level.';
    await fakeVoice(2600);
    caption.textContent = 'Thinking: three dots, eyes up.';
    await director.think();
    await sleep(1500);
    caption.textContent = 'Ack: a nod and "Noted", then Retreat to the corner.';
    await director.ack();
    await director.idle();
    await sleep(900);

    caption.textContent = 'Warning (Teach): she flies beside Send in the orange pose before the click.';
    await director.warn(SEND);
    await director.speak('Sabine would stop here. customer_07 asked for the address as text.', { durationMs: 3200 });
    await sleep(500);
    caption.textContent = 'Pointing: she shows the replay of the expert’s moment.';
    await director.point(REPLAY);
    await director.speak('Here is how Sabine did it.', { durationMs: 2200 });
    await sleep(1200);
    caption.textContent = 'Retreat: back to the dock.';
    await director.retreat();
    await director.idle();
    await sleep(800);

    caption.textContent = 'Off the record: grey, eyes closed, parked in the corner.';
    offBtn.setAttribute('aria-pressed', 'true');
    offBtn.textContent = 'Back on air';
    await director.setOff(true);
    await sleep(2000);
    offBtn.setAttribute('aria-pressed', 'false');
    offBtn.textContent = 'Off record';
    await director.setOff(false);
    await sleep(800);
    caption.textContent = 'Done. Tick "Simulate typing" and press Approach to see her refuse to move.';
  } finally {
    autoBtn.disabled = false;
  }
}
autoBtn.addEventListener('click', () => void runAuto());

window.clipaDemo = { director, events, targetEl: () => lastTarget, runAuto };
