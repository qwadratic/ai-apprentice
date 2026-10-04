// Runtime configuration and the sliding-window limiter for the agent API module.
import type { Request } from 'express';
export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export type LogFields = Record<string, unknown>;
export type Logger = (fields: LogFields) => void;
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AgentOptions {
  allowedOrigins?: string[];
  sessionsDir?: string;
  sessionTtlMs?: number;
  /** The signed-url route insists on a valid session token. Default: env SIGNED_URL_REQUIRE_SESSION=1. */
  signedUrlRequiresSession?: boolean;
  elevenLabsApiKey?: string;
  elevenLabsAgentIdInterviewer?: string;
  elevenLabsAgentIdTutor?: string;
  fetch?: FetchFn;
  now?: () => number;
  log?: Logger;
  limits?: Partial<Limits>;
  timing?: Partial<Timing>;
}
export interface Limits {
  sessionsPerMinute: number;
  sessionsPerHour: number;
  signedUrlPerMinute: number;
  signedUrlPerHour: number;
  eventsPerMinute: number;
  finishPerMinute: number;
  eventsBodyBytes: number;
  finishBodyBytes: number;
  sessionFileBytes: number;
  eventBytesPerHour: number;
  maxLiveSessions: number;
}
export interface Timing {
  finishWaitMs: number;
  finishRetryMs: number;
  backgroundWaitMs: number;
  backgroundPollMs: number;
}
export interface AgentConfig {
  allowedOrigins: ReadonlySet<string>;
  sessionsDir: string;
  sessionTtlMs: number;
  signedUrlRequiresSession: boolean;
  elevenLabsApiKey: string;
  interviewerAgentId: string;
  agentIds: ReadonlySet<string>;
  limits: Limits;
  timing: Timing;
  fetch: FetchFn;
  now: () => number;
  log: Logger;
}

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function resolveConfig(options: AgentOptions = {}, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const origins = options.allowedOrigins ?? (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const interviewer = options.elevenLabsAgentIdInterviewer ?? env.ELEVENLABS_AGENT_ID_INTERVIEWER ?? '';
  const tutor = options.elevenLabsAgentIdTutor ?? env.ELEVENLABS_AGENT_ID_TUTOR ?? '';
  const limits: Limits = {
    sessionsPerMinute: 10, sessionsPerHour: 300,
    signedUrlPerMinute: 6, signedUrlPerHour: 60,
    eventsPerMinute: 120, finishPerMinute: 6,
    eventsBodyBytes: 512 * 1024, finishBodyBytes: 4096,
    sessionFileBytes: 5 * 1024 * 1024,
    eventBytesPerHour: num(env.EVENTS_BYTES_PER_HOUR, 50 * 1024 * 1024),
    maxLiveSessions: 2000,
    ...options.limits,
  };
  const timing: Timing = { finishWaitMs: 18_000, finishRetryMs: 3000, backgroundWaitMs: 5 * 60_000, backgroundPollMs: 5000, ...options.timing };
  return {
    allowedOrigins: new Set(origins),
    sessionsDir: options.sessionsDir ?? env.SESSIONS_DIR ?? '/var/lib/apprentice/sessions',
    sessionTtlMs: options.sessionTtlMs ?? 12 * 3_600_000,
    signedUrlRequiresSession: options.signedUrlRequiresSession ?? env.SIGNED_URL_REQUIRE_SESSION === '1',
    elevenLabsApiKey: options.elevenLabsApiKey ?? env.ELEVENLABS_API_KEY ?? '',
    interviewerAgentId: interviewer,
    agentIds: new Set([interviewer, tutor].filter(Boolean)),
    limits, timing,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? Date.now,
    log: options.log ?? ((fields) => { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n'); }),
  };
}

/** Client IP as the exe.dev proxy reports it: the last X-Forwarded-For entry, else the socket address. */
export function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

/** Requests without Origin count as local dev only when they come straight from loopback (no proxy header). */
export function isLocalDevRequest(req: Request): boolean {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Sliding window: `perMinute` per client IP and `perHour` overall (0 = none). Returns true when limited. */
export function makeLimiter(perMinute: number, perHour: number, now: () => number = Date.now): (ip: string) => boolean {
  const perIp = new Map<string, number[]>();
  let globalHits: number[] = [];
  return (ip) => {
    const t = now();
    if (perHour) globalHits = globalHits.filter((h) => t - h < 3_600_000);
    const mine = (perIp.get(ip) ?? []).filter((h) => t - h < 60_000);
    if (mine.length >= perMinute || (perHour && globalHits.length >= perHour)) { perIp.set(ip, mine); return true; }
    mine.push(t);
    perIp.set(ip, mine);
    if (perHour) globalHits.push(t);
    if (perIp.size > 10_000) {
      for (const [k, v] of perIp) { const last = v.at(-1); if (last === undefined || t - last >= 60_000) perIp.delete(k); }
    }
    return false;
  };
}
