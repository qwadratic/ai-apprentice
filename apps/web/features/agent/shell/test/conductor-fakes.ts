// Fakes for the conductor tests: a controllable SSE response body and a fetch for the conductor routes.

/** A response body the test writes to; it errors when the request is aborted, like a real fetch stream. */
export class FakeStream {
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly enc = new TextEncoder();
  closed = false;
  readonly body: ReadableStream<Uint8Array>;
  constructor(signal?: AbortSignal | null) {
    this.body = new ReadableStream<Uint8Array>({ start: (c) => { this.ctrl = c; } });
    signal?.addEventListener('abort', () => { if (!this.closed) { this.closed = true; this.ctrl?.error(new Error('aborted')); } });
  }
  push(text: string): void { if (!this.closed) this.ctrl?.enqueue(this.enc.encode(text)); }
  end(): void { if (!this.closed) { this.closed = true; this.ctrl?.close(); } }
}

export interface FakeCall { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fetch for the conductor routes: GET /cues answers with a FakeStream (or `cueStatus`), POST /events with `eventStatus`. */
export function conductorFetch(options: { cueStatus?: number[]; eventStatus?: Array<number | 'network'>; linkStatus?: number } = {}) {
  const calls: FakeCall[] = [];
  const streams: FakeStream[] = [];
  const cueStatus = [...(options.cueStatus ?? [])];
  const eventStatus = [...(options.eventStatus ?? [])];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    let body: unknown = null;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers, body });
    if (url.includes('/cues')) {
      const status = cueStatus.shift() ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ ok: false }), { status });
      const stream = new FakeStream(init?.signal);
      streams.push(stream);
      return new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/events')) {
      const status = eventStatus.shift() ?? 200;
      if (status === 'network') throw new TypeError('network error');
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }
    if (url.endsWith('/link')) return new Response(JSON.stringify({ ok: true }), { status: options.linkStatus ?? 200 });
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls, streams };
}

export function sseCue(env: Record<string, unknown>): string {
  return `id: ${String(env.seq)}\nevent: cue\ndata: ${JSON.stringify(env)}\n\n`;
}

export function sseHello(lastCueSeq = -1): string {
  return `event: hello\ndata: ${JSON.stringify({ sessionId: 'sess-1', lastCueSeq, serverNowMs: 1 })}\n\n`;
}

export function cue(seq: number, body: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq, cueId: `c${seq}-abcdef12`, atMs: seq * 100, mode: 'learn', persona: 'expert', for: 'all', cue: body, expiresAtMs: null, ...extra };
}
