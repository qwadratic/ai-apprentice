// Runtime configuration and the sliding-window limiter for the agent API module.
import type { Request } from 'express';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /** Bearer token for the admin routes (list, read, delete stored sessions). Default: env API_TOKEN; under 32 chars disables them. */
  apiToken?: string;
  /** Claude runner (infra/claude-runner). Default: env RUNNER_URL (http://127.0.0.1:8787) and RUNNER_TOKEN. */
  runnerUrl?: string;
  runnerToken?: string;
  elevenLabsApiKey?: string;
  elevenLabsAgentIdInterviewer?: string;
  elevenLabsAgentIdTutor?: string;
  /** Model for the short, latency-bound tasks (a question at a pause, a guardrail check). Default: env AGENT_FAST_MODEL; '' uses the runner's default. */
  fastModel?: string;
  /** The web app the macOS client sends people to (Review, Summary). Default: env PUBLIC_WEB_URL. */
  publicWebUrl?: string;
  /** Work Maps on disk (confirmed maps and the last built one), so a restart keeps them. Default: env AGENT_MAPS_FILE, else /var/lib/apprentice/maps.json; '' keeps them in memory only. */
  mapsFile?: string;
  /**
   * Seed the invented "earlier sessions" of the email digital twin (agent/conductor/seed/twin-sessions.json) as confirmed maps, in
   * memory only, when no confirmed map exists. Default: env AGENT_SEED_MAPS=1; off otherwise (production never sets it).
   */
  seedMaps?: boolean;
  /** How many earlier sessions of the same persona the map_enrich job reads besides the current one. Default: env AGENT_ENRICH_SESSIONS, else 5. */
  enrichSessions?: number;
  /** Voice-over cache (GET /api/agent/voiceover/:id). Default: {env MEDIA_DIR, else /var/lib/apprentice}/voiceover. */
  voiceoverDir?: string;
  /** The whitelist of voice-over lines. Default: agent/voiceover/lines.json next to this file. */
  voiceoverLinesFile?: string;
  /** Voice ids per role, over the defaults. Default: env ELEVENLABS_VOICEOVER_VOICES (JSON {narrator:"id",...}). */
  voiceoverVoices?: Record<string, string>;
  fetch?: FetchFn;
  now?: () => number;
  log?: Logger;
  limits?: Partial<Limits>;
  timing?: Partial<Timing>;
}
export interface Limits {
  sessionsPerMinute: number;
  sessionsPerIpPerHour: number;
  sessionsGlobalPerHour: number;
  signedUrlPerMinute: number;
  signedUrlPerIpPerHour: number;
  signedUrlGlobalPerHour: number;
  eventsPerMinute: number;
  finishPerMinute: number;
  eventsBodyBytes: number;
  finishBodyBytes: number;
  sessionFileBytes: number;
  eventBytesPerHour: number;
  maxLiveSessions: number;
  /** Disk rotation: warn above warnBytes, delete oldest sessions above rotateBytes (never newer than minSessionAgeMs). */
  warnBytes: number;
  rotateBytes: number;
  minSessionAgeMs: number;
  tmpMaxAgeMs: number;
  maintenanceIntervalMs: number;
  /**
   * POST /api/agent/llm/:task costs money and shares the runner with vision, so it is bounded hard:
   * per session, per client IP (checked before the token, a venue may share one IP) and globally (counted
   * only for authorized calls), plus at most one call in flight per session and llmGlobalInFlight overall.
   */
  llmPerSessionPerMinute: number;
  llmPerSessionPerHour: number;
  llmPerIpPerMinute: number;
  llmPerIpPerHour: number;
  llmGlobalPerHour: number;
  llmGlobalInFlight: number;
  llmInputBytes: number;
}
export interface Timing {
  finishWaitMs: number;
  finishRetryMs: number;
  backgroundWaitMs: number;
  backgroundPollMs: number;
  llmTimeoutMs: number;
  /** How long the API waits for the runner's job route (map_enrich); the runner's own limit, RUNNER_JOB_TIMEOUT_MS (180 s), is shorter. */
  enrichTimeoutMs: number;
}
export interface AgentConfig {
  allowedOrigins: ReadonlySet<string>;
  sessionsDir: string;
  sessionTtlMs: number;
  signedUrlRequiresSession: boolean;
  apiToken: string;
  runnerUrl: string;
  runnerToken: string;
  elevenLabsApiKey: string;
  interviewerAgentId: string;
  /** The agent Teach connects to (its own voice and prompt); empty when not configured. */
  tutorAgentId: string;
  agentIds: ReadonlySet<string>;
  fastModel: string;
  publicWebUrl: string;
  /** The Work Map file; '' when maps stay in memory only. */
  mapsFile: string;
  /** Seed the invented earlier sessions of the email twin as confirmed maps when none exist (AGENT_SEED_MAPS=1). */
  seedMaps: boolean;
  /** Earlier sessions the map_enrich job reads (0 reads only the current session). */
  enrichSessions: number;
  voiceoverDir: string;
  voiceoverLinesFile: string;
  /** Overrides only; roles without one use the voice-over defaults. */
  voiceoverVoices: Record<string, string>;
  limits: Limits;
  timing: Timing;
  fetch: FetchFn;
  now: () => number;
  log: Logger;
}

/** A positive integer from the environment; anything else (and an unset or empty value) falls back, with a warning if it was set. */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, log: Logger): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (/^\s*\d+\s*$/.test(raw) && Number.isSafeInteger(n) && n > 0) return n;
  log({ level: 'warn', msg: 'invalid agent limit in environment; using the default', name, default: fallback });
  return fallback;
}

/** ELEVENLABS_VOICEOVER_VOICES: a JSON object of role -> voice id; anything else is ignored with a warning (no value logged). */
function parseVoices(raw: string | undefined, log: Logger): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (isRecord(v)) {
      const out: Record<string, string> = {};
      for (const [k, id] of Object.entries(v)) if (typeof id === 'string' && /^[A-Za-z0-9]{8,64}$/.test(id)) out[k] = id;
      return out;
    }
  } catch { /* fall through */ }
  log({ level: 'warn', msg: 'invalid ELEVENLABS_VOICEOVER_VOICES; using the default voices' });
  return {};
}

export function resolveConfig(options: AgentOptions = {}, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const origins = options.allowedOrigins ?? (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const interviewer = options.elevenLabsAgentIdInterviewer ?? env.ELEVENLABS_AGENT_ID_INTERVIEWER ?? '';
  const tutor = options.elevenLabsAgentIdTutor ?? env.ELEVENLABS_AGENT_ID_TUTOR ?? '';
  const log = options.log ?? ((fields: LogFields) => { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n'); });
  // The whole venue may share one public IP, so every rate limit can be raised from the environment.
  const int = (name: string, fallback: number): number => positiveInt(env, name, fallback, log);
  const limits: Limits = {
    sessionsPerMinute: int('AGENT_SESSIONS_PER_IP_MIN', 30),
    sessionsPerIpPerHour: int('AGENT_SESSIONS_PER_IP_HOUR', 300),
    sessionsGlobalPerHour: int('AGENT_SESSIONS_GLOBAL_HOUR', 5000),
    signedUrlPerMinute: int('SIGNED_URL_PER_IP_MIN', 20),
    signedUrlPerIpPerHour: int('SIGNED_URL_PER_IP_HOUR', 200),
    signedUrlGlobalPerHour: int('SIGNED_URL_GLOBAL_HOUR', 1000),
    eventsPerMinute: int('AGENT_EVENTS_PER_IP_MIN', 120),
    finishPerMinute: int('AGENT_FINISH_PER_IP_MIN', 6),
    eventsBodyBytes: 512 * 1024, finishBodyBytes: 4096,
    sessionFileBytes: 5 * 1024 * 1024,
    eventBytesPerHour: int('EVENTS_BYTES_PER_HOUR', 50 * 1024 * 1024),
    maxLiveSessions: 2000,
    warnBytes: int('SESSIONS_WARN_BYTES', 1024 ** 3),
    rotateBytes: int('SESSIONS_ROTATE_BYTES', 2 * 1024 ** 3),
    minSessionAgeMs: 24 * 3_600_000,
    tmpMaxAgeMs: 10 * 60_000,
    maintenanceIntervalMs: 10 * 60_000,
    llmPerSessionPerMinute: int('AGENT_LLM_PER_SESSION_MIN', 6),
    llmPerSessionPerHour: int('AGENT_LLM_PER_SESSION_HOUR', 60),
    llmPerIpPerMinute: int('AGENT_LLM_PER_IP_MIN', 20),
    llmPerIpPerHour: int('AGENT_LLM_PER_IP_HOUR', 200),
    llmGlobalPerHour: int('AGENT_LLM_GLOBAL_HOUR', 600),
    llmGlobalInFlight: int('AGENT_LLM_GLOBAL_IN_FLIGHT', 1),
    llmInputBytes: 16 * 1024,
    ...options.limits,
  };
  const timing: Timing = { finishWaitMs: 18_000, finishRetryMs: 3000, backgroundWaitMs: 5 * 60_000, backgroundPollMs: 5000, llmTimeoutMs: int('AGENT_LLM_TIMEOUT_MS', 25_000), enrichTimeoutMs: int('AGENT_ENRICH_TIMEOUT_MS', 200_000), ...options.timing };
  return {
    allowedOrigins: new Set(origins),
    sessionsDir: options.sessionsDir ?? env.SESSIONS_DIR ?? '/var/lib/apprentice/sessions',
    sessionTtlMs: options.sessionTtlMs ?? 12 * 3_600_000,
    signedUrlRequiresSession: options.signedUrlRequiresSession ?? env.SIGNED_URL_REQUIRE_SESSION === '1',
    apiToken: options.apiToken ?? env.API_TOKEN ?? '',
    runnerUrl: options.runnerUrl ?? (env.RUNNER_URL || 'http://127.0.0.1:8787'),
    runnerToken: options.runnerToken ?? env.RUNNER_TOKEN ?? '',
    elevenLabsApiKey: options.elevenLabsApiKey ?? env.ELEVENLABS_API_KEY ?? '',
    interviewerAgentId: interviewer,
    tutorAgentId: tutor,
    agentIds: new Set([interviewer, tutor].filter(Boolean)),
    fastModel: options.fastModel ?? env.AGENT_FAST_MODEL ?? 'claude-haiku-4-5-20251001',
    publicWebUrl: options.publicWebUrl ?? (env.PUBLIC_WEB_URL || 'https://qwadratic.github.io/clipa/'),
    mapsFile: (options.mapsFile ?? env.AGENT_MAPS_FILE ?? '/var/lib/apprentice/maps.json').trim(),
    seedMaps: options.seedMaps ?? env.AGENT_SEED_MAPS === '1',
    enrichSessions: options.enrichSessions ?? int('AGENT_ENRICH_SESSIONS', 5),
    voiceoverDir: options.voiceoverDir ?? join(env.MEDIA_DIR || '/var/lib/apprentice', 'voiceover'),
    voiceoverLinesFile: options.voiceoverLinesFile ?? fileURLToPath(new URL('./voiceover/lines.json', import.meta.url)),
    voiceoverVoices: options.voiceoverVoices ?? parseVoices(env.ELEVENLABS_VOICEOVER_VOICES, log),
    limits, timing,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? Date.now,
    log,
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

export interface LimiterRules {
  perMinute: number;
  /** Per client IP over the last hour (0 = none). */
  perIpPerHour?: number;
  /** Over all clients together in the last hour (0 = none): a safety cap, high enough that one IP cannot reach it. */
  globalPerHour?: number;
}

/** Sliding windows per client IP and overall. Returns true when the request is limited (and is then not counted). */
export function makeLimiter(rules: LimiterRules, now: () => number = Date.now): (ip: string) => boolean {
  const hour = 3_600_000;
  const perIpPerHour = rules.perIpPerHour ?? 0;
  const globalPerHour = rules.globalPerHour ?? 0;
  const keep = perIpPerHour ? hour : 60_000;
  const perIp = new Map<string, number[]>();
  let globalHits: number[] = [];
  return (ip) => {
    const t = now();
    if (globalPerHour) globalHits = globalHits.filter((h) => t - h < hour);
    const mine = (perIp.get(ip) ?? []).filter((h) => t - h < keep);
    const lastMinute = mine.filter((h) => t - h < 60_000).length;
    if (lastMinute >= rules.perMinute || (perIpPerHour && mine.length >= perIpPerHour) || (globalPerHour && globalHits.length >= globalPerHour)) {
      perIp.set(ip, mine);
      return true;
    }
    mine.push(t);
    perIp.set(ip, mine);
    if (globalPerHour) globalHits.push(t);
    if (perIp.size > 10_000) {
      for (const [k, v] of perIp) { const last = v.at(-1); if (last === undefined || t - last >= keep) perIp.delete(k); }
    }
    return false;
  };
}
