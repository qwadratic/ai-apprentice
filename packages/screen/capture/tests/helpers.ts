import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import type {
  CaptureInvalidation,
  CaptureRuntime,
  DisplayCaptureOptions,
  FrameLease,
  ProcessedFrame,
} from '../ScreenCapture.ts';
import type { Geometry, PrivacyMask } from '../../privacy/masks.ts';

type ScreenCaptureConstructor = typeof import('../ScreenCapture.ts').ScreenCapture;
type ValidateMasks = (masks: readonly PrivacyMask[]) => readonly PrivacyMask[];
type MaskPixels = (mask: PrivacyMask, width: number, height: number) => {
  x: number; y: number; width: number; height: number;
};
type LoadedModules = {
  ScreenCapture: ScreenCaptureConstructor;
  validateMasks: ValidateMasks;
  maskPixels: MaskPixels;
  directory: string;
  cleanup: () => Promise<void>;
};

export async function prepareBrowserModules(
  { includePanel = false }: { includePanel?: boolean } = {},
): Promise<LoadedModules> {
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
  const capture = await import(pathToFileURL(join(directory, 'packages/screen/capture/ScreenCapture.js')).href) as {
    ScreenCapture: ScreenCaptureConstructor;
  };
  const privacy = await import(pathToFileURL(join(directory, 'packages/screen/privacy/masks.js')).href) as {
    validateMasks: ValidateMasks;
    maskPixels: MaskPixels;
  };
  return { ...capture, ...privacy, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function loadModules(): Promise<LoadedModules> {
  return prepareBrowserModules();
}

export function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolvePromise = a; reject = b; });
  const resolve = (value?: T | PromiseLike<T>): void => resolvePromise(value as T | PromiseLike<T>);
  return { promise, resolve, reject };
}
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class Track extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  enabled = true;
  stopped = 0;
  frames: Uint8ClampedArray[] = [];
  rate?: number;
  requestFrame?: () => void;
  stop(): void { this.readyState = 'ended'; ++this.stopped; }
}
type FakeStream = {
  getVideoTracks(): Track[];
  getAudioTracks(): Track[];
  getTracks(): Track[];
};
export function stream(video = new Track(), audio: Track[] = []): FakeStream {
  return { getVideoTracks: () => [video], getAudioTracks: () => audio, getTracks: () => [video, ...audio] };
}
type HarnessOptions = {
  play?: () => Promise<void>;
  deferEncoding?: boolean;
  noManualCapture?: boolean;
  getDisplayMedia?: (request: DisplayCaptureOptions) => Promise<MediaStream>;
  onFrame?: (frame: ProcessedFrame, lease: FrameLease) => void | Promise<void>;
};

export function harness(ScreenCapture: ScreenCaptureConstructor, options: HarnessOptions = {}) {
  let now = 10_000;
  let handle = 0;
  const animations = new Map<number, FrameRequestCallback>();
  const encodings: Array<() => void> = [];
  const tracks: Track[] = [];
  const sourceTrack = new Track();
  const audioTrack = new Track();
  const source = stream(sourceTrack, [audioTrack]);
  const video = Object.assign(new EventTarget(), {
    videoWidth: 100, videoHeight: 60, readyState: 2,
    srcObject: null as MediaStream | null,
    play: options.play ?? (async () => {}),
    pause(): void {},
  });
  type FakeContext = {
    save(): void;
    restore(): void;
    setTransform(...values: number[]): void;
    fillStyle: string;
    drawImage(): void;
    fillRect(x: number, y: number, width: number, height: number): void;
  };
  type FakeCanvas = {
    width: number;
    height: number;
    pixels: Uint8ClampedArray | null;
    getContext(): FakeContext;
    toBlob(callback: BlobCallback): void;
    captureStream(rate?: number): FakeStream;
  };
  const canvas: FakeCanvas = {
    width: 100, height: 60, pixels: null,
    getContext() { return context; },
    toBlob(callback): void {
      if (!this.pixels) throw new Error('Synthetic canvas has no pixels.');
      const blob = new Blob([this.pixels.slice()], { type: 'image/png' });
      if (options.deferEncoding) encodings.push(() => callback(blob));
      else callback(blob);
    },
    captureStream(rate): FakeStream {
      const track = new Track();
      track.rate = rate;
      track.requestFrame = () => {
        if (!this.pixels) throw new Error('Synthetic canvas has no pixels.');
        track.frames.push(this.pixels.slice());
      };
      if (options.noManualCapture) track.requestFrame = undefined;
      tracks.push(track);
      return stream(track);
    },
  };
  const context: FakeContext = {
    save(): void {}, restore(): void {}, setTransform(): void {}, fillStyle: '',
    drawImage(): void {
      canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
    },
    fillRect(x, y, width, height): void {
      if (!canvas.pixels || canvas.pixels.length !== canvas.width * canvas.height * 4) {
        canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255);
      }
      for (let cy = y; cy < y + height; cy++) for (let cx = x; cx < x + width; cx++) {
        const offset = (cy * canvas.width + cx) * 4;
        canvas.pixels.set([0, 0, 0, 255], offset);
      }
    },
  };
  const frames: ProcessedFrame[] = [];
  const leases: FrameLease[] = [];
  const requests: DisplayCaptureOptions[] = [];
  const invalidations: CaptureInvalidation[] = [];
  const runtime: CaptureRuntime = {
    getDisplayMedia(request) {
      requests.push(request);
      return options.getDisplayMedia?.(request) ?? Promise.resolve(source as unknown as MediaStream);
    },
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    createVideo: () => video as unknown as HTMLVideoElement,
    now: () => now,
    schedule(callback) { animations.set(++handle, callback); return handle; },
    cancel(id) { animations.delete(id); },
  };
  const capture = new ScreenCapture({
    runtime, frameIntervalMs: 1000, renderIntervalMs: 50,
    onFrame: options.onFrame ?? ((frame, lease) => { frames.push(frame); leases.push(lease); }),
  });
  capture.onInvalidate((event: CaptureInvalidation) => invalidations.push(event));
  return {
    capture, canvas, video, source, sourceTrack, audioTrack, frames, leases,
    requests, tracks, encodings, invalidations, animations,
    async start() { await capture.start({ sessionId: 'synthetic-session', sessionEpochMs: 9_000 }); },
    share() {
      const geometry: Geometry | null = capture.getSnapshot().geometry;
      if (!geometry) throw new Error('Synthetic geometry was not initialized.');
      return capture.confirmMasks(geometry.revision) && capture.resume();
    },
    async step(ms = 100) {
      now += ms;
      const callbacks = [...animations.values()]; animations.clear();
      callbacks.forEach((callback) => callback(now));
      await flush();
    },
  };
}
