// The web face's connection to the Clipa Conductor (doc-12): events go up as POSTed batches, cues come down as a
// Server-Sent Events stream read with fetch (EventSource cannot send the Authorization header).
//   - Events carry an increasing seq. Activity, talking, off-the-record and cue_done go out at once; the rest wait up to
//     BATCH_MS to share one POST. A failed POST is retried with the same seqs: the server skips seqs it already has.
//   - The stream reconnects with `after=<last cue seq>` and a backoff, so missed cues are replayed and none is applied twice.
//   - The token only ever travels in the Authorization header: never in a URL, the DOM or a log line.
import type { ClientEnvelope, ClientEvent, CueEnvelope, StreamHello } from './protocol.ts';
import { parseCueEnvelope, parseStreamHello, sanitizeEvent } from './protocol.ts';
import { SseParser } from './sse.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ConductorStatus = 'idle' | 'connecting' | 'live' | 'retrying' | 'failed' | 'closed';

export interface ConductorClientOptions {
  /** API origin ('' means this site). */
  base: string;
  sessionId: string;
  /** `Bearer <token>` of the session, read at each request. A secret: never logged. */
  authorization(): string | null;
  fetch: FetchLike;
  timers: ClientTimers;
  /** Milliseconds since the session's epoch (the atMs of an event). */
  clock(): number;
  onCue(cue: CueEnvelope): void;
  /** The stream's first message. `first` is true only for the first stream this client opened. */
  onHello?(hello: StreamHello, first: boolean): void;
  onStatus?(status: ConductorStatus, detail: string | null): void;
  log?(line: string): void;
  batchMs?: number;
}

/** How long non-urgent events wait to share one POST. */
export const BATCH_MS = 120;
/** At most this many events per POST (the server's limit is 50). */
export const MAX_BATCH = 50;
export const RETRY_MIN_MS = 300;
export const RETRY_MAX_MS = 8000;
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
/** The server pings every 15 s: a stream silent for this long is dead and is reopened. */
export const STALL_MS = 40_000;
/** Queued events kept while the server cannot be reached; the oldest go first. */
const MAX_QUEUE = 500;

/** Sent without the batching delay: they are the conductor's pause and silence signals. */
const URGENT: ReadonlySet<ClientEvent['type']> = new Set(['activity', 'talking', 'off_record', 'cue_done']);

export class ConductorClient {
  private readonly o: ConductorClientOptions;
  private seq = 0;
  private queue: ClientEnvelope[] = [];
  private inflight: ClientEnvelope[] | null = null;
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private retryMs = RETRY_MIN_MS;
  private lastCueSeq = -1;
  private streams = 0;
  private status: ConductorStatus = 'idle';
  private closed = false;
  private opened = false;
  private attempt: AbortController | null = null;
  private reconnectTimer: unknown = null;
  private reconnectMs = RECONNECT_MIN_MS;
  private stallTimer: unknown = null;
  private eventsRefused = false;

  constructor(options: ConductorClientOptions) {
    this.o = options;
  }

  get sessionId(): string { return this.o.sessionId; }
  /** The highest cue seq applied so far (-1 before the first cue). */
  get lastSeq(): number { return this.lastCueSeq; }
  get state(): ConductorStatus { return this.status; }
  /** Events queued or in flight (for tests and the debug view). */
  get pending(): number { return this.queue.length + (this.inflight?.length ?? 0); }

  private log(line: string): void { this.o.log?.(line); }

  private setStatus(status: ConductorStatus, detail: string | null = null): void {
    if (this.status === status) return;
    this.status = status;
    this.o.onStatus?.(status, detail);
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const auth = this.o.authorization();
    return auth ? { ...extra, Authorization: auth } : { ...extra };
  }

  private url(path: string): string {
    return `${this.o.base}/api/agent/conductor/${encodeURIComponent(this.o.sessionId)}${path}`;
  }

  // ---- events ----------------------------------------------------------------

  /** Queues one event; returns its seq. Nothing is sent after close(). */
  send(raw: ClientEvent): number {
    if (this.closed || this.eventsRefused) return -1;
    const event = sanitizeEvent(raw);
    if (event === null) { this.log(`conductor event ${raw.type} could not be sent (invalid); dropped`); return -1; }
    const seq = ++this.seq;
    this.queue.push({ seq, atMs: Math.max(0, Math.round(this.o.clock())), event });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (URGENT.has(event.type)) this.flush();
    else if (this.flushTimer === null) {
      this.flushTimer = this.o.timers.setTimeout(() => { this.flushTimer = null; this.flush(); }, this.o.batchMs ?? BATCH_MS);
    }
    return seq;
  }

  /** Sends what is queued now (one POST at a time, in seq order). */
  flush(): void {
    if (this.flushTimer !== null) { this.o.timers.clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.inflight !== null || this.retryTimer !== null || this.queue.length === 0) return;
    const batch = this.queue.splice(0, MAX_BATCH);
    this.inflight = batch;
    void this.post(batch);
  }

  private async post(batch: ClientEnvelope[]): Promise<void> {
    let status: number | null = null;
    try {
      const res = await this.o.fetch(this.url('/events'), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify({ events: batch }),
      });
      status = res.status;
      // The body is small; reading it frees the connection.
      await res.text().catch(() => '');
    } catch {
      status = null;
    }
    if (this.inflight !== batch) return;
    if (status !== null && status >= 200 && status < 300) {
      this.inflight = null;
      this.retryMs = RETRY_MIN_MS;
      if (this.queue.length > 0) this.flush();
      return;
    }
    if (status === 400 || status === 413) {
      // A batch the server cannot read never becomes readable: drop it, keep the rest.
      this.inflight = null;
      this.log(`conductor refused ${batch.length} event(s) (${status}); they were dropped`);
      if (this.queue.length > 0) this.flush();
      return;
    }
    if (status === 401 || status === 403 || status === 404) {
      this.inflight = null;
      this.queue = [];
      this.eventsRefused = true;
      this.log(`conductor events refused (${status}): no more events are sent for this session`);
      return;
    }
    if (this.closed) { this.inflight = null; return; }
    // Network error, 429 or 5xx: the same batch again, later. The server skips seqs it already applied.
    const wait = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryTimer = this.o.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.inflight !== batch || this.closed) return;
      void this.post(batch);
    }, wait);
  }

  // ---- cues --------------------------------------------------------------------

  /** Opens the cue stream (once). It reconnects by itself until close(). */
  open(): void {
    if (this.opened || this.closed) return;
    this.opened = true;
    void this.connect();
  }

  private scheduleReconnect(detail: string): void {
    if (this.closed) return;
    this.setStatus('retrying', detail);
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    this.reconnectTimer = this.o.timers.setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, wait);
  }

  private armStall(attempt: AbortController): void {
    if (this.stallTimer !== null) this.o.timers.clearTimeout(this.stallTimer);
    this.stallTimer = this.o.timers.setTimeout(() => {
      this.stallTimer = null;
      if (this.attempt === attempt) attempt.abort();
    }, STALL_MS);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const attempt = new AbortController();
    this.attempt = attempt;
    if (this.status !== 'retrying') this.setStatus('connecting');
    let res: Response;
    try {
      res = await this.o.fetch(`${this.url('/cues')}?after=${this.lastCueSeq}&client=web`, {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream' }),
        cache: 'no-store',
        signal: attempt.signal,
      });
    } catch {
      if (this.attempt === attempt) this.scheduleReconnect('network error');
      return;
    }
    if (this.closed || this.attempt !== attempt) { try { await res.body?.cancel(); } catch { /* gone */ } return; }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      this.setStatus('failed', `the server refused the cue stream (${res.status})`);
      return;
    }
    if (!res.ok || res.body === null) {
      this.scheduleReconnect(`the server answered ${res.status}`);
      return;
    }
    const first = this.streams === 0;
    this.streams += 1;
    const parser = new SseParser((m) => {
      if (this.attempt !== attempt) return;
      if (m.event === 'hello') {
        const hello = parseStreamHello(safeJson(m.data));
        this.reconnectMs = RECONNECT_MIN_MS;
        this.setStatus('live');
        if (hello) this.o.onHello?.(hello, first);
        return;
      }
      if (m.event !== 'cue') return;
      const env = parseCueEnvelope(safeJson(m.data));
      if (env === null) { this.log('conductor sent a cue this page does not understand; ignored'); return; }
      if (env.seq <= this.lastCueSeq) return;
      this.lastCueSeq = env.seq;
      try { this.o.onCue(env); } catch (e) { this.log(`cue ${env.cue.type} failed: ${e instanceof Error ? e.message : String(e)}`); }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    this.armStall(attempt);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.attempt !== attempt) break;
        this.armStall(attempt);
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // aborted (close, stall) or the connection broke: handled below
    }
    try { reader.releaseLock(); } catch { /* already released */ }
    if (this.attempt !== attempt || this.closed) return;
    if (this.stallTimer !== null) { this.o.timers.clearTimeout(this.stallTimer); this.stallTimer = null; }
    this.scheduleReconnect('the cue stream ended');
  }

  /** Stops the stream and the retries. Events still queued are sent once more, best effort. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.abort();
    for (const t of [this.reconnectTimer, this.stallTimer, this.retryTimer, this.flushTimer]) if (t !== null) this.o.timers.clearTimeout(t);
    this.reconnectTimer = null;
    this.stallTimer = null;
    this.retryTimer = null;
    this.flushTimer = null;
    this.setStatus('closed');
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
