// A tiny in-memory storyboard for generic vision: a vision call sees the analysed frame plus up to K-1 earlier
// frames of the same surface key, so `change` can describe what moved instead of guessing from one frame.
// Frames stay in this process only (never on disk), bounded by count, age and bytes, and the screen service
// clears them on start, pause (off the record included), resume and stop.
import type {ScreenMediaType} from './evidence-store.ts';

export interface StoryboardFrame {
  readonly frameId: string; readonly timestampMs: number;
  readonly mediaType: ScreenMediaType; readonly bytes: Uint8Array;
}
export interface StoryboardOptions {
  /** Images per vision call, the analysed frame included: 1..MAX_STORYBOARD_FRAMES. 1 sends one frame, as before. */
  readonly frames: number;
  /** An earlier frame last seen on screen longer than this before the analysed frame is left out. */
  readonly maxAgeMs: number;
  /** Earlier frames are added only while all images of one call stay within this many bytes. */
  readonly maxBytes: number;
}
/** The runner's vision route takes at most four images. */
export const MAX_STORYBOARD_FRAMES = 4;
export const STORYBOARD_DEFAULTS: StoryboardOptions = Object.freeze({frames: 3, maxAgeMs: 10_000, maxBytes: 4_000_000});

/** `VISION_FRAMES`: an integer, clamped to 1..MAX_STORYBOARD_FRAMES; unset or not an integer gives the default. */
export function parseVisionFrames(value: string | undefined): number {
  const frames = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(frames)) return STORYBOARD_DEFAULTS.frames;
  return Math.min(MAX_STORYBOARD_FRAMES, Math.max(1, frames));
}

interface StoryboardEntry { readonly frame: StoryboardFrame; seenMs: number }

/** The last accepted frames of one surface key, oldest first. */
export class FrameStoryboard {
  readonly #options: StoryboardOptions;
  #entries: StoryboardEntry[] = [];
  #bytes = 0;

  constructor(options: Partial<StoryboardOptions> = {}) {
    const resolved: StoryboardOptions = {frames: options.frames ?? STORYBOARD_DEFAULTS.frames,
      maxAgeMs: options.maxAgeMs ?? STORYBOARD_DEFAULTS.maxAgeMs, maxBytes: options.maxBytes ?? STORYBOARD_DEFAULTS.maxBytes};
    if (!Number.isInteger(resolved.frames) || resolved.frames < 1 || resolved.frames > MAX_STORYBOARD_FRAMES ||
      !Number.isFinite(resolved.maxAgeMs) || resolved.maxAgeMs < 0 ||
      !Number.isSafeInteger(resolved.maxBytes) || resolved.maxBytes < 1) throw new TypeError('Invalid storyboard limits');
    this.#options = Object.freeze(resolved);
  }

  get frames(): number { return this.#options.frames; }
  get size(): number { return this.#entries.length; }
  get bytes(): number { return this.#bytes; }

  /** A frame the queue accepted. Keeps at most `frames` entries and drops the oldest past `maxBytes`. */
  record(frame: StoryboardFrame): void {
    if (this.#options.frames < 2) return;
    // The queue may accept the same pixels again after a failed call: keep one entry, seen until now.
    if (this.#isNewest(frame)) { this.seen(frame); return; }
    this.#entries.push({frame, seenMs: frame.timestampMs}); this.#bytes += frame.bytes.length;
    while (this.#entries.length > this.#options.frames ||
      (this.#entries.length > 1 && this.#bytes > this.#options.maxBytes)) {
      const dropped = this.#entries.shift();
      if (dropped) this.#bytes -= dropped.frame.bytes.length;
    }
  }

  /** A duplicate of the newest frame (same pixels): that screen was still visible at this capture time. */
  seen(frame: StoryboardFrame): void {
    const newest = this.#entries.at(-1);
    if (newest && frame.timestampMs > newest.seenMs && this.#isNewest(frame)) newest.seenMs = frame.timestampMs;
  }

  #isNewest(frame: StoryboardFrame): boolean {
    const newest = this.#entries.at(-1);
    return newest !== undefined && Buffer.compare(newest.frame.bytes, frame.bytes) === 0;
  }

  clear(): void { this.#entries = []; this.#bytes = 0; }

  /**
   * The images for one call, oldest first and `latest` last: earlier frames captured before `latest`, newest
   * first back in time, until `frames`, `maxAgeMs` or `maxBytes` stops the run, so the images stay consecutive.
   * An earlier frame with the same pixels as `latest` adds nothing and is passed over. `latest` is always sent,
   * whatever its size.
   */
  framesFor(latest: StoryboardFrame): StoryboardFrame[] {
    const picked: StoryboardFrame[] = [latest]; let bytes = latest.bytes.length;
    for (let index = this.#entries.length - 1; index >= 0 && picked.length < this.#options.frames; index--) {
      const entry = this.#entries[index];
      if (!entry || entry.frame.frameId === latest.frameId || entry.frame.timestampMs >= latest.timestampMs ||
        Buffer.compare(entry.frame.bytes, latest.bytes) === 0) continue;
      if (latest.timestampMs - entry.seenMs > this.#options.maxAgeMs) break;
      if (bytes + entry.frame.bytes.length > this.#options.maxBytes) break;
      bytes += entry.frame.bytes.length; picked.unshift(entry.frame);
    }
    return picked;
  }
}
