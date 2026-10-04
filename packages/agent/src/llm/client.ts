// A small client for the server's LLM route: POST {apiBase}/api/agent/llm/:task with the session token.
// The browser never holds a model key; the route runs the model. fetch is injected, so tests use recorded responses.
// Nothing sensitive is logged: an event names the task and the outcome, never the transcript, the token or the output.

export type LlmTask = "answer_extraction" | "reply_classification" | "entity_resolution";

export type LlmFailure = "no_fetch" | "timeout" | "network" | "http_error" | "invalid_json" | "invalid_output";

/** One call and how it ended: the model answered ("llm") or the heuristic took over ("fallback", with the reason). */
export interface LlmEvent {
  task: LlmTask;
  outcome: "llm" | "fallback";
  reason?: LlmFailure;
  /** HTTP status, when there was a response. */
  status?: number;
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
  /** Longer than this and the heuristic takes over. Default 8 s. */
  timeoutMs?: number;
  onEvent?: (event: LlmEvent) => void;
  /** Milliseconds, for elapsedMs. Default Date.now. */
  now?: () => number;
}

export type LlmCall = { ok: true; output: unknown } | { ok: false; reason: LlmFailure; status?: number };

export const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The route may answer with the output itself or wrapped as { output } or { result }. */
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

  /** Calls the route. Never throws; a failed call says why. The caller validates the output and records the outcome. */
  async call(task: LlmTask, input: unknown): Promise<{ result: LlmCall; startedAt: number }> {
    const startedAt = this.clock();
    const doFetch: FetchLike | undefined = this.options.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
    if (doFetch === undefined) return { result: { ok: false, reason: "no_fetch" }, startedAt };
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
      if (response === "timeout") return { result: { ok: false, reason: "timeout" }, startedAt };
      if (!response.ok) return { result: { ok: false, reason: "http_error", status: response.status }, startedAt };
      let body: unknown;
      try {
        body = await Promise.race([response.json(), timedOut]);
      } catch {
        return { result: { ok: false, reason: "invalid_json", status: response.status }, startedAt };
      }
      if (body === "timeout") return { result: { ok: false, reason: "timeout" }, startedAt };
      return { result: { ok: true, output: unwrapOutput(body) }, startedAt };
    } catch {
      return { result: { ok: false, reason: controller.signal.aborted ? "timeout" : "network" }, startedAt };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
