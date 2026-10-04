// Test doubles for the shell: manual timers, a recording fetch, a fake voice and a scriptable brain.
import type { AgentApi } from '../api.ts';
import { createAgentApi } from '../api.ts';
import type { Brain, BrainDecision, ReviewOutput } from '../brain/types.ts';
import { NullBrain } from '../brain/null-brain.ts';
import type { ClipaPresenter, ClipaState, TargetRect } from '../clipa/presenter.ts';
import { ShellController } from '../controller.ts';
import type { ControllerDeps, ControllerTimers } from '../controller.ts';
import type { ObservationSource } from '../screen/observation-source.ts';
import { SampleObservationSource } from '../screen/sample-source.ts';
import type { VoiceConnector, VoiceEvents, VoiceHandle } from '../voice/types.ts';

export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present`);
  return value;
}

interface Task { at: number; callback: () => void; every: number | null }

/** Manual timers: nothing runs until advance(). */
export class FakeTimers implements ControllerTimers {
  now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, Task>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, callback, every: null });
    return id;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(Number(handle)); }
  setInterval(callback: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, callback, every: ms });
    return id;
  }
  clearInterval(handle: unknown): void { this.tasks.delete(Number(handle)); }
  pending(): number { return this.tasks.size; }

  /** Moves time forward, running everything that falls due in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: Task | null = null;
      for (const [id, task] of this.tasks) {
        if (task.at <= end && (next === null || task.at < next.at)) { nextId = id; next = task; }
      }
      if (next === null || nextId === null) break;
      this.now = next.at;
      if (next.every === null) this.tasks.delete(nextId);
      else next.at += next.every;
      next.callback();
    }
    this.now = end;
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (req: RecordedRequest) => Response | null | Promise<Response | null>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that records every request and answers through the given responders (first non-null wins; default 404). */
export function recordingFetch(...responders: Responder[]): { fetch: (input: string, init?: RequestInit) => Promise<Response>; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && !Array.isArray(raw) && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    let body: unknown = null;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const req: RecordedRequest = { url: input, method: init?.method ?? 'GET', headers, body };
    calls.push(req);
    for (const responder of responders) {
      const res = await responder(req);
      if (res) return res;
    }
    return json(404, { ok: false });
  };
  return { fetch, calls };
}

export const TOKEN = 'tok_0123456789abcdef0123456789abcdef';
export const SIGNED_URL = 'wss://api.example.invalid/v1/convai/conversation?agent_id=a&conversation_signature=secretsecret';

/** The modern agent API (TASK-3.27): sessions, signed-url, events, finish. */
export function modernApi(options: { sessionId?: string; signedUrlStatus?: number } = {}): Responder {
  const sessionId = options.sessionId ?? 'sess-1';
  return (req) => {
    if (req.url.endsWith('/api/agent/sessions') && req.method === 'POST') {
      return json(201, { sessionId, token: TOKEN, issuedAtMs: 1_000_000, serverNowMs: 1_000_000 });
    }
    if (req.url.includes('/api/agent/elevenlabs/signed-url')) {
      return options.signedUrlStatus ? json(options.signedUrlStatus, { ok: false }) : json(200, { signed_url: SIGNED_URL });
    }
    if (req.url.includes('/api/agent/sessions/') && req.url.endsWith('/events')) return json(200, { ok: true });
    if (req.url.includes('/api/agent/sessions/') && req.url.endsWith('/finish')) return json(200, { ok: true, transcriptStored: true });
    return null;
  };
}

/** The old placeholder API: no session endpoint, /agent/* routes, no token. */
export function legacyApi(): Responder {
  return (req) => {
    if (req.url.includes('/agent/elevenlabs/signed-url')) return json(200, { signed_url: SIGNED_URL });
    if (req.url.includes('/agent/sessions/') && req.url.endsWith('/events')) return json(200, { ok: true });
    if (req.url.includes('/agent/sessions/') && req.url.endsWith('/finish')) return json(200, { transcriptStored: false });
    return null;
  };
}

export class FakeVoice {
  url = '';
  events: VoiceEvents | null = null;
  signal: AbortSignal | null = null;
  readonly contexts: string[] = [];
  readonly userMessages: string[] = [];
  order: string[] = [];
  ended = false;
  failWith: string | null = null;
  /**
   * Like the real SDK 1.26.0: the connected events (onStatusChange('connected') and onConnect) fire from inside the
   * connector, before it returns the handle.
   */
  autoConnect = true;
  /** When set, the connector waits for it before connecting (the handshake: microphone prompt, socket). */
  gate: Promise<void> | null = null;
  conversationId = 'conv_test_1';

  readonly connector: VoiceConnector = async (signedUrl, events, signal) => {
    this.url = signedUrl;
    this.events = events;
    this.signal = signal;
    if (this.gate) await this.gate;
    if (this.failWith) throw new Error(this.failWith);
    const handle: VoiceHandle = {
      conversationId: () => this.conversationId,
      sendContextualUpdate: (text) => { this.contexts.push(text); },
      sendUserMessage: (text) => { this.userMessages.push(text); },
      end: async () => { this.ended = true; this.order.push('voice.end'); },
    };
    if (this.autoConnect) {
      events.onStatus('connected');
      events.onConnect(this.conversationId);
    }
    return handle;
  };

  say(source: 'ai' | 'user', text: string): void { must(this.events, 'voice events').onMessage({ source, text }); }
  mode(mode: 'speaking' | 'listening'): void { must(this.events, 'voice events').onMode(mode); }
}

type CaptureState = 'idle' | 'selecting' | 'paused' | 'capturing' | 'stopped' | 'error';
type CaptureListener = (s: { state: CaptureState; reason?: string }) => void;

export class FakeCapture {
  stops = 0;
  order: string[] = [];
  private listener: CaptureListener | null = null;
  subscribe(listener: CaptureListener): () => void {
    this.listener = listener;
    listener({ state: 'idle' });
    return () => { this.listener = null; };
  }
  emit(state: CaptureState, reason?: string): void { this.listener?.({ state, reason }); }
  stop(): void { this.stops += 1; this.order.push('capture.stop'); this.emit('stopped'); }
}

export class FakePresenter implements ClipaPresenter {
  states: ClipaState[] = [];
  bubbles: string[] = [];
  targets: Array<TargetRect | null> = [];
  setState(state: ClipaState): void { this.states.push(state); }
  say(text: string): void { this.bubbles.push(text); }
  setTarget(rect: TargetRect | null): void { this.targets.push(rect); }
  get state(): ClipaState | undefined { return this.states[this.states.length - 1]; }
  get bubble(): string | undefined { return this.bubbles[this.bubbles.length - 1]; }
}

/** A brain that returns the scripted decisions on the next tick and records every call. */
export class ScriptedBrain implements Brain {
  readonly name = 'ScriptedBrain';
  readonly wired = true;
  readonly calls: string[] = [];
  readonly answers: Array<{ kind: string; text: string; topic: string | null }> = [];
  queue: BrainDecision[] = [];
  reviewOutput: ReviewOutput = { gaps: [], teachBack: null, map: { steps: [] } };
  checkpointStatus: 'clear' | 'warn' | 'unknown' = 'warn';

  onObservation(o: { kind: string }): void { this.calls.push(`obs:${o.kind}`); }
  onStatus(s: { state: string }): void { this.calls.push(`status:${s.state}`); }
  onTranscript(t: { role: string }): void { this.calls.push(`transcript:${t.role}`); }
  tick(): BrainDecision[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  onAnswer(a: { kind: string; text: string; topic: string | null }): void { this.answers.push({ kind: a.kind, text: a.text, topic: a.topic }); }
  review(): ReviewOutput { return this.reviewOutput; }
  checkpoint(c: { id: string; revisions: { order: string; email: string } }) {
    return {
      schemaVersion: 1 as const, checkpointId: c.id, status: this.checkpointStatus,
      message: `scripted ${this.checkpointStatus}`, evidenceIds: [], basedOn: { order: c.revisions.order, email: c.revisions.email },
    };
  }
}

export interface Rig {
  controller: ShellController;
  timers: FakeTimers;
  voice: FakeVoice;
  presenter: FakePresenter;
  brain: Brain;
  calls: RecordedRequest[];
  clock: { base: number; now(): number };
  sources: ObservationSource[];
  /** Order in which voice, screen source and capture were shut down. */
  trace: string[];
  capture: FakeCapture;
}

export function createRig(options: { responders?: Responder[]; brain?: Brain; createBrain?: (log: (line: string) => void) => Brain; base?: string; scenarios?: boolean } = {}): Rig {
  const timers = new FakeTimers();
  const clock = { base: 1_700_000_000_000, now: () => clock.base + timers.now };
  const { fetch, calls } = recordingFetch(...(options.responders ?? [modernApi()]));
  const trace: string[] = [];
  const voice = new FakeVoice();
  voice.order = trace;
  const presenter = new FakePresenter();
  const capture = new FakeCapture();
  capture.order = trace;
  let brain: Brain = options.brain ?? new NullBrain();
  const sources: ObservationSource[] = [];
  const api: AgentApi = createAgentApi({ base: options.base ?? 'https://api.example.invalid', fetch, now: clock.now, newId: () => 'legacy-session-id' });
  const memory = new Map<string, string>();
  const deps: ControllerDeps = {
    api, fetch, connectVoice: voice.connector,
    createBrain: (log) => { brain = options.createBrain ? options.createBrain(log) : brain; return brain; },
    // `scenarios: true` plays the scripts of the product (the customer_07 Learn run and the Teach cases); by default the neutral sample.
    createSampleSource: (scenario) => {
      const source = new SampleObservationSource(clock.now, timers, options.scenarios ? scenario : 'neutral');
      const stop = source.stop.bind(source);
      source.stop = async () => { trace.push('source.stop'); await stop(); };
      sources.push(source);
      return source;
    },
    presenter, now: clock.now, perfNow: () => timers.now, timers, isHidden: () => false,
    storage: { get: (k) => memory.get(k) ?? null, set: (k, v) => { memory.set(k, v); } },
  };
  const controller = new ShellController(deps);
  return { controller, timers, voice, presenter, brain, calls, clock, sources, trace, capture };
}

/** Lets pending promise callbacks run. */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
