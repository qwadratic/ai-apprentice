// Infra-owned API module (TASK-4.5). Two jobs:
//  1. forwards every /ops/* request, unchanged, to the deploy webhook (infra/ops, OPS_URL, default
//     http://127.0.0.1:8788). The webhook verifies an HMAC over the raw body, so the bytes are read from the
//     stream and sent on as they came: method, query, content-type, X-Deploy-Signature, and the client IP as
//     X-Forwarded-For (last entry of the incoming header, else the socket address, like the old placeholder).
//     createApi installs express.json for every route; the release job sends the signed body as
//     application/octet-stream, which that parser leaves unread. A body that was already parsed (JSON content
//     type) is refused with 415, never re-serialised, because re-serialising would break the signature.
//  2. GET /ops/vm-health: {ok, runner, git_sha, deployed_sha}, the VM facts the old placeholder put into /health.
// Logs carry method, route, status, duration and sizes; never bodies or signatures.
import http from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Express, Request, Response } from 'express';
import type { ApiModule } from '../src/app.ts';

export interface OpsOptions {
  /** The deploy webhook. Default: env OPS_URL, else http://127.0.0.1:8788. */
  opsUrl?: string;
  /** The Claude runner whose /health vm-health probes. Default: env RUNNER_URL, else http://127.0.0.1:8787. */
  runnerUrl?: string;
  /** The commit this process runs. Default: env GIT_SHA (set by infra/start-api.sh), else "unknown". */
  gitSha?: string;
  /** Written by deploy.sh after a healthy deploy. Default: env DEPLOYED_SHA_FILE, else /var/lib/apprentice/deployed-sha. */
  deployedShaFile?: string;
  /** Largest request body forwarded (bytes). Default 4096. */
  maxBodyBytes?: number;
  /** Idle timeout of the forwarded request (ms). Default 60000. */
  timeoutMs?: number;
  /** Timeout of the runner probe (ms). Default 2000. */
  runnerTimeoutMs?: number;
  log?: (fields: Record<string, unknown>) => void;
}

type Upstream = { status: number; contentType: string; body: Buffer };
type RawBody = { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'aborted' };

const defaultLog = (fields: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
};

/** Client IP as the exe.dev proxy reports it: the last X-Forwarded-For entry, else the socket address. */
function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

/** Reads the request stream as it is. Stops with 'too_large' as soon as more than max bytes are seen. */
function readRaw(req: Request, max: number): Promise<RawBody> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > max) { resolve({ ok: false, reason: 'too_large' }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) { req.removeAllListeners('data'); req.resume(); resolve({ ok: false, reason: 'too_large' }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ ok: false, reason: 'aborted' }));
    req.on('close', () => resolve({ ok: false, reason: 'aborted' }));
  });
}

function forward(target: URL, method: string, path: string, headers: OutgoingHttpHeaders, body: Buffer | null, timeoutMs: number): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: target.hostname, port: target.port, method, path, headers, timeout: timeoutMs }, (rr) => {
      const chunks: Buffer[] = [];
      rr.on('data', (c: Buffer) => chunks.push(c));
      rr.on('end', () => resolve({ status: rr.statusCode ?? 502, contentType: String(rr.headers['content-type'] ?? 'application/json'), body: Buffer.concat(chunks) }));
      rr.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(body ?? undefined);
  });
}

export function createOpsModule(options: OpsOptions = {}, env: NodeJS.ProcessEnv = process.env): ApiModule {
  const opsUrl = new URL(options.opsUrl ?? (env.OPS_URL || 'http://127.0.0.1:8788'));
  const runnerUrl = options.runnerUrl ?? (env.RUNNER_URL || 'http://127.0.0.1:8787');
  const gitSha = options.gitSha ?? (env.GIT_SHA || 'unknown');
  const deployedShaFile = options.deployedShaFile ?? (env.DEPLOYED_SHA_FILE || '/var/lib/apprentice/deployed-sha');
  const maxBody = options.maxBodyBytes ?? 4096;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const runnerTimeoutMs = options.runnerTimeoutMs ?? 2000;
  const log = options.log ?? defaultLog;

  const reply = (res: Response, status: number, body: unknown): number => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
    return buf.length;
  };

  async function runnerState(): Promise<'up' | 'down'> {
    try {
      const r = await fetch(new URL('/health', runnerUrl), { signal: AbortSignal.timeout(runnerTimeoutMs) });
      await r.arrayBuffer().catch(() => {});
      return r.status === 200 ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  // The last commit deploy.sh deployed; it can be newer than GIT_SHA when that deploy did not restart the API.
  async function deployedSha(): Promise<string | null> {
    try { return (await fsp.readFile(deployedShaFile, 'utf8')).trim() || null; } catch { return null; }
  }

  async function proxy(req: Request, res: Response): Promise<void> {
    const started = Date.now();
    let url: URL;
    try { url = new URL(req.originalUrl, 'http://localhost'); }
    catch { reply(res, 400, { ok: false, error: 'bad_request' }); req.resume(); return; }
    const meta: Record<string, unknown> = { rid: randomUUID(), method: req.method, route: url.pathname };
    let status = 500;
    let resBytes = 0;
    try {
      // Only the pathname and query are forwarded, never an absolute-form target, and only below /ops.
      if (url.pathname !== '/ops' && !url.pathname.startsWith('/ops/')) { status = 404; resBytes = reply(res, 404, { ok: false, error: 'not_found' }); req.resume(); return; }
      let body: Buffer | null = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.body !== undefined) {
          // A JSON body parser already consumed the stream; the signed bytes are gone.
          status = 415;
          resBytes = reply(res, 415, { ok: false, error: 'unsupported_media_type', hint: 'send the body as application/octet-stream' });
          return;
        }
        const raw = await readRaw(req, maxBody);
        if (!raw.ok) {
          if (raw.reason === 'aborted') { status = 499; return; }
          status = 413;
          res.setHeader('Connection', 'close');
          resBytes = reply(res, 413, { ok: false, error: 'body_too_large', max_bytes: maxBody });
          res.on('finish', () => req.destroy());
          return;
        }
        body = raw.body;
        meta.req_bytes = body.length;
      } else {
        req.resume();
      }
      const headers: OutgoingHttpHeaders = { 'x-forwarded-for': clientIp(req) };
      const signature = req.headers['x-deploy-signature'];
      if (typeof signature === 'string') headers['x-deploy-signature'] = signature;
      if (body) {
        const type = req.headers['content-type'];
        if (typeof type === 'string') headers['content-type'] = type;
        headers['content-length'] = body.length;
      }
      try {
        const up = await forward(opsUrl, req.method, url.pathname + url.search, headers, body, timeoutMs);
        status = up.status;
        res.writeHead(up.status, { 'Content-Type': up.contentType, 'Content-Length': up.body.length, 'Cache-Control': 'no-store' });
        res.end(up.body);
        resBytes = up.body.length;
      } catch {
        status = 502;
        resBytes = reply(res, 502, { ok: false, error: 'ops_unreachable' });
      }
    } finally {
      log({ ...meta, status, ms: Date.now() - started, res_bytes: resBytes });
    }
  }

  return {
    name: 'ops',
    mount(app: Express): void {
      // Registered before the catch-all so vm-health is answered here and not forwarded.
      app.get('/ops/vm-health', async (_req, res) => {
        const [runner, deployed] = await Promise.all([runnerState(), deployedSha()]);
        reply(res, 200, { ok: true, runner, git_sha: gitSha, deployed_sha: deployed });
      });
      app.use('/ops', (req, res, next) => { proxy(req, res).catch(next); });
    },
  };
}

/** Registered in src/modules.ts; reads its environment when mounted. */
export const opsModule: ApiModule = { name: 'ops', mount: (app) => createOpsModule().mount(app) };
