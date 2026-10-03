// VoiceAdapter: the boundary between the conversation coordinator and a voice
// transport. The real implementation will wrap the ElevenLabs Agents web SDK
// (@elevenlabs/react / @elevenlabs/client); FakeVoiceAdapter is a scripted stand-in
// so policy, Work Map and tutor code can be developed and tested without network,
// microphone or keys.
//
// Semantics every implementation must keep:
// - 'spoken' is emitted only after the agent actually finished saying a command;
//   a cancelled or paused utterance never produces 'spoken' (so the question is
//   not counted as asked);
// - pause() (off-record) stops microphone handling and discards anything unspoken;
//   nothing is emitted afterwards until resume();
// - timestamps (tsMs) count from the same sessionEpochMs as screen observations;
// - time is wall-clock, like the screen bridge: a scripted event is due at start() + atMs,
//   and an event that falls due while paused is dropped, never replayed after resume().

import { systemClock } from "../clock.ts";
import type { Clock, TimerHandle } from "../clock.ts";

export type VoiceRole = "expert" | "novice" | "agent";
export type VoiceMode = "listening" | "speaking";
export type VoiceStatusState = "connecting" | "connected" | "paused" | "disconnected" | "error";

export type VoiceEvent =
  | { type: "transcript"; role: VoiceRole; text: string; final: boolean; tsMs: number }
  | { type: "user_speaking"; speaking: boolean; tsMs: number }
  | { type: "mode"; mode: VoiceMode; tsMs: number }
  | { type: "spoken"; commandId: string; text: string; tsMs: number }
  | { type: "status"; state: VoiceStatusState; reason?: string; tsMs: number };

export interface SpeakRequest {
  /** CoachCommand id; echoed in the 'spoken' event. */
  id: string;
  text: string;
}

export interface VoiceAdapter {
  start(opts: { sessionId: string; sessionEpochMs: number }): Promise<void>;
  stop(): Promise<void>;
  /** Off-record: stop the microphone and discard unspoken output. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Resolves after the agent has finished saying the text; rejects if cancelled or paused. */
  speak(request: SpeakRequest): Promise<void>;
  /** Abort the current utterance without a 'spoken' event. */
  cancelSpeech(): void;
  /** Background context for the agent that must not trigger a reply (contextual_update). */
  sendContext(text: string): void;
  subscribe(listener: (event: VoiceEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

/** An event the scripted "expert side" produces; the adapter adds role and timestamp. */
export type ScriptedUserEvent =
  | { type: "user_speaking"; speaking: boolean }
  | { type: "transcript"; text: string; final: boolean; role?: Exclude<VoiceRole, "agent"> };

export interface ScriptStep {
  /** Wall-clock offset from start(); paused time is a gap, not removed. */
  atMs: number;
  event: ScriptedUserEvent;
}

/**
 * Builds the steps for one spoken expert turn: user_speaking true, an interim
 * transcript halfway, user_speaking false and the final transcript at the end.
 */
export function userSays(text: string, startMs: number, durationMs: number): ScriptStep[] {
  const half = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
  const end = startMs + durationMs;
  return [
    { atMs: startMs, event: { type: "user_speaking", speaking: true } },
    { atMs: startMs + Math.floor(durationMs / 2), event: { type: "transcript", text: half, final: false } },
    { atMs: end, event: { type: "user_speaking", speaking: false } },
    { atMs: end, event: { type: "transcript", text, final: true } },
  ];
}

export interface FakeVoiceOptions {
  script?: ScriptStep[];
  clock?: Clock;
  /** Simulated speaking time per character of agent text. */
  msPerChar?: number;
  minSpeakMs?: number;
}

interface PendingSpeech {
  request: SpeakRequest;
  timer: TimerHandle;
  resolve: () => void;
  reject: (e: Error) => void;
}

export class FakeVoiceAdapter implements VoiceAdapter {
  private readonly script: ScriptStep[];
  private readonly clock: Clock;
  private readonly msPerChar: number;
  private readonly minSpeakMs: number;
  private listeners = new Set<(e: VoiceEvent) => void>();
  private state: "idle" | "active" | "paused" | "stopped" = "idle";
  private sessionEpochMs = 0;
  private index = 0;
  private startedAtMs = 0;
  private timer: TimerHandle | null = null;
  private speech: PendingSpeech | null = null;

  /** Context updates the coordinator pushed, for assertions. */
  readonly contextUpdates: string[] = [];
  /** Texts the agent finished speaking, in order. */
  readonly spokenLog: SpeakRequest[] = [];

  constructor(opts: FakeVoiceOptions = {}) {
    this.script = [...(opts.script ?? [])].sort((a, b) => a.atMs - b.atMs);
    this.clock = opts.clock ?? systemClock;
    this.msPerChar = opts.msPerChar ?? 40;
    this.minSpeakMs = opts.minSpeakMs ?? 300;
  }

  async start(opts: { sessionId: string; sessionEpochMs: number }): Promise<void> {
    if (this.state === "active" || this.state === "paused") throw new Error(`start(): adapter is ${this.state}`);
    this.sessionEpochMs = opts.sessionEpochMs;
    this.index = 0;
    this.startedAtMs = this.clock.now();
    this.state = "active";
    this.emit({ type: "status", state: "connected" });
    this.emit({ type: "mode", mode: "listening" });
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    this.cancelTimer();
    this.rejectSpeech("stopped");
    this.state = "stopped";
    this.emit({ type: "status", state: "disconnected" });
  }

  async pause(): Promise<void> {
    if (this.state !== "active") return;
    this.cancelTimer();
    this.rejectSpeech("paused");
    this.state = "paused";
    this.emit({ type: "status", state: "paused" });
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    // Whatever fell due while paused is dropped, not replayed.
    const now = this.clock.now();
    for (let step = this.script[this.index]; step && this.startedAtMs + step.atMs < now; step = this.script[this.index]) this.index++;
    this.state = "active";
    this.emit({ type: "status", state: "connected" });
    this.emit({ type: "mode", mode: "listening" });
    this.scheduleNext();
  }

  speak(request: SpeakRequest): Promise<void> {
    if (this.state !== "active") return Promise.reject(new Error(`speak(): adapter is ${this.state}`));
    if (this.speech) return Promise.reject(new Error("speak(): already speaking"));
    this.emit({ type: "mode", mode: "speaking" });
    const duration = Math.max(this.minSpeakMs, request.text.length * this.msPerChar);
    return new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.speech = null;
        this.spokenLog.push({ ...request });
        this.emit({ type: "transcript", role: "agent", text: request.text, final: true });
        this.emit({ type: "spoken", commandId: request.id, text: request.text });
        this.emit({ type: "mode", mode: "listening" });
        resolve();
      }, duration);
      this.speech = { request, timer, resolve, reject };
    });
  }

  cancelSpeech(): void {
    if (!this.speech) return;
    this.rejectSpeech("cancelled");
    this.emit({ type: "mode", mode: "listening" });
  }

  sendContext(text: string): void {
    if (this.state !== "active") return; // paused or stopped: nothing may be sent
    this.contextUpdates.push(text);
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- internals -------------------------------------------------------------

  private now(): number {
    return this.clock.now() - this.sessionEpochMs;
  }

  private emit(event: DistributiveOmitTs<VoiceEvent>): void {
    const full = { ...event, tsMs: this.now() } as VoiceEvent;
    for (const l of [...this.listeners]) l(full);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private rejectSpeech(reason: string): void {
    if (!this.speech) return;
    const s = this.speech;
    this.speech = null;
    this.clock.clearTimeout(s.timer);
    s.reject(new Error(`speech ${reason}`));
  }

  private scheduleNext(): void {
    this.cancelTimer();
    const next = this.script[this.index];
    if (!next) return;
    const delay = Math.max(0, this.startedAtMs + next.atMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.state !== "active") return;
      this.index++;
      const e = next.event;
      if (e.type === "user_speaking") this.emit({ type: "user_speaking", speaking: e.speaking });
      else this.emit({ type: "transcript", role: e.role ?? "expert", text: e.text, final: e.final });
      this.scheduleNext();
    }, delay);
  }
}

type DistributiveOmitTs<T> = T extends unknown ? Omit<T, "tsMs"> : never;
