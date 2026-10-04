import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import type {
  CaptureInvalidation,
  CaptureProvenance,
  CaptureRuntime,
  DisplayCaptureOptions,
  FrameEncoding,
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
  DEFAULT_FRAME_ENCODING: FrameEncoding;
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
    DEFAULT_FRAME_ENCODING: FrameEncoding;
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
  snapshotProvenance?: () => CaptureProvenance;
  onFrame?: (frame: ProcessedFrame, lease: FrameLease) => void | Promise<void>;
  frameEncoding?: Partial<FrameEncoding>;
  videoWidth?: number;
  videoHeight?: number;
};
/** One toBlob call: which canvas encoded, its size, and the requested type and quality. */
export type BlobRequest = { canvas: 'processed' | 'scaled'; width: number; height: number; type?: string; quality?: number };

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
    videoWidth: options.videoWidth ?? 100, videoHeight: options.videoHeight ?? 60, readyState: 2,
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
    toBlob(callback: BlobCallback, type?: string, quality?: number): void;
    captureStream(rate?: number): FakeStream;
  };
  const blobRequests: BlobRequest[] = [];
  const canvas: FakeCanvas = {
    width: 100, height: 60, pixels: null,
    getContext() { return context; },
    toBlob(callback, type, quality): void {
      if (!this.pixels) throw new Error('Synthetic canvas has no pixels.');
      blobRequests.push({ canvas: 'processed', width: this.width, height: this.height, type, quality });
      const blob = new Blob([this.pixels.slice()], { type: type ?? 'image/png' });
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
  // A scaled copy samples the processed canvas (nearest neighbour), so tests see exactly which pixels were encoded.
  type ScaledCanvas = { width: number; height: number; pixels: Uint8ClampedArray | null; draws: number[][];
    getContext(): object; toBlob(callback: BlobCallback, type?: string, quality?: number): void };
  const scaled: ScaledCanvas[] = [];
  const createScaledCanvas = (): ScaledCanvas => {
    const target: ScaledCanvas = {
      width: 300, height: 150, pixels: null, draws: [],
      getContext: () => ({
        setTransform(): void {},
        drawImage(source: FakeCanvas, x: number, y: number, width: number, height: number): void {
          if (source !== canvas || !source.pixels) throw new Error('Only processed pixels may be scaled.');
          target.draws.push([x, y, width, height]);
          target.pixels = new Uint8ClampedArray(target.width * target.height * 4);
          for (let ty = 0; ty < target.height; ty++) for (let tx = 0; tx < target.width; tx++) {
            const sx = Math.floor((tx * source.width) / target.width), sy = Math.floor((ty * source.height) / target.height);
            const from = (sy * source.width + sx) * 4;
            target.pixels.set(source.pixels.subarray(from, from + 4), (ty * target.width + tx) * 4);
          }
        },
      }),
      toBlob(callback, type, quality): void {
        if (!target.pixels) throw new Error('Scaled canvas has no pixels.');
        blobRequests.push({ canvas: 'scaled', width: target.width, height: target.height, type, quality });
        const blob = new Blob([target.pixels.slice()], { type: type ?? 'image/png' });
        if (options.deferEncoding) encodings.push(() => callback(blob));
        else callback(blob);
      },
    };
    scaled.push(target);
    return target;
  };
  let canvases = 0;
  const frames: ProcessedFrame[] = [];
  const leases: FrameLease[] = [];
  const requests: DisplayCaptureOptions[] = [];
  const invalidations: CaptureInvalidation[] = [];
  const runtime: CaptureRuntime = {
    getDisplayMedia(request) {
      requests.push(request);
      return options.getDisplayMedia?.(request) ?? Promise.resolve(source as unknown as MediaStream);
    },
    // The first canvas is the processed canvas; any later one is the capture's scaled copy for encoding.
    createCanvas: () => (canvases++ === 0 ? canvas : createScaledCanvas()) as unknown as HTMLCanvasElement,
    createVideo: () => video as unknown as HTMLVideoElement,
    now: () => now,
    schedule(callback) { animations.set(++handle, callback); return handle; },
    cancel(id) { animations.delete(id); },
  };
  const capture = new ScreenCapture({
    runtime, frameIntervalMs: 1000, renderIntervalMs: 50,
    snapshotProvenance: options.snapshotProvenance,
    ...(options.frameEncoding ? { frameEncoding: options.frameEncoding } : {}),
    onFrame: options.onFrame ?? ((frame, lease) => { frames.push(frame); leases.push(lease); }),
  });
  capture.onInvalidate((event: CaptureInvalidation) => invalidations.push(event));
  return {
    capture, canvas, video, source, sourceTrack, audioTrack, frames, leases,
    requests, tracks, encodings, invalidations, animations, blobRequests, scaled,
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
