// Headless Chromium run of the simulation, against the STUB agent: no ElevenLabs, no brain, no network.
//
//   node apps/web/features/agent/sim/e2e/run.ts                      the synthetic expert does the Learn task (default)
//   SIM_E2E_PERSONA=newhire node .../run.ts                          the synthetic new hire does Teach T1
//   SIM_E2E_OUT=/some/dir node .../run.ts                            where the video and report.json go (default: .e2e-out/ next to this file)
//   SIM_E2E_MODE=auto|headed|headless node .../run.ts                how the browser runs (default auto, see below)
//   SIM_E2E_LAG=5000 node .../run.ts                                 the vision lag the persona leaves room for (default 0: the stub reads the DOM)
//
// Modes. headed: a real (headful) Chromium; without an X server the script starts itself again under `xvfb-run -a` (Xvfb is
// installed on the VM). The page shares ITS OWN TAB with getDisplayMedia({preferCurrentTab}) and --auto-accept-this-tab-capture:
// real pixels, the same path as the product. headless: headless Chrome cannot capture a tab (NotReadableError or a hang), so
// the page paints the simulated desktop into a canvas and shares canvas.captureStream() instead (?capture=canvas). auto picks
// headed when a display or xvfb-run exists and headless otherwise. Never add --use-fake-ui-for-media-stream: it breaks
// getDisplayMedia, and the synthetic microphone does not need it. Do not use --auto-select-tab-capture-source-by-title: it hangs.
//
// What it does: starts the Vite dev server for apps/web on a free port, launches Chromium with the fake-UI and tab-capture
// auto-accept flags, opens the simulation page with ?sim=<persona>, clicks Start (a real click: getDisplayMedia needs a user
// gesture), records a video of the whole run and checks the page's own report. It then opens the page WITHOUT ?sim= in a
// second browser context and checks that nothing was installed. One page only: A's capture loop runs on
// requestAnimationFrame, so the shared tab must stay visible, and the run counts animation frames and the visibility state
// to prove it was never backgrounded.
//
// Playwright is not a dependency of the repo: it is looked up in the working directory and in the global node_modules
// (npm i -g playwright). The live-stack run (real ElevenLabs agent, real brain) is a later step: it needs the shell.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- the part of Playwright's API this script uses ------------------------------------------------------------------

interface PwConsoleMessage {
  type(): string;
  text(): string;
}
interface PwVideo {
  path(): Promise<string>;
}
interface PwPage {
  on(event: 'console', listener: (message: PwConsoleMessage) => void): unknown;
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  addInitScript(script: { content: string }): Promise<void>;
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  bringToFront(): Promise<void>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number; polling?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  video(): PwVideo | null;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: {
    viewport: { width: number; height: number } | null;
    recordVideo?: { dir: string; size: { width: number; height: number } };
  }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: {
    launch(options: { executablePath?: string; args?: string[]; headless?: boolean }): Promise<PwBrowser>;
    executablePath(): string;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isPwModule(value: unknown): value is PwModule {
  if (!isRecord(value) || !('chromium' in value)) return false;
  const chromium = value['chromium'];
  return isRecord(chromium) && typeof chromium['launch'] === 'function';
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
  const fromEnv = process.env['CHROMIUM_PATH'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const declared = pw.chromium.executablePath();
    if (declared && existsSync(declared)) return declared;
  } catch {
    // no bundled browser: try the known system location
  }
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// ---- the page's own report ----------------------------------------------------------------------------------------------

interface SimReport {
  status: string;
  persona: string | null;
  error: string | null;
  logs: Array<{ atMs: number; source: string; text: string }>;
  report: { completed: boolean; sent: boolean; checks: string[]; stepsRun: number } | null;
  answered: Array<{ topic: string; clipId: string; known: boolean }>;
  asked: Array<{ topic: string; text: string }>;
  mediaCalls: Array<{ kind: string; synthetic: boolean }>;
  capture: { source: string | null; displaySurface: string | null; width: number; height: number; nonBlank: boolean; trackState: string } | null;
  ears: { speechMs: number; utterances: number; peak: number } | null;
  workspace: { sent: boolean; ticket: string; attachments: number; check: string } | null;
}

function parseReport(text: unknown): SimReport {
  if (typeof text !== 'string') throw new Error('the page did not return a JSON string');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed['status'] !== 'string') throw new Error('the page report is not a report');
  return parsed as unknown as SimReport;
}

// ---- checks -------------------------------------------------------------------------------------------------------------

const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, what: string): void {
  (ok ? notes : failures).push(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

/** Counts animation frames and visibility changes from the first moment of the page. */
const FRAME_COUNTER = `
(() => {
  const state = { frames: 0, hiddenSamples: 0, samples: 0 };
  const loop = () => { state.frames += 1; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { state.samples += 1; if (document.visibilityState !== 'visible') state.hiddenSamples += 1; }, 500);
  window.__frameCounter = state;
})();
`;

type Mode = 'headed' | 'headless';

function hasCommand(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The mode to run in. For headed without a display the caller starts xvfb-run (see main). */
function chooseMode(): Mode {
  const wanted = (process.env['SIM_E2E_MODE'] ?? 'auto').toLowerCase();
  if (wanted === 'headed' || wanted === 'headless') return wanted;
  return process.env['DISPLAY'] || hasCommand('xvfb-run') ? 'headed' : 'headless';
}

// Headless: a fixed viewport (the page is painted into a canvas, so nothing is clipped). Headed: the real window decides.
const HEADLESS_VIEW = { width: 1440, height: 760 };
const HEADED_VIDEO = { width: 1280, height: 720 };

async function main(): Promise<void> {
  const mode = chooseMode();
  if (mode === 'headed' && !process.env['DISPLAY']) {
    if (!hasCommand('xvfb-run')) throw new Error('headed mode needs a display: set DISPLAY or install xvfb-run (or use SIM_E2E_MODE=headless)');
    // No X server: start this script again under Xvfb (a big virtual screen, so the window is never clipped).
    const again = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1700x1100x24', process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, SIM_E2E_MODE: 'headed' },
    });
    process.exitCode = again.status ?? 1;
    return;
  }
  const persona = (process.env['SIM_E2E_PERSONA'] ?? 'expert').toLowerCase().replace(/[-_ ]/g, '') === 'newhire' ? 'newhire' : 'expert';
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, '..', '..', '..', '..');
  const outDir = process.env['SIM_E2E_OUT'] ?? join(here, '.e2e-out');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const pw = loadPlaywright();
  const executablePath = findChromium(pw);

  const { createServer } = await import('vite');
  const port = await freePort();
  const server = await createServer({
    root: webRoot,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true },
    // The simulation page imports no packages: nothing to pre-bundle, and no scan of the other pages' scripts.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const pageUrl = (query: string): string => `${base}/features/agent/sim/entry/index.html${query}`;

  const browser = await pw.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: mode === 'headless',
    args: [
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      ...(mode === 'headed' ? ['--window-size=1440,900', '--window-position=0,0'] : []),
    ],
  });
  let exitCode = 0;
  try {
    // ---- the run -------------------------------------------------------------------------------------------------------
    const context =
      mode === 'headed'
        ? await browser.newContext({ viewport: null, recordVideo: { dir: outDir, size: HEADED_VIDEO } })
        : await browser.newContext({ viewport: HEADLESS_VIEW, recordVideo: { dir: outDir, size: HEADLESS_VIEW } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript({ content: FRAME_COUNTER });
    const lag = process.env['SIM_E2E_LAG'] ?? '0';
    await page.goto(pageUrl(`?sim=${persona}&capture=${mode === 'headed' ? 'tab' : 'canvas'}&lag=${lag}`));
    await page.waitForFunction('document.querySelector("[data-sim-start]") !== null');
    await page.bringToFront();
    const startedAt = Date.now();
    await page.click('[data-sim-start]');
    await page.waitForFunction('document.body.dataset.simStatus === "done" || document.body.dataset.simStatus === "failed"', undefined, {
      timeout: 8 * 60_000,
      polling: 500,
    });
    const elapsedMs = Date.now() - startedAt;
    const report = parseReport(await page.evaluate('JSON.stringify(window.__sim)'));
    const frames = (await page.evaluate('JSON.stringify(window.__frameCounter)')) as string;
    const frameState = JSON.parse(frames) as { frames: number; hiddenSamples: number; samples: number };
    const bodyText = String(await page.evaluate('document.body.innerText'));
    const frameUrl = await page.evaluate('window.__simFrame || null');
    if (typeof frameUrl === 'string' && frameUrl.startsWith('data:image/png;base64,')) {
      writeFileSync(join(outDir, 'shared-screen-last-frame.png'), Buffer.from(frameUrl.slice('data:image/png;base64,'.length), 'base64'));
    }
    const videoPath = (await page.video()?.path()) ?? null;
    await context.close();

    const label = persona === 'expert' ? 'Simulation — synthetic expert' : 'Simulation — synthetic new hire';
    check(report.status === 'done', `the run finished (status ${report.status}${report.error ? `: ${report.error}` : ''})`);
    check(report.report?.completed === true, 'the persona completed its task script');
    check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);
    check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    check(bodyText.includes(label), `the page shows the label "${label}"`);
    check(bodyText.toLowerCase().includes('stub'), 'the page says the agent is a stub');
    check(
      report.mediaCalls.some((c) => c.kind === 'getUserMedia' && c.synthetic) && report.mediaCalls.some((c) => c.kind === 'getDisplayMedia' && c.synthetic),
      'the page used the shimmed getUserMedia and getDisplayMedia',
    );
    check(report.capture?.nonBlank === true, `the shared screen delivered real frames (${report.capture?.width}x${report.capture?.height})`);
    if (mode === 'headed') {
      check(report.capture?.source === 'tab' && report.capture.displaySurface === 'browser', `the shared surface is this tab (source ${report.capture?.source}, displaySurface ${report.capture?.displaySurface})`);
    } else {
      check(report.capture?.source === 'canvas', `headless: the shared surface is a canvas painting of the desktop (source ${report.capture?.source})`);
    }
    check(frameState.frames > 10 * (elapsedMs / 1000), `animation frames kept running (${frameState.frames} in ${Math.round(elapsedMs / 1000)} s)`);
    check(frameState.hiddenSamples === 0, `the tab was never hidden (${frameState.hiddenSamples} of ${frameState.samples} samples)`);
    check(videoPath !== null && existsSync(videoPath), 'a video was recorded');

    if (persona === 'expert') {
      const topics = report.answered.map((a) => a.topic);
      check(report.answered.length >= 3, `the expert answered at least 3 questions (${topics.join(', ')})`);
      check(['reason', 'essentials', 'guardrail'].every((t) => topics.includes(t)), 'the answers cover reason, essentials and guardrail');
      check(report.answered.every((a) => a.known && a.clipId.startsWith('expert.')), 'every answer was a known clip of the expert');
      check((report.ears?.utterances ?? 0) >= 3, `a reader of the microphone heard at least 3 utterances (${report.ears?.utterances})`);
      check((report.ears?.speechMs ?? 0) >= 10_000, `and ${Math.round((report.ears?.speechMs ?? 0) / 1000)} s of speech`);
      check(report.workspace?.sent === true && report.workspace.ticket === 'resolved', 'the email was sent and the ticket resolved');
      check(report.workspace?.attachments === 0, 'the image was removed and the details written as text');
    } else {
      const topics = report.answered.map((a) => a.topic);
      check(topics.includes('predict') && topics.includes('why_hold'), `the new hire predicted and was asked why (${topics.join(', ')})`);
      check(report.report?.checks[0] === 'warn', `the first Preview was held back (checks ${report.report?.checks.join(', ')})`);
      check(report.report?.sent === true, 'after the fix the email was sent');
      check((report.ears?.utterances ?? 0) >= 2, `a reader of the microphone heard the answers (${report.ears?.utterances})`);
    }

    // ---- the page without ?sim= ------------------------------------------------------------------------------------------
    const plainContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const plain = await plainContext.newPage();
    await plain.goto(pageUrl(''));
    const untouched = String(
      await plain.evaluate(
        `JSON.stringify({ persona: window.__sim && window.__sim.persona, getUserMedia: String(navigator.mediaDevices.getUserMedia), getDisplayMedia: String(navigator.mediaDevices.getDisplayMedia), ownKeys: Object.getOwnPropertyNames(navigator.mediaDevices), startButton: !!document.querySelector('[data-sim-start]') })`,
      ),
    );
    const plainState = JSON.parse(untouched) as { persona: string | null; getUserMedia: string; getDisplayMedia: string; ownKeys: string[]; startButton: boolean };
    check(plainState.persona === null && !plainState.startButton, 'without ?sim= the page does nothing');
    check(plainState.getUserMedia.includes('[native code]') && plainState.getDisplayMedia.includes('[native code]'), 'without ?sim= getUserMedia and getDisplayMedia are the browser\'s own');
    check(!plainState.ownKeys.includes('getUserMedia') && !plainState.ownKeys.includes('getDisplayMedia'), 'without ?sim= nothing was installed on navigator.mediaDevices');
    await plainContext.close();

    // ---- the files ---------------------------------------------------------------------------------------------------
    let savedVideo: string | null = null;
    if (videoPath && existsSync(videoPath)) {
      savedVideo = join(outDir, `sim-${persona}.webm`);
      renameSync(videoPath, savedVideo);
    }
    for (const file of readdirSync(outDir)) if (file.endsWith('.webm') && join(outDir, file) !== savedVideo) rmSync(join(outDir, file));
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ persona, mode, elapsedMs, video: savedVideo, frameState, checks: { passed: notes, failed: failures }, page: report }, null, 2)}\n`);
    console.log(`${persona} (${mode}): ${Math.round(elapsedMs / 1000)} s, video ${savedVideo ?? 'none'}`);
    for (const line of [...notes, ...failures]) console.log(line);
    if (failures.length > 0) exitCode = 1;
  } finally {
    await browser.close();
    await server.close();
  }
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
