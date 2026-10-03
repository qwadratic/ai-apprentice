// Placeholder public API on 0.0.0.0:8000 (dependency-free TypeScript, run with
// Node's built-in type stripping: node server.ts). Serves /health,
// exact-origin CORS, a 12 MB body cap, a token-protected /runner/* test proxy
// and, with DEBUG_ENDPOINTS=1, /debug/sse; plus the ElevenLabs signed URL and
// session log storage for stream B. Replaced by apps/api once it exists.
import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
type SessionEvent = { t: number; dir: string; type: string; text: string };
type SessionInfo = { id: string; size: number; mtime: number; hasEvents: boolean; hasTranscript: boolean; hasAudio: boolean };
type ParsedEvents =
  | { ok: false; error: string; field?: string }
  | { ok: true; conversationId: string | undefined; events: SessionEvent[] };
type ConversationResult = { status: number | 'unreachable'; conv?: Json };
type AudioResult = { status: number | string; type?: string; ext?: string; bytes?: number };

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const errCode = (e: unknown): unknown => (isRecord(e) ? e.code : undefined);
class TooLarge extends Error {}

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const RUNNER_URL = new URL(process.env.RUNNER_URL || 'http://127.0.0.1:8787');
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const API_TOKEN = process.env.API_TOKEN || '';
const GIT_SHA = process.env.GIT_SHA || 'unknown'; // the code this process runs
const DEPLOYED_SHA_FILE = process.env.DEPLOYED_SHA_FILE || '/var/lib/apprentice/deployed-sha'; // written by deploy.sh
const DEBUG = process.env.DEBUG_ENDPOINTS === '1';
const MAX_BODY = 12 * 1024 * 1024;
const EL_AGENT_ID = process.env.ELEVENLABS_AGENT_ID_INTERVIEWER || '';
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
// Agents whose conversations /finish may store.
const EL_AGENT_IDS = new Set([process.env.ELEVENLABS_AGENT_ID_INTERVIEWER, process.env.ELEVENLABS_AGENT_ID_TUTOR].filter((v): v is string => !!v));
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/var/lib/apprentice/sessions';
const SESSION_EVENTS_MAX_BODY = 512 * 1024; // the page counts UTF-16 chars, not bytes
const SESSION_FILE_MAX = 5 * 1024 * 1024; // one session's .jsonl
const EVENTS_BYTES_PER_HOUR = Number(process.env.EVENTS_BYTES_PER_HOUR || 50 * 1024 * 1024); // all sessions together
const SESSIONS_MIN_AGE_MS = 24 * 3_600_000; // rotation never deletes newer sessions
const AUDIO_MAX = 50 * 1024 * 1024;
const SESSIONS_WARN_BYTES = Number(process.env.SESSIONS_WARN_BYTES || 1024 ** 3); // 1 GiB: warn in logs and listings
const SESSIONS_ROTATE_BYTES = Number(process.env.SESSIONS_ROTATE_BYTES || 2 * 1024 ** 3); // 2 GiB: delete oldest sessions
const SESSIONS_ROTATE_TARGET = 0.75 * SESSIONS_ROTATE_BYTES;
const ALLOWED = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

function log(fields: Json): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function send(res: ServerResponse, status: number, body: unknown): number {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return buf.length;
}

function bearerOk(req: IncomingMessage, token: string): boolean {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!given || token.length < 32) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > max) return reject(new TooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.resume();
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req: IncomingMessage): string {
  // exe.dev appends the client IP as seen by its proxy as the last entry.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? (req.socket.remoteAddress || 'unknown');
}

// Sliding-window limiter: perMinute per client IP and perHour overall (0 = none).
function makeLimiter(perMinute: number, perHour: number): (ip: string) => boolean {
  const perIp = new Map<string, number[]>(); // ip -> timestamps (ms) within the last minute
  let globalHits: number[] = []; // timestamps within the last hour
  return function limited(ip: string): boolean {
    const now = Date.now();
    if (perHour) globalHits = globalHits.filter((t) => now - t < 3_600_000);
    const mine = (perIp.get(ip) || []).filter((t) => now - t < 60_000);
    if (mine.length >= perMinute || (perHour && globalHits.length >= perHour)) {
      perIp.set(ip, mine);
      return true;
    }
    mine.push(now);
    perIp.set(ip, mine);
    if (perHour) globalHits.push(now);
    if (perIp.size > 10_000) {
      for (const [k, v] of perIp) {
        const last = v.at(-1);
        if (last === undefined || now - last >= 60_000) perIp.delete(k);
      }
    }
    return false;
  };
}
const signedUrlLimited = makeLimiter(6, 60);
const eventsLimited = makeLimiter(120, 0);
const finishLimited = makeLimiter(6, 0);

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !!origin && ALLOWED.has(origin);
}

// ---- session storage ------------------------------------------------------
// Files per session in SESSIONS_DIR: {id}.jsonl (events), {id}.conv (the
// conversationId the session is bound to), {id}.elevenlabs.json (conversation
// from ElevenLabs), {id}.{mp3,wav,...} (conversation audio).
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_DIRS = new Set<string>(['sent', 'recv', 'sys', 'err']);
const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
};
const AUDIO_EXTS = [...new Set(Object.values(AUDIO_EXT))];
const SESSION_FILE = new RegExp(`^([A-Za-z0-9-]{8,64})\\.(jsonl|conv|elevenlabs\\.json|${AUDIO_EXTS.join('|')})$`);
const sessionFile = (id: string, ext: string): string => join(SESSIONS_DIR, `${id}.${ext}`);

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o640 });
  await fsp.rename(tmp, path);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return 0;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function findAudio(id: string): Promise<{ ext: string; size: number } | null> {
  for (const ext of AUDIO_EXTS) {
    const size = await fileSize(sessionFile(id, ext));
    if (size) return { ext, size };
  }
  return null;
}

// A session is bound to the first conversationId it reports (events or
// finish). Returns false when it is already bound to a different one.
async function bindConversation(id: string, conversationId: string): Promise<boolean> {
  const path = sessionFile(id, 'conv');
  try {
    await fsp.writeFile(path, conversationId, { flag: 'wx', mode: 0o640 });
    return true;
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
    return (await fsp.readFile(path, 'utf8')).trim() === conversationId;
  }
}
async function boundConversation(id: string): Promise<string | null> {
  try {
    return (await fsp.readFile(sessionFile(id, 'conv'), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function listSessions(): Promise<{ sessions: SessionInfo[]; total: number; tmp: string[] }> {
  const byId = new Map<string, SessionInfo>();
  let total = 0;
  const tmp: string[] = [];
  for (const name of await fsp.readdir(SESSIONS_DIR)) {
    if (name.endsWith('.tmp')) {
      tmp.push(name);
      continue;
    }
    const m = SESSION_FILE.exec(name);
    const id = m?.[1];
    const kind = m?.[2];
    if (!id || !kind) continue;
    const st = await fsp.stat(join(SESSIONS_DIR, name));
    total += st.size;
    const s = byId.get(id) || { id, size: 0, mtime: 0, hasEvents: false, hasTranscript: false, hasAudio: false };
    s.size += st.size;
    s.mtime = Math.max(s.mtime, st.mtimeMs);
    if (kind === 'jsonl') s.hasEvents = true;
    if (kind === 'elevenlabs.json') s.hasTranscript = true;
    if (AUDIO_EXTS.includes(kind)) s.hasAudio = true;
    byId.set(id, s);
  }
  const sessions = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
  return { sessions, total, tmp };
}

async function deleteSession(id: string): Promise<void> {
  for (const ext of ['jsonl', 'conv', 'elevenlabs.json', ...AUDIO_EXTS]) await fsp.rm(sessionFile(id, ext), { force: true });
}

// Rotation, at most once a minute after a write: removes orphaned *.tmp files
// older than 10 min, warns above SESSIONS_WARN_BYTES, and above
// SESSIONS_ROTATE_BYTES deletes the oldest sessions that are older than 24 h.
// Recent sessions are never deleted; if they alone exceed the cap it only warns.
let lastRotateCheck = 0;
async function maybeRotate(): Promise<void> {
  const now = Date.now();
  if (now - lastRotateCheck < 60_000) return;
  lastRotateCheck = now;
  try {
    const { sessions, total, tmp } = await listSessions();
    let orphans = 0;
    for (const name of tmp) {
      const path = join(SESSIONS_DIR, name);
      const st = await fsp.stat(path).catch(() => null);
      if (st && now - st.mtimeMs > 10 * 60_000) {
        await fsp.rm(path, { force: true });
        orphans++;
      }
    }
    if (orphans) log({ level: 'warn', msg: 'sessions orphaned tmp files removed', count: orphans });
    if (total > SESSIONS_WARN_BYTES) log({ level: 'warn', msg: 'sessions dir over warn threshold', bytes: total, warn_bytes: SESSIONS_WARN_BYTES });
    if (total <= SESSIONS_ROTATE_BYTES) return;
    let left = total;
    let removed = 0;
    for (const s of [...sessions].reverse()) {
      if (left <= SESSIONS_ROTATE_TARGET) break;
      if (now - s.mtime < SESSIONS_MIN_AGE_MS) break; // oldest-first, so the rest are newer
      await deleteSession(s.id);
      left -= s.size;
      removed++;
    }
    log({ level: 'warn', msg: 'sessions rotated', removed, bytes_before: total, bytes_after: left });
    if (left > SESSIONS_ROTATE_BYTES) log({ level: 'warn', msg: 'sessions over cap but all remaining are newer than 24 h; nothing deleted', bytes: left });
  } catch {
    log({ level: 'error', msg: 'sessions rotation failed' });
  }
}

// Global byte budget for /events per hour.
let eventBytes: Array<[number, number]> = []; // [time, bytes]
function eventBytesOverBudget(n: number): boolean {
  const now = Date.now();
  eventBytes = eventBytes.filter(([t]) => now - t < 3_600_000);
  const used = eventBytes.reduce((a, [, b]) => a + b, 0);
  if (used + n > EVENTS_BYTES_PER_HOUR) return true;
  eventBytes.push([now, n]);
  return false;
}

function parseEvents(raw: Buffer): ParsedEvents {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!isRecord(body) || !Array.isArray(body.events) || body.events.length === 0) return { ok: false, error: 'invalid_body', field: 'events' };
  const conversationId = body.conversationId;
  if (conversationId !== undefined && (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId))) {
    return { ok: false, error: 'invalid_body', field: 'conversationId' };
  }
  const events: SessionEvent[] = [];
  for (const [i, e] of (body.events as unknown[]).entries()) {
    if (!isRecord(e)) return { ok: false, error: 'invalid_body', field: `events.${i}` };
    const { t, dir, type, text } = e;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof dir !== 'string' || !EVENT_DIRS.has(dir) || typeof type !== 'string' || typeof text !== 'string') {
      return { ok: false, error: 'invalid_body', field: `events.${i}` };
    }
    events.push({ t, dir, type, text });
  }
  return { ok: true, conversationId, events };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- ElevenLabs conversation fetch ----------------------------------------
const elBase = (conversationId: string): string => `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`;

async function getConversation(conversationId: string): Promise<ConversationResult> {
  try {
    const r = await fetch(elBase(conversationId), { headers: { 'xi-api-key': EL_KEY }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) {
      await r.arrayBuffer().catch(() => {});
      return { status: r.status };
    }
    const conv: unknown = await r.json();
    return isRecord(conv) ? { status: r.status, conv } : { status: r.status };
  } catch {
    return { status: 'unreachable' };
  }
}

// Stores a transcript unless a finished ('done') one is already there: a
// partial transcript may be replaced by the finished one, nothing else.
async function storeTranscript(id: string, conv: Json): Promise<boolean> {
  const existing = await readJson(sessionFile(id, 'elevenlabs.json'));
  if (isRecord(existing) && existing.status === 'done') return false;
  await writeAtomic(sessionFile(id, 'elevenlabs.json'), JSON.stringify(conv));
  return true;
}

// Downloads the audio once (never overwrites), capped at AUDIO_MAX bytes,
// with the extension taken from the content type.
async function storeAudio(id: string, conversationId: string): Promise<AudioResult> {
  if (await findAudio(id)) return { status: 'exists' };
  const r = await fetch(`${elBase(conversationId)}/audio`, { headers: { 'xi-api-key': EL_KEY }, signal: AbortSignal.timeout(60_000) });
  const type = ((r.headers.get('content-type') || '').split(';')[0] ?? '').trim().toLowerCase();
  const ext = AUDIO_EXT[type];
  if (!r.ok || !ext || !r.body) {
    await r.arrayBuffer().catch(() => {});
    return { status: r.status, type };
  }
  if (Number(r.headers.get('content-length') || 0) > AUDIO_MAX) {
    await r.body?.cancel().catch(() => {});
    return { status: 'too_large' };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > AUDIO_MAX) return { status: 'too_large' };
    chunks.push(c);
  }
  const path = sessionFile(id, ext);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, Buffer.concat(chunks), { mode: 0o640 });
  try {
    await fsp.link(tmp, path); // fails if the file appeared meanwhile: never overwrite
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  return { status: r.status, ext, bytes: size };
}

// After /finish has answered: wait (up to 5 min) for a finished transcript if
// only a partial one was stored, then fetch the audio. Logs statuses only.
async function finishInBackground(id: string, conversationId: string, partial: boolean): Promise<void> {
  const t0 = Date.now();
  let conversationStatus: unknown = null;
  try {
    while (partial && Date.now() - t0 < 5 * 60_000) {
      await sleep(5000);
      const g = await getConversation(conversationId);
      if (g.conv) {
        conversationStatus = g.conv.status ?? null;
        if (g.conv.status === 'done' || g.conv.status === 'failed') {
          await storeTranscript(id, g.conv);
          partial = false;
        }
      } else if (typeof g.status === 'number' && g.status < 500 && g.status !== 429) {
        break;
      }
    }
    const a = await storeAudio(id, conversationId);
    log({ level: 'info', msg: 'finish background done', session: id, partial, conversation_status: conversationStatus, audio_status: a.status, audio_bytes: a.bytes ?? 0, ms: Date.now() - t0 });
  } catch {
    log({ level: 'error', msg: 'finish background failed', session: id, ms: Date.now() - t0 });
  } finally {
    finishing.delete(id);
  }
}
const finishing = new Set<string>(); // sessions with a finish in progress

async function elevenLabsSignedUrl(): Promise<{ status: number; signed_url?: string }> {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(EL_AGENT_ID)}`;
  const r = await fetch(url, { headers: { 'xi-api-key': EL_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { status: r.status };
  const j: unknown = await r.json();
  const signedUrl = isRecord(j) ? j.signed_url : undefined;
  return { status: r.status, signed_url: typeof signedUrl === 'string' ? signedUrl : undefined };
}

function runnerRequest(method: string, path: string, body: Buffer | null, rid: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { 'x-request-id': rid };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
      headers.authorization = `Bearer ${RUNNER_TOKEN}`;
    }
    const r = http.request(
      { host: RUNNER_URL.hostname, port: RUNNER_URL.port, method, path, headers, timeout: 90_000 },
      (rr) => {
        const chunks: Buffer[] = [];
        rr.on('data', (c: Buffer) => chunks.push(c));
        rr.on('end', () => resolve({ status: rr.statusCode || 502, body: Buffer.concat(chunks) }));
        rr.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.end(body);
    else r.end();
  });
}

// The last commit deploy.sh deployed; it can be newer than GIT_SHA when that
// deploy did not touch the API and so did not restart it.
async function deployedSha(): Promise<string | null> {
  try {
    return (await fsp.readFile(DEPLOYED_SHA_FILE, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function runnerUp(rid: string): Promise<'up' | 'down'> {
  try {
    const r = await runnerRequest('GET', '/health', null, rid);
    return r.status === 200 ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

const server = http.createServer(async (req, res) => {
  const rid = randomUUID();
  const started = Date.now();
  const route = (req.url || '/').split('?')[0] ?? '/';
  const meta: Json = { rid, method: req.method, route };
  let status = 500;
  let resBytes = 0;
  try {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      status = 204;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && route === '/health') {
      status = 200;
      resBytes = send(res, 200, { ok: true, runner: await runnerUp(rid), git_sha: GIT_SHA, deployed_sha: await deployedSha() });
      return;
    }
    if (req.method === 'GET' && route === '/agent/elevenlabs/signed-url') {
      // Browser route: no token, but only for allowed origins. Never log the URL or key.
      const origin = req.headers.origin;
      if (!origin || !ALLOWED.has(origin)) {
        status = 403;
        resBytes = send(res, 403, { ok: false, error: 'origin_not_allowed' });
        return;
      }
      if (!EL_AGENT_ID || !EL_KEY) {
        status = 503;
        resBytes = send(res, 503, { ok: false, error: 'elevenlabs_not_configured', missing: [!EL_AGENT_ID && 'ELEVENLABS_AGENT_ID_INTERVIEWER', !EL_KEY && 'ELEVENLABS_API_KEY'].filter(Boolean) });
        return;
      }
      if (signedUrlLimited(clientIp(req))) {
        status = 429;
        res.setHeader('Retry-After', '60');
        resBytes = send(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      try {
        const r = await elevenLabsSignedUrl();
        meta.upstream = r.status;
        if (r.signed_url) {
          status = 200;
          resBytes = send(res, 200, { signed_url: r.signed_url });
        } else {
          status = 502;
          resBytes = send(res, 502, { ok: false, error: 'elevenlabs_error', upstream_status: r.status });
        }
      } catch {
        status = 502;
        resBytes = send(res, 502, { ok: false, error: 'elevenlabs_unreachable' });
      }
      return;
    }
    const sessionRoute = /^\/agent\/sessions(?:\/([^/]+)(?:\/(events|finish))?)?$/.exec(route);
    if (sessionRoute) {
      // Bodies, transcripts, audio and keys are never logged.
      const sessionId = sessionRoute[1];
      const action = sessionRoute[2];
      if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        status = 400;
        resBytes = send(res, 400, { ok: false, error: 'invalid_session_id' });
        return;
      }
      if (action !== undefined && sessionId !== undefined) {
        // Browser routes: origin check instead of a token.
        if (req.method !== 'POST') {
          status = 405;
          resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        if (!originAllowed(req)) {
          status = 403;
          req.resume();
          resBytes = send(res, 403, { ok: false, error: 'origin_not_allowed' });
          return;
        }
        if ((action === 'events' ? eventsLimited : finishLimited)(clientIp(req))) {
          status = 429;
          req.resume();
          res.setHeader('Retry-After', '60');
          resBytes = send(res, 429, { ok: false, error: 'rate_limited' });
          return;
        }
        const maxBody = action === 'events' ? SESSION_EVENTS_MAX_BODY : 4096;
        let raw: Buffer;
        try {
          raw = await readBody(req, maxBody);
        } catch (e) {
          if (e instanceof TooLarge) {
            status = 413;
            resBytes = send(res, 413, { ok: false, error: 'body_too_large', max_bytes: maxBody });
            res.on('finish', () => req.destroy());
            return;
          }
          throw e;
        }
        meta.req_bytes = raw.length;
        if (action === 'events') {
          const p = parseEvents(raw);
          if (!p.ok) {
            status = 400;
            resBytes = send(res, 400, { ok: false, error: p.error, field: p.field });
            return;
          }
          if (p.conversationId && !(await bindConversation(sessionId, p.conversationId))) {
            status = 409;
            resBytes = send(res, 409, { ok: false, error: 'conversation_mismatch' });
            return;
          }
          const receivedAt = Date.now();
          const lines = p.events
            .map((e) => JSON.stringify({ t: e.t, dir: e.dir, type: e.type, text: e.text, conversationId: p.conversationId ?? null, receivedAt }))
            .join('\n') + '\n';
          const bytes = Buffer.byteLength(lines);
          const path = sessionFile(sessionId, 'jsonl');
          if ((await fileSize(path)) + bytes > SESSION_FILE_MAX) {
            // 507, not 413: the request was fine, this session has no room left.
            status = 507;
            resBytes = send(res, 507, { ok: false, error: 'session_full', max_bytes: SESSION_FILE_MAX });
            return;
          }
          if (eventBytesOverBudget(bytes)) {
            status = 429;
            res.setHeader('Retry-After', '300');
            resBytes = send(res, 429, { ok: false, error: 'hourly_byte_cap', max_bytes_per_hour: EVENTS_BYTES_PER_HOUR });
            log({ level: 'warn', msg: 'events hourly byte cap reached' });
            return;
          }
          await fsp.appendFile(path, lines, { mode: 0o640 });
          meta.stored = p.events.length;
          status = 200;
          resBytes = send(res, 200, { ok: true, stored: p.events.length });
          void maybeRotate();
          return;
        }
        // finish: answers within ~20 s once a transcript is stored (partial if
        // ElevenLabs is still processing); the finished transcript and the
        // audio follow in the background. The lab page gives up at 30 s.
        let conversationId: unknown;
        try {
          const parsed: unknown = JSON.parse(raw.toString('utf8'));
          conversationId = isRecord(parsed) ? parsed.conversationId : undefined;
        } catch {
          status = 400;
          resBytes = send(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
          status = 400;
          resBytes = send(res, 400, { ok: false, error: 'invalid_body', field: 'conversationId' });
          return;
        }
        if (!EL_KEY || EL_AGENT_IDS.size === 0) {
          status = 503;
          resBytes = send(res, 503, { ok: false, error: 'elevenlabs_not_configured' });
          return;
        }
        const bound = await boundConversation(sessionId);
        if (bound && bound !== conversationId) {
          status = 409;
          resBytes = send(res, 409, { ok: false, error: 'conversation_mismatch' });
          return;
        }
        const existing = await readJson(sessionFile(sessionId, 'elevenlabs.json'));
        if (isRecord(existing) && existing.status === 'done' && (await findAudio(sessionId))) {
          status = 200;
          resBytes = send(res, 200, { ok: true, transcriptStored: true, partial: false, audioStored: true, already: true });
          return;
        }
        if (finishing.has(sessionId)) {
          status = 409;
          resBytes = send(res, 409, { ok: false, error: 'finish_in_progress' });
          return;
        }
        finishing.add(sessionId);
        let handedOff = false;
        try {
          const deadline = Date.now() + 18_000;
          let g: ConversationResult;
          for (;;) {
            g = await getConversation(conversationId);
            meta.transcript_status = g.status;
            if (g.conv) {
              const agentId = g.conv.agent_id;
              if (typeof agentId !== 'string' || !EL_AGENT_IDS.has(agentId)) {
                status = 422;
                resBytes = send(res, 422, { ok: false, error: 'agent_not_allowed' });
                return;
              }
              if (g.conv.status === 'done' || g.conv.status === 'failed') break;
            } else if (typeof g.status === 'number' && g.status < 500 && g.status !== 429) {
              break;
            }
            if (Date.now() + 3000 > deadline) break;
            await sleep(3000);
          }
          if (!g.conv) {
            status = 502;
            resBytes = send(res, 502, { ok: false, error: 'conversation_unavailable', transcriptStatus: g.status, transcriptStored: false, audioStored: false });
            return;
          }
          if (!(await bindConversation(sessionId, conversationId))) {
            status = 409;
            resBytes = send(res, 409, { ok: false, error: 'conversation_mismatch' });
            return;
          }
          await storeTranscript(sessionId, g.conv);
          const partial = !(g.conv.status === 'done' || g.conv.status === 'failed');
          meta.conversation_status = g.conv.status ?? null;
          status = 200;
          resBytes = send(res, 200, {
            ok: true,
            transcriptStored: true,
            partial,
            conversationStatus: g.conv.status ?? null,
            audioStored: false,
            audioPending: true,
          });
          handedOff = true;
          void finishInBackground(sessionId, conversationId, partial);
          void maybeRotate();
        } finally {
          if (!handedOff) finishing.delete(sessionId);
        }
        return;
      }
      // Reading and deleting stored sessions needs the API token.
      if (!bearerOk(req, API_TOKEN)) {
        status = 401;
        req.resume();
        resBytes = send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method === 'DELETE' && sessionId !== undefined) {
        await deleteSession(sessionId);
        status = 200;
        resBytes = send(res, 200, { ok: true, deleted: sessionId });
        return;
      }
      if (req.method !== 'GET') {
        status = 405;
        resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      if (sessionId === undefined) {
        const { sessions, total } = await listSessions();
        status = 200;
        resBytes = send(res, 200, {
          ok: true,
          total_bytes: total,
          warn: total > SESSIONS_WARN_BYTES,
          sessions: sessions.map((s) => ({ ...s, mtime: new Date(s.mtime).toISOString() })),
        });
        return;
      }
      let events = null;
      try {
        events = (await fsp.readFile(sessionFile(sessionId, 'jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {}
      const transcript = await readJson(sessionFile(sessionId, 'elevenlabs.json'));
      const audio = await findAudio(sessionId);
      const conversationId = await boundConversation(sessionId);
      if (events === null && transcript === null && !audio && !conversationId) {
        status = 404;
        resBytes = send(res, 404, { ok: false, error: 'session_not_found' });
        return;
      }
      status = 200;
      resBytes = send(res, 200, {
        ok: true,
        id: sessionId,
        conversationId,
        events: events ?? [],
        transcript,
        audio: audio ? { ext: audio.ext, bytes: audio.size } : null,
      });
      return;
    }
    if (DEBUG && req.method === 'GET' && route === '/debug/sse') {
      status = 200;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      for (let i = 1; i <= 5; i++) {
        if (res.destroyed) break;
        res.write(`id: ${i}\nevent: tick\ndata: ${JSON.stringify({ i, t: Date.now() })}\n\n`);
        if (i < 5) await new Promise((r) => setTimeout(r, 1000));
      }
      res.end();
      return;
    }
    if (route.startsWith('/runner/')) {
      if (!bearerOk(req, API_TOKEN)) {
        status = 401;
        req.resume();
        resBytes = send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        status = 405;
        resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e instanceof TooLarge) {
          status = 413;
          resBytes = send(res, 413, { ok: false, error: 'body_too_large', max_bytes: MAX_BODY });
          res.on('finish', () => req.destroy());
          return;
        }
        throw e;
      }
      meta.req_bytes = body.length;
      try {
        const r = await runnerRequest('POST', route.slice('/runner'.length), body, rid);
        status = r.status;
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': r.body.length, 'Cache-Control': 'no-store' });
        res.end(r.body);
        resBytes = r.body.length;
      } catch {
        status = 502;
        resBytes = send(res, 502, { ok: false, error: 'runner_unreachable' });
      }
      return;
    }
    status = 404;
    resBytes = send(res, 404, { ok: false, error: 'not_found' });
  } catch {
    status = 500;
    if (!res.headersSent) resBytes = send(res, 500, { ok: false, error: 'internal' });
  } finally {
    log({ ...meta, status, ms: Date.now() - started, res_bytes: resBytes });
  }
});
server.requestTimeout = 120_000;

await fsp.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o750 });
server.listen(PORT, HOST, () => {
  log({ level: 'info', msg: 'placeholder api listening', host: HOST, port: PORT, git_sha: GIT_SHA, origins: ALLOWED.size, debug: DEBUG });
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
