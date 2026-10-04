import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createRequire, stripTypeScriptTypes} from 'node:module';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';

test('Chromium: replay seeks real media, falls back to frames, suppresses stale loads and cleans up', {
  skip: !process.env.PLAYWRIGHT_MODULE && 'Set PLAYWRIGHT_MODULE to an installed Playwright module.', timeout: 45_000,
}, async () => {
  if (!process.env.PLAYWRIGHT_MODULE) return;
  const root = join(import.meta.dirname, '../../../../..');
  const output = await mkdtemp(join(tmpdir(), 'apprentice-replay-test-'));
  for (const path of ['packages/screen/evidence/index.ts', 'apps/web/features/screen/ReplayPanel/index.ts']) {
    const destination = join(output, path.replace(/\.ts$/, '.js'));
    await mkdir(dirname(destination), {recursive: true});
    await writeFile(destination, stripTypeScriptTypes(await readFile(join(root, path), 'utf8'), {mode: 'strip'}));
  }
  await writeFile(join(output, 'package.json'), '{"type":"module"}');
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<main id="root"></main>'); return; }
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!path.endsWith('.js') || path.includes('..')) throw new Error('invalid path');
      response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(output, path)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: any;
  try {
    const playwright = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE) as any;
    browser = await playwright.chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined});
    const page = await browser.newPage();
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(async () => {
      // @ts-expect-error Runtime module is provided by the synthetic server.
      const {mountReplayPanel} = await import('/apps/web/features/screen/ReplayPanel/index.js');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
      const context = canvas.getContext('2d')!; const stream = canvas.captureStream(20);
      const recorder = new MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp8'}); const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data); recorder.start(100);
      const began = performance.now();
      while (performance.now() - began < 1_200) {
        context.fillStyle = performance.now() - began < 500 ? '#f00' : '#00f'; context.fillRect(0, 0, 64, 36);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const stopped = new Promise<void>(resolve => recorder.onstop = () => resolve()); recorder.stop(); await stopped;
      stream.getTracks().forEach(track => track.stop());
      const videoUrl = URL.createObjectURL(new Blob(chunks, {type: recorder.mimeType}));
      const frame = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="lime"/></svg>');
      let release!: (value: any) => void;
      const pending = new Promise(resolve => { release = resolve; });
      const refs: Record<string, any> = {video: {assetRef: frame, startMs: 700, endMs: 700}, frame: {assetRef: frame, startMs: 2_000, endMs: 2_000}, broken: {assetRef: '/missing.png', startMs: 2_000, endMs: 2_000}, stalledMedia: {assetRef: frame, startMs: 3_500, endMs: 3_500}};
      const panel = mountReplayPanel(document.querySelector('#root'), {
        resolveEvidence: (id: string) => id === 'slow' ? pending : id === 'stall' ? new Promise(() => {}) : Promise.resolve(refs[id]!),
        recordingSegments: () => [
          {id: 'segment', sessionId: 's', assetRef: videoUrl, startMs: 0, endMs: 1_100, mediaStartMs: 0, mediaEndMs: 1_100, mimeType: recorder.mimeType},
          {id: 'stalled', sessionId: 's', assetRef: 'stalled-media', startMs: 3_000, endMs: 4_000, mediaStartMs: 0, mediaEndMs: 1_000, mimeType: recorder.mimeType},
        ],
        resolveRecordingAsset: (segment: any) => segment.assetRef === 'stalled-media' ? videoUrl : segment.assetRef,
        sessionId: 's',
        loadTimeoutMs: 500,
      });
      Object.assign(window, {panel, release, refs, videoUrl});
      await panel.openEvidence('video', 700);
    });
    await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) >= .65);
    assert.ok(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime) >= .65);
    await page.evaluate(async () => (window as any).panel.openEvidence('frame'));
    await page.getByRole('img', {name: 'Processed screen evidence'}).waitFor();
    await page.evaluate(() => {
      const state = window as any; void state.panel.openEvidence('slow'); void state.panel.openEvidence('frame');
      state.release({assetRef: state.refs.frame.assetRef, startMs: 0, endMs: 0});
    });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('img').count(), 1, 'late resolver cannot replace the current selection');
    assert.equal(await page.evaluate(async () => {
      const state = window as any;
      const cancelled = state.panel.openEvidence('stall');
      await state.panel.openEvidence('frame');
      return Promise.race([cancelled.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    }), true, 'replacement settles a resolver that ignores abort');
    await page.evaluate(async () => (window as any).panel.openEvidence('broken'));
    await page.getByText('This evidence asset is unavailable or could not be loaded.').waitFor();
    await page.evaluate(() => (window as any).panel.openEvidence('stall'));
    await page.getByText('This evidence took too long to load or seek.').waitFor();
    await page.evaluate(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {...descriptor, set() {}});
      try { await (window as any).panel.openEvidence('stalledMedia', 3_500); }
      finally { Object.defineProperty(HTMLMediaElement.prototype, 'src', descriptor); }
      await new Promise(resolve => setTimeout(resolve, 650));
    });
    await page.getByText('This evidence took too long to load or seek.').waitFor();
    await page.evaluate(() => { const state = window as any; state.panel.dispose(); URL.revokeObjectURL(state.videoUrl); });
    assert.equal(await page.locator('.replay-panel').count(), 0);
  } finally {
    await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(output, {recursive: true, force: true});
  }
});
