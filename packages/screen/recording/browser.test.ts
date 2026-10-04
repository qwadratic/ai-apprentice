import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const playwrightModule = process.env.PLAYWRIGHT_MODULE;

test('Chromium records masked processed pixels in separate pause/resume clips', {
  skip: !playwrightModule && 'Set PLAYWRIGHT_MODULE to an installed Playwright module.', timeout: 45_000,
}, async () => {
  if (!playwrightModule) return;
  const root = new URL('../../../', import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'recording-browser-'));
  for (const path of ['packages/screen/privacy/masks.ts', 'packages/screen/capture/ScreenCapture.ts',
    'packages/screen/recording/ProcessedRecorder.ts', 'packages/screen/evidence/index.ts',
    'apps/web/features/screen/ReplayPanel/index.ts']) {
    const output = join(directory, path.replace(/\.ts$/, '.js'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, stripTypeScriptTypes(await readFile(new URL(path, root), 'utf8'), { mode: 'strip' }));
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><canvas id="source" width="160" height="90"></canvas>'); return; }
      const path = new URL(request.url!, 'http://local').pathname;
      response.setHeader('content-type', 'text/javascript'); response.end(await readFile(join(directory, path)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const playwright = createRequire(import.meta.url)(playwrightModule) as {
    chromium: { launch(options: { headless: boolean; channel?: string }): Promise<{
      newPage(): Promise<{ goto(url: string): Promise<unknown>; evaluate<T>(callback: () => Promise<T>): Promise<T> }>;
      close(): Promise<void>;
    }> };
  };
  const browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server');
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(async () => {
      // @ts-expect-error Served as browser JavaScript by this test's local module host.
      const { ScreenCapture, browserCaptureRuntime } = await import('/packages/screen/capture/ScreenCapture.js');
      // @ts-expect-error Served as browser JavaScript by this test's local module host.
      const { ProcessedRecorder, IndexedDbRecordingStore } = await import('/packages/screen/recording/ProcessedRecorder.js');
      // @ts-expect-error Served as browser JavaScript by this test's local module host.
      const { mountReplayPanel } = await import('/apps/web/features/screen/ReplayPanel/index.js');
      const source = document.querySelector('canvas')!; const context = source.getContext('2d')!;
      const paint = (color: string) => { context.fillStyle = color; context.fillRect(0, 0, 160, 90); };
      paint('#ffff00'); const raw = source.captureStream(30);
      const runtime = { ...browserCaptureRuntime(), getDisplayMedia: async () => raw };
      const capture = new ScreenCapture({ runtime, renderIntervalMs: 20 });
      await capture.start({ sessionId: 'browser', sessionEpochMs: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const geometry = capture.getSnapshot().geometry!;
      capture.setMasks([{ id: 'secret', x: 0, y: 0, width: .25, height: 1, enabled: true }]);
      capture.confirmMasks(geometry.revision); capture.resume();
      const assets = new Map<string, Blob>();
      const store = { save: async (input: { segment: { assetRef: string; mimeType: string }; chunks: Blob[] }) =>
        assets.set(input.segment.assetRef, new Blob(input.chunks, { type: input.segment.mimeType })),
        load: async (ref: string) => assets.get(ref) };
      const recorder = new ProcessedRecorder(capture, { store, timesliceMs: 100 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      capture.pause(); paint('#0000ff'); await new Promise((resolve) => setTimeout(resolve, 250));
      paint('#00ff00'); await new Promise((resolve) => setTimeout(resolve, 100));
      capture.resume(); await new Promise((resolve) => setTimeout(resolve, 500));
      capture.stop(); await recorder.flush();
      const sample = async (blob: Blob) => {
        const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(blob);
        await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(video.error); });
        await video.play(); await new Promise((resolve) => setTimeout(resolve, 150)); video.pause();
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
        const c = canvas.getContext('2d')!; c.drawImage(video, 0, 0); const pixels = c.getImageData(0, 0, 160, 90);
        return { masked: [...pixels.data.slice((45 * 160 + 10) * 4, (45 * 160 + 10) * 4 + 3)],
          visible: [...pixels.data.slice((45 * 160 + 120) * 4, (45 * 160 + 120) * 4 + 3)] };
      };
      const segments = recorder.getSegments(); const samples = [];
      for (const segment of segments) samples.push(await sample(assets.get(segment.assetRef)!));
      const databaseName = `recording-browser-${crypto.randomUUID()}`;
      const durable = new IndexedDbRecordingStore(databaseName);
      await durable.save({ segment: segments[0]!, chunks: [assets.get(segments[0]!.assetRef)!] });
      const restored = await new IndexedDbRecordingStore(databaseName).listSegments('browser');
      const restoredBytes = (await new IndexedDbRecordingStore(databaseName).load(segments[0]!.assetRef))?.size;
      const replayRoot = document.createElement('main'); document.body.append(replayRoot);
      const requested = segments[1]!.startMs + 100;
      const panel = mountReplayPanel(replayRoot, { sessionId: 'browser', recordingSegments: () => segments,
        resolveEvidence: async () => ({ schemaVersion: 1, id: 'recorded', kind: 'recording', assetRef: 'fallback',
          startMs: requested, endMs: requested }),
        resolveRecordingAsset: async (segment: { assetRef: string }) => assets.get(segment.assetRef)!,
      });
      await panel.openEvidence('recorded', requested);
      const replayVideo = replayRoot.querySelector('video')!;
      await new Promise<void>((resolve, reject) => {
        if (replayVideo.readyState >= 2) { resolve(); return; }
        replayVideo.onseeked = () => resolve(); replayVideo.onerror = () => reject(replayVideo.error);
      });
      await replayVideo.play(); await new Promise((resolve) => setTimeout(resolve, 100)); replayVideo.pause();
      const replayCanvas = document.createElement('canvas'); replayCanvas.width = 160; replayCanvas.height = 90;
      const replayContext = replayCanvas.getContext('2d')!; replayContext.drawImage(replayVideo, 0, 0);
      const replayPixels = replayContext.getImageData(0, 0, 160, 90).data;
      const replayVisible = [...replayPixels.slice((45 * 160 + 120) * 4, (45 * 160 + 120) * 4 + 3)];
      panel.dispose(); await recorder.dispose(); return { segments, samples, replayVisible, restored, restoredBytes };
    });
    assert.equal(result.segments.length, 2);
    assert.ok(result.segments[1]!.startMs - result.segments[0]!.endMs >= 200, 'pause remains a session-time gap');
    for (const sample of result.samples) assert.ok(sample.masked.every((channel: number) => channel < 20), 'mask stays black');
    assert.ok(result.samples[0]!.visible[0]! > 180 && result.samples[0]!.visible[1]! > 180,
      `first clip is yellow: ${JSON.stringify(result.samples)}`);
    assert.ok(result.samples[1]!.visible[1]! > 150 && result.samples[1]!.visible[2]! < 80,
      `second clip is green, not paused blue: ${JSON.stringify(result.samples)}`);
    assert.ok(result.replayVisible[1]! > 150 && result.replayVisible[2]! < 80, 'ReplayPanel opens the generated second clip');
    assert.deepEqual(result.restored, [result.segments[0]]); assert.ok((result.restoredBytes ?? 0) > 0);
  } finally { await browser.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
