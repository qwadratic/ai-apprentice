import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareBrowserModules } from './helpers.ts';

type BrowserFrame = { image: Blob; timestampMs: number; geometry: { width: number } };
type BrowserLease = { isCurrent(): boolean };
type BrowserCapture = {
  canvas: HTMLCanvasElement;
  start(session: { sessionId: string; sessionEpochMs: number }): Promise<void>;
  pause(): void;
  resume(): boolean;
  stop(): void;
  createProcessedStream(): MediaStream;
  getSnapshot(): { geometry: { width: number } | null; masks: readonly unknown[]; state: string; reason?: string };
};

declare global {
  interface Window {
    framesReceived: BrowserFrame[];
    leases: BrowserLease[];
    requests: unknown[];
    controllerCalls: string[];
    capture: BrowserCapture;
    processed: MediaStream;
    rawTrack: MediaStreamTrack;
    unmount(): void;
    testBrokenControllerStop(kind: 'throw' | 'reject' | 'pending'): Promise<{
      state: string; trackState: MediaStreamTrackState; before: number; after: number;
    }>;
    resizeSource(): void;
    decodeFrame(frame: BrowserFrame): Promise<{ width: number; height: number; pixels: number[] }>;
  }
}

// Optional local browser test: no product dependencies or browser downloads are added.
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const assertYellow = (pixel: readonly number[]): void => {
  // A video decoder may round unmasked RGB channels during YUV conversion.
  assert.ok([255, 192, 0].every((value, i) => Math.abs(value - (pixel[i] ?? Number.NaN)) <= 2));
  assert.equal(pixel[3], 255);
};

test('Chromium: real canvas/PNG/processed stream pixels, panel masks, lifecycle and resize', {
  skip: !playwrightModule && 'Set PLAYWRIGHT_MODULE to an installed Playwright module.',
  timeout: 45_000,
}, async () => {
  if (!playwrightModule) return;
  const { directory, cleanup } = await prepareBrowserModules({ includePanel: true });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Capture test</title><body><main id="panel"></main></body></html>');
      } else {
        const path = new URL(request.url ?? '/missing', 'http://localhost').pathname;
        if (!path.endsWith('.js') || path.includes('..')) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(join(directory, path)));
      }
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  let browser: {
    newPage(options: { viewport: { width: number; height: number } }): Promise<any>;
    close(): Promise<void>;
  } | undefined;
  try {
    const playwright = createRequire(import.meta.url)(playwrightModule) as {
      chromium: { launch(options: { headless: boolean; channel?: string }): Promise<{
        newPage(options: { viewport: { width: number; height: number } }): Promise<any>;
        close(): Promise<void>;
      }> };
    };
    browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic server did not bind TCP.');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(async () => {
      // @ts-expect-error Browser test server provides this runtime-only module.
      const { ScreenCapture, browserCaptureRuntime } = await import('/packages/screen/capture/ScreenCapture.js');
      // @ts-expect-error Browser test server provides this runtime-only module.
      const { mountScreenPanel } = await import('/apps/web/features/screen/ScreenPanel/index.js');
      const source = document.createElement('canvas'); source.width = 320; source.height = 180;
      const context = source.getContext('2d')!;
      const paint = () => {
        context.fillStyle = '#ffc000'; context.fillRect(0, 0, source.width, source.height);
        context.fillStyle = '#ffffff'; context.fillRect(24, 40, 260, 40);
        context.fillStyle = '#000000'; context.font = '20px sans-serif';
        context.fillText('learner@example.invalid', 26, 65);
      };
      paint();
      const raw = source.captureStream(30);
      window.framesReceived = [];
      window.leases = [];
      window.requests = [];
      window.controllerCalls = [];
      window.capture = new ScreenCapture({
        runtime: { ...browserCaptureRuntime(), getDisplayMedia: async (options: unknown) => { window.requests.push(options); return raw; } },
        frameIntervalMs: 100, renderIntervalMs: 15,
        // Lossless native-size frames: this test compares exact mask and preview pixels.
        frameEncoding: { maxWidth: Infinity, jpegQuality: null },
        onFrame: (frame: BrowserFrame, lease: BrowserLease) => { window.framesReceived.push(frame); window.leases.push(lease); },
      });
      window.unmount = mountScreenPanel(document.querySelector('#panel'), {
        capture: window.capture, session: () => ({ sessionId: 'browser-synthetic', sessionEpochMs: Date.now() - 5000 }),
        controller: {
          start: async (session: { sessionId: string; sessionEpochMs: number }) => {
            window.controllerCalls.push('start');
            await window.capture.start(session);
          },
          pause: () => { window.controllerCalls.push('pause'); window.capture.pause(); },
          resume: () => { window.controllerCalls.push('resume'); window.capture.resume(); },
          stop: () => { window.controllerCalls.push('stop'); window.capture.stop(); },
        },
      });
      window.testBrokenControllerStop = async (kind) => {
        const fixture = document.createElement('canvas'); fixture.width = 40; fixture.height = 20;
        fixture.getContext('2d')!.fillRect(0, 0, 40, 20);
        const fixtureStream = fixture.captureStream(30);
        const localFrames: BrowserFrame[] = [];
        const localCapture = new ScreenCapture({
          runtime: { ...browserCaptureRuntime(), getDisplayMedia: async () => fixtureStream },
          frameIntervalMs: 10, renderIntervalMs: 5,
          onFrame: (frame: BrowserFrame) => { localFrames.push(frame); },
        });
        const host = document.body.appendChild(document.createElement('div'));
        const unmount = mountScreenPanel(host, {
          capture: localCapture,
          session: () => ({ sessionId: `broken-${kind}`, sessionEpochMs: Date.now() }),
          controller: {
            start: (session: { sessionId: string; sessionEpochMs: number }) => localCapture.start(session),
            pause: () => localCapture.pause(),
            resume: () => { localCapture.resume(); },
            stop: () => {
              if (kind === 'throw') throw new Error('Synthetic stop failure');
              if (kind === 'reject') return Promise.reject(new Error('Synthetic stop rejection'));
              return new Promise<void>(() => {});
            },
          },
        });
        await localCapture.start({ sessionId: `broken-${kind}`, sessionEpochMs: Date.now() });
        while (!localCapture.getSnapshot().geometry) await new Promise((resolve) => setTimeout(resolve, 10));
        localCapture.confirmMasks(localCapture.getSnapshot().geometry!.revision);
        localCapture.resume();
        while (localFrames.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
        const before = localFrames.length;
        unmount();
        const state = localCapture.getSnapshot().state;
        const trackState = fixtureStream.getVideoTracks()[0]!.readyState;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const after = localFrames.length;
        host.remove();
        return { state, trackState, before, after };
      };
      window.resizeSource = () => {
        source.width = 640; source.height = 360; paint();
        (raw.getVideoTracks()[0]! as MediaStreamTrack & { requestFrame(): void }).requestFrame();
      };
      window.rawTrack = raw.getVideoTracks()[0]!;
      window.decodeFrame = async (frame: BrowserFrame) => {
        const image = await createImageBitmap(frame.image);
        const decoded = document.createElement('canvas'); decoded.width = image.width; decoded.height = image.height;
        const ctx = decoded.getContext('2d')!; ctx.drawImage(image, 0, 0); image.close();
        return { width: decoded.width, height: decoded.height, pixels: [...ctx.getImageData(0, 0, decoded.width, decoded.height).data] };
      };
    });
    await page.getByRole('button', { name: 'Choose screen or window' }).click();
    await page.waitForFunction(() => window.capture.getSnapshot().geometry?.width === 320);
    assert.equal(await page.evaluate(() => window.framesReceived.length), 0);
    assert.deepEqual(await page.evaluate(() => window.requests), [{ video: { cursor: 'always' }, audio: false }]);
    assert.deepEqual(await page.evaluate(() => window.controllerCalls), ['start']);
    // Accessible coordinate entry covers the complete synthetic email.
    await page.getByLabel('Left (%)').fill('6.25');
    await page.getByLabel('Top (%)').fill('20');
    await page.getByLabel('Width (%)').fill('87.5');
    await page.getByLabel('Height (%)').fill('30');
    await page.getByRole('button', { name: 'Add mask', exact: true }).click();
    assert.equal(await page.evaluate(() => window.capture.getSnapshot().masks.length), 1);
    await page.getByRole('button', { name: 'Confirm masks and share' }).click();
    await page.waitForFunction(() => window.framesReceived.length > 0);
    const result = await page.evaluate(async () => {
      const frame = window.framesReceived.at(-1)!;
      const decoded = await window.decodeFrame(frame);
      const preview = [...window.capture.canvas.getContext('2d')!.getImageData(0, 0, 320, 180).data];
      return { ...decoded, preview, timestamp: frame.timestampMs, valid: window.leases.at(-1)!.isCurrent() };
    });
    assert.deepEqual(result.pixels, result.preview);
    assert.ok(result.timestamp >= 5000); assert.equal(result.valid, true);
    for (let y = 40; y < 80; y++) for (let x = 24; x < 284; x++) {
      const offset = (y * 320 + x) * 4;
      assert.deepEqual(result.pixels.slice(offset, offset + 4), [0, 0, 0, 255]);
    }
    assertYellow(result.pixels.slice(0, 4));
    if (process.env.CAPTURE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CAPTURE_SCREENSHOT_PATH, fullPage: true });

    // A real decoded media frame proves the output stream contains the same masks.
    const streamPixels = await page.evaluate(async () => {
      window.processed = window.capture.createProcessedStream();
      const video = document.createElement('video'); video.muted = true; video.srcObject = window.processed;
      await video.play();
      await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0);
      const masked = [...ctx.getImageData(24, 40, 1, 1).data];
      const clear = [...ctx.getImageData(0, 0, 1, 1).data];
      video.pause(); video.srcObject = null;
      return { masked, clear, audioTracks: window.processed.getAudioTracks().length };
    });
    assert.deepEqual(streamPixels.masked, [0, 0, 0, 255]);
    assertYellow(streamPixels.clear); assert.equal(streamPixels.audioTracks, 0);

    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await page.evaluate(() => ({
      count: window.framesReceived.length,
      stale: window.leases.every((lease: BrowserLease) => !lease.isCurrent()),
      enabled: window.processed.getVideoTracks()[0]!.enabled,
    }));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.framesReceived.length), paused.count);
    assert.equal(paused.stale, true); assert.equal(paused.enabled, false);
    assert.deepEqual(await page.evaluate(() => window.controllerCalls.slice(-1)), ['pause']);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction((count: number) => window.framesReceived.length > count, paused.count);
    assert.deepEqual(await page.evaluate(() => window.controllerCalls.slice(-1)), ['resume']);
    await page.evaluate(() => window.resizeSource());
    await page.waitForFunction(() => window.capture.getSnapshot().reason === 'geometry-changed');
    const resized = await page.evaluate(() => ({
      count: window.framesReceived.length,
      geometry: window.capture.getSnapshot().geometry,
      enabled: window.processed.getVideoTracks()[0]!.enabled,
    }));
    assert.ok(resized.geometry);
    assert.equal(resized.geometry.width, 640); assert.equal(resized.enabled, false);
    await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.framesReceived.length), resized.count);
    await page.getByRole('button', { name: 'Confirm masks and share' }).click();
    await page.waitForFunction((count: number) => window.framesReceived.length > count, resized.count);
    assert.equal(await page.evaluate(() => window.framesReceived.at(-1)!.geometry.width), 640);

    // Drag editing pauses before any mask changes and remains gated until confirmation.
    const canvasBox = await page.locator('canvas').boundingBox();
    assert.ok(canvasBox);
    await page.mouse.move(canvasBox.x + 5, canvasBox.y + 5); await page.mouse.down();
    await page.mouse.move(canvasBox.x + 80, canvasBox.y + 50); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.capture.getSnapshot().state), 'paused');
    assert.equal(await page.evaluate(() => window.capture.getSnapshot().masks.length), 2);
    await page.getByRole('button', { name: 'Confirm masks and share' }).click();
    await page.evaluate(() => window.rawTrack.dispatchEvent(new Event('ended')));
    assert.equal(await page.evaluate(() => window.capture.getSnapshot().reason), 'source-ended');
    await page.evaluate(() => window.unmount());
    assert.equal(await page.locator('.screen-panel').count(), 0);
    for (const kind of ['throw', 'reject', 'pending'] as const) {
      const stopped = await page.evaluate((value: 'throw' | 'reject' | 'pending') =>
        window.testBrokenControllerStop(value), kind);
      assert.equal(stopped.state, 'stopped', kind);
      assert.equal(stopped.trackState, 'ended', kind);
      assert.equal(stopped.after, stopped.before, kind);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
});
