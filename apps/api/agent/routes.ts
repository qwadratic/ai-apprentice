// Express 5 handlers for /api/agent/*. Bodies, transcripts, audio, tokens, signed URLs and keys are never logged.
import type { Express, Request, Response } from 'express';
import type { AgentConfig } from './config.ts';
import { clientIp, isLocalDevRequest, isRecord, makeLimiter } from './config.ts';
import type { SessionStore, AuthResult } from './auth.ts';
import type { ElevenLabsClient, ConversationResult } from './elevenlabs.ts';
import type { Maintenance } from './rotation.ts';
import { sleep } from './elevenlabs.ts';
import { CONVERSATION_ID, SESSION_ID, parseEvents } from './sessions.ts';
import type { SessionFiles } from './sessions.ts';

export interface AgentRuntime {
  config: AgentConfig;
  store: SessionStore;
  files: SessionFiles;
  eleven: ElevenLabsClient;
  maintenance: Maintenance;
  /** Background work (audio fetch after /finish) still running; tests await it. */
  background: Set<Promise<void>>;
}

export type Body = { ok: true; body: unknown } | { ok: false; status: 400 | 413; error: string; maxBytes?: number };

export function reply(res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.status(status).set({ 'Cache-Control': 'no-store', ...headers }).json(body);
}

/**
 * createApi has already parsed JSON bodies up to its own 12 MB limit, so the smaller per-route limit is
 * enforced on the declared length and on the re-serialised size. Other content types are read from the stream.
 */
export async function readBody(req: Request, max: number): Promise<Body> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) return { ok: false, status: 413, error: 'body_too_large', maxBytes: max };
  if (req.body !== undefined) {
    return Buffer.byteLength(JSON.stringify(req.body)) > max
      ? { ok: false, status: 413, error: 'body_too_large', maxBytes: max }
      : { ok: true, body: req.body };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const c = chunk as Buffer;
    size += c.length;
    if (size > max) return { ok: false, status: 413, error: 'body_too_large', maxBytes: max };
    chunks.push(c);
  }
  try { return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }; }
  catch { return { ok: false, status: 400, error: 'invalid_json' }; }
}

/** A browser origin must be allow-listed; no Origin is accepted only from a direct loopback request (local dev). */
export function originAllowed(config: Pick<AgentConfig, 'allowedOrigins'>, req: Request): boolean {
  const origin = req.get('Origin');
  return origin ? config.allowedOrigins.has(origin) : isLocalDevRequest(req);
}

export function registerAgentRoutes(app: Express, rt: AgentRuntime): void {
  const { config, store, files, eleven } = rt;
  const { limits } = config;
  // Per-IP windows are the real limit; the global caps are safety nets that one IP cannot reach on its own.
  const sessionsLimited = makeLimiter({ perMinute: limits.sessionsPerMinute, perIpPerHour: limits.sessionsPerIpPerHour, globalPerHour: limits.sessionsGlobalPerHour }, config.now);
  const signedUrlLimited = makeLimiter({ perMinute: limits.signedUrlPerMinute, perIpPerHour: limits.signedUrlPerIpPerHour, globalPerHour: limits.signedUrlGlobalPerHour }, config.now);
  const eventsLimited = makeLimiter({ perMinute: limits.eventsPerMinute }, config.now);
  const finishLimited = makeLimiter({ perMinute: limits.finishPerMinute }, config.now);
  const finishing = new Set<string>();
  let eventBytes: Array<[number, number]> = [];
  const overHourlyBudget = (n: number): boolean => {
    const now = config.now();
    eventBytes = eventBytes.filter(([t]) => now - t < 3_600_000);
    if (eventBytes.reduce((a, [, b]) => a + b, 0) + n > limits.eventBytesPerHour) return true;
    eventBytes.push([now, n]);
    return false;
  };

  /** A browser origin must be allow-listed; no Origin is accepted only from a direct loopback request (local dev). */
  const originOk = (req: Request): boolean => originAllowed(config, req);
  const forbidOrigin = (res: Response): void => reply(res, 403, { ok: false, error: 'origin_not_allowed' });
  const limited = (res: Response): void => reply(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });
  const denied = (res: Response, auth: Extract<AuthResult, { ok: false }>): void =>
    auth.reason === 'forbidden' ? reply(res, 403, { ok: false, error: 'forbidden' }) : reply(res, 401, { ok: false, error: 'unauthorized' });

  app.post('/api/agent/sessions', async (req, res) => {
    if (!originOk(req)) { forbidOrigin(res); return; }
    if (sessionsLimited(clientIp(req))) { limited(res); return; }
    try { reply(res, 201, await store.issue()); }
    catch { config.log({ level: 'error', msg: 'agent session store write failed' }); reply(res, 503, { ok: false, error: 'session_store_unavailable' }); }
  });

  app.get('/api/agent/elevenlabs/signed-url', async (req, res) => {
    if (!originOk(req)) { forbidOrigin(res); return; }
    // Learn and Review talk to the interviewer, Teach to the tutor: each role has its own agent, voice and prompt.
    const role = req.query.role === undefined ? 'interviewer' : req.query.role;
    if (role !== 'interviewer' && role !== 'tutor') { reply(res, 400, { ok: false, error: 'invalid_role' }); return; }
    const agentId = role === 'tutor' ? config.tutorAgentId : config.interviewerAgentId;
    const agentEnv = role === 'tutor' ? 'ELEVENLABS_AGENT_ID_TUTOR' : 'ELEVENLABS_AGENT_ID_INTERVIEWER';
    if (!agentId || !config.elevenLabsApiKey) {
      reply(res, 503, { ok: false, error: 'elevenlabs_not_configured', missing: [!agentId && agentEnv, !config.elevenLabsApiKey && 'ELEVENLABS_API_KEY'].filter(Boolean) });
      return;
    }
    if (signedUrlLimited(clientIp(req))) { limited(res); return; }
    // A session token is required by default (SIGNED_URL_REQUIRE_SESSION=0 opts out); even when opted out, a token
    // that is sent must still be valid.
    const header = req.get('Authorization');
    if (config.signedUrlRequiresSession || header !== undefined) {
      const auth = store.check(header, null);
      if (!auth.ok) { denied(res, auth); return; }
    }
    try {
      const r = await eleven.signedUrl(agentId);
      if (r.signedUrl) reply(res, 200, { signed_url: r.signedUrl });
      else reply(res, 502, { ok: false, error: 'elevenlabs_error', upstream_status: r.status });
    } catch { reply(res, 502, { ok: false, error: 'elevenlabs_unreachable' }); }
  });

  /** Shared gate for /events and /finish: origin, rate limit, id format, session token. Returns the id or null after replying. */
  const gate = (req: Request, res: Response, limiter: (ip: string) => boolean): string | null => {
    if (!originOk(req)) { forbidOrigin(res); return null; }
    if (limiter(clientIp(req))) { limited(res); return null; }
    const id = String(req.params.id);
    if (!SESSION_ID.test(id)) { reply(res, 400, { ok: false, error: 'invalid_session_id' }); return null; }
    const auth = store.check(req.get('Authorization'), id);
    if (!auth.ok) { denied(res, auth); return null; }
    return id;
  };

  app.post('/api/agent/sessions/:id/events', async (req, res) => {
    const id = gate(req, res, eventsLimited);
    if (id === null) return;
    const raw = await readBody(req, limits.eventsBodyBytes);
    if (!raw.ok) { reply(res, raw.status, { ok: false, error: raw.error, max_bytes: raw.maxBytes }); return; }
    const p = parseEvents(raw.body);
    if (!p.ok) { reply(res, 400, { ok: false, error: p.error, field: p.field }); return; }
    if (p.conversationId && !(await files.bindConversation(id, p.conversationId))) { reply(res, 409, { ok: false, error: 'conversation_mismatch' }); return; }
    const receivedAt = config.now();
    const lines = p.events.map((e) => JSON.stringify({ t: e.t, dir: e.dir, type: e.type, text: e.text, conversationId: p.conversationId ?? null, receivedAt })).join('\n') + '\n';
    const bytes = Buffer.byteLength(lines);
    // 507, not 413: the request was fine, this session has no room left. It is checked before the global
    // hourly budget so that a full session cannot drain the budget of other sessions.
    if ((await files.eventsSize(id)) + bytes > limits.sessionFileBytes) { reply(res, 507, { ok: false, error: 'session_full', max_bytes: limits.sessionFileBytes }); return; }
    if (overHourlyBudget(bytes)) {
      config.log({ level: 'warn', msg: 'events hourly byte cap reached' });
      reply(res, 429, { ok: false, error: 'hourly_byte_cap', max_bytes_per_hour: limits.eventBytesPerHour }, { 'Retry-After': '300' });
      return;
    }
    await files.appendEvents(id, lines);
    reply(res, 200, { ok: true, stored: p.events.length });
    rt.maintenance.afterWrite();
  });

  // finish answers within ~20 s once a transcript is stored (partial if ElevenLabs is still processing);
  // the finished transcript and the audio follow in the background.
  app.post('/api/agent/sessions/:id/finish', async (req, res) => {
    const id = gate(req, res, finishLimited);
    if (id === null) return;
    const raw = await readBody(req, limits.finishBodyBytes);
    if (!raw.ok) { reply(res, raw.status, { ok: false, error: raw.error, max_bytes: raw.maxBytes }); return; }
    const conversationId = isRecord(raw.body) ? raw.body.conversationId : undefined;
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) { reply(res, 400, { ok: false, error: 'invalid_body', field: 'conversationId' }); return; }
    if (!config.elevenLabsApiKey || config.agentIds.size === 0) { reply(res, 503, { ok: false, error: 'elevenlabs_not_configured' }); return; }
    const bound = await files.boundConversation(id);
    if (bound && bound !== conversationId) { reply(res, 409, { ok: false, error: 'conversation_mismatch' }); return; }
    const existing = await files.readTranscript(id);
    if (isRecord(existing) && existing.status === 'done' && (await files.hasAudio(id))) {
      reply(res, 200, { ok: true, transcriptStored: true, partial: false, audioStored: true, already: true });
      return;
    }
    if (finishing.has(id)) { reply(res, 409, { ok: false, error: 'finish_in_progress' }); return; }
    finishing.add(id);
    let handedOff = false;
    try {
      const deadline = config.now() + config.timing.finishWaitMs;
      let g: ConversationResult;
      for (;;) {
        g = await eleven.getConversation(conversationId);
        if (g.conv) {
          const agentId = g.conv.agent_id;
          if (typeof agentId !== 'string' || !config.agentIds.has(agentId)) { reply(res, 422, { ok: false, error: 'agent_not_allowed' }); return; }
          if (g.conv.status === 'done' || g.conv.status === 'failed') break;
        } else if (typeof g.status === 'number' && g.status < 500 && g.status !== 429) break;
        if (config.now() + config.timing.finishRetryMs > deadline) break;
        await sleep(config.timing.finishRetryMs);
      }
      if (!g.conv) { reply(res, 502, { ok: false, error: 'conversation_unavailable', transcriptStatus: g.status, transcriptStored: false, audioStored: false }); return; }
      if (!(await files.bindConversation(id, conversationId))) { reply(res, 409, { ok: false, error: 'conversation_mismatch' }); return; }
      await files.storeTranscript(id, g.conv);
      rt.maintenance.afterWrite();
      const partial = !(g.conv.status === 'done' || g.conv.status === 'failed');
      reply(res, 200, { ok: true, transcriptStored: true, partial, conversationStatus: g.conv.status ?? null, audioStored: false, audioPending: true });
      handedOff = true;
      const job: Promise<void> = eleven.finishInBackground(id, conversationId, partial).finally(() => { finishing.delete(id); rt.background.delete(job); });
      rt.background.add(job);
    } finally {
      if (!handedOff) finishing.delete(id);
    }
  });
}
