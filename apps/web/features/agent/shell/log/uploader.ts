// The session log: every visible log line is also queued and posted to the server in batches
// (ported from the agent lab, TASK-3.22). The server appends the lines as JSONL under the session id.
//   POST events  {conversationId?, events: [{t, dir, type, text}]}   every 2 s while lines are queued
//   POST finish  {conversationId}   the server stores the ElevenLabs transcript and audio recording
// A failed request keeps the lines queued and they are retried; a refusal that retrying cannot fix stops the upload.
import type { AgentSession, FetchLike } from '../api.ts';
import { scrub } from '../voice/scrub.ts';

export type LogDir = 'sent' | 'recv' | 'sys' | 'err';
export interface LogEvent {
  t: number;
  dir: LogDir;
  type: string;
  text: string;
}

export const FLUSH_MS = 2000;
export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 200000; // UTF-8 bytes of the lines as JSON; the server refuses bodies over 256 KB
/** A keepalive request may carry at most 64 KB; stay below it on page hide. */
export const PAGEHIDE_BATCH_BYTES = 60000;
export const PAGEHIDE_BATCH_EVENTS = 50;
export const MAX_TEXT_CHARS = 4000;
export const EVENTS_TIMEOUT_MS = 8000;
export const FINISH_TIMEOUT_MS = 30000; // the server polls ElevenLabs for up to about 15 s before it answers
/** 401 token refused, 403 origin, 404 route missing, 409 conversation mismatch, 413 too large, 507 session full. */
export const PERMANENT_FAILURES: readonly number[] = [400, 401, 403, 404, 409, 413, 507];

export interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface UploaderOptions {
  session: AgentSession;
  fetch: FetchLike;
  timers: Timers;
  now: () => number;
  /** Called for the problems the person should see (once per kind). */
  onProblem?: (text: string) => void;
}

export type FinishResult =
  | { kind: 'stored'; transcriptStored: boolean }
  | { kind: 'no-conversation' }
  | { kind: 'failed'; message: string; unsent: number };

const encoder = new TextEncoder();

/** UTF-8 bytes of one line as it goes into the request body (JSON escapes and multi-byte characters count). */
export function eventBytes(ev: LogEvent): number {
  return encoder.encode(JSON.stringify(ev)).length + 1; // +1 for the comma between lines
}

export class EventUploader {
  private readonly session: AgentSession;
  private readonly fetchFn: FetchLike;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly onProblem: (text: string) => void;
  private queue: LogEvent[] = [];
  private conversationId = '';
  private timer: unknown = null;
  private chain: Promise<boolean> | null = null;
  private flushing = false;
  private failedShown = false;
  private gaveUp = false;
  private finished = false;
  private recording = true;

  constructor(options: UploaderOptions) {
    this.session = options.session;
    this.fetchFn = options.fetch;
    this.timers = options.timers;
    this.now = options.now;
    this.onProblem = options.onProblem ?? (() => {});
    this.timer = this.timers.setInterval(() => {
      if (!this.flushing && !this.gaveUp && this.queue.length > 0) void this.flush();
    }, FLUSH_MS);
  }

  isRecording(): boolean { return this.recording; }
  pending(): number { return this.queue.length; }
  hasGivenUp(): boolean { return this.gaveUp; }

  setConversationId(id: string): void {
    if (id) this.conversationId = id;
  }

  /** Off the record: nothing more is queued. What was queued before is still sent. */
  stopRecording(): void {
    this.recording = false;
  }

  enqueue(dir: LogDir, type: string, rawText: unknown): void {
    if (!this.recording || this.finished) return;
    const text = scrub(rawText);
    this.queue.push({
      t: this.now(), dir, type,
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}...[truncated]` : text,
    });
  }

  /** The next lines to send, within `maxEvents` and `maxBytes` of UTF-8 JSON (the first line is always taken). */
  private nextBatch(maxEvents: number = MAX_BATCH_EVENTS, maxBytes: number = MAX_BATCH_BYTES): LogEvent[] {
    const batch: LogEvent[] = [];
    let bytes = 0;
    for (const ev of this.queue) {
      const size = eventBytes(ev);
      if (batch.length >= maxEvents || (batch.length > 0 && bytes + size > maxBytes)) break;
      batch.push(ev);
      bytes += size;
    }
    return batch;
  }

  /** Sends the queue in batches, one request at a time and in order. Resolves true when the queue is empty. */
  flush(): Promise<boolean> {
    this.chain = (this.chain ?? Promise.resolve()).then(() => this.doFlush());
    return this.chain;
  }

  private async doFlush(): Promise<boolean> {
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.nextBatch();
        const body: { events: LogEvent[]; conversationId?: string } = { events: batch };
        if (this.conversationId) body.conversationId = this.conversationId;
        const req = this.session.events();
        let res: Response | null;
        try {
          res = await this.fetchFn(req.url, {
            method: 'POST', headers: { 'content-type': 'application/json', ...req.headers },
            body: JSON.stringify(body), signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
          });
        } catch {
          res = null;
        }
        if (res && PERMANENT_FAILURES.includes(res.status)) {
          // The server will not accept this session's log (route missing, origin or token refused, session full).
          this.gaveUp = true;
          this.stopTimer();
          this.onProblem(`Session log upload refused (${res.status}); upload stopped for this session.`);
          return false;
        }
        if (!res || !res.ok) {
          if (!this.failedShown) {
            this.failedShown = true;
            this.onProblem(`Session log upload failed${res ? ` (${res.status})` : ''}. Lines stay queued and are retried.`);
          }
          return false;
        }
        this.failedShown = false;
        this.queue.splice(0, batch.length);
      }
      return true;
    } finally {
      this.flushing = false;
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** Flushes what is left, asks the server to store the ElevenLabs conversation and stops the timer. */
  async finish(): Promise<FinishResult> {
    if (this.finished) return { kind: 'no-conversation' };
    this.stopTimer();
    if (!this.gaveUp) await this.flush();
    this.finished = true;
    this.recording = false;
    if (!this.conversationId) return { kind: 'no-conversation' };
    const req = this.session.finish();
    try {
      const res = await this.fetchFn(req.url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...req.headers },
        body: JSON.stringify({ conversationId: this.conversationId }), signal: AbortSignal.timeout(FINISH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`finish answered ${res.status}`);
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      const stored = typeof body === 'object' && body !== null && !!(
        (body as Record<string, unknown>)['transcriptStored'] || (body as Record<string, unknown>)['transcript_stored']
      );
      return { kind: 'stored', transcriptStored: stored };
    } catch (e) {
      return { kind: 'failed', message: e instanceof Error ? e.message : String(e), unsent: this.queue.length };
    }
  }

  /** Closing or reloading the tab: best effort with keepalive (bodies are limited to 64 KB). */
  sendOnPageHide(): void {
    if (this.finished || this.gaveUp) return;
    this.finished = true;
    this.recording = false;
    this.stopTimer();
    const post = (req: { url: string; headers: Record<string, string> }, body: unknown): void => {
      try {
        void this.fetchFn(req.url, {
          method: 'POST', headers: { 'content-type': 'application/json', ...req.headers },
          body: JSON.stringify(body), keepalive: true,
        }).catch(() => {});
      } catch { /* the page is going away */ }
    };
    const batch = this.nextBatch(PAGEHIDE_BATCH_EVENTS, PAGEHIDE_BATCH_BYTES);
    if (batch.length > 0) post(this.session.events(), { conversationId: this.conversationId || undefined, events: batch });
    if (this.conversationId) post(this.session.finish(), { conversationId: this.conversationId });
  }
}
