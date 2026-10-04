// Test doubles for the simulation: a virtual clock, a fake AudioContext, a fake mediaDevices and a scriptable workspace.
import type { Clock } from '../clock.ts';
import type { AudioBufferLike, AudioContextLike, BufferSourceLike, GainLike } from '../synthetic-mic.ts';
import type { MediaDevicesLike } from '../sim-media.ts';
import type { CheckResult, CheckStatus, EmailView, OrderView, TextTarget, WorkspaceActions } from '../workspace-actions.ts';

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Virtual time: sleep() waits for run() to advance the clock, so a whole scripted task takes no real time. */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  readonly sleeps: number[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    const wait = Math.max(0, ms);
    this.sleeps.push(wait);
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + wait, seq: this.seq++, resolve });
    });
  }

  /** Advances time timer by timer until `work` settles. Fails if everything is waiting and no timer is left. */
  async run<T>(work: Promise<T>, limitMs = 30 * 60_000): Promise<T> {
    let settled = false;
    const guarded = work.finally(() => {
      settled = true;
    });
    guarded.catch(() => undefined);
    for (;;) {
      await flush();
      if (settled) break;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (!next) {
        await flush();
        if (settled) break;
        throw new Error('deadlock: nothing is scheduled and the work has not finished');
      }
      if (next.at > limitMs) throw new Error('virtual time limit reached');
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    return work;
  }

  /** Lets timers due within the next `ms` fire (for tests that start work and look at it midway). */
  async advance(ms: number): Promise<void> {
    const until = this.t + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > until) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    this.t = until;
    await flush();
  }
}

// ---- audio ---------------------------------------------------------------------------------------------------------

export class FakeTrack {
  stopped = false;
  readonly kind: 'audio' | 'video';
  readonly origin: FakeTrack | null;
  constructor(kind: 'audio' | 'video' = 'audio', origin: FakeTrack | null = null) {
    this.kind = kind;
    this.origin = origin;
  }
  clone(): FakeTrack {
    return new FakeTrack(this.kind, this);
  }
  stop(): void {
    this.stopped = true;
  }
}

export class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export const asStream = (stream: FakeStream): MediaStream => stream as unknown as MediaStream;
export const createFakeStream = (tracks: MediaStreamTrack[]): MediaStream => new FakeStream(tracks as unknown as FakeTrack[]) as unknown as MediaStream;

export class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: ((event: Event) => void) | null = null;
  started = false;
  stopped = false;
  connectedTo: unknown[] = [];
  private readonly context: FakeAudioContext;
  constructor(context: FakeAudioContext) {
    this.context = context;
  }
  connect(destination: unknown): unknown {
    this.connectedTo.push(destination);
    return destination;
  }
  start(): void {
    this.started = true;
    this.context.startOrder.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
  disconnect(): void {}
  /** The clip reaches its end. */
  end(): void {
    this.onended?.(new Event('ended'));
  }
}

export class FakeGain implements GainLike {
  readonly gain = { value: 1 };
  connectedTo: unknown[] = [];
  connect(destination: unknown): unknown {
    this.connectedTo.push(destination);
    return destination;
  }
  disconnect(): void {}
}

export class FakeAudioContext implements AudioContextLike {
  state = 'suspended';
  readonly destination = { kind: 'speakers' };
  readonly streamDestination = { stream: asStream(new FakeStream([new FakeTrack('audio')])) };
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly startOrder: FakeSource[] = [];
  decodeCalls = 0;
  resumeCalls = 0;
  closed = false;
  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodeCalls += 1;
    return Promise.resolve({ duration: data.byteLength / 1000 });
  }
  createBufferSource(): BufferSourceLike {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }
  createGain(): GainLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createMediaStreamDestination(): { readonly stream: MediaStream } {
    return this.streamDestination;
  }
}

// ---- media devices ---------------------------------------------------------------------------------------------------

export class FakeMediaDevices implements MediaDevicesLike {
  readonly userMediaCalls: Array<MediaStreamConstraints | undefined> = [];
  readonly displayCalls: unknown[] = [];
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    this.userMediaCalls.push(constraints);
    const kinds: Array<'audio' | 'video'> = [];
    if (constraints?.audio) kinds.push('audio');
    if (constraints?.video) kinds.push('video');
    return Promise.resolve(asStream(new FakeStream(kinds.map((k) => new FakeTrack(k)))));
  }
  getDisplayMedia(options?: unknown): Promise<MediaStream> {
    this.displayCalls.push(options);
    return Promise.resolve(asStream(new FakeStream([new FakeTrack('video')])));
  }
}

// ---- workspace ---------------------------------------------------------------------------------------------------------

/** A WorkspaceActions double that records what the persona did and answers the checks it is told to. */
export class FakeWorkspace implements WorkspaceActions {
  readonly calls: string[] = [];
  order: OrderView = { orderId: 'ORD-2041', customer: 'customer_07', address: '14 Sample Lane, 1010 Exampletown', window: '2026-10-12 14:00-16:00' };
  email: EmailView = { body: 'Hello,\n\nPlease see the attached delivery summary.', attachments: 1 };
  /** The status each Preview produces, in order; the last one repeats. */
  checks: CheckStatus[] = ['clear'];
  private checkIndex = -1;
  private current: CheckResult = { status: 'idle', message: '' };
  sent = false;
  typed: Array<{ target: TextTarget; text: string; mode: string }> = [];

  private readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }

  async openOrder(caseId: string): Promise<void> {
    this.calls.push(`open:${caseId}`);
    await this.clock.sleep(300);
  }
  readOrder(): OrderView {
    return { ...this.order };
  }
  readEmail(): EmailView {
    return { ...this.email };
  }
  async removeImage(): Promise<void> {
    this.calls.push('remove_image');
    await this.clock.sleep(300);
    this.email.attachments = 0;
  }
  async attachImage(): Promise<void> {
    this.calls.push('attach_image');
    this.email.attachments = 1;
  }
  async typeText(target: TextTarget, text: string, mode: 'replace' | 'append'): Promise<void> {
    this.calls.push(`type:${target}`);
    this.typed.push({ target, text, mode });
    await this.clock.sleep(2000);
    if (target === 'body') this.email.body = mode === 'replace' ? text : this.email.body + text;
  }
  async preview(): Promise<void> {
    this.calls.push('preview');
    this.checkIndex += 1;
    const status = this.checks[Math.min(this.checkIndex, this.checks.length - 1)] ?? 'clear';
    this.current = { status: 'pending', message: '' };
    this.pendingStatus = status;
    await this.clock.sleep(200);
  }
  private pendingStatus: CheckStatus = 'clear';
  checkResult(): CheckResult {
    return { ...this.current };
  }
  async waitForCheck(): Promise<CheckResult> {
    await this.clock.sleep(1500);
    this.current = { status: this.pendingStatus, message: `check ${this.pendingStatus}` };
    return { ...this.current };
  }
  async acknowledge(): Promise<void> {
    this.calls.push('ack');
  }
  async send(): Promise<boolean> {
    this.calls.push('send');
    this.sent = this.current.status === 'clear';
    return this.sent;
  }
  isSent(): boolean {
    return this.sent;
  }
  async resolveTicket(): Promise<void> {
    this.calls.push('resolve');
  }
}
