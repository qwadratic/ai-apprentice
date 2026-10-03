// Placeholder public API on 0.0.0.0:8000 (dependency-free). Serves /health,
// exact-origin CORS, a 12 MB body cap, a token-protected /runner/* test proxy
// and, with DEBUG_ENDPOINTS=1, /debug/sse. Replaced by apps/api once it exists.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reject(Object.assign(new Error(), { tooLarge: true }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
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

// Signed-URL rate limits: 6 per minute per client IP, 60 per hour overall.
const perIp = new Map(); // ip -> timestamps (ms) within the last minute
let globalHits = []; // timestamps within the last hour
function clientIp(req) {
  // exe.dev appends the client IP as seen by its proxy as the last entry.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < 3_600_000);
  const mine = (perIp.get(ip) || []).filter((t) => now - t < 60_000);
  if (mine.length >= 6 || globalHits.length >= 60) {
    perIp.set(ip, mine);
    return true;
  }
  mine.push(now);
  perIp.set(ip, mine);
  globalHits.push(now);
  if (perIp.size > 10_000) for (const [k, v] of perIp) if (!v.length || now - v[v.length - 1] >= 60_000) perIp.delete(k);
  return false;
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
      if (rateLimited(clientIp(req))) {
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

server.listen(PORT, HOST, () => {
  log({ level: 'info', msg: 'placeholder api listening', host: HOST, port: PORT, git_sha: GIT_SHA, origins: ALLOWED.size, debug: DEBUG });
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
