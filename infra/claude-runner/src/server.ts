// Claude runner: a small internal HTTP service on 127.0.0.1:8787 that wraps the
// Claude Agent SDK for text and vision calls with optional JSON Schema output.
// Logs carry metadata only (request id, route, status, duration, sizes, model);
// never prompts, images, outputs or SDK stderr.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  query,
  startup,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const HOST = process.env.RUNNER_HOST || '127.0.0.1';
const PORT = Number(process.env.RUNNER_PORT || 8787);
const MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5-5';
const CONCURRENCY = Math.max(1, Number(process.env.RUNNER_CONCURRENCY || 2));
const QUEUE_MAX = 10;
const TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 60_000);
const MAX_BODY = 12 * 1024 * 1024;
const MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 3);
const CWD = process.env.RUNNER_CWD || '/var/lib/apprentice/runner-cwd';
const SYSTEM_PROMPT =
  'You are a precise extraction and reasoning helper inside an internal service. ' +
  'Answer only from the provided input. Be concise. You have no tools.';

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
}

// ---- credentials ----------------------------------------------------------
const nonEmpty = (v: string | undefined) => typeof v === 'string' && v.trim() !== '';
const hasOauth = nonEmpty(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const hasKey = nonEmpty(process.env.ANTHROPIC_API_KEY);
if (hasOauth === hasKey) {
  log({ level: 'fatal', msg: hasOauth ? 'both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set; set exactly one' : 'neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set; set exactly one' });
  process.exit(1);
}
const MODE: 'oauth' | 'apikey' = hasOauth ? 'oauth' : 'apikey';
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
if (RUNNER_TOKEN.length < 32) {
  log({ level: 'fatal', msg: 'RUNNER_TOKEN missing or shorter than 32 chars' });
  process.exit(1);
}

function readGitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', '..', 'GIT_SHA'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}
const GIT_SHA = readGitSha();

// Subprocess environment: `env` replaces the environment, so pass a filtered
// copy without our own service tokens and without empty credential variables.
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  for (const k of ['RUNNER_TOKEN', 'API_TOKEN', 'ELEVENLABS_API_KEY']) delete env[k];
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (!nonEmpty(env[k])) delete env[k];
  return env;
}

function baseOptions(model: string): Options {
  return {
    model,
    tools: [],
    permissionMode: 'dontAsk',
    settingSources: [],
    persistSession: false,
    cwd: CWD,
    maxTurns: MAX_TURNS,
    maxBudgetUsd: 0.5,
    env: childEnv(),
  };
}

// ---- request schemas ------------------------------------------------------
const jsonSchema = z.record(z.string(), z.unknown());
const CompleteBody = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  schema: jsonSchema.optional(),
  model: z.string().min(1).optional(),
});
const VisionBody = CompleteBody.extend({
  images: z
    .array(
      z.object({
        media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        data: z.string().min(1),
      }),
    )
    .min(1)
    .max(4),
});
type CompleteReq = z.infer<typeof CompleteBody>;
type VisionReq = z.infer<typeof VisionBody>;

// ---- concurrency ----------------------------------------------------------
let active = 0;
const waiters: Array<() => void> = [];
class QueueFull extends Error {}
async function acquire(): Promise<void> {
  if (active < CONCURRENCY) {
    active++;
    return;
  }
  if (waiters.length >= QUEUE_MAX) throw new QueueFull();
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

// ---- running one SDK call -------------------------------------------------
type RunResult =
  | { status: 200; body: { ok: true; text?: string; json?: unknown; ms: number }; firstMs?: number }
  | { status: 502 | 504; body: { ok: false; error: string; subtype?: string; ms: number }; firstMs?: number };

async function run(req: CompleteReq | VisionReq, images?: VisionReq['images']): Promise<RunResult> {
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TIMEOUT_MS);
  const options: Options = {
    ...baseOptions(req.model || MODEL),
    abortController: abort,
    systemPrompt: req.system ? `${SYSTEM_PROMPT}\n\n${req.system}` : SYSTEM_PROMPT,
  };
  if (req.schema) options.outputFormat = { type: 'json_schema', schema: req.schema };

  let prompt: string | AsyncIterable<SDKUserMessage> = req.prompt;
  if (images) {
    const content = [
      ...images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
      })),
      { type: 'text' as const, text: req.prompt },
    ];
    prompt = (async function* () {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
    })();
  }

  let firstMs: number | undefined;
  try {
    const q = query({ prompt, options });
    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    for await (const msg of q) {
      if (firstMs === undefined && msg.type !== 'system') firstMs = Date.now() - started;
      if (msg.type === 'result') {
        result = msg;
        break;
      }
    }
    const ms = Date.now() - started;
    if (timedOut) return { status: 504, body: { ok: false, error: 'timeout', ms }, firstMs };
    if (!result) return { status: 502, body: { ok: false, error: 'no_result', ms }, firstMs };
    if (result.subtype !== 'success') {
      return { status: 502, body: { ok: false, error: 'sdk_error', subtype: result.subtype, ms }, firstMs };
    }
    if (result.is_error) {
      return { status: 502, body: { ok: false, error: 'sdk_error', subtype: 'is_error', ms }, firstMs };
    }
    if (req.schema) {
      if (result.structured_output === undefined) {
        return { status: 502, body: { ok: false, error: 'no_structured_output', subtype: result.subtype, ms }, firstMs };
      }
      return { status: 200, body: { ok: true, json: result.structured_output, ms }, firstMs };
    }
    return { status: 200, body: { ok: true, text: result.result, ms }, firstMs };
  } catch {
    // The error text may echo SDK stderr, so it is not logged or returned.
    const ms = Date.now() - started;
    if (timedOut) return { status: 504, body: { ok: false, error: 'timeout', ms }, firstMs };
    return { status: 502, body: { ok: false, error: 'sdk_exception', ms }, firstMs };
  } finally {
    clearTimeout(timer);
    if (!abort.signal.aborted) abort.abort();
  }
}

// ---- HTTP -----------------------------------------------------------------
class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(RUNNER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): number {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return buf.length;
}

const server = http.createServer(async (req, res) => {
  const rid = (req.headers['x-request-id'] as string) || randomUUID();
  const started = Date.now();
  const route = (req.url || '/').split('?')[0];
  const meta: Record<string, unknown> = { rid, method: req.method, route };
  let status = 500;
  let resBytes = 0;
  try {
    if (req.method === 'GET' && route === '/health') {
      status = 200;
      resBytes = send(res, 200, { ok: true, mode: MODE, model: MODEL, git_sha: GIT_SHA, active, queued: waiters.length });
      return;
    }
    const isComplete = route === '/v1/complete';
    const isVision = route === '/v1/vision';
    if (!isComplete && !isVision) {
      status = 404;
      resBytes = send(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      status = 405;
      resBytes = send(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!authorized(req)) {
      status = 401;
      req.resume();
      resBytes = send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        status = 413;
        resBytes = send(res, 413, { ok: false, error: 'body_too_large', max_bytes: MAX_BODY });
        res.on('finish', () => req.destroy());
        return;
      }
      throw e;
    }
    meta.req_bytes = raw.length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      status = 400;
      resBytes = send(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    const v = (isVision ? VisionBody : CompleteBody).safeParse(parsed);
    if (!v.success) {
      status = 400;
      // Only field paths, never values.
      resBytes = send(res, 400, { ok: false, error: 'invalid_body', fields: v.error.issues.map((i) => i.path.join('.')) });
      return;
    }
    const body = v.data;
    meta.model = body.model || MODEL;
    meta.schema = !!body.schema;
    if (isVision) meta.images = (body as VisionReq).images.length;

    try {
      await acquire();
    } catch (e) {
      if (e instanceof QueueFull) {
        status = 429;
        res.setHeader('Retry-After', '5');
        resBytes = send(res, 429, { ok: false, error: 'queue_full' });
        return;
      }
      throw e;
    }
    meta.wait_ms = Date.now() - started;
    try {
      const r = await run(body, isVision ? (body as VisionReq).images : undefined);
      status = r.status;
      meta.first_ms = r.firstMs;
      meta.run_ms = r.body.ms;
      if (!r.body.ok) meta.error = r.body.error + (r.body.subtype ? `:${r.body.subtype}` : '');
      resBytes = send(res, r.status, r.body);
    } finally {
      release();
    }
  } catch {
    status = 500;
    if (!res.headersSent) resBytes = send(res, 500, { ok: false, error: 'internal' });
  } finally {
    log({ ...meta, status, ms: Date.now() - started, res_bytes: resBytes });
  }
});
server.requestTimeout = TIMEOUT_MS + 30_000;

async function prewarm(): Promise<void> {
  // Spawn one CLI subprocess at boot so binary and caches are warm, then
  // discard it: per-request options (schema, model, system) differ.
  const t0 = Date.now();
  try {
    const warm = await startup({ options: baseOptions(MODEL), initializeTimeoutMs: 30_000 });
    warm.close();
    log({ level: 'info', msg: 'prewarm ok', ms: Date.now() - t0 });
  } catch {
    log({ level: 'warn', msg: 'prewarm failed', ms: Date.now() - t0 });
  }
}

server.listen(PORT, HOST, () => {
  log({ level: 'info', msg: 'runner listening', host: HOST, port: PORT, mode: MODE, model: MODEL, concurrency: CONCURRENCY, git_sha: GIT_SHA });
  void prewarm();
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
