// Browser client of the agent API (apps/api/agent, TASK-3.27). Routes under /api/agent/*:
//   POST {base}/api/agent/sessions                     -> 201 {sessionId, token, issuedAtMs, serverNowMs}
//   GET  {base}/api/agent/elevenlabs/signed-url        Authorization: Bearer <token>  -> {signed_url}
//   POST {base}/api/agent/sessions/:id/events|finish   Authorization: Bearer <token>
//   POST {base}/api/agent/llm/:task                    Authorization: Bearer <token>  (the brain's model-backed parts)
// The browser, not the server, chooses sessionEpochMs (Date.now() at the start click).
// The token and the signed URL stay in this module's closures and in the request that uses them: they are never
// put into shell state, the DOM or the visible log.
import { estimateClockSkew } from './session-clock.ts';

/** Production API (the exe.dev VM). Dev builds use '' and the Vite proxy (/api, /health, /screen). */
export const PRODUCTION_API_BASE = 'https://apprentice.exe.xyz';

/** VITE_API_BASE wins when it is set (an empty string means "same origin"); otherwise production builds use the VM. */
export function resolveApiBase(raw: unknown, production: boolean): string {
  if (typeof raw === 'string') return raw.trim().replace(/\/+$/, '');
  return production ? PRODUCTION_API_BASE : '';
}

export type VoiceRole = 'interviewer' | 'tutor';

export interface ApiRequest {
  url: string;
  headers: Record<string, string>;
}

export interface AgentSession {
  readonly sessionId: string;
  /** TEMPORARY: the VM still runs the old placeholder API (no token, /agent/* routes). Remove with legacySession(). */
  readonly legacy: boolean;
  readonly issuedAtMs: number | null;
  readonly serverNowMs: number | null;
  /** Estimated server clock minus browser clock; null for a legacy session. */
  readonly clockSkewMs: number | null;
  signedUrl(role: VoiceRole): ApiRequest;
  events(): ApiRequest;
  finish(): ApiRequest;
  /** POST {base}/api/agent/llm/:task with the session token, or null on the placeholder API (it has no LLM route). */
  llm(task: string): ApiRequest | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function httpErrorMessage(status: number, what: string): string {
  if (status === 401) return `${what}: the session token was refused (401).`;
  if (status === 403) return `${what}: the server refused this page's origin (403).`;
  if (status === 429) return `${what}: too many requests, try again in a minute (429).`;
  if (status === 503) return `${what}: the service is not available or not configured (503).`;
  return `${what}: the server answered ${status}.`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export interface AgentApiOptions {
  base: string;
  fetch: FetchLike;
  /** Date.now(); injected for tests. */
  now: () => number;
  /** Generates the id of a legacy session (crypto.randomUUID). */
  newId: () => string;
  timeoutMs?: number;
}

export interface AgentApi {
  readonly base: string;
  createSession(): Promise<AgentSession>;
  /** The signed WebSocket URL. A secret: never log it. */
  fetchSignedUrl(session: AgentSession, role: VoiceRole): Promise<string>;
}

export function createAgentApi(options: AgentApiOptions): AgentApi {
  const { base, now } = options;
  const timeoutMs = options.timeoutMs ?? 10000;
  const where = base || 'this site';

  // TEMPORARY, remove when the VM runs apps/api (TASK-3.27 switch): the placeholder has no session endpoint,
  // no token and answers on /agent/* exactly as the agent lab expects. Nothing else in this file knows about it.
  function legacySession(): AgentSession {
    const sessionId = options.newId();
    const prefix = `${base}/agent/sessions/${encodeURIComponent(sessionId)}`;
    return {
      sessionId, legacy: true, issuedAtMs: null, serverNowMs: null, clockSkewMs: null,
      signedUrl: (role) => ({ url: `${base}/agent/elevenlabs/signed-url?role=${role}`, headers: {} }),
      events: () => ({ url: `${prefix}/events`, headers: {} }),
      finish: () => ({ url: `${prefix}/finish`, headers: {} }),
      llm: () => null,
    };
  }

  function tokenSession(sessionId: string, token: string, issuedAtMs: number, serverNowMs: number, clockSkewMs: number): AgentSession {
    const headers = { Authorization: `Bearer ${token}` };
    const prefix = `${base}/api/agent/sessions/${encodeURIComponent(sessionId)}`;
    return {
      sessionId, legacy: false, issuedAtMs, serverNowMs, clockSkewMs,
      signedUrl: (role) => ({ url: `${base}/api/agent/elevenlabs/signed-url?role=${role}`, headers: { ...headers } }),
      events: () => ({ url: `${prefix}/events`, headers: { ...headers } }),
      finish: () => ({ url: `${prefix}/finish`, headers: { ...headers } }),
      llm: (task) => ({ url: `${base}/api/agent/llm/${encodeURIComponent(task)}`, headers: { ...headers } }),
    };
  }

  async function createSession(): Promise<AgentSession> {
    const sentAt = now();
    let res: Response;
    try {
      res = await options.fetch(`${base}/api/agent/sessions`, {
        method: 'POST', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError(`Cannot reach ${where} (network error or CORS). The agent API may not be deployed yet.`, null);
    }
    if (res.status === 404) return legacySession();
    if (!res.ok) throw new ApiError(httpErrorMessage(res.status, 'Could not start a session'), res.status);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!isRecord(body) || typeof body['sessionId'] !== 'string' || typeof body['token'] !== 'string') {
      throw new ApiError('The session endpoint answered, but not with {sessionId, token}.', res.status);
    }
    const receivedAt = now();
    const issuedAtMs = typeof body['issuedAtMs'] === 'number' ? body['issuedAtMs'] : receivedAt;
    const serverNowMs = typeof body['serverNowMs'] === 'number' ? body['serverNowMs'] : receivedAt;
    return tokenSession(body['sessionId'], body['token'], issuedAtMs, serverNowMs, estimateClockSkew(sentAt, receivedAt, serverNowMs));
  }

  async function fetchSignedUrl(session: AgentSession, role: VoiceRole): Promise<string> {
    const req = session.signedUrl(role);
    let res: Response;
    try {
      res = await options.fetch(req.url, { headers: { accept: 'application/json', ...req.headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ApiError(`Could not get a voice connection: cannot reach ${where} (network error or CORS).`, null);
    }
    if (!res.ok) throw new ApiError(httpErrorMessage(res.status, 'Could not get a voice connection'), res.status);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!isRecord(body) || typeof body['signed_url'] !== 'string') {
      throw new ApiError('The voice endpoint answered, but not with {"signed_url": "..."}.', res.status);
    }
    return body['signed_url'];
  }

  return { base, createSession, fetchSignedUrl };
}
