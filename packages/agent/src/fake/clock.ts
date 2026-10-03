import type { Clock, TimerHandle } from "../clock.ts";

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/** Deterministic clock: time moves only through advance(). Timers fire in (time, creation) order. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(startEpochMs = 1_000_000) {
    this.current = startEpochMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + Math.max(0, ms), seq: this.seq++, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Move time forward by ms, running every timer that becomes due (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}
