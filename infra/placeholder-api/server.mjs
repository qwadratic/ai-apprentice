// Placeholder public API on 0.0.0.0:8000 (dependency-free). Serves /health,
// exact-origin CORS, a 12 MB body cap, a token-protected /runner/* test proxy
// and, with DEBUG_ENDPOINTS=1, /debug/sse; plus the ElevenLabs signed URL and
// session log storage for stream B. Replaced by apps/api once it exists.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const RUNNER_URL = new URL(process.env.RUNNER_URL || 'http://127.0.0.1:8787');
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const API_TOKEN = process.env.API_TOKEN || '';
const GIT_SHA = process.env.GIT_SHA || 'unknown';
const DEBUG = process.env.DEBUG_ENDPOINTS === '1';
const MAX_BODY = 12 * 1024 * 1024;
const EL_AGENT_ID = process.env.ELEVENLABS_AGENT_ID_INTERVIEWER || '';
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/var/lib/apprentice/sessions';
const SESSION_EVENTS_MAX_BODY = 256 * 1024;
const SESSION_FILE_MAX = 5 * 1024 * 1024; // one session's .jsonl
const SESSIONS_WARN_BYTES = Number(process.env.SESSIONS_WARN_BYTES || 1024 ** 3); // 1 GiB: warn in logs and listings
const SESSIONS_ROTATE_BYTES = Number(process.env.SESSIONS_ROTATE_BYTES || 2 * 1024 ** 3); // 2 GiB: delete oldest sessions
const SESSIONS_ROTATE_TARGET = 0.75 * SESSIONS_ROTATE_BYTES;
const ALLOWED = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

function log(fields) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
}

function cors(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function send(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return buf.length;
}

function bearerOk(req, token) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m || token.length < 32) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > max) return reject(Object.assign(new Error(), { tooLarge: true }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error(), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  // exe.dev appends the client IP as seen by its proxy as the last entry.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}

// Sliding-window limiter: perMinute per client IP and perHour overall (0 = none).
function makeLimiter(perMinute, perHour) {
  const perIp = new Map(); // ip -> timestamps (ms) within the last minute
  let globalHits = []; // timestamps within the last hour
  return function limited(ip) {
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
    if (perIp.size > 10_000) for (const [k, v] of perIp) if (!v.length || now - v[v.length - 1] >= 60_000) perIp.delete(k);
    return false;
  };
}
const signedUrlLimited = makeLimiter(6, 60);
const eventsLimited = makeLimiter(120, 0);
const finishLimited = makeLimiter(6, 0);

function originAllowed(req) {
  const origin = req.headers.origin;
  return !!origin && ALLOWED.has(origin);
}

// ---- session storage ------------------------------------------------------
// Files per session in SESSIONS_DIR: {id}.jsonl (events), {id}.elevenlabs.json
// (conversation from ElevenLabs), {id}.mp3 (conversation audio).
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_DIRS = new Set(['sent', 'recv', 'sys', 'err']);
const sessionFile = (id, ext) => join(SESSIONS_DIR, `${id}.${ext}`);

async function writeAtomic(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o640 });
  await fsp.rename(tmp, path);
}

async function fileSize(path) {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return 0;
  }
}

async function listSessions() {
  const byId = new Map();
  let total = 0;
  for (const name of await fsp.readdir(SESSIONS_DIR)) {
    const m = /^([A-Za-z0-9-]{8,64})\.(jsonl|elevenlabs\.json|mp3)$/.exec(name);
    if (!m) continue;
    const st = await fsp.stat(join(SESSIONS_DIR, name));
    total += st.size;
    const s = byId.get(m[1]) || { id: m[1], size: 0, mtime: 0, hasEvents: false, hasTranscript: false, hasAudio: false };
    s.size += st.size;
    s.mtime = Math.max(s.mtime, st.mtimeMs);
    if (m[2] === 'jsonl') s.hasEvents = true;
    if (m[2] === 'elevenlabs.json') s.hasTranscript = true;
    if (m[2] === 'mp3') s.hasAudio = true;
    byId.set(m[1], s);
  }
  const sessions = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
  return { sessions, total };
}

// Rotation: at most once a minute after a write; deletes the oldest sessions
// when the directory passes 2 GiB, and warns in the log above 1 GiB.
let lastRotateCheck = 0;
async function maybeRotate() {
  const now = Date.now();
  if (now - lastRotateCheck < 60_000) return;
  lastRotateCheck = now;
  try {
    const { sessions, total } = await listSessions();
    if (total > SESSIONS_WARN_BYTES) log({ level: 'warn', msg: 'sessions dir over warn threshold', bytes: total, warn_bytes: SESSIONS_WARN_BYTES });
    if (total <= SESSIONS_ROTATE_BYTES) return;
    let left = total;
    let removed = 0;
    for (const s of [...sessions].reverse()) {
      if (left <= SESSIONS_ROTATE_TARGET) break;
      for (const ext of ['jsonl', 'elevenlabs.json', 'mp3']) await fsp.rm(sessionFile(s.id, ext), { force: true });
      left -= s.size;
      removed++;
    }
    log({ level: 'warn', msg: 'sessions rotated', removed, bytes_before: total, bytes_after: left });
  } catch {
    log({ level: 'error', msg: 'sessions rotation failed' });
  }
}

function parseEvents(raw) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { error: 'invalid_json' };
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.events) || body.events.length === 0) return { error: 'invalid_body', field: 'events' };
  if (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !CONVERSATION_ID.test(body.conversationId))) {
    return { error: 'invalid_body', field: 'conversationId' };
  }
  for (const [i, e] of body.events.entries()) {
    if (!e || typeof e !== 'object' || typeof e.t !== 'number' || !Number.isFinite(e.t) || !EVENT_DIRS.has(e.dir) || typeof e.type !== 'string' || typeof e.text !== 'string') {
      return { error: 'invalid_body', field: `events.${i}` };
    }
  }
  return { conversationId: body.conversationId, events: body.events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetches the finished conversation (retrying while ElevenLabs is still
// processing) and its audio; stores both next to the session's events.
async function fetchConversation(sessionId, conversationId) {
  const base = `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`;
  const headers = { 'xi-api-key': EL_KEY };
  const out = { transcriptStored: false, audioStored: false, transcriptStatus: null, conversationStatus: null, audioStatus: null };
  let conv = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(base, { headers, signal: AbortSignal.timeout(10_000) });
      out.transcriptStatus = r.status;
      if (r.ok) {
        conv = await r.json();
        out.conversationStatus = typeof conv.status === 'string' ? conv.status : null;
        if (conv.status === 'done' || conv.status === 'failed') break;
      } else if (r.status < 500 && r.status !== 429) {
        break;
      }
    } catch {
      out.transcriptStatus = 'unreachable';
    }
    if (attempt < 5) await sleep(3000);
  }
  if (conv) {
    await writeAtomic(sessionFile(sessionId, 'elevenlabs.json'), JSON.stringify(conv));
    out.transcriptStored = true;
  }
  try {
    const r = await fetch(`${base}/audio`, { headers, signal: AbortSignal.timeout(30_000) });
    out.audioStatus = r.status;
    const type = r.headers.get('content-type') || '';
    if (r.ok && type.startsWith('audio/')) {
      await writeAtomic(sessionFile(sessionId, 'mp3'), Buffer.from(await r.arrayBuffer()));
      out.audioStored = true;
    } else {
      await r.arrayBuffer().catch(() => {});
    }
  } catch {
    out.audioStatus = 'unreachable';
  }
  return out;
}

async function elevenLabsSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(EL_AGENT_ID)}`;
  const r = await fetch(url, { headers: { 'xi-api-key': EL_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { status: r.status, signed_url: typeof j.signed_url === 'string' ? j.signed_url : undefined };
}

function runnerRequest(method, path, body, rid) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-request-id': rid };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
      headers.authorization = `Bearer ${RUNNER_TOKEN}`;
    }
    const r = http.request(
      { host: RUNNER_URL.hostname, port: RUNNER_URL.port, method, path, headers, timeout: 90_000 },
      (rr) => {
        const chunks = [];
        rr.on('data', (c) => chunks.push(c));
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

async function runnerUp(rid) {
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
  const route = (req.url || '/').split('?')[0];
  const meta = { rid, method: req.method, route };
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
      resBytes = send(res, 200, { ok: true, runner: await runnerUp(rid), git_sha: GIT_SHA });
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
      // Bodies, transcripts and keys are never logged.
      const [, sessionId, action] = sessionRoute;
      if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        status = 400;
        resBytes = send(res, 400, { ok: false, error: 'invalid_session_id' });
        return;
      }
      if (action) {
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
        let raw;
        try {
          raw = await readBody(req, action === 'events' ? SESSION_EVENTS_MAX_BODY : 4096);
        } catch (e) {
          if (e.tooLarge) {
            status = 413;
            resBytes = send(res, 413, { ok: false, error: 'body_too_large', max_bytes: action === 'events' ? SESSION_EVENTS_MAX_BODY : 4096 });
            res.on('finish', () => req.destroy());
            return;
          }
          throw e;
        }
        meta.req_bytes = raw.length;
        if (action === 'events') {
          const p = parseEvents(raw);
          if (p.error) {
            status = 400;
            resBytes = send(res, 400, { ok: false, error: p.error, field: p.field });
            return;
          }
          const receivedAt = Date.now();
          const lines = p.events
            .map((e) => JSON.stringify({ t: e.t, dir: e.dir, type: e.type, text: e.text, conversationId: p.conversationId ?? null, receivedAt }))
            .join('\n') + '\n';
          const path = sessionFile(sessionId, 'jsonl');
          if ((await fileSize(path)) + Buffer.byteLength(lines) > SESSION_FILE_MAX) {
            status = 413;
            resBytes = send(res, 413, { ok: false, error: 'session_full', max_bytes: SESSION_FILE_MAX });
            return;
          }
          await fsp.appendFile(path, lines, { mode: 0o640 });
          meta.stored = p.events.length;
          status = 200;
          resBytes = send(res, 200, { ok: true, stored: p.events.length });
          void maybeRotate();
          return;
        }
        // finish
        let conversationId;
        try {
          conversationId = JSON.parse(raw.toString('utf8')).conversationId;
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
        if (!EL_KEY) {
          status = 503;
          resBytes = send(res, 503, { ok: false, error: 'elevenlabs_not_configured', missing: ['ELEVENLABS_API_KEY'] });
          return;
        }
        const r = await fetchConversation(sessionId, conversationId);
        Object.assign(meta, { transcript_status: r.transcriptStatus, conversation_status: r.conversationStatus, audio_status: r.audioStatus });
        // 502 when ElevenLabs gave no conversation, so a client never sees an empty success.
        status = r.transcriptStored ? 200 : 502;
        resBytes = send(res, status, { ok: r.transcriptStored, ...r });
        void maybeRotate();
        return;
      }
      // Reading stored sessions needs the API token.
      if (req.method !== 'GET') {
        status = 405;
        resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      if (!bearerOk(req, API_TOKEN)) {
        status = 401;
        resBytes = send(res, 401, { ok: false, error: 'unauthorized' });
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
      let transcript = null;
      try {
        events = (await fsp.readFile(sessionFile(sessionId, 'jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {}
      try {
        transcript = JSON.parse(await fsp.readFile(sessionFile(sessionId, 'elevenlabs.json'), 'utf8'));
      } catch {}
      const audioBytes = await fileSize(sessionFile(sessionId, 'mp3'));
      if (events === null && transcript === null && !audioBytes) {
        status = 404;
        resBytes = send(res, 404, { ok: false, error: 'session_not_found' });
        return;
      }
      status = 200;
      resBytes = send(res, 200, { ok: true, id: sessionId, events: events ?? [], transcript, audio_bytes: audioBytes });
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
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e.tooLarge) {
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
