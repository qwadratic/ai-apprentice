// A small client for the server's LLM route: POST {apiBase}/api/agent/llm/:task with the session token.
// The browser never holds a model key; the route runs the model. fetch is injected, so tests use recorded responses.
// The server allows one call in flight per session (and few overall) and answers 429 "busy" otherwise, so this client
// queues its own calls and runs them one at a time. A busy answer, a timeout or any error never loses the turn: the caller
// gets a failure and uses the heuristic. Nothing sensitive is logged: an event names the task and the outcome, never the
// transcript, the token or the output.

export type LlmTask = "answer_extraction" | "reply_classification" | "entity_resolution";

export type LlmFailure =
  | "no_fetch"
  | "timeout"
  | "network"
  | "http_error"
  /** HTTP 429: the server is busy or rate limiting. */
  | "busy"
  /** The call waited in this client's own queue for too long. */
  | "queue_timeout"
  | "invalid_json"
  | "invalid_output"
  /** The input was not sent: it is outside what the route accepts. */
  | "invalid_input";

/** One call and how it ended: the model answered ("llm") or the heuristic took over ("fallback", with the reason). */
export interface LlmEvent {
  task: LlmTask;
  outcome: "llm" | "fallback";
  reason?: LlmFailure;
  /** HTTP status, when there was a response. */
  status?: number;
  /** From the moment of the call (including the time in the queue) to its end. */
  elapsedMs: number;
}

export interface FetchLikeInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The part of fetch that is used. */
export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface LlmClientOptions {
  /** Origin of the API, e.g. "https://api.example". A trailing slash is ignored. */
  apiBase: string;
  /** The session token issued by POST /api/agent/sessions. Sent as a Bearer token. */
  token: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** A call that takes longer than this once it has started falls back. Default 8 s. */
  timeoutMs?: number;
  /** A call that waits longer than this behind earlier calls falls back without being sent. Default: timeoutMs. */
  maxQueueWaitMs?: number;
  onEvent?: (event: LlmEvent) => void;
  /** Milliseconds, for elapsedMs. Default Date.now. */
  now?: () => number;
}

export type LlmCall = { ok: true; output: unknown } | { ok: false; reason: LlmFailure; status?: number };

export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The route answers { ok: true, output }; the output itself or { result } are accepted too. */
export function unwrapOutput(body: unknown): unknown {
  if (isJsonObject(body)) {
    if (isJsonObject(body.output)) return body.output;
    if (isJsonObject(body.result)) return body.result;
  }
  return body;
}

export class LlmClient {
  /** Every call so far, oldest first. */
  readonly events: LlmEvent[] = [];
  private readonly options: LlmClientOptions;
  /** Settles when the last queued call has finished. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: LlmClientOptions) {
    this.options = options;
  }

  private clock(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Records how a call ended. Callers use it when the output turned out unusable, or when it was used. */
  record(task: LlmTask, startedAt: number, outcome: LlmEvent["outcome"], reason?: LlmFailure, status?: number): void {
    const event: LlmEvent = { task, outcome, elapsedMs: Math.max(0, this.clock() - startedAt) };
    if (reason !== undefined) event.reason = reason;
    if (status !== undefined) event.status = status;
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  /** Records a call that was not sent because its input is outside what the route accepts. */
  skip(task: LlmTask, reason: LlmFailure = "invalid_input"): void {
    this.record(task, this.clock(), "fallback", reason);
  }

  /**
   * Calls the route, one call at a time. Never throws; a failed call says why. The caller validates the output and records
   * the outcome. startedAt is the moment of the call, so the elapsed time includes the wait in the queue.
   */
  async call(task: LlmTask, input: unknown): Promise<{ result: LlmCall; startedAt: number }> {
    const startedAt = this.clock();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => mine);

    const maxWait = this.options.maxQueueWaitMs ?? this.options.timeoutMs ?? 8000;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const turn = await Promise.race([
      previous.then(() => "go" as const),
      new Promise<"late">((resolve) => {
        waitTimer = setTimeout(() => resolve("late"), maxWait);
      }),
    ]);
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    if (turn === "late") {
      release(); // the chain goes on once the earlier calls are done
      return { result: { ok: false, reason: "queue_timeout" }, startedAt };
    }
    try {
      return { result: await this.send(task, input), startedAt };
    } finally {
      release();
    }
  }

  private async send(task: LlmTask, input: unknown): Promise<LlmCall> {
    const doFetch: FetchLike | undefined = this.options.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
    if (doFetch === undefined) return { ok: false, reason: "no_fetch" };
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 8000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const url = `${this.options.apiBase.replace(/\/+$/, "")}/api/agent/llm/${task}`;
      const request = doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      request.catch(() => undefined); // a late rejection after the timeout must not surface
      const response = await Promise.race([request, timedOut]);
      if (response === "timeout") return { ok: false, reason: "timeout" };
      if (response.status === 429) return { ok: false, reason: "busy", status: 429 };
      if (!response.ok) return { ok: false, reason: "http_error", status: response.status };
      let body: unknown;
      try {
        body = await Promise.race([response.json(), timedOut]);
      } catch {
        return { ok: false, reason: "invalid_json", status: response.status };
      }
      if (body === "timeout") return { ok: false, reason: "timeout" };
      return { ok: true, output: unwrapOutput(body) };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
