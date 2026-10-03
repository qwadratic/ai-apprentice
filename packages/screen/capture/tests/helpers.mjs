import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

export async function loadModules({ includePanel = false } = {}) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'apprentice-capture-test-'));
  const paths = [
    'packages/screen/privacy/masks.ts',
    'packages/screen/capture/ScreenCapture.ts',
    'packages/screen/capture/index.ts',
  ];
  if (includePanel) paths.push('apps/web/features/screen/ScreenPanel/index.ts');
  for (const path of paths) {
    const output = join(directory, path.replace(/\.ts$/, '.js'));
    await mkdir(dirname(output), { recursive: true });
    const source = await readFile(join(root, path), 'utf8');
    await writeFile(output, stripTypeScriptTypes(source, { mode: 'strip' }));
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const capture = await import(pathToFileURL(join(directory, 'packages/screen/capture/ScreenCapture.js')));
  const privacy = await import(pathToFileURL(join(directory, 'packages/screen/privacy/masks.js')));
  return { ...capture, ...privacy, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export class Track extends EventTarget {
  readyState = 'live';
  muted = false;
  enabled = true;
  stopped = 0;
  frames = [];
  stop() { this.readyState = 'ended'; ++this.stopped; }
}
export function stream(video = new Track(), audio = []) {
  return { getVideoTracks: () => [video], getAudioTracks: () => audio, getTracks: () => [video, ...audio] };
}
export function harness(ScreenCapture, options = {}) {
  let now = 10_000;
  let handle = 0;
  const animations = new Map();
  const encodings = [];
  const tracks = [];
  const sourceTrack = new Track();
  const audioTrack = new Track();
  const source = stream(sourceTrack, [audioTrack]);
  const video = Object.assign(new EventTarget(), {
    videoWidth: 100, videoHeight: 60, readyState: 2,
    srcObject: null, play: options.play ?? (async () => {}), pause() {},
  });
  const canvas = {
    width: 100, height: 60, pixels: null,
    getContext() { return context; },
    toBlob(callback) {
      const blob = new Blob([this.pixels.slice()], { type: 'image/png' });
      if (options.deferEncoding) encodings.push(() => callback(blob));
      else callback(blob);
    },
    captureStream(rate) {
      const track = new Track();
      track.rate = rate;
      track.requestFrame = () => { track.frames.push(this.pixels.slice()); };
      if (options.noManualCapture) delete track.requestFrame;
      tracks.push(track);
      return stream(track);
    },
  };
  const context = {
    save() {}, restore() {}, setTransform() {}, fillStyle: '',
    drawImage() {
      canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
    },
    fillRect(x, y, width, height) {
      if (!canvas.pixels || canvas.pixels.length !== canvas.width * canvas.height * 4) {
        canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
      }
      for (let cy = y; cy < y + height; cy++) for (let cx = x; cx < x + width; cx++) {
        const offset = (cy * canvas.width + cx) * 4;
        canvas.pixels.set([0, 0, 0, 255], offset);
      }
    },
  };
  const frames = [], leases = [], requests = [], invalidations = [];
  const runtime = {
    getDisplayMedia(request) { requests.push(request); return options.getDisplayMedia?.(request) ?? Promise.resolve(source); },
    createCanvas: () => canvas, createVideo: () => video,
    now: () => now,
    schedule(callback) { animations.set(++handle, callback); return handle; },
    cancel(id) { animations.delete(id); },
  };
  const capture = new ScreenCapture({
    runtime, frameIntervalMs: 1000, renderIntervalMs: 50,
    onFrame: options.onFrame ?? ((frame, lease) => { frames.push(frame); leases.push(lease); }),
  });
  capture.onInvalidate((event) => invalidations.push(event));
  return {
    capture, canvas, video, source, sourceTrack, audioTrack, frames, leases,
    requests, tracks, encodings, invalidations, animations,
    async start() { await capture.start({ sessionId: 'synthetic-session', sessionEpochMs: 9_000 }); },
    share() { const revision = capture.getSnapshot().geometry.revision; return capture.confirmMasks(revision) && capture.resume(); },
    async step(ms = 100) {
      now += ms;
      const callbacks = [...animations.values()]; animations.clear();
      callbacks.forEach((callback) => callback(now));
      await flush();
    },
  };
}
