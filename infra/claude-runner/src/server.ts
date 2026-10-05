// Claude runner: a small internal HTTP service on 127.0.0.1:8787 that wraps the
// Claude Agent SDK for text and vision calls with optional JSON Schema output
// (or, with RUNNER_ENGINE=codex, the Codex CLI: src/codex.ts), plus POST /v1/job: a call that
// can read a small set of files in a temp directory (src/job.ts).
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
import { unwrapResult, wrapRootUnion } from './schema.js';
import { dropAddedNulls, parseJsonAnswer, runCodex, toCodexSchema } from './codex.js';
import type { CodexOutcome } from './codex.js';
import { JOB_SYSTEM_PROMPT, JobBody, jobClaudeOptions, runJob } from './job.js';
import type { JobEngine, JobEngineInput, JobEngineResult, JobRequest, JobResult } from './job.js';

const HOST = process.env.RUNNER_HOST || '127.0.0.1';
const PORT = Number(process.env.RUNNER_PORT || 8787);
const MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-5-5';
// Models a request may pick; RUNNER_MODEL is always allowed.
const MODELS = new Set([
  MODEL,
  ...(process.env.RUNNER_MODELS || 'claude-sonnet-5-5,claude-opus-5-5,claude-haiku-4-5-20251001').split(',').map((m) => m.trim()).filter(Boolean),
]);
const CONCURRENCY = Math.max(1, Number(process.env.RUNNER_CONCURRENCY || 2));
const QUEUE_MAX = 10;
const TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 60_000);
const MAX_BODY = 12 * 1024 * 1024;
const MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 3);
// Per-call spend ceiling: text completions (structured extraction) are small; vision keeps the larger one.
const MAX_BUDGET_USD = 0.5;
const COMPLETE_MAX_BUDGET_USD = Number(process.env.RUNNER_COMPLETE_MAX_BUDGET_USD || 0.1);
const CWD = process.env.RUNNER_CWD || '/var/lib/apprentice/runner-cwd';
const SYSTEM_PROMPT =
  'You are a precise extraction and reasoning helper inside an internal service. ' +
  'Answer only from the provided input. Be concise. You have no tools.';
// RUNNER_ENGINE=codex runs every request through the Codex CLI (`codex exec`) instead of the Agent SDK,
// for when the Claude credentials have no quota. Default: claude (unchanged).
const ENGINE: 'claude' | 'codex' = process.env.RUNNER_ENGINE === 'codex' ? 'codex' : 'claude';
const CODEX_MODEL = process.env.RUNNER_CODEX_MODEL?.trim() || undefined;
const CODEX_REASONING = process.env.RUNNER_CODEX_REASONING ?? 'low';
const CODEX_EPHEMERAL = process.env.RUNNER_CODEX_EPHEMERAL === '1';
const CODEX_BIN = process.env.RUNNER_CODEX_BIN?.trim() || 'codex';
// POST /v1/job reads files, so it has its own, longer run limit and room for tool turns and spend.
const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};
const JOB_TIMEOUT_MS = positive(process.env.RUNNER_JOB_TIMEOUT_MS, 180_000);
const JOB_MAX_TURNS = positive(process.env.RUNNER_JOB_MAX_TURNS, 24);
const JOB_MAX_BUDGET_USD = positive(process.env.RUNNER_JOB_MAX_BUDGET_USD, 1);
const JOB_CODEX_REASONING = process.env.RUNNER_JOB_CODEX_REASONING ?? CODEX_REASONING;

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...fields }) + '\n');
}

// ---- credentials ----------------------------------------------------------
const nonEmpty = (v: string | undefined) => typeof v === 'string' && v.trim() !== '';
const hasOauth = nonEmpty(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const hasKey = nonEmpty(process.env.ANTHROPIC_API_KEY);
if (ENGINE === 'claude' && hasOauth === hasKey) {
  log({ level: 'fatal', msg: hasOauth ? 'both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set; set exactly one' : 'neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set; set exactly one' });
  process.exit(1);
}
const MODE: 'oauth' | 'apikey' | 'codex' = ENGINE === 'codex' ? 'codex' : hasOauth ? 'oauth' : 'apikey';
const HEALTH_MODEL = ENGINE === 'codex' ? (CODEX_MODEL ?? 'codex-default') : MODEL;
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
  for (const k of ['RUNNER_TOKEN', 'API_TOKEN', 'ELEVENLABS_API_KEY', 'DEPLOY_WEBHOOK_SECRET']) delete env[k];
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (!nonEmpty(env[k])) delete env[k];
  return env;
}

function baseOptions(model: string, maxBudgetUsd = MAX_BUDGET_USD): Options {
  return {
    model,
    tools: [],
    permissionMode: 'dontAsk',
    settingSources: [],
    persistSession: false,
    cwd: CWD,
    maxTurns: MAX_TURNS,
    maxBudgetUsd,
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

async function run(req: CompleteReq | VisionReq, images: VisionReq['images'] | undefined, clientGone: AbortSignal): Promise<RunResult> {
  if (ENGINE === 'codex') return runWithCodex(req, images, clientGone);
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  // A client that disconnected no longer needs the answer: stop the SDK call (and its spend) at once.
  const onClientGone = (): void => abort.abort();
  if (clientGone.aborted) onClientGone();
  else clientGone.addEventListener('abort', onClientGone, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TIMEOUT_MS);
  const options: Options = {
    ...baseOptions(req.model || MODEL, images ? MAX_BUDGET_USD : COMPLETE_MAX_BUDGET_USD),
    abortController: abort,
    systemPrompt: req.system ? `${SYSTEM_PROMPT}\n\n${req.system}` : SYSTEM_PROMPT,
  };
  const output = req.schema ? wrapRootUnion(req.schema) : undefined;
  if (output) options.outputFormat = { type: 'json_schema', schema: output.schema };

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
      const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      yield msg;
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
    if (output) {
      const json = result.structured_output === undefined ? undefined : unwrapResult(result.structured_output, output.wrapped);
      if (json === undefined) {
        return { status: 502, body: { ok: false, error: 'no_structured_output', subtype: result.subtype, ms }, firstMs };
      }
      return { status: 200, body: { ok: true, json, ms }, firstMs };
    }
    return { status: 200, body: { ok: true, text: result.result, ms }, firstMs };
  } catch {
    // The error text may echo SDK stderr, so it is not logged or returned.
    const ms = Date.now() - started;
    if (timedOut) return { status: 504, body: { ok: false, error: 'timeout', ms }, firstMs };
    return { status: 502, body: { ok: false, error: 'sdk_exception', ms }, firstMs };
  } finally {
    clearTimeout(timer);
    clientGone.removeEventListener('abort', onClientGone);
    if (!abort.signal.aborted) abort.abort();
  }
}

// The request's `model` names a Claude model; the Codex engine uses RUNNER_CODEX_MODEL (or the CLI's default).
async function runWithCodex(req: CompleteReq | VisionReq, images: VisionReq['images'] | undefined, clientGone: AbortSignal): Promise<RunResult> {
  const started = Date.now();
  const output = req.schema ? wrapRootUnion(req.schema) : undefined;
  const system = `${SYSTEM_PROMPT} Do not run commands or read files.${req.system ? `\n\n${req.system}` : ''}`;
  const env = childEnv();
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];
  try {
    const r = await runCodex(
      { prompt: `<system>\n${system}\n</system>\n\n${req.prompt}`, schema: output ? toCodexSchema(output.schema) : undefined, images },
      { baseDir: CWD, env, timeoutMs: TIMEOUT_MS, signal: clientGone, model: CODEX_MODEL, reasoning: CODEX_REASONING, ephemeral: CODEX_EPHEMERAL, bin: CODEX_BIN },
    );
    return codexResult(r, output, Date.now() - started);
  } catch {
    // Temp-dir or spawn failures; their messages may carry paths, so only the code is returned.
    return { status: 502, body: { ok: false, error: 'sdk_exception', ms: Date.now() - started } };
  }
}

/** A Codex outcome as the HTTP result; `output` is the (wrapped) schema when the request had one. */
function codexResult(r: CodexOutcome, output: ReturnType<typeof wrapRootUnion> | undefined, ms: number): RunResult {
  if (r.kind === 'timeout') return { status: 504, body: { ok: false, error: 'timeout', ms } };
  if (r.kind === 'aborted') return { status: 502, body: { ok: false, error: 'sdk_error', subtype: 'aborted', ms } };
  if (r.kind === 'spawn_error') return { status: 502, body: { ok: false, error: 'sdk_exception', subtype: 'codex_spawn', ms } };
  if (r.kind === 'exit') return { status: 502, body: { ok: false, error: 'sdk_error', subtype: 'codex_exit', ms } };
  if (output) {
    const parsed = parseJsonAnswer(r.text);
    const json = parsed === undefined ? undefined : unwrapResult(dropAddedNulls(parsed, output.schema), output.wrapped);
    if (json === undefined) return { status: 502, body: { ok: false, error: 'no_structured_output', subtype: 'codex', ms } };
    return { status: 200, body: { ok: true, json, ms } };
  }
  const text = r.text.trim();
  if (!text) return { status: 502, body: { ok: false, error: 'no_result', ms } };
  return { status: 200, body: { ok: true, text, ms } };
}

// ---- POST /v1/job engines: the same answer contract, but the model may read the files in `input.dir` ---------------
/** Claude: Read, Glob and Grep only, kept inside the job directory (job.ts); more turns and budget than a plain call. */
const jobWithClaude: JobEngine = async (input: JobEngineInput): Promise<JobEngineResult> => {
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  const onGone = (): void => abort.abort();
  if (input.signal.aborted) onGone();
  else input.signal.addEventListener('abort', onGone, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, input.timeoutMs);
  const output = wrapRootUnion(input.schema);
  const options: Options = {
    ...jobClaudeOptions(input.dir),
    model: input.model || MODEL,
    maxTurns: JOB_MAX_TURNS,
    maxBudgetUsd: JOB_MAX_BUDGET_USD,
    env: childEnv(),
    abortController: abort,
    systemPrompt: input.system ? `${JOB_SYSTEM_PROMPT}\n\n${input.system}` : JOB_SYSTEM_PROMPT,
    outputFormat: { type: 'json_schema', schema: output.schema },
  };
  try {
    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    for await (const msg of query({ prompt: input.prompt, options })) {
      if (msg.type === 'result') {
        result = msg;
        break;
      }
    }
    const ms = Date.now() - started;
    if (timedOut) return { status: 504, body: { ok: false, error: 'timeout', ms } };
    if (!result) return { status: 502, body: { ok: false, error: 'no_result', ms } };
    if (result.subtype !== 'success') return { status: 502, body: { ok: false, error: 'sdk_error', subtype: result.subtype, ms } };
    if (result.is_error) return { status: 502, body: { ok: false, error: 'sdk_error', subtype: 'is_error', ms } };
    const json = result.structured_output === undefined ? undefined : unwrapResult(result.structured_output, output.wrapped);
    if (json === undefined) return { status: 502, body: { ok: false, error: 'no_structured_output', subtype: result.subtype, ms } };
    return { status: 200, body: { ok: true, json, ms } };
  } catch {
    // The error text may echo SDK stderr, so it is not logged or returned.
    const ms = Date.now() - started;
    return timedOut ? { status: 504, body: { ok: false, error: 'timeout', ms } } : { status: 502, body: { ok: false, error: 'sdk_exception', ms } };
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onGone);
    if (!abort.signal.aborted) abort.abort();
  }
};

/** Codex: the same flags as every call (`--sandbox read-only`, so it can read but not write), with the job directory as its cwd. */
const jobWithCodex: JobEngine = async (input: JobEngineInput): Promise<JobEngineResult> => {
  const started = Date.now();
  const output = wrapRootUnion(input.schema);
  const env = childEnv();
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];
  const system = input.system ? `${JOB_SYSTEM_PROMPT}\n\n${input.system}` : JOB_SYSTEM_PROMPT;
  try {
    const r = await runCodex(
      { prompt: `<system>\n${system}\n</system>\n\n${input.prompt}`, schema: toCodexSchema(output.schema) },
      { baseDir: CWD, cwd: input.dir, env, timeoutMs: input.timeoutMs, signal: input.signal, model: CODEX_MODEL, reasoning: JOB_CODEX_REASONING, ephemeral: CODEX_EPHEMERAL, bin: CODEX_BIN },
    );
    const m = codexResult(r, output, Date.now() - started);
    if (m.status !== 200) return { status: m.status, body: m.body };
    if (m.body.json === undefined) return { status: 502, body: { ok: false, error: 'no_structured_output', subtype: 'codex', ms: m.body.ms } };
    return { status: 200, body: { ok: true, json: m.body.json, ms: m.body.ms } };
  } catch {
    return { status: 502, body: { ok: false, error: 'sdk_exception', ms: Date.now() - started } };
  }
};

const jobEngine: JobEngine = ENGINE === 'codex' ? jobWithCodex : jobWithClaude;

// ---- HTTP -----------------------------------------------------------------
class BodyTooLarge extends Error {}

/** `error`, with the subtype (or, for rejected job files, the fixed reason code) after a colon: for the log line. */
function errorTag(body: { error: string; subtype?: string; reason?: string }): string {
  const detail = body.subtype ?? body.reason;
  return body.error + (detail ? `:${detail}` : '');
}

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
  const given = /^Bearer (.+)$/.exec(h)?.[1];
  if (!given) return false;
  const a = Buffer.from(given);
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
  const given = String(req.headers['x-request-id'] || '');
  const rid = /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomUUID();
  // A queued request whose client went away is dropped before it runs.
  let clientGone = false;
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(); // also stops a call that is already running
    }
  });
  const started = Date.now();
  const route = (req.url || '/').split('?')[0];
  const meta: Record<string, unknown> = { rid, method: req.method, route };
  let status = 500;
  let resBytes = 0;
  try {
    if (req.method === 'GET' && route === '/health') {
      status = 200;
      resBytes = send(res, 200, { ok: true, mode: MODE, model: HEALTH_MODEL, git_sha: GIT_SHA, active, queued: waiters.length, job_timeout_ms: JOB_TIMEOUT_MS });
      return;
    }
    const isComplete = route === '/v1/complete';
    const isVision = route === '/v1/vision';
    const isJob = route === '/v1/job';
    if (!isComplete && !isVision && !isJob) {
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
    const v = (isJob ? JobBody : isVision ? VisionBody : CompleteBody).safeParse(parsed);
    if (!v.success) {
      status = 400;
      // Only field paths, never values.
      resBytes = send(res, 400, { ok: false, error: 'invalid_body', fields: v.error.issues.map((i) => i.path.join('.')) });
      return;
    }
    const body = v.data as CompleteReq | VisionReq | JobRequest;
    if (body.model && !MODELS.has(body.model)) {
      status = 400;
      resBytes = send(res, 400, { ok: false, error: 'model_not_allowed', allowed: [...MODELS] });
      return;
    }
    meta.model = ENGINE === 'codex' ? HEALTH_MODEL : body.model || MODEL;
    meta.schema = !!body.schema;
    if (isVision) meta.images = (body as VisionReq).images.length;
    // Counts and sizes only, never paths or contents.
    if (isJob) {
      meta.files = (body as JobRequest).files.length;
      meta.job_chars = (body as JobRequest).files.reduce((n, f) => n + f.content.length, 0);
    }

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
    if (clientGone) {
      release();
      status = 499;
      meta.error = 'client_gone';
      return;
    }
    try {
      const r: RunResult | JobResult = isJob
        ? await runJob(body as JobRequest, jobEngine, { baseDir: CWD, timeoutMs: JOB_TIMEOUT_MS, signal: clientAbort.signal })
        : await run(body as CompleteReq | VisionReq, isVision ? (body as VisionReq).images : undefined, clientAbort.signal);
      if (clientGone) {
        status = 499;
        meta.error = 'client_gone';
        meta.run_ms = r.body.ms;
        return;
      }
      status = r.status;
      meta.first_ms = 'firstMs' in r ? r.firstMs : undefined;
      meta.run_ms = r.body.ms;
      if (!r.body.ok) meta.error = errorTag(r.body);
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
server.requestTimeout = Math.max(TIMEOUT_MS, JOB_TIMEOUT_MS) + 30_000;

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
  log({ level: 'info', msg: 'runner listening', host: HOST, port: PORT, mode: MODE, model: HEALTH_MODEL, concurrency: CONCURRENCY, job_timeout_ms: JOB_TIMEOUT_MS, git_sha: GIT_SHA });
  if (ENGINE === 'claude') void prewarm();
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
