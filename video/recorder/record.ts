// Records a scripted walkthrough of the product as a 1920x1080 video.
//
//   npm run record:sample                      # recorder/walkthroughs/sample.json
//   npm run record -- my-flow                  # recorder/walkthroughs/my-flow.json
//   npm run record -- sample --url http://localhost:5173/
//
// Output in assets/recordings/: <name>.mp4 (H.264, what the compositions use) and <name>.json
// (when each marked step happened, in seconds on the mp4).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { resolveBrowser } from '../lib/browser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Target = {
  role?: string;
  name?: string;
  text?: string;
  /** A form label, for inputs and checkboxes. */
  byLabel?: string;
  selector?: string;
  exact?: boolean;
};

type Step = Target & {
  do: 'goto' | 'click' | 'check' | 'hover' | 'type' | 'press' | 'scroll' | 'wait';
  url?: string;
  /** For "goto": wait until this element is visible (default: the load event). */
  ready?: Target;
  /** Text for "type", key for "press" (e.g. "Enter"), pixels for "scroll". */
  value?: string | number;
  /** Pause after the step, in ms. */
  wait?: number;
  /** Name this moment in the sidecar JSON. */
  marker?: string;
  /** Do not fail the recording if the target is missing. */
  optional?: boolean;
};

type Walkthrough = {
  description?: string;
  url?: string;
  viewport?: { width: number; height: number };
  permissions?: string[];
  steps: Step[];
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    headed: { type: 'boolean', default: false },
    'keep-frames': { type: 'boolean', default: false },
    'no-proxy': { type: 'boolean', default: false },
    'no-warmup': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    fps: { type: 'string', default: '30' },
  },
});

const name = positionals[0] ?? 'sample';
const walkthroughFile = path.join(root, 'recorder', 'walkthroughs', `${name}.json`);
if (!existsSync(walkthroughFile)) {
  console.error(`No walkthrough at ${walkthroughFile}`);
  process.exit(1);
}
const walkthrough = JSON.parse(readFileSync(walkthroughFile, 'utf8')) as Walkthrough;
const url = values.url ?? walkthrough.url ?? 'https://qwadratic.github.io/ai-apprentice/';
const viewport = walkthrough.viewport ?? { width: 1920, height: 1080 };

// A visible cursor and click ripple: Playwright's video does not draw the mouse.
const CURSOR_SCRIPT = `
(() => {
  if (window.__recCursor) return;
  window.__recCursor = true;
  const make = () => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px)';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M3 2l7 18 2.6-7.4L20 10z" fill="#ffffff" stroke="#0f2d2a" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    addEventListener('mousemove', (e) => { el.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 3) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;border:4px solid #17b3a3;width:20px;height:20px;left:' + (e.clientX - 10) + 'px;top:' + (e.clientY - 10) + 'px;opacity:.95;transition:all 450ms ease-out';
      document.documentElement.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(3.4)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 600);
    }, true);
  };
  if (document.documentElement) make(); else addEventListener('DOMContentLoaded', make);
})();
`;

const locate = (page: Page, t: Target): Locator => {
  if (t.role) {
    return page.getByRole(t.role as Parameters<Page['getByRole']>[0], { name: t.name, exact: t.exact }).first();
  }
  if (t.byLabel) return page.getByLabel(t.byLabel, { exact: t.exact }).first();
  if (t.text) return page.getByText(t.text, { exact: t.exact }).first();
  if (t.selector) return page.locator(t.selector).first();
  throw new Error('A step needs role, byLabel, text or selector');
};

let cursor = { x: viewport.width / 2, y: viewport.height / 2 };

/** Moves the visible cursor to the middle of the target over `ms`, so the video shows a smooth glide. */
const glideTo = async (page: Page, locator: Locator, ms = 700): Promise<void> => {
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const box = await locator.boundingBox();
  if (!box) return;
  const from = cursor;
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const began = Date.now();
  for (;;) {
    const p = Math.min(1, (Date.now() - began) / ms);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
    if (p >= 1) break;
    await page.waitForTimeout(16); // keeps the CPU free for the video encoder
  }
  cursor = to;
};

/** A proxy or a cold server can fail the first request; try a few times before giving up. */
const gotoWithRetry = async (page: Page, target: string, tries = 4): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 25_000 });
      return;
    } catch (error) {
      if (attempt >= tries) throw error;
      console.log(`  goto attempt ${attempt} failed (${(error as Error).message.split('\n')[0]}), retrying`);
      await page.waitForTimeout(1000);
    }
  }
};

type CachedResponse = { status: number; headers: Record<string, string>; body: Buffer };

const STATIC_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font']);

/**
 * Loads the page once without recording and keeps its static files in memory. The recorded run
 * then serves them from memory, so the video shows the app loading at normal speed even when
 * the network is slow or flaky (the cloud container's proxy is both). XHR and fetch calls are
 * never cached: the app still talks to its real backend.
 */
const warmUp = async (browser: Browser, first: Step | undefined): Promise<Map<string, CachedResponse>> => {
  const cache = new Map<string, CachedResponse>();
  for (let pass = 1; pass <= 3; pass++) {
    const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, permissions: walkthrough.permissions ?? [] });
    const page = await ctx.newPage();
    let failed = 0;
    const pending: Promise<void>[] = [];
    page.on('requestfailed', () => failed++);
    page.on('response', (response) => {
      const request = response.request();
      if (request.method() !== 'GET' || response.status() !== 200 || !STATIC_TYPES.has(request.resourceType())) return;
      pending.push(
        response
          .body()
          .then((body) => {
            // The body is already decoded, so the encoding and length headers would be wrong.
            const { 'content-encoding': _enc, 'content-length': _len, 'transfer-encoding': _tr, ...headers } =
              response.headers();
            cache.set(response.url(), { status: 200, headers, body });
          })
          .catch(() => undefined),
      );
    });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      if (first?.ready) await locate(page, first.ready).waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1500);
    } catch (error) {
      failed++;
      console.log(`  warm-up pass ${pass}: ${(error as Error).message.split('\n')[0]}`);
    }
    await Promise.all(pending);
    await ctx.close();
    if (failed === 0 && cache.size > 0) break;
  }
  console.log(`Warm-up: ${cache.size} static file(s) cached in memory`);
  return cache;
};

const ffmpeg = (args: string[]): void => {
  // Remotion ships an ffmpeg with libx264 and a VP8 decoder; it needs no system install.
  execFileSync('npx', ['remotion', 'ffmpeg', '-hide_banner', '-loglevel', 'error', ...args], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
};

const main = async (): Promise<void> => {
  const outDir = path.join(root, 'assets', 'recordings');
  const tmpDir = path.join(outDir, `.tmp-${name}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const browser = resolveBrowser();
  console.log(browser ? `Browser: ${browser.executable} (${browser.source})` : 'Browser: Playwright default (run "npx playwright-core install chromium" if it is missing)');

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const launched = await chromium.launch({
    executablePath: browser?.executable,
    headless: !values.headed,
    proxy: proxyServer && !isLocal && !values['no-proxy'] ? { server: proxyServer } : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--force-device-scale-factor=1'],
  });

  const firstGoto = walkthrough.steps.find((step) => step.do === 'goto');
  const cache = values['no-warmup'] ? new Map<string, CachedResponse>() : await warmUp(launched, firstGoto);

  // ignoreHTTPSErrors: in the cloud container the HTTPS proxy re-signs traffic with its own CA.
  const context: BrowserContext = await launched.newContext({
    viewport,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    colorScheme: 'light',
    permissions: walkthrough.permissions ?? [],
  });
  await context.addInitScript(CURSOR_SCRIPT);
  if (cache.size > 0) {
    await context.route('**/*', (route) => {
      // The page itself always comes from the network (it is small); scripts, styles, fonts and images are replayed.
      const replay = route.request().method() === 'GET' && route.request().resourceType() !== 'document';
      const hit = replay ? cache.get(route.request().url()) : undefined;
      if (values.verbose) console.log(`  ${hit ? 'cache' : 'net  '} ${route.request().method()} ${route.request().url().slice(0, 100)}`);
      return hit ? route.fulfill(hit) : route.continue();
    });
  }
  if (values.verbose) {
    context.on('requestfailed', (r) => console.log(`  FAILED ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
  }


  const page = await context.newPage();

  // The video comes from Chrome's screencast, not from Playwright's recordVideo: every painted
  // frame arrives with its own timestamp, so the video is cut on the real clock and the markers
  // in the sidecar JSON match it exactly. (recordVideo re-times frames at a fixed rate and
  // drifts by 10 to 20 percent on a busy machine.)
  type Shot = { atMs: number; file: string };
  const shots: Shot[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (event) => {
    const file = path.join(tmpDir, `${String(shots.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(event.data, 'base64'));
    shots.push({ atMs: (event.metadata.timestamp ?? Date.now() / 1000) * 1000, file });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  const markers: { marker: string; atMs: number }[] = [];
  const beganAt = Date.now();
  let readyAtMs = 0;
  let endAtMs = 0;
  const elapsed = (): string => `${((Date.now() - beganAt) / 1000).toFixed(1)} s`;

  try {
    for (const [index, step] of walkthrough.steps.entries()) {
      const label = `${index + 1}. ${step.do}${step.name ? ` "${step.name}"` : step.byLabel ? ` "${step.byLabel}"` : ''}`;
      try {
        switch (step.do) {
          case 'goto':
            await gotoWithRetry(page, step.url ?? url);
            if (step.ready) await locate(page, step.ready).waitFor({ state: 'visible', timeout: 30_000 });
            await page.mouse.move(cursor.x, cursor.y);
            if (readyAtMs === 0) readyAtMs = Date.now();
            break;
          case 'click': {
            const target = locate(page, step);
            await glideTo(page, target);
            await target.click({ delay: 90, timeout: 10_000 });
            break;
          }
          case 'check': {
            const target = locate(page, step);
            await glideTo(page, target);
            await target.check({ timeout: 10_000 });
            break;
          }
          case 'hover': {
            const target = locate(page, step);
            await glideTo(page, target);
            break;
          }
          case 'type': {
            const target = locate(page, step);
            await glideTo(page, target);
            await target.click();
            await page.keyboard.type(String(step.value ?? ''), { delay: 70 });
            break;
          }
          case 'press':
            await page.keyboard.press(String(step.value ?? 'Enter'));
            break;
          case 'scroll':
            await page.mouse.wheel(0, Number(step.value ?? 400));
            break;
          case 'wait':
            break;
        }
        if (step.marker) markers.push({ marker: step.marker, atMs: Date.now() });
        console.log(`  ok   ${label}  (${elapsed()})`);
      } catch (error) {
        if (!step.optional) throw error;
        console.log(`  skip ${label}: ${(error as Error).message.split('\n')[0]}`);
      }
      await page.waitForTimeout(step.wait ?? 600);
    }
    endAtMs = Date.now();
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await context.close();
    await launched.close();
  }

  if (shots.length === 0) throw new Error('The screencast produced no frames.');
  // Frames can arrive slightly out of order; the timestamp says when the picture was on screen.
  shots.sort((a, b) => a.atMs - b.atMs);

  // The video starts just before the page first looked ready; times in the sidecar count from there.
  const startMs = Math.max(shots[0]!.atMs, readyAtMs - 200);
  const first = Math.max(0, shots.findLastIndex((s) => s.atMs <= startMs));
  const used = shots.slice(first);
  const lines: string[] = ['ffconcat version 1.0'];
  used.forEach((shot, i) => {
    const from = Math.max(shot.atMs, startMs);
    const until = used[i + 1]?.atMs ?? endAtMs;
    const seconds = (until - from) / 1000;
    if (seconds <= 0) return;
    lines.push(`file '${path.basename(shot.file)}'`, `duration ${seconds.toFixed(4)}`);
  });
  lines.push(`file '${path.basename(used[used.length - 1]!.file)}'`);
  const listFile = path.join(tmpDir, 'frames.txt');
  writeFileSync(listFile, `${lines.join('\n')}\n`);

  const durationSec = (endAtMs - startMs) / 1000;
  const sidecar = {
    name,
    url,
    viewport,
    recordedAt: new Date().toISOString(),
    durationSec: Number(durationSec.toFixed(2)),
    frames: used.length,
    markers: markers.map((m) => ({ marker: m.marker, tSec: Number(((m.atMs - startMs) / 1000).toFixed(2)) })),
  };
  writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(`Captured ${used.length} frames over ${durationSec.toFixed(1)} s (${(used.length / durationSec).toFixed(1)} fps average)`);

  const mp4 = path.join(outDir, `${name}.mp4`);
  const tmpMp4 = path.join(outDir, `.${name}.tmp.mp4`);
  ffmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-fps_mode', 'cfr', '-r', values.fps,
    '-vf', 'scale=in_range=pc:out_range=tv', // JPEG frames are full range; players expect limited range
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', '-an', tmpMp4,
  ]);
  renameSync(tmpMp4, mp4);
  if (!values['keep-frames']) rmSync(tmpDir, { recursive: true, force: true });
  console.log(`Recorded -> ${mp4} (${(statSync(mp4).size / 1024).toFixed(0)} KB)`);
  console.log(`Markers (s on the mp4): ${sidecar.markers.map((m) => `${m.marker}=${m.tSec}`).join(', ')}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
