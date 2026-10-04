// Headless Chromium run of the demo page (dist/index.html, built by `npm run build`).
//
//   npm run e2e                       builds, serves dist/ on a random port, runs two scenarios, records one video each
//   CLIPA_VIDEO_DIR=/some/dir ...     where the .webm files and report.json go (default: .e2e-video/)
//
// Scenario 1 (normal motion): the typing guard (refuses, gives up, waits then flies), then the scripted auto
// sequence dock -> notice -> approach -> speak -> listen -> think -> ack -> retreat -> warn -> point -> retreat -> off.
// Scenario 2 (prefers-reduced-motion: reduce): the same auto sequence; she must never be seen between two places.
// A requestAnimationFrame recorder in the page samples Clipa, her bubble and the current target on every frame, and the
// checks run on those samples: no console errors, never overlapping the target, bubble clear of both, smooth flights,
// the timings of the spec, the state order. Playwright is not a dependency of the repo: it is looked up in the
// working directory and in the global node_modules.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideViewport, overlapArea } from '../src/geometry.ts';
import type { Box } from '../src/geometry.ts';

// ---- the part of Playwright's API this script uses ------------------------------------------------------------------

interface PwConsoleMessage {
  type(): string;
  text(): string;
}
interface PwRequest {
  url(): string;
  failure(): { errorText: string } | null;
}
interface PwVideo {
  saveAs(path: string): Promise<void>;
}
interface PwPage {
  on(event: 'console', listener: (message: PwConsoleMessage) => void): unknown;
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  on(event: 'requestfailed', listener: (request: PwRequest) => void): unknown;
  addInitScript(script: { content: string }): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  check(selector: string): Promise<void>;
  uncheck(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  video(): PwVideo | null;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    reducedMotion: 'reduce' | 'no-preference';
    recordVideo: { dir: string; size: { width: number; height: number } };
  }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: {
    launch(options: { executablePath?: string; args?: string[] }): Promise<PwBrowser>;
    executablePath(): string;
  };
}

function isPwModule(value: unknown): value is PwModule {
  if (typeof value !== 'object' || value === null || !('chromium' in value)) return false;
  const chromium = value.chromium;
  return typeof chromium === 'object' && chromium !== null && 'launch' in chromium && typeof chromium.launch === 'function';
}

function loadPlaywright(): PwModule {
  const require = createRequire(import.meta.url);
  const roots = [process.cwd(), ...(process.env['NODE_PATH'] ?? '').split(':').filter(Boolean)];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // no npm on the path: the other roots may still work
  }
  for (const name of ['playwright', 'playwright-core']) {
    for (const root of roots) {
      for (const dir of [root, join(root, 'node_modules')]) {
        const candidate = join(dir, name);
        if (!existsSync(join(candidate, 'package.json'))) continue;
        const mod: unknown = require(candidate);
        if (isPwModule(mod)) return mod;
      }
    }
  }
  throw new Error('Playwright was not found in the working directory or the global node_modules (npm i -g playwright).');
}

function findChromium(pw: PwModule): string | undefined {
  try {
    const declared = pw.chromium.executablePath();
    if (declared && existsSync(declared)) return declared;
  } catch {
    // browsers not installed where Playwright looks: search below
  }
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium')) continue;
    for (const exe of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const path = join(root, dir, exe);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

// ---- static server for dist/ -------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serve(dir: string): Promise<{ server: Server; base: string }> {
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

// ---- the in-page recorder and what it returns ----------------------------------------------------------------------

const RECORDER = `
(() => {
  const frames = [];
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const loop = () => {
    const demo = window.clipaDemo;
    const actor = document.querySelector('.clipa-actor');
    if (demo && actor) {
      const buddy = demo.director.element;
      const root = buddy.shadowRoot && buddy.shadowRoot.querySelector('.root');
      const lvl = root ? root.style.getPropertyValue('--lvl') : '';
      frames.push({
        t: performance.now(),
        state: demo.director.state,
        visual: buddy.getAttribute('state'),
        off: buddy.hasAttribute('off'),
        lvl: lvl === '' ? null : Number(lvl),
        actor: rect(actor),
        opacity: parseFloat(getComputedStyle(actor).opacity),
        bubble: rect(document.querySelector('.clipa-bubble.on .box')),
        target: rect(demo.targetEl()),
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__frames = frames;
})();
`;

interface Frame {
  t: number;
  state: string;
  visual: string | null;
  off: boolean;
  lvl: number | null;
  actor: Box;
  opacity: number;
  bubble: Box | null;
  target: Box | null;
}
interface DemoEvent {
  type: string;
  at: number;
  from?: string;
  to?: string;
  phase?: string;
  kind?: string;
  durationMs?: number;
  reduced?: boolean;
  completed?: boolean;
}
interface DemoLog {
  kind: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function toBox(v: unknown): Box | null {
  if (!isRecord(v)) return null;
  const { x, y, w, h } = v;
  return typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number' ? { x, y, w, h } : null;
}
function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') throw new Error('the page did not return a JSON string');
  const parsed: unknown = JSON.parse(text);
  return parsed;
}
function toFrames(v: unknown): Frame[] {
  if (!Array.isArray(v)) throw new Error('frames: not an array');
  return v.map((item: unknown): Frame => {
    if (!isRecord(item)) throw new Error('frames: bad item');
    const actor = toBox(item['actor']);
    if (!actor || typeof item['t'] !== 'number' || typeof item['state'] !== 'string' || typeof item['opacity'] !== 'number') {
      throw new Error(`frames: bad frame ${JSON.stringify(item)}`);
    }
    return {
      t: item['t'],
      state: item['state'],
      visual: typeof item['visual'] === 'string' ? item['visual'] : null,
      off: item['off'] === true,
      lvl: typeof item['lvl'] === 'number' ? item['lvl'] : null,
      actor,
      opacity: item['opacity'],
      bubble: toBox(item['bubble']),
      target: toBox(item['target']),
    };
  });
}
function toEvents(v: unknown): DemoEvent[] {
  if (!Array.isArray(v)) throw new Error('events: not an array');
  return v.map((item: unknown): DemoEvent => {
    if (!isRecord(item) || typeof item['type'] !== 'string') throw new Error('events: bad item');
    const event: DemoEvent = { type: item['type'], at: typeof item['at'] === 'number' ? item['at'] : 0 };
    if (typeof item['from'] === 'string') event.from = item['from'];
    if (typeof item['to'] === 'string') event.to = item['to'];
    if (typeof item['phase'] === 'string') event.phase = item['phase'];
    if (typeof item['kind'] === 'string') event.kind = item['kind'];
    if (typeof item['durationMs'] === 'number') event.durationMs = item['durationMs'];
    if (typeof item['reduced'] === 'boolean') event.reduced = item['reduced'];
    if (typeof item['completed'] === 'boolean') event.completed = item['completed'];
    return event;
  });
}
function toLog(v: unknown): DemoLog[] {
  if (!Array.isArray(v)) throw new Error('log: not an array');
  return v.map((item: unknown): DemoLog => {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || typeof item['message'] !== 'string') throw new Error('log: bad item');
    return { kind: item['kind'], message: item['message'] };
  });
}

// ---- checks ------------------------------------------------------------------------------------------------------------

interface Check {
  scenario: string;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(scenario: string, name: string, pass: boolean, detail = ''): void {
  checks.push({ scenario, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? `  (${detail})` : ''}`);
}

const centerOf = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const round = (n: number): number => Math.round(n * 10) / 10;

async function evalJson(page: PwPage, expression: string): Promise<unknown> {
  return parseJson(await page.evaluate(`JSON.stringify(${expression})`));
}
async function actorBox(page: PwPage): Promise<Box> {
  const box = toBox(
    await evalJson(page, "(() => { const r = document.querySelector('.clipa-actor').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()"),
  );
  if (!box) throw new Error('no actor box');
  return box;
}
async function directorState(page: PwPage): Promise<string> {
  const state = await page.evaluate('window.clipaDemo.director.state');
  return String(state);
}

interface Outcome {
  frames: Frame[];
  events: DemoEvent[];
  log: DemoLog[];
  problems: string[];
  autoFrom: number;
}

async function runScenario(browser: PwBrowser, base: string, name: 'motion' | 'reduced', videoDir: string): Promise<Outcome> {
  const reduced = name === 'reduced';
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.addInitScript({ content: RECORDER });
  await page.goto(`${base}/index.html?giveup=2500`);
  await page.waitForFunction('window.clipaDemo !== undefined', undefined, { timeout: 10000 });
  await page.waitForTimeout(900);

  // Every target of the demo is on screen, so the geometry is really exercised.
  const targetBoxes = await evalJson(
    page,
    "[...document.querySelectorAll('[data-clipa-hint]')].map((el) => { const r = el.getBoundingClientRect(); return { hint: el.getAttribute('data-clipa-hint'), x: r.left, y: r.top, w: r.width, h: r.height }; })",
  );
  const offScreen = (Array.isArray(targetBoxes) ? targetBoxes : []).filter((t: unknown) => {
    const box = toBox(t);
    return !box || !insideViewport(box, { w: 1280, h: 800 }, 0);
  });
  check(name, 'all demo targets are inside the viewport', Array.isArray(targetBoxes) && targetBoxes.length >= 6 && offScreen.length === 0, JSON.stringify(offScreen.length > 0 ? offScreen : targetBoxes));

  // The dock: 70% scale, 45% opacity, in the bottom-right corner.
  const dockBox = await actorBox(page);
  const dockOpacity = Number(await page.evaluate("getComputedStyle(document.querySelector('.clipa-actor')).opacity"));
  const fullWidth = 96 * 0.8;
  check(name, 'docked at 70% scale', Math.abs(dockBox.w - fullWidth * 0.7) < 0.6, `width ${round(dockBox.w)} px of ${round(fullWidth)}`);
  check(name, 'docked at 45% opacity', Math.abs(dockOpacity - 0.45) < 0.02, `opacity ${dockOpacity}`);
  check(name, 'docked in the bottom-right corner', dockBox.x + dockBox.w > 1280 - 40 && dockBox.y + dockBox.h > 800 - 40, JSON.stringify(dockBox));

  if (!reduced) {
    // Typing: she refuses to move, waits, gives up after 2.5 s and stays docked.
    await page.check('#typing');
    await page.click('button[data-act="approach"]');
    await page.waitForTimeout(1200);
    const held = await actorBox(page);
    check(name, 'typing: no movement while input is active', Math.abs(held.x - dockBox.x) < 1 && Math.abs(held.y - dockBox.y) < 1 && (await directorState(page)) === 'dock', JSON.stringify(held));
    await page.waitForFunction("window.clipaDemo.director.log.some((e) => e.kind === 'gave-up')", undefined, { timeout: 6000 });
    const gaveUp = await actorBox(page);
    check(name, 'typing: gives up after the wait and stays docked', Math.abs(gaveUp.x - dockBox.x) < 1 && Math.abs(gaveUp.y - dockBox.y) < 1 && (await directorState(page)) === 'dock', `state ${await directorState(page)}`);
    await page.uncheck('#typing');
    await page.waitForTimeout(300);

    // Typing that stops in time: she waits at the dock, then flies.
    await page.check('#typing');
    await page.click('button[data-act="approach"]');
    await page.waitForTimeout(900);
    const waiting = await actorBox(page);
    check(name, 'typing: still docked after 0.9 s of input', Math.abs(waiting.x - dockBox.x) < 1 && Math.abs(waiting.y - dockBox.y) < 1, JSON.stringify(waiting));
    await page.uncheck('#typing');
    await page.waitForFunction("window.clipaDemo.events.some((e) => e.type === 'flight' && e.phase === 'end' && e.kind === 'approach')", undefined, { timeout: 5000 });
    check(name, 'typing: flies once the input has stopped', (await directorState(page)) === 'approach', `state ${await directorState(page)}`);
    await page.click('button[data-act="retreat"]');
    await page.evaluate('window.clipaDemo.director.idle()');
    await page.waitForTimeout(400);
  }

  if (!reduced) {
    // Off the record in the middle of a flight cancels the sequence and sends her home asleep.
    await page.evaluate(
      "(() => { window.__applied = null; window.clipaDemo.director.apply({ decision: 'ASK_NOW', utterance: 'Why this client?', expectsAnswer: true, clipa: { state: 'approach', target: { surface: 'email', hint: 'body' } } }).then((r) => { window.__applied = r; }); })()",
    );
    await page.waitForFunction("window.clipaDemo.director.state === 'approach'", undefined, { timeout: 3000 });
    await page.waitForTimeout(250);
    await page.evaluate('window.clipaDemo.director.setOff(true)');
    await page.waitForFunction('window.__applied !== null', undefined, { timeout: 3000 });
    const applied = await evalJson(page, 'window.__applied');
    check(name, 'off-record mid-flight: the running sequence is cancelled', isRecord(applied) && applied['ok'] === false && applied['reason'] === 'off', JSON.stringify(applied));
    await page.evaluate('window.clipaDemo.director.idle()');
    const parked = await actorBox(page);
    check(name, 'off-record mid-flight: she ends in the dock corner, asleep, without a bubble',
      (await directorState(page)) === 'off' && Math.abs(parked.x - dockBox.x) < 1 && Math.abs(parked.y - dockBox.y) < 1 && (await page.evaluate("document.querySelector('.clipa-bubble.on') === null")) === true,
      `state ${await directorState(page)} ${JSON.stringify(parked)}`);
    check(name, 'off-record mid-flight: the flight was superseded, not finished',
      (await page.evaluate("window.clipaDemo.events.some((e) => e.type === 'flight' && e.phase === 'end' && e.kind === 'approach' && e.completed === false)")) === true);
    await page.evaluate('window.clipaDemo.director.setOff(false)');
    await page.evaluate('window.clipaDemo.director.idle()');
    await page.waitForTimeout(300);

    // Typing while she listens sends her back to the dock and defers the question.
    await page.evaluate("window.clipaDemo.director.approach({ surface: 'email', hint: 'body' }).then(() => window.clipaDemo.director.listen(0.3))");
    check(name, 'listening at the target before the typing test', (await directorState(page)) === 'listening', `state ${await directorState(page)}`);
    await page.check('#typing');
    await page.waitForFunction("window.clipaDemo.director.log.some((e) => e.kind === 'deferred')", undefined, { timeout: 4000 });
    await page.uncheck('#typing');
    await page.evaluate('window.clipaDemo.director.idle()');
    check(name, 'typing while listening: back to the dock, question deferred', (await directorState(page)) === 'dock', `state ${await directorState(page)}`);
    await page.waitForTimeout(300);

    // One flight per question: a second approach while she is out waits in a single slot (the newest wins).
    const queued = parseJson(
      await page.evaluate(`(async () => {
        const d = window.clipaDemo.director;
        const at = (hint) => ({ surface: 'email', hint });
        await d.approach(at('body'));
        const first = d.approach(at('to'));
        const second = d.approach(at('subject'));
        const dropped = await first;
        const during = d.state;
        d.retreat();
        await new Promise((resolve) => setTimeout(resolve, 2600));
        const secondResult = await second;
        return JSON.stringify({ dropped, during, after: d.state, secondResult, kinds: d.log.map((l) => l.kind).filter((k) => k === 'queued' || k === 'dropped') });
      })()`),
    );
    const q = isRecord(queued) ? queued : {};
    const droppedResult = q['dropped'];
    const secondResult = q['secondResult'];
    check(name, 'queue: the second approach replaces the first, which is dropped',
      isRecord(droppedResult) && droppedResult['reason'] === 'dropped' && Array.isArray(q['kinds']) && q['kinds'].filter((k: unknown) => k === 'dropped').length === 1,
      JSON.stringify(queued));
    check(name, 'queue: she stayed at the first target until she was home, then flew for the queued one',
      q['during'] === 'approach' && q['after'] === 'approach' && isRecord(secondResult) && secondResult['ok'] === true, JSON.stringify(queued));
    await page.evaluate('window.clipaDemo.director.retreat()');
    await page.evaluate('window.clipaDemo.director.idle()');
    await page.waitForTimeout(400);
  }

  const autoFrom = toEvents(await evalJson(page, 'window.clipaDemo.events')).length;
  await page.evaluate('window.clipaDemo.runAuto()');
  await page.evaluate('window.clipaDemo.director.idle()');
  await page.waitForTimeout(500);

  const frames = toFrames(await evalJson(page, 'window.__frames'));
  const events = toEvents(await evalJson(page, 'window.clipaDemo.events'));
  const log = toLog(await evalJson(page, 'window.clipaDemo.director.log'));
  await context.close();
  const video = page.video();
  if (video) await video.saveAs(join(videoDir, reduced ? 'clipa-demo-reduced-motion.webm' : 'clipa-demo.webm'));
  return { frames, events, log, problems, autoFrom };
}

const EXPECTED_AUTO_STATES = [
  'notice', 'approach', 'speaking', 'listening', 'thinking', 'ack', 'retreat', 'dock',
  'warning', 'pointing', 'retreat', 'dock', 'off', 'dock',
];

function analyse(name: 'motion' | 'reduced', outcome: Outcome): void {
  const { frames, events, log, problems, autoFrom } = outcome;
  const vp: { w: number; h: number } = { w: 1280, h: 800 };
  const reduced = name === 'reduced';
  check(name, 'no console errors, page errors or failed requests', problems.length === 0, problems.join(' | '));
  check(name, 'the recorder sampled the run', frames.length > 300, `${frames.length} frames`);

  // The order of states of the scripted sequence.
  const states = events.slice(autoFrom).filter((e) => e.type === 'state').map((e) => e.to ?? '?');
  check(name, 'auto sequence visits every state in the spec order', states.join(',') === EXPECTED_AUTO_STATES.join(','), states.join(' > '));
  const visited = new Set(events.filter((e) => e.type === 'state').map((e) => e.to));
  for (const state of ['dock', 'notice', 'approach', 'speaking', 'listening', 'thinking', 'ack', 'retreat', 'warning', 'pointing', 'off']) {
    check(name, `state "${state}" was entered`, visited.has(state));
  }
  check(name, 'no illegal command in the log', !log.some((l) => l.kind === 'illegal'), log.filter((l) => l.kind === 'illegal').map((l) => l.message).join(' | '));

  // Never on the target. Frames sample the whole run, including the flights.
  let overlaps = 0;
  let worst: Frame | null = null;
  for (const f of frames) {
    if (f.target && overlapArea(f.actor, f.target) > 0.01) {
      overlaps++;
      worst ??= f;
    }
  }
  check(name, 'Clipa never overlaps the target rect (every frame)', overlaps === 0, `${overlaps} frames${worst ? `, first at state ${worst.state}: actor ${JSON.stringify(worst.actor)} target ${JSON.stringify(worst.target)}` : ''}`);
  const withTarget = frames.filter((f) => f.target !== null).length;
  check(name, 'the target was sampled', withTarget > 100, `${withTarget} frames with a target`);

  // Inside the viewport at all times (flights included), with her opacity above zero or not.
  const outside = frames.filter((f) => !insideViewport(f.actor, vp, -0.5));
  check(name, 'Clipa stays inside the viewport', outside.length === 0, `${outside.length} frames outside`);

  // The bubble: inside the viewport, clear of the target and of Clipa.
  const bubbles = frames.filter((f) => f.bubble !== null);
  check(name, 'bubbles were shown', bubbles.length > 100, `${bubbles.length} frames`);
  const bubbleOutside = bubbles.filter((f) => f.bubble && !insideViewport(f.bubble, vp, -0.5));
  const bubbleOnTarget = bubbles.filter((f) => f.bubble && f.target && overlapArea(f.bubble, f.target) > 0.01);
  const bubbleOnActor = bubbles.filter((f) => f.bubble && overlapArea(f.bubble, f.actor) > 0.5);
  const sample = (f: Frame | undefined): string => (f ? `first at state ${f.state}: bubble ${JSON.stringify(f.bubble)} actor ${JSON.stringify(f.actor)} target ${JSON.stringify(f.target)}` : '');
  check(name, 'the bubble stays inside the viewport', bubbleOutside.length === 0, `${bubbleOutside.length} frames ${sample(bubbleOutside[0])}`);
  check(name, 'the bubble never covers the target', bubbleOnTarget.length === 0, `${bubbleOnTarget.length} frames ${sample(bubbleOnTarget[0])}`);
  check(name, 'the bubble never covers Clipa', bubbleOnActor.length === 0, `${bubbleOnActor.length} frames ${sample(bubbleOnActor[0])}`);

  // Back at the dock where she started, still half transparent.
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first && last) {
    const a = centerOf(first.actor);
    const b = centerOf(last.actor);
    check(name, 'ends back in the dock corner at 45% opacity', Math.hypot(a.x - b.x, a.y - b.y) < 1.5 && Math.abs(last.opacity - 0.45) < 0.02 && last.state === 'dock', `end ${JSON.stringify(last.actor)} opacity ${last.opacity}`);
  }

  // Off the record: grey (the buddy reports off), at 50% opacity, in the corner.
  const offFrames = frames.filter((f) => f.state === 'off');
  check(name, 'off-record frames show the grey, eyes-closed buddy', offFrames.length > 30 && offFrames.every((f) => f.off && f.visual === 'idle'), `${offFrames.length} frames`);

  // The listening rings follow the voice level.
  const levels = frames.filter((f) => f.state === 'listening' && f.lvl !== null).map((f) => f.lvl ?? 0);
  check(name, 'the listening ring follows the voice level', levels.length > 40 && Math.max(...levels) - Math.min(...levels) > 0.4, `${levels.length} samples, ${round(Math.min(...levels))}-${round(Math.max(...levels))}`);

  // Flights.
  const flightEnds = events.slice(autoFrom).filter((e) => e.type === 'flight' && e.phase === 'end');
  const byKind = (kind: string): DemoEvent[] => flightEnds.filter((e) => e.kind === kind);
  for (const kind of ['approach', 'warn', 'point']) {
    const ends = byKind(kind);
    check(name, `one ${kind} flight`, ends.length === 1 && ends[0]?.completed === true, `${ends.length}`);
    if (!reduced) {
      const ms = ends[0]?.durationMs ?? 0;
      check(name, `${kind} flight lasts 600-900 ms`, ms >= 570 && ms <= 960, `${round(ms)} ms`);
    }
  }
  const retreats = byKind('retreat');
  check(name, 'two retreats, both arrive', retreats.length === 2 && retreats.every((e) => e.completed === true), `${retreats.length}`);
  if (!reduced) {
    check(name, 'retreat lasts about 500 ms', retreats.every((e) => (e.durationMs ?? 0) >= 450 && (e.durationMs ?? 0) <= 650), retreats.map((e) => `${round(e.durationMs ?? 0)} ms`).join(', '));
  }
  check(name, 'flight events say whether motion was reduced', flightEnds.every((e) => e.reduced === reduced), `reduced=${reduced}`);

  // Motion quality, from the per-frame samples. The recorder samples before the page paints, so with uneven frame
  // times a single pair of samples can pair one frame's distance with the next frame's interval; speeds are
  // measured over windows of at least 48 ms instead.
  let fastest = 0;
  let fastestInfo = '';
  let jumps = 0;
  let firstJump: string | undefined;
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1];
    const q = frames[i];
    if (!p || !q || q.t - p.t < 4) continue;
    if (reduced) {
      // A move between two places is only allowed while she is invisible; a move is a visible one when she is
      // visible both before and after it.
      const a = centerOf(p.actor);
      const b = centerOf(q.actor);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > 2 && p.opacity > 0.06 && q.opacity > 0.06) {
        jumps++;
        firstJump ??= `${p.state} -> ${q.state}, ${round(dist)} px, opacity ${round(p.opacity)} -> ${round(q.opacity)}`;
      }
    }
  }
  if (!reduced) {
    for (let i = 0; i < frames.length; i++) {
      const p = frames[i];
      if (!p) continue;
      let j = i + 1;
      while (j < frames.length && (frames[j]?.t ?? Infinity) - p.t < 48) j++;
      const q = frames[j];
      if (!q) break;
      const a = centerOf(p.actor);
      const b = centerOf(q.actor);
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / (q.t - p.t);
      if (speed > fastest) {
        fastest = speed;
        fastestInfo = `${p.state} -> ${q.state}, ${round(speed * (q.t - p.t))} px in ${round(q.t - p.t)} ms, from ${JSON.stringify(p.actor)} to ${JSON.stringify(q.actor)}`;
      }
    }
  }
  if (reduced) check(name, 'reduced motion: never seen between two places (she fades out, moves unseen, fades in)', jumps === 0, `${jumps} visible jumps ${firstJump ?? ''}`);
  else check(name, 'flights are smooth: no jump (peak speed stays near the eased maximum)', fastest < 5, `peak ${round(fastest)} px/ms over 48 ms windows ${fastest >= 5 ? fastestInfo : ''}`);
  if (reduced) {
    const faded = frames.filter((f) => f.opacity < 0.05).length;
    check(name, 'reduced motion: she was invisible at times, instead of flying', faded > 5, `${faded} frames below 5% opacity`);
  }
  if (!reduced) {
    const moving = frames.filter((f) => f.state === 'approach' || f.state === 'retreat' || f.state === 'warning' || f.state === 'pointing');
    const distinct = new Set(moving.map((f) => `${Math.round(f.actor.x / 8)},${Math.round(f.actor.y / 8)}`));
    check(name, 'flights pass through many places (a curve, not a teleport)', distinct.size > 40, `${distinct.size} cells`);
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const here = new URL('../', import.meta.url);
  const dist = fileURLToPath(new URL('dist/', here));
  if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing: run npm run build first');
  const videoDir = process.env['CLIPA_VIDEO_DIR'] ?? fileURLToPath(new URL('.e2e-video/', here));
  mkdirSync(videoDir, { recursive: true });

  const pw = loadPlaywright();
  const executablePath = findChromium(pw);
  const { server, base } = await serve(dist);
  const browser = await pw.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    for (const name of ['motion', 'reduced'] as const) {
      console.log(`\n== scenario: ${name}`);
      const outcome = await runScenario(browser, base, name, videoDir);
      analyse(name, outcome);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  writeFileSync(join(videoDir, 'report.json'), JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed. Videos and report.json: ${videoDir}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
