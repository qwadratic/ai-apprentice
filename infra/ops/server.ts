// Deploy webhook on 127.0.0.1:8788 (dependency-free TypeScript, run with
// Node's built-in type stripping: node server.ts). The public API forwards
// /ops/* here, so the webhook keeps working whatever serves port 8000.
//
//   POST /ops/deploy          {"sha": "<40 hex>", "ts": <unix seconds>}
//                             X-Deploy-Signature: sha256=<hex HMAC-SHA256(DEPLOY_WEBHOOK_SECRET, raw body)>
//                             → 202 {accepted, sha}; writes deploy-request.json, which a
//                               systemd path unit turns into a deploy (no sudo here)
//   GET  /ops/deploy/status   → {deployed_sha, last: {sha, state, started_at, finished_at, message}}
//
// Logs carry route, status, duration and sizes; never bodies or signatures.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const HOST = process.env.OPS_HOST || '127.0.0.1';
const PORT = Number(process.env.OPS_PORT || 8788);
const SECRET = process.env.DEPLOY_WEBHOOK_SECRET || '';
const REPO = process.env.DEPLOY_REPO || '/opt/apprentice/repo';
// Branch a deployable sha must be an ancestor of. Default main until the VM is switched
// (see infra/README.md "Deploy from the release branch").
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH || 'main';
const STATE = process.env.DEPLOY_STATE_DIR || '/var/lib/apprentice';
const REQUEST_FILE = join(STATE, 'deploy-request.json');
const STATUS_FILE = join(STATE, 'deploy-status.json');
const DEPLOYED_FILE = join(STATE, 'deployed-sha');
const MAX_BODY = 1024;
const MAX_AGE_S = 300; // reject requests signed longer ago
const MAX_SKEW_S = 60; // or this far in the future
const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function log(fields: Json): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
}

function send(res: ServerResponse, status: number, body: unknown): number {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return buf.length;
}

class TooLarge extends Error {}
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
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
  // Only the public API (loopback) talks to this service; it passes the client IP.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? (req.socket.remoteAddress || 'unknown');
}

// Sliding-window limiter: perMinute per client IP and perHour overall.
function makeLimiter(perMinute: number, perHour: number): (ip: string) => boolean {
  const perIp = new Map<string, number[]>();
  let globalHits: number[] = [];
  return function limited(ip: string): boolean {
    const now = Date.now();
    globalHits = globalHits.filter((t) => now - t < 3_600_000);
    const mine = (perIp.get(ip) || []).filter((t) => now - t < 60_000);
    if (mine.length >= perMinute || globalHits.length >= perHour) {
      perIp.set(ip, mine);
      return true;
    }
    mine.push(now);
    perIp.set(ip, mine);
    globalHits.push(now);
    if (perIp.size > 10_000) {
      for (const [k, v] of perIp) {
        const last = v.at(-1);
        if (last === undefined || now - last >= 60_000) perIp.delete(k);
      }
    }
    return false;
  };
}
const failedLimited = makeLimiter(6, 30); // requests with a missing or wrong signature

// A valid signature is accepted once; replays inside the time window get 409.
const seenSignatures = new Map<string, number>(); // signature hex -> expiry (ms)
function replayed(sig: string): boolean {
  const now = Date.now();
  for (const [k, exp] of seenSignatures) if (exp < now) seenSignatures.delete(k);
  if (seenSignatures.has(sig)) return true;
  seenSignatures.set(sig, now + (MAX_AGE_S + MAX_SKEW_S) * 1000);
  return false;
}

function signatureOk(raw: Buffer, header: string | undefined): string | null {
  const hex = SIGNATURE.exec(header || '')?.[1];
  if (!hex || !SECRET) return null;
  const given = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', SECRET).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected) ? hex : null;
}

function git(args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    execFile('git', ['-C', REPO, ...args], { timeout: timeoutMs }, (err) => {
      if (!err) return resolve(0);
      const code = isRecord(err) && typeof err.code === 'number' ? err.code : -1;
      resolve(code);
    });
  });
}

// True if sha is on origin/<DEPLOY_BRANCH>. A failed fetch is not fatal: the check then
// runs against the origin/<DEPLOY_BRANCH> the checkout already knows.
async function onDeployBranch(sha: string): Promise<boolean> {
  const fetched = await git(['fetch', '-q', 'origin', DEPLOY_BRANCH], 20_000);
  if (fetched !== 0) log({ level: 'warn', msg: 'git fetch failed before the ancestry check', code: fetched, branch: DEPLOY_BRANCH });
  return (await git(['merge-base', '--is-ancestor', sha, `origin/${DEPLOY_BRANCH}`], 10_000)) === 0;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o640 });
  await fsp.rename(tmp, path);
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function status(): Promise<Json> {
  let last: unknown = null;
  const raw = await readText(STATUS_FILE);
  if (raw) {
    try {
      last = JSON.parse(raw);
    } catch {
      last = null;
    }
  }
  return { deployed_sha: await readText(DEPLOYED_FILE), last: isRecord(last) ? last : null };
}

const server = http.createServer(async (req, res) => {
  const rid = randomUUID();
  const started = Date.now();
  const route = (req.url || '/').split('?')[0] ?? '/';
  const meta: Json = { rid, method: req.method, route };
  let code = 500;
  let resBytes = 0;
  try {
    if (route === '/ops/deploy/status' && req.method === 'GET') {
      code = 200;
      resBytes = send(res, 200, await status());
      return;
    }
    if (route !== '/ops/deploy') {
      code = 404;
      resBytes = send(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      code = 405;
      resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!SECRET) {
      code = 503;
      req.resume();
      resBytes = send(res, 503, { ok: false, error: 'webhook_not_configured' });
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_BODY);
    } catch (e) {
      if (e instanceof TooLarge) {
        code = 413;
        resBytes = send(res, 413, { ok: false, error: 'body_too_large', max_bytes: MAX_BODY });
        res.on('finish', () => req.destroy());
        return;
      }
      throw e;
    }
    meta.req_bytes = raw.length;
    const sigHeader = req.headers['x-deploy-signature'];
    const sig = signatureOk(raw, typeof sigHeader === 'string' ? sigHeader : undefined);
    if (!sig) {
      // Only failed signatures spend the rate limit, so unsigned noise cannot
      // block real deploys; valid ones are bounded by the ts window and replay check.
      if (failedLimited(clientIp(req))) {
        code = 429;
        res.setHeader('Retry-After', '60');
        resBytes = send(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      code = 401;
      resBytes = send(res, 401, { ok: false, error: 'bad_signature' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = null;
    }
    const sha = isRecord(body) ? body.sha : undefined;
    const ts = isRecord(body) ? body.ts : undefined;
    if (typeof sha !== 'string' || !SHA.test(sha) || typeof ts !== 'number' || !Number.isInteger(ts)) {
      code = 400;
      resBytes = send(res, 400, { ok: false, error: 'invalid_body', expected: '{"sha": "<40 hex>", "ts": <unix seconds>}' });
      return;
    }
    const age = Math.floor(Date.now() / 1000) - ts;
    if (age > MAX_AGE_S || age < -MAX_SKEW_S) {
      code = 401;
      resBytes = send(res, 401, { ok: false, error: 'timestamp_out_of_window', max_age_s: MAX_AGE_S, max_skew_s: MAX_SKEW_S });
      return;
    }
    if (replayed(sig)) {
      code = 409;
      resBytes = send(res, 409, { ok: false, error: 'replayed' });
      return;
    }
    meta.sha = sha.slice(0, 12);
    if (!(await onDeployBranch(sha))) {
      code = 422;
      // Backward compatible: the default branch still answers the original error code.
      // A VM switched to another branch (DEPLOY_BRANCH) answers a generic one instead.
      const error = DEPLOY_BRANCH === 'main' ? 'not_on_main' : 'not_on_deploy_branch';
      resBytes = send(res, 422, { ok: false, error, sha, branch: DEPLOY_BRANCH });
      return;
    }
    const now = new Date().toISOString();
    await writeAtomic(STATUS_FILE, JSON.stringify({ sha, state: 'queued', source: 'request', requested_at: now, started_at: null, finished_at: null, message: 'queued' }));
    // The path unit watches this file and starts apprentice-deploy-request.service.
    await writeAtomic(REQUEST_FILE, JSON.stringify({ sha, ts, requested_at: now, id: rid }));
    code = 202;
    resBytes = send(res, 202, { accepted: true, sha });
  } catch {
    code = 500;
    if (!res.headersSent) resBytes = send(res, 500, { ok: false, error: 'internal' });
  } finally {
    log({ ...meta, status: code, ms: Date.now() - started, res_bytes: resBytes });
  }
});
server.requestTimeout = 60_000;

server.listen(PORT, HOST, () => {
  log({ level: 'info', msg: 'ops listening', host: HOST, port: PORT, configured: !!SECRET });
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
