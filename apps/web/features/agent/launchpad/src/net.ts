// The one way this page reads JSON from the network. It always answers with a result object and never throws,
// so a dead server, a CORS block or a bad answer becomes a state on the page, not an uncaught error.
import { FETCH_TIMEOUT_MS } from './config.ts';

export type Failure =
  | { kind: 'timeout' } // no complete answer within the time limit
  | { kind: 'network' } // offline, DNS, TLS, or blocked by CORS (the browser does not say which)
  | { kind: 'http'; status: number; headers: Headers } // the server answered with an error status
  | { kind: 'parse' } // a 2xx answer whose body is not JSON
  | { kind: 'shape' }; // JSON, but not what the caller expects (set by the callers, never by getJson)

export type Fetched = { ok: true; data: unknown; headers: Headers } | { ok: false; failure: Failure };

export interface GetOptions {
  accept?: string;
  cache?: RequestCache;
  timeoutMs?: number;
}

export async function getJson(url: string, options: GetOptions = {}): Promise<Fetched> {
  const { accept = 'application/json', cache = 'no-store', timeoutMs = FETCH_TIMEOUT_MS } = options;
  const controller = new AbortController();
  let timedOut = false;
  // One timer for the whole request, body included: a server that sends headers and then stalls is a timeout too.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      // Only a CORS-safelisted request header (Accept), so a cross-origin GET needs no preflight.
      res = await fetch(url, { headers: { accept }, cache, credentials: 'omit', signal: controller.signal });
    } catch {
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'network' } };
    }
    if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status, headers: res.headers } };
    try {
      const data: unknown = await res.json();
      return { ok: true, data, headers: res.headers };
    } catch {
      return { ok: false, failure: { kind: timedOut ? 'timeout' : 'parse' } };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** One short phrase for a failure, for example "HTTP 404" or "no answer within 5 s". */
export function describeFailure(failure: Failure, timeoutMs: number = FETCH_TIMEOUT_MS): string {
  switch (failure.kind) {
    case 'timeout':
      return `no answer within ${timeoutMs / 1000} s`;
    case 'network':
      return 'network error, or blocked by CORS';
    case 'http':
      return `HTTP ${failure.status}`;
    case 'parse':
      return 'answered, but not with JSON';
    case 'shape':
      return 'answered, but not with the expected content';
  }
}
