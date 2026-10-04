// Headless Chromium run of the journey page (journey/e2e/page.ts): the real Clipa director and the real journey engine.
//
//   npm run e2e:journey     compiles the page to .e2e-dist/, serves it on a random port and drives the shell's event sequence
//
// It checks what only a browser can show: Clipa really moves in the DOM to the step's control and lands beside it (not on it),
// the bubble carries the line, she goes home when the person types and does not fly while they type, a flight the person
// interrupts is called back, the agent's question is not queued behind her, the teach-back step lets go of her, a reload
// resumes at the Start of the session, a second tab starts at step 1, and prefers-reduced-motion turns flights into fades.
// Playwright is not a dependency of the repo: it is looked up in the working directory and in the global node_modules.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlapArea } from '../../src/geometry.ts';
import type { Box } from '../../src/geometry.ts';
import { JOURNEY_STEPS } from '../journey.ts';
import type { JourneyStepId } from '../journey.ts';

// ---- the part of Playwright's API this script uses -------------------------------------------------------------------

interface PwConsoleMessage {
  type(): string;
  text(): string;
}
interface PwPage {
  on(event: 'console', listener: (message: PwConsoleMessage) => void): unknown;
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  focus(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  keyboard: { type(text: string, options?: { delay?: number }): Promise<void> };
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: { viewport: { width: number; height: number }; reducedMotion: 'reduce' | 'no-preference' }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(options: { executablePath?: string; args?: string[] }): Promise<PwBrowser>; executablePath(): string };
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

// ---- build and serve ---------------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serve(dir: string): Promise<{ server: Server; base: string }> {
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const file = normalize(join(root, path));
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

// ---- what the page reports ------------------------------------------------------------------------------------------------

interface Snap {
  step: JourneyStepId;
  done: boolean;
  variant: string | null;
  runId: string;
  state: string;
  visual: string | null;
  bubble: string | null;
  actor: Box | null;
  opacity: number;
  viewport: { w: number; h: number };
  targets: Record<string, Box | null>;
  saved: string | null;
  said: string[];
  illegal: string[];
  flights: Array<{ t: number; kind: string; reduced: boolean; typing: boolean }>;
  states: Array<{ t: number; to: string; typing: boolean }>;
}

async function snap(page: PwPage): Promise<Snap> {
  const text = await page.evaluate('window.journeyE2E.snapshot()');
  if (typeof text !== 'string') throw new Error('the page did not return a snapshot');
  return JSON.parse(text) as Snap;
}

const emit = (page: PwPage, event: object): Promise<unknown> => page.evaluate(`window.journeyE2E.bus.emit(${JSON.stringify(event)})`);
const stepLine = (id: JourneyStepId): string => JOURNEY_STEPS.find((s) => s.id === id)?.line ?? '';
const centerOf = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const distance = (a: Box, b: Box): number => Math.hypot(centerOf(a).x - centerOf(b).x, centerOf(a).y - centerOf(b).y);
/** The gap between the nearest edges of two boxes (0 when they touch or overlap). */
const edgeGap = (a: Box, b: Box): number => {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
};
const bubbleIs = (text: string): string => `document.querySelector('.clipa-bubble.on .box')?.textContent === ${JSON.stringify(text)}`;
const stateIs = (state: string): string => `window.journeyE2E.director.state === ${JSON.stringify(state)}`;

// ---- the checks ---------------------------------------------------------------------------------------------------------------

const failures: string[] = [];
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

/** Clipa stands beside the control: close, and never on top of it. */
function besideTarget(s: Snap, target: string): { ok: boolean; detail: string } {
  const t = s.targets[target];
  if (!s.actor || !t) return { ok: false, detail: `no box for Clipa or ${target}` };
  const overlap = overlapArea(s.actor, t);
  const gap = edgeGap(s.actor, t);
  return { ok: overlap === 0 && gap < 80, detail: `overlap ${overlap.toFixed(0)} px2, ${gap.toFixed(0)} px between the edges` };
}

const WAIT = { timeout: 9000 };

async function runExpertAndNewHire(browser: PwBrowser, base: string): Promise<void> {
  console.log('Scenario 1: the whole journey, normal motion');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const url = `${base}/journey/e2e/index.html`;
  await page.goto(url);
  await page.waitForFunction('window.journeyE2E !== undefined', undefined, WAIT);

  // 1. open: she flies to Start and says the greeting. Nothing before the page says it is ready.
  let s = await snap(page);
  check('nothing happens before app_ready', s.state === 'dock' && s.bubble === null);
  const homeBox = s.actor;
  await emit(page, { type: 'app_ready', mode: 'learn' });
  await page.waitForFunction(bubbleIs(stepLine('open')), undefined, WAIT);
  s = await snap(page);
  let beside = besideTarget(s, 'session-start');
  check('open: the greeting is in the bubble and she points', s.state === 'pointing' && s.bubble === stepLine('open'));
  check('open: she stands beside the Start button, not on it', beside.ok, beside.detail);
  check('open: she left the dock', homeBox !== null && s.actor !== null && distance(homeBox, s.actor) > 60);

  // 2. Start Learn: Share comes next, and she moves to the share control.
  const before = s.actor;
  await emit(page, { type: 'session_live', mode: 'learn' });
  await page.waitForFunction(bubbleIs(stepLine('share')), undefined, WAIT);
  s = await snap(page);
  beside = besideTarget(s, 'share-screen');
  check('share: after Start Learn she moves on to the share control', beside.ok && before !== null && s.actor !== null && distance(before, s.actor) > 20, beside.detail);

  // 3. The person types: she goes home at once and no flight starts while they type.
  await page.focus('#note');
  const typed = page.keyboard.type('x'.repeat(36), { delay: 70 });
  await page.waitForFunction(stateIs('dock'), undefined, { timeout: 3000 });
  s = await snap(page);
  check('typing: she is home within seconds of the first key', s.state === 'dock');
  check('typing: no bubble is left behind', s.bubble === null);
  await emit(page, { type: 'screen_capturing' }); // the next step arrives while the person is still typing
  await typed;
  s = await snap(page);
  const flownWhileTyping = s.states.filter((e) => e.to === 'pointing' && e.typing);
  check('typing: she never flies out while the person types', flownWhileTyping.length === 0, JSON.stringify(flownWhileTyping));
  await page.waitForFunction(bubbleIs(stepLine('learn')), undefined, { timeout: 12000 });
  s = await snap(page);
  beside = besideTarget(s, 'screen-preview');
  check('typing: after the quiet moment the held line comes (Learn)', s.step === 'learn' && beside.ok, beside.detail);

  // 4. The agent asks: she leaves her control and the question is not queued behind her.
  await emit(page, { type: 'agent_asked', guardrail: true });
  void page.evaluate("window.journeyE2E.ask('Why did you copy the address?', 'workspace')");
  await page.waitForFunction(bubbleIs('Why did you copy the address?'), undefined, { timeout: 5000 });
  s = await snap(page);
  beside = besideTarget(s, 'workspace');
  check('agent: its question appears next to the workspace within 5 s', beside.ok, beside.detail);
  await page.evaluate('window.journeyE2E.director.retreat()');
  await page.waitForFunction(stateIs('dock'), undefined, WAIT);

  // 5. End Learn, Start Review: the Review tab first, then the Start button.
  await emit(page, { type: 'session_ended', mode: 'learn' });
  await page.waitForFunction(bubbleIs('Open the Review tab first, then press Start.'), undefined, { timeout: 12000 });
  s = await snap(page);
  beside = besideTarget(s, 'mode-review');
  check('review: with another tab selected she points at the Review tab', beside.ok, beside.detail);
  await emit(page, { type: 'mode_changed', mode: 'review' });
  await page.waitForFunction(bubbleIs(stepLine('start-review')), undefined, WAIT);
  s = await snap(page);
  check('review: once the tab is selected she moves to the Start button', besideTarget(s, 'session-start').ok);
  await emit(page, { type: 'session_live', mode: 'review' });
  await page.waitForFunction(bubbleIs(stepLine('review-board')), undefined, WAIT);
  s = await snap(page);
  check('review: she points at the open gap on the board', besideTarget(s, 'board-gap').ok);

  // 6. The teach-back is the agent's: she lets go and does not stand at the gap.
  await emit(page, { type: 'teachback_started' });
  await page.waitForFunction(stateIs('dock'), undefined, { timeout: 4000 });
  s = await snap(page);
  check('teach-back: she goes home while the agent speaks it', s.state === 'dock' && s.bubble === null && s.step === 'teach-back');
  await emit(page, { type: 'teachback_confirmed' });
  await page.waitForFunction(bubbleIs(stepLine('end-review')), undefined, WAIT);
  s = await snap(page);
  check('end of Review: she points at End session', besideTarget(s, 'session-end').ok);
  await emit(page, { type: 'session_ended', mode: 'review' });
  await page.waitForFunction(bubbleIs(stepLine('handoff')), undefined, WAIT);
  s = await snap(page);
  check('hand-over: only after the Review session ended, she points at the Teach tab', besideTarget(s, 'mode-teach').ok && s.step === 'handoff');

  // 7. A reload: the same tab resumes at the hand-over.
  await page.reload();
  await page.waitForFunction('window.journeyE2E !== undefined', undefined, WAIT);
  s = await snap(page);
  check('reload: the step is restored before any event', s.step === 'handoff');
  await emit(page, { type: 'app_ready', mode: 'review' });
  await page.waitForFunction(bubbleIs(stepLine('handoff')), undefined, WAIT);
  check('reload: she says the hand-over line again', true);

  // 8. Teach: the new hire.
  await emit(page, { type: 'mode_changed', mode: 'teach' });
  await page.waitForFunction(bubbleIs(stepLine('start-teach')), undefined, WAIT);
  await emit(page, { type: 'session_live', mode: 'teach' });
  await page.waitForFunction(bubbleIs(stepLine('teach')), undefined, WAIT);
  await emit(page, { type: 'checkpoint_warned' });
  await page.waitForFunction("window.journeyE2E.journey.getSnapshot().stepId === 'teach-fix'", undefined, WAIT);
  await emit(page, { type: 'sent' });
  await page.waitForFunction(bubbleIs(stepLine('end-teach')), undefined, WAIT);
  s = await snap(page);
  check('teach: after Send she points at End session', besideTarget(s, 'session-end').ok);
  await emit(page, { type: 'session_ended', mode: 'teach' });
  await page.waitForFunction(bubbleIs(stepLine('summary')), undefined, WAIT);
  s = await snap(page);
  check('summary: reached from the end of the Teach session, and the journey is done', s.done && besideTarget(s, 'mastery-summary').ok);
  check('summary: the saved position is cleared', s.saved === null);
  check('summary: no line promises an export', !s.said.some((l) => /export/i.test(l)));
  check('director: no illegal command was issued during the whole run', s.illegal.length === 0, s.illegal.join(' | '));
  check('page: no console errors or warnings', problems.length === 0, problems.join(' | '));

  // 9. A second tab starts at step 1, whatever the first one saved.
  const second = await context.newPage();
  await second.goto(url);
  await second.waitForFunction('window.journeyE2E !== undefined', undefined, WAIT);
  const fresh = await snap(second);
  check('a new tab starts at step 1', fresh.step === 'open' && !fresh.done);
  await context.close();
}

async function runInterrupted(browser: PwBrowser, base: string): Promise<void> {
  console.log('Scenario 2: typing during take-off');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.goto(`${base}/journey/e2e/index.html`);
  await page.waitForFunction('window.journeyE2E !== undefined', undefined, WAIT);
  await page.focus('#note');
  const typed = page.keyboard.type('y'.repeat(6), { delay: 150 }); // typing is active as the greeting is due
  await emit(page, { type: 'app_ready', mode: 'learn' });
  await typed;
  await page.waitForTimeout(600);
  let s = await snap(page);
  check('take-off: nothing is said while the person types', s.bubble === null && s.said.length === 0);
  check('take-off: she is at home', s.state === 'dock');
  await page.waitForFunction(bubbleIs(stepLine('open')), undefined, { timeout: 12000 });
  s = await snap(page);
  check('take-off: the greeting comes once the typing stopped', s.state === 'pointing' && besideTarget(s, 'session-start').ok);
  check('take-off: she never flew while the person typed', s.states.every((e) => !(e.to === 'pointing' && e.typing)));
  await context.close();
}

async function runReduced(browser: PwBrowser, base: string): Promise<void> {
  console.log('Scenario 3: prefers-reduced-motion');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${base}/journey/e2e/index.html`);
  await page.waitForFunction('window.journeyE2E !== undefined', undefined, WAIT);
  await emit(page, { type: 'app_ready', mode: 'learn' });
  await page.waitForFunction(bubbleIs(stepLine('open')), undefined, WAIT);
  await emit(page, { type: 'session_live', mode: 'learn' });
  await page.waitForFunction(bubbleIs(stepLine('share')), undefined, WAIT);
  const s = await snap(page);
  check('reduced motion: every flight is a fade, not a flight', s.flights.length > 0 && s.flights.every((f) => f.reduced));
  check('reduced motion: she still lands beside the control', besideTarget(s, 'share-screen').ok);
  await context.close();
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  console.log('Compiling the page ...');
  execFileSync('npx', ['tsc', '-p', 'journey/e2e/tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
  cpSync(join(root, 'journey/e2e/index.html'), join(root, '.e2e-dist/journey/e2e/index.html'));
  const pw = loadPlaywright();
  const executablePath = findChromium(pw);
  const { server, base } = await serve(join(root, '.e2e-dist'));
  const browser = await pw.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    await runExpertAndNewHire(browser, base);
    await runInterrupted(browser, base);
    await runReduced(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
