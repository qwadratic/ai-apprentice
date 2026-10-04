// HTTP face of the conductor (doc-12): POST events in, Server-Sent Events out. Same origin and token rules as the
// other /api/agent routes; the token is only ever read from the Authorization header.
// One conductor per session serves every face of it: the macOS app hands over to the web with a short-lived join code,
// and the web app's own session is then linked to the same conductor.
import { randomInt, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { clientIp, isRecord, makeLimiter } from '../config.ts';
import { runLlmTask } from '../llm.ts';
import { originAllowed, readBody, reply } from '../routes.ts';
import type { AgentRuntime } from '../routes.ts';
import { SESSION_ID } from '../sessions.ts';
import { Conductor, MapRegistry } from './engine.ts';
import { parseBatch, parseObservation } from './protocol.ts';
import type { ClientKind } from './protocol.ts';

const EVENTS_BODY_BYTES = 64 * 1024;
const MAX_STREAMS_PER_SESSION = 3;
const KEEPALIVE_MS = 15_000;
/** The clock that drives pauses and deadlines: short, so a pause or a pending action is acted on quickly. */
const TICK_MS = 200;
/** A conductor with no event, observation or open stream for this long is dropped. */
const IDLE_DROP_MS = 2 * 60 * 60_000;
const JOIN_CODE_TTL_MS = 5 * 60_000;
/** No 0/O, 1/I/L: a code read aloud or typed by hand stays unambiguous. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface ConductorHub {
  /** The conductor that serves this session id: its own, or the one it is linked to. */
  forSession(sessionId: string): Conductor;
  /** For the screen module: feeds an observation of this session to its conductor, if one exists. */
  observe(sessionId: string, observation: unknown): void;
  /** Mints a single-use code that links another session to `target`'s conductor. */
  joinCode(target: string): string;
  /** Links `sessionId` to the conductor named by `code`; false for an unknown, used or expired code. */
  link(sessionId: string, code: string): boolean;
  close(): void;
}

export function createConductorHub(rt: AgentRuntime): ConductorHub {
  const { config } = rt;
  const maps = new MapRegistry();
  const conductors = new Map<string, Conductor>();
  const links = new Map<string, string>();
  const codes = new Map<string, { target: string; expiresAt: number }>();
  // The conductor's own LLM budget: one call at a time across all sessions, so the runner keeps a slot for vision.
  let busy: Promise<unknown> = Promise.resolve();
  const llm = (task: string, body: unknown, signal: AbortSignal) => {
    const run = busy.then(() => (signal.aborted ? { ok: false as const, error: 'aborted' as const } : runLlmTask(config, task, body, signal)));
    busy = run.catch(() => undefined);
    return run;
  };
  const hub: ConductorHub = {
    forSession(sessionId) {
      const id = links.get(sessionId) ?? sessionId;
      let c = conductors.get(id);
      if (!c) {
        c = new Conductor(id, {
          now: config.now, llm, newId: randomUUID, maps,
          webLink: (page) => {
            const url = new URL(config.publicWebUrl);
            url.searchParams.set('join', hub.joinCode(id));
            url.searchParams.set('page', page);
            return url.toString();
          },
        });
        conductors.set(id, c);
      }
      return c;
    },
    observe(sessionId, observation) {
      const c = conductors.get(links.get(sessionId) ?? sessionId);
      const o = parseObservation(observation);
      if (c && o.ok) { c.onObservation(o.value); c.tick(); }
    },
    joinCode(target) {
      const now = config.now();
      for (const [code, entry] of codes) if (entry.expiresAt < now) codes.delete(code);
      let code = '';
      do { code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (codes.has(code));
      codes.set(code, { target, expiresAt: now + JOIN_CODE_TTL_MS });
      return code;
    },
    link(sessionId, code) {
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.expiresAt < config.now() || entry.target === sessionId) return false;
      links.set(sessionId, entry.target);
      return true;
    },
    close() { clearInterval(timer); },
  };
  const timer = setInterval(() => {
    const now = config.now();
    for (const [id, c] of conductors) {
      if (c.listenerCount() === 0 && now - c.lastSeenAt > IDLE_DROP_MS) {
        conductors.delete(id);
        for (const [from, to] of links) if (to === id) links.delete(from);
        continue;
      }
      try { c.tick(); } catch (err) { config.log({ level: 'warn', msg: 'conductor tick failed', error: err instanceof Error ? err.name : 'unknown' }); }
    }
  }, TICK_MS);
  timer.unref?.();
  return hub;
}

export function registerConductorRoutes(app: Express, rt: AgentRuntime, hub: ConductorHub): void {
  const { config, store } = rt;
  const eventsLimited = makeLimiter({ perMinute: 600 }, config.now);
  const statusLimited = makeLimiter({ perMinute: 60 }, config.now);
  const streamsLimited = makeLimiter({ perMinute: 30 }, config.now);
  const linkLimited = makeLimiter({ perMinute: 10 }, config.now);
  const streams = new Map<string, number>();

  const gate = (req: Request, res: Response, limited: (ip: string) => boolean): string | null => {
    if (!originAllowed(config, req)) { reply(res, 403, { ok: false, error: 'origin_not_allowed' }); return null; }
    if (limited(clientIp(req))) { reply(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' }); return null; }
    const id = String(req.params.id);
    if (!SESSION_ID.test(id)) { reply(res, 400, { ok: false, error: 'invalid_session_id' }); return null; }
    if (!store.check(req.get('Authorization'), id).ok) { reply(res, 401, { ok: false, error: 'unauthorized' }); return null; }
    return id;
  };

  // Authenticated diagnostics expose selector identity and bounded evidence without transcript text.
  app.get('/api/agent/conductor/:id/status', (req, res) => {
    const id = gate(req, res, statusLimited);
    if (id === null) return;
    reply(res, 200, { ok: true, status: hub.forSession(id).status() }, { 'Cache-Control': 'no-store' });
  });

  app.post('/api/agent/conductor/:id/events', async (req, res) => {
    const id = gate(req, res, eventsLimited);
    if (id === null) return;
    const raw = await readBody(req, EVENTS_BODY_BYTES);
    if (!raw.ok) { reply(res, raw.status, { ok: false, error: raw.error, max_bytes: raw.maxBytes }); return; }
    const batch = parseBatch(raw.body);
    if (!batch.ok) { reply(res, 400, { ok: false, error: 'invalid_events', field: batch.field }); return; }
    const conductor = hub.forSession(id);
    conductor.handle(batch.value, id);
    reply(res, 200, { ok: true, lastEventSeq: conductor.lastEventSeq(id), lastCueSeq: conductor.lastSeq() });
  });

  // The web app opened from a macOS hand-over: `{code}` links this (new) session to the macOS session's conductor.
  app.post('/api/agent/conductor/:id/link', async (req, res) => {
    const id = gate(req, res, linkLimited);
    if (id === null) return;
    const raw = await readBody(req, 1024);
    if (!raw.ok) { reply(res, raw.status, { ok: false, error: raw.error }); return; }
    const code = isRecord(raw.body) && typeof raw.body.code === 'string' ? raw.body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{8}$/.test(code) || !hub.link(id, code)) { reply(res, 404, { ok: false, error: 'invalid_code' }); return; }
    reply(res, 200, { ok: true });
  });

  app.get('/api/agent/conductor/:id/cues', (req, res) => {
    const id = gate(req, res, streamsLimited);
    if (id === null) return;
    const open = streams.get(id) ?? 0;
    if (open >= MAX_STREAMS_PER_SESSION) { reply(res, 429, { ok: false, error: 'too_many_streams' }, { 'Retry-After': '5' }); return; }
    const afterRaw = Number(req.query.after ?? -1);
    const after = Number.isInteger(afterRaw) && afterRaw >= -1 ? afterRaw : -1;
    const conductor = hub.forSession(id);
    const asked = req.query.client;
    // Which face reads this stream: its hello says so; `?client=` covers a stream opened before the hello.
    const client: ClientKind | null = asked === 'web' || asked === 'macos' ? asked : conductor.clientOf(id);
    streams.set(id, open + 1);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const forMe = (cue: { for: string }): boolean => {
      const kind = client ?? conductor.clientOf(id);
      return kind === null || cue.for === 'all' || cue.for === kind;
    };
    const write = (cue: { seq: number; for: string }): void => { if (forMe(cue)) res.write(`id: ${cue.seq}\nevent: cue\ndata: ${JSON.stringify(cue)}\n\n`); };
    res.write(`event: hello\ndata: ${JSON.stringify({ sessionId: id, lastCueSeq: conductor.lastSeq(), serverNowMs: config.now() })}\n\n`);
    for (const cue of conductor.cuesAfter(after)) write(cue);
    const unsubscribe = conductor.subscribe(write);
    const keepalive = setInterval(() => { res.write(': ping\n\n'); }, KEEPALIVE_MS);
    keepalive.unref?.();
    res.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      const n = (streams.get(id) ?? 1) - 1;
      if (n <= 0) streams.delete(id); else streams.set(id, n);
    });
  });
}
