export type WorkspaceSurface = 'order' | 'email' | 'ticket';
// Local facts only; the host adds the approved ScreenObservation envelope.
export type WorkspaceActivity = { surface: WorkspaceSurface; typing: boolean; lastInputAtMs: number; idleMs: number };
export type ActivityClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
};
const realClock: ActivityClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Scoped typing/idle facts, with no customer, text, rule or screen evidence. */
export function createInputActivityReporter(onActivity?: (activity: WorkspaceActivity) => void, clock: ActivityClock = realClock) {
  const intervalMs = 2000;
  const idleLimitMs = 10000;
  let enabled = true;
  let disposed = false;
  let generation = 0;
  let timer: unknown;
  let lastInputAt: number | undefined;
  let lastEmittedAt = -Infinity;
  let surface: WorkspaceSurface = 'email';
  let typing = false;
  function clear() {
    generation++;
    if (timer !== undefined) clock.clearTimer(timer);
    timer = undefined;
  }
  function emit(isTyping: boolean) {
    if (lastInputAt === undefined) return;
    const timestampMs = Math.floor(clock.now());
    const lastInputAtMs = Math.floor(lastInputAt);
    typing = isTyping;
    lastEmittedAt = timestampMs;
    onActivity?.({ surface, typing: isTyping, lastInputAtMs, idleMs: timestampMs - lastInputAtMs });
  }
  function arm() {
    clear();
    if (!enabled || disposed || !onActivity || lastInputAt === undefined) return;
    const now = clock.now();
    const idleMs = Math.max(0, now - lastInputAt);
    if (!typing && idleMs >= idleLimitMs) return;
    const due = typing ? Math.min(lastEmittedAt + intervalMs, lastInputAt + intervalMs) : lastEmittedAt + intervalMs;
    const scheduledGeneration = generation;
    timer = clock.setTimer(() => {
      if (!enabled || disposed || scheduledGeneration !== generation || lastInputAt === undefined) return;
      const elapsed = Math.max(0, clock.now() - lastInputAt);
      emit(elapsed < intervalMs);
      arm();
    }, Math.max(0, due - now));
  }
  function reset() { clear(); lastInputAt = undefined; lastEmittedAt = -Infinity; typing = false; }
  return {
    input(nextSurface: WorkspaceSurface) {
      if (!enabled || disposed || !onActivity) return;
      if (!['order', 'email', 'ticket'].includes(nextSurface)) throw new Error('Unknown workspace surface.');
      const changedSurface = surface !== nextSurface;
      surface = nextSurface;
      lastInputAt = clock.now();
      if (!typing || changedSurface || lastInputAt - lastEmittedAt >= intervalMs) emit(true);
      arm();
    },
    reset,
    pause() { enabled = false; reset(); },
    resume() { if (!disposed) enabled = true; },
    dispose() { disposed = true; enabled = false; reset(); },
  };
}
