// Test doubles for the journey: a recording director, a manual clock, a memory storage and a scriptable page.
import type { ClipaFailure, ClipaResult, ClipaState, ClipaTarget, RectLike } from '../../src/types.ts';
import { createJourneyEventBus } from '../events.ts';
import type { JourneyEventBus } from '../events.ts';
import { createJourney } from '../engine.ts';
import type { Journey, JourneyClock, JourneyDirector, JourneyOptions, JourneyStorage } from '../engine.ts';
import { journeyTargets } from '../journey.ts';
import type { CaptureCapabilities } from '../capabilities.ts';

const ok: ClipaResult = { ok: true };

export class FakeDirector implements JourneyDirector {
  state: ClipaState = 'dock';
  readonly calls: string[] = [];
  /** While set, idle() does not resolve: Clipa is "busy" with something else. */
  idleGate: Promise<void> | null = null;
  failPoint: ClipaFailure | null = null;
  /** While set, a flight started by point() does not arrive: the state is already 'pointing', as in the real director. */
  pointGate: Promise<void> | null = null;

  async point(target?: ClipaTarget): Promise<ClipaResult> {
    this.calls.push(`point:${target?.hint ?? '-'}`);
    if (this.failPoint) return { ok: false, reason: this.failPoint };
    this.state = 'pointing';
    if (this.pointGate) await this.pointGate;
    return ok;
  }
  speak(text: string): Promise<ClipaResult> {
    this.calls.push(`speak:${text}`);
    return Promise.resolve(ok);
  }
  retreat(): Promise<ClipaResult> {
    this.calls.push('retreat');
    this.state = 'dock';
    return Promise.resolve(ok);
  }
  setOff(off: boolean): Promise<ClipaResult> {
    this.calls.push(`off:${off}`);
    this.state = off ? 'off' : 'dock';
    return Promise.resolve(ok);
  }
  idle(): Promise<void> {
    return this.idleGate ?? Promise.resolve();
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
}

export function rig(overrides: Partial<JourneyOptions> = {}, parts: Partial<Pick<Rig, 'director' | 'clock' | 'storage' | 'bus' | 'present'>> = {}): Rig {
  const bus = parts.bus ?? createJourneyEventBus();
  const director = parts.director ?? new FakeDirector();
  const clock = parts.clock ?? new FakeClock();
  const storage = parts.storage ?? new MemoryStorage();
  const present = parts.present ?? new Set(journeyTargets());
  const said: string[] = [];
  const capabilities: CaptureCapabilities = { screen: true, camera: true };
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
  return { bus, director, clock, storage, journey, said, present };
}
