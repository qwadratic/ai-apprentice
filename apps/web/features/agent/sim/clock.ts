// Time for the simulation. Everything that waits (typing, thinking, pauses, cursor flights) goes through a Clock, so a test
// can run a whole scripted task in virtual time and the page can compress time for a quick dry run (?speed=4).

export interface Clock {
  /** Milliseconds on the clock's own timeline. */
  now(): number;
  /** Resolves after `ms` of simulated time. */
  sleep(ms: number): Promise<void>;
}

/** The real clock. `speed` > 1 makes every wait shorter by that factor (a dry run); the default is real time. */
export function createRealClock(speed = 1): Clock {
  const factor = speed > 0 ? speed : 1;
  const t0 = Date.now();
  return {
    now: () => (Date.now() - t0) * factor,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms / factor))),
  };
}

/** A small seeded random number generator (mulberry32): the same seed gives the same "human" every run. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value between min and max (inclusive of min) from the generator. */
export const between = (rng: () => number, min: number, max: number): number => min + rng() * (max - min);

/** A duration spread around `ms` by +-`spread` (0.2 means +-20%). */
export const jittered = (rng: () => number, ms: number, spread = 0.2): number => Math.max(0, Math.round(ms * (1 + (rng() * 2 - 1) * spread)));
