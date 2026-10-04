// The two shims of the simulation. Nothing is installed at import time: installSimMedia() replaces
// navigator.mediaDevices.getUserMedia (audio) with the synthetic microphone and getDisplayMedia with a call that asks for
// the current tab, and returns a handle that puts the originals back. The product shell calls it only when the page was
// opened with ?sim=expert or ?sim=newhire (see simModeFromSearch); without that parameter the page never touches either.
import type { PersonaId } from './personas.ts';
import type { SyntheticMic } from './synthetic-mic.ts';

/** The part of navigator.mediaDevices the shims replace. */
export interface MediaDevicesLike {
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia?(options?: unknown): Promise<MediaStream>;
}

export interface ScreenShimOptions {
  /** Extra getDisplayMedia options, applied before the caller's own and the two the shim always sets. */
  extra?: Record<string, unknown>;
  /**
   * A screen source for browsers that cannot capture a tab (headless Chrome fails with NotReadableError, or hangs): for
   * example a canvas.captureStream() of the simulated desktop (see desktop/canvas-screen.ts). Used when the real call
   * rejects or does not answer within `timeoutMs`, or always when `forceFallback` is set.
   */
  fallback?: () => Promise<MediaStream>;
  /** How long the real getDisplayMedia may take before the fallback is used (default 8000). Only with `fallback`. */
  timeoutMs?: number;
  /** Skip the real getDisplayMedia and use the fallback (for tests of the fallback itself). */
  forceFallback?: boolean;
}

export interface InstallSimMediaOptions {
  mic: Pick<SyntheticMic, 'cloneStream'>;
  /** Replace getDisplayMedia too (default true). false leaves screen sharing alone. */
  screen?: boolean | ScreenShimOptions;
  /** Where to install. By default navigator.mediaDevices. */
  mediaDevices?: MediaDevicesLike;
  /** Builds a MediaStream from tracks (video and audio of a mixed request). By default `new MediaStream(tracks)`. */
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

export interface InstalledSimMedia {
  /** Puts the original getUserMedia and getDisplayMedia back. Idempotent. */
  restore(): void;
  /** What the shims did, for the log and the tests. */
  readonly calls: ReadonlyArray<{ kind: 'getUserMedia' | 'getDisplayMedia'; synthetic: boolean; via?: 'tab' | 'fallback' }>;
}

export class SimMediaInstalledError extends Error {
  constructor() {
    super('the simulation shims are already installed on this mediaDevices');
    this.name = 'SimMediaInstalledError';
  }
}

const INSTALLED = Symbol.for('apprentice.sim.media-installed');

/** Always set on the display request: the tab the page runs in is the screen the simulated expert shares. */
export const CURRENT_TAB_OPTIONS = { preferCurrentTab: true, selfBrowserSurface: 'include' } as const;

interface Slot<K extends 'getUserMedia' | 'getDisplayMedia'> {
  key: K;
  hadOwn: boolean;
  original: unknown;
}

function slotOf<K extends 'getUserMedia' | 'getDisplayMedia'>(target: object, key: K): Slot<K> {
  return { key, hadOwn: Object.prototype.hasOwnProperty.call(target, key), original: Reflect.get(target, key) };
}

function putBack(target: object, slot: Slot<'getUserMedia' | 'getDisplayMedia'>): void {
  if (slot.hadOwn) Reflect.set(target, slot.key, slot.original);
  else Reflect.deleteProperty(target, slot.key);
}

const wantsAudio = (c: MediaStreamConstraints | undefined): boolean => c?.audio !== undefined && c.audio !== false;
const wantsVideo = (c: MediaStreamConstraints | undefined): boolean => c?.video !== undefined && c.video !== false;

export function installSimMedia(options: InstallSimMediaOptions): InstalledSimMedia {
  const target: MediaDevicesLike | undefined = options.mediaDevices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
  if (!target) throw new Error('navigator.mediaDevices is not available here (it needs a secure context)');
  if (Reflect.get(target, INSTALLED) === true) throw new SimMediaInstalledError();

  const makeStream = options.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
  const calls: Array<{ kind: 'getUserMedia' | 'getDisplayMedia'; synthetic: boolean; via?: 'tab' | 'fallback' }> = [];
  const originalUserMedia = target.getUserMedia.bind(target);
  const userMediaSlot = slotOf(target, 'getUserMedia');

  const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!wantsAudio(constraints)) {
      calls.push({ kind: 'getUserMedia', synthetic: false });
      return originalUserMedia(constraints);
    }
    calls.push({ kind: 'getUserMedia', synthetic: true });
    const synthetic = options.mic.cloneStream();
    if (!wantsVideo(constraints)) return synthetic;
    // A request for both: the audio is synthetic, the video comes from the real device.
    const video = await originalUserMedia({ video: constraints?.video ?? true });
    return makeStream([...synthetic.getAudioTracks(), ...video.getVideoTracks()]);
  };
  Reflect.set(target, 'getUserMedia', getUserMedia);

  let displaySlot: Slot<'getDisplayMedia'> | null = null;
  const screen = options.screen ?? true;
  if (screen !== false) {
    const originalDisplay = target.getDisplayMedia?.bind(target);
    displaySlot = slotOf(target, 'getDisplayMedia');
    const screenOptions: ScreenShimOptions = typeof screen === 'object' ? screen : {};
    const extra = screenOptions.extra ?? {};
    const fallback = screenOptions.fallback;
    const timeoutMs = screenOptions.timeoutMs ?? 8000;
    const real = (request?: unknown): Promise<MediaStream> => {
      if (!originalDisplay) return Promise.reject(new Error('getDisplayMedia is not supported by this browser'));
      const given = typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {};
      return originalDisplay({ video: true, audio: false, ...extra, ...given, ...CURRENT_TAB_OPTIONS });
    };
    const getDisplayMedia = async (request?: unknown): Promise<MediaStream> => {
      if (!fallback) {
        calls.push({ kind: 'getDisplayMedia', synthetic: true, via: 'tab' });
        return real(request);
      }
      if (!screenOptions.forceFallback) {
        const attempt = real(request);
        // A call that answers after the timeout is not wanted any more: end its tracks when it arrives.
        let timedOut = false;
        attempt.then(
          (late) => {
            if (timedOut) for (const track of late.getTracks()) track.stop();
          },
          () => undefined,
        );
        try {
          const stream = await new Promise<MediaStream>((resolve, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`getDisplayMedia did not answer within ${timeoutMs} ms`));
            }, timeoutMs);
            attempt.then(
              (s) => {
                clearTimeout(timer);
                resolve(s);
              },
              (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
              },
            );
          });
          calls.push({ kind: 'getDisplayMedia', synthetic: true, via: 'tab' });
          return stream;
        } catch {
          // fall through to the fallback source
        }
      }
      calls.push({ kind: 'getDisplayMedia', synthetic: true, via: 'fallback' });
      return fallback();
    };
    Reflect.set(target, 'getDisplayMedia', getDisplayMedia);
  }

  Reflect.set(target, INSTALLED, true);
  let restored = false;
  return {
    calls,
    restore: () => {
      if (restored) return;
      restored = true;
      putBack(target, userMediaSlot);
      if (displaySlot) putBack(target, displaySlot);
      Reflect.deleteProperty(target, INSTALLED);
    },
  };
}

/**
 * The one guard the shell calls: installs the shims only when the page was opened with ?sim=expert or ?sim=newhire.
 * Returns null, and touches nothing, in every other case.
 */
export function installSimMediaIfRequested(
  search: string,
  options: InstallSimMediaOptions,
): { persona: PersonaId; media: InstalledSimMedia } | null {
  const persona = simModeFromSearch(search);
  if (persona === null) return null;
  return { persona, media: installSimMedia(options) };
}

/** The persona named by `?sim=` (expert, newhire / new-hire / newHire), or null: sim mode is off. */
export function simModeFromSearch(search: string): PersonaId | null {
  const value = new URLSearchParams(search).get('sim');
  if (value === null) return null;
  const key = value.toLowerCase().replace(/[-_ ]/g, '');
  if (key === 'expert') return 'expert';
  if (key === 'newhire') return 'newHire';
  return null;
}
