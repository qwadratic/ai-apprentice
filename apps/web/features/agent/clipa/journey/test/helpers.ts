// Test doubles for the journey: a director that behaves like the real one, a manual clock, a memory storage and a scriptable page.
import type { ClipaFailure, ClipaResult, ClipaState, ClipaTarget, RectLike } from '../../src/types.ts';
import { createJourneyEventBus } from '../events.ts';
import type { JourneyEvent, JourneyEventBus } from '../events.ts';
import { createJourney } from '../engine.ts';
import type { Journey, JourneyClock, JourneyDirector, JourneyOptions, JourneyStorage } from '../engine.ts';
import { journeyTargets } from '../journey.ts';
import type { CaptureCapabilities } from '../capabilities.ts';

const ok: ClipaResult = { ok: true };

/**
 * A recording stand-in for the Clipa director with the properties the journey depends on:
 *   - idle() resolves only when she is docked or off (the real one does not resolve while she points, listens or speaks);
 *   - retreat() and setOff() cancel a flight in progress, whose point() then reports 'cancelled';
 *   - pointMode 'flight': point() enters the pointing state at once and arrives when pointGate opens;
 *   - pointMode 'waitQuiet': she stays at home until pointGate opens (the director holds a flight while input is active).
 */
export class FakeDirector implements JourneyDirector {
  readonly calls: string[] = [];
  pointMode: 'flight' | 'waitQuiet' = 'flight';
  pointGate: Promise<void> | null = null;
  failPoint: ClipaFailure | null = null;
  private current: ClipaState = 'dock';
  private epoch = 0;
  private readonly idleWaiters: Array<() => void> = [];

  get state(): ClipaState {
    return this.current;
  }
  /** Moves the pose, as the shell's presenter would for the agent (a question, a warning). */
  set state(next: ClipaState) {
    this.current = next;
    if (next === 'dock' || next === 'off') for (const wake of this.idleWaiters.splice(0)) wake();
  }

  async point(target?: ClipaTarget): Promise<ClipaResult> {
    this.calls.push(`point:${target?.hint ?? '-'}`);
    if (this.failPoint) return { ok: false, reason: this.failPoint };
    const epoch = this.epoch;
    if (this.pointMode === 'waitQuiet') {
      if (this.pointGate) await this.pointGate;
      if (epoch !== this.epoch) return { ok: false, reason: 'cancelled' };
      this.state = 'pointing';
      return ok;
    }
    this.state = 'pointing';
    if (this.pointGate) await this.pointGate;
    if (epoch !== this.epoch) return { ok: false, reason: 'cancelled' };
    return ok;
  }
  speak(text: string): Promise<ClipaResult> {
    this.calls.push(`speak:${text}`);
    return Promise.resolve(ok);
  }
  retreat(): Promise<ClipaResult> {
    this.calls.push('retreat');
    this.epoch += 1;
    this.state = 'dock';
    return Promise.resolve(ok);
  }
  setOff(off: boolean): Promise<ClipaResult> {
    this.calls.push(`off:${off}`);
    this.epoch += 1;
    this.state = off ? 'off' : 'dock';
    return Promise.resolve(ok);
  }
  idle(): Promise<void> {
    if (this.current === 'dock' || this.current === 'off') return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** The lines in the bubble, in order. */
  get lines(): string[] {
    return this.calls.filter((c) => c.startsWith('speak:')).map((c) => c.slice('speak:'.length));
  }
  get points(): string[] {
    return this.calls.filter((c) => c.startsWith('point:')).map((c) => c.slice('point:'.length));
  }
  clear(): void {
    this.calls.length = 0;
  }
}

interface Timer {
  at: number;
  fn: () => void;
}

export class FakeClock implements JourneyClock {
  t = 1_000_000;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  /** Runs every timer that falls due within `ms`, in order, letting them schedule more. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, Timer] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }
}

export class MemoryStorage implements JourneyStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export class ThrowingStorage implements JourneyStorage {
  getItem(): string | null {
    throw new Error('storage blocked');
  }
  setItem(): void {
    throw new Error('storage blocked');
  }
  removeItem(): void {
    throw new Error('storage blocked');
  }
}

/** Lets every promise chain of the engine run to its end. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const RECT: RectLike = { left: 10, top: 10, width: 100, height: 40 };

export interface Rig {
  bus: JourneyEventBus;
  director: FakeDirector;
  clock: FakeClock;
  storage: MemoryStorage;
  journey: Journey;
  /** What onSay received. */
  said: string[];
  /** The data-clipa-target values that exist on the "page". Delete one to remove it. */
  present: Set<string>;
  /** Emits the events one by one, letting the engine finish each before the next. */
  play(...events: JourneyEvent[]): Promise<void>;
}

type Parts = Partial<Pick<Rig, 'director' | 'clock' | 'storage' | 'bus' | 'present'>>;

export function rig(overrides: Partial<JourneyOptions> = {}, parts: Parts = {}): Rig {
  const bus = parts.bus ?? createJourneyEventBus();
  const director = parts.director ?? new FakeDirector();
  const clock = parts.clock ?? new FakeClock();
  const storage = parts.storage ?? new MemoryStorage();
  const present = parts.present ?? new Set(journeyTargets());
  const said: string[] = [];
  const capabilities: CaptureCapabilities = { screen: true, camera: false };
  const journey = createJourney({
    director,
    events: bus,
    resolveTarget: (target) => (present.has(target) ? RECT : null),
    storage,
    clock,
    capabilities,
    onSay: (line) => said.push(line),
    ...overrides,
  });
  return {
    bus,
    director,
    clock,
    storage,
    journey,
    said,
    present,
    async play(...events) {
      for (const event of events) {
        bus.emit(event);
        await flush();
      }
    },
  };
}
