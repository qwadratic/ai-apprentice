// Injectable clock. Everything time-dependent in this package takes a Clock so
// tests are deterministic and need no real timers.

export type TimerHandle = number;

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

// The platform's timer handle is a number in browsers and an object in Node, so the
// system clock hands out its own numeric ids and keeps the real handles privately.
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
let nextSystemTimerId = 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        fn();
      }, ms),
    );
    return id;
  },
  clearTimeout: (handle) => {
    const real = systemTimers.get(handle);
    if (real === undefined) return;
    systemTimers.delete(handle);
    clearTimeout(real);
  },
};
