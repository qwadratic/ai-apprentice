// POST /api/agent/llm/:task: typed input in, schema-checked JSON out, through the internal Claude runner.
// The prompts and schemas are fixed server-side per task. Inputs, outputs and tokens are never logged.
import type { Express, Request, Response } from 'express';
import { clientIp, isRecord, makeLimiter } from './config.ts';
import type { AgentConfig } from './config.ts';
import { LLM_TASKS } from './llm-tasks.ts';
import type { RunnerRequest } from './llm-tasks.ts';
import { originAllowed, readBody, reply } from './routes.ts';
import type { AgentRuntime } from './routes.ts';

export type LlmError = 'llm_not_configured' | 'runner_unavailable' | 'runner_auth' | 'runner_busy' | 'runner_timeout' | 'runner_error' | 'invalid_output';
type RunnerResult = { ok: true; json: unknown } | { ok: false; status: 502 | 503 | 504; error: LlmError };
const MAX_RUNNER_RESPONSE = 256 * 1024;

/** Reads at most `max` bytes of a response body; null when it is larger. */
async function boundedText(r: globalThis.Response, max: number): Promise<string | null> {
  if (!r.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > max) { await r.body.cancel().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function callRunner(config: AgentConfig, request: RunnerRequest, signal: AbortSignal): Promise<RunnerResult> {
  if (!config.runnerToken || !config.runnerUrl) return { ok: false, status: 503, error: 'llm_not_configured' };
  let url: URL;
  try { url = new URL('/v1/complete', config.runnerUrl); } catch { return { ok: false, status: 503, error: 'llm_not_configured' }; }
  const timeout = AbortSignal.timeout(config.timing.llmTimeoutMs);
  try {
    const r = await config.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.runnerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: request.system, prompt: request.prompt, schema: request.schema }),
      signal: AbortSignal.any([timeout, signal]),
    });
    if (r.status === 401 || r.status === 403) { await r.arrayBuffer().catch(() => {}); return { ok: false, status: 503, error: 'runner_auth' }; }
    if (r.status === 413 || r.status === 429) { await r.arrayBuffer().catch(() => {}); return { ok: false, status: 503, error: 'runner_busy' }; }
    if (r.status === 504) { await r.arrayBuffer().catch(() => {}); return { ok: false, status: 504, error: 'runner_timeout' }; }
    const raw = await boundedText(r, MAX_RUNNER_RESPONSE);
    if (r.status !== 200 || raw === null) return { ok: false, status: 502, error: 'runner_error' };
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return { ok: false, status: 502, error: 'runner_error' }; }
    if (!isRecord(body) || body.ok !== true || !('json' in body)) return { ok: false, status: 502, error: 'runner_error' };
    return { ok: true, json: body.json };
  } catch {
    // Not logged: the error text could echo request data.
    return timeout.aborted ? { ok: false, status: 504, error: 'runner_timeout' } : { ok: false, status: 503, error: 'runner_unavailable' };
  }
}

export function registerLlmRoutes(app: Express, rt: AgentRuntime): void {
  const { config, store } = rt;
  const perIp = makeLimiter({ perMinute: config.limits.llmPerIpPerMinute }, config.now);
  const perSession = makeLimiter({ perMinute: config.limits.llmPerSessionPerMinute }, config.now);
  const limited = (res: Response): void => reply(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' });

  app.post('/api/agent/llm/:task', async (req: Request, res: Response) => {
    if (!originAllowed(config, req)) { reply(res, 403, { ok: false, error: 'origin_not_allowed' }); return; }
    if (perIp(clientIp(req))) { limited(res); return; }
    // The route carries no session id: the token identifies its session, which is then the rate-limit key.
    const auth = store.check(req.get('Authorization'), null);
    if (!auth.ok) { reply(res, 401, { ok: false, error: 'unauthorized' }); return; }
    const name = String(req.params.task);
    const task = Object.hasOwn(LLM_TASKS, name) ? LLM_TASKS[name] : undefined;
    if (!task) { reply(res, 404, { ok: false, error: 'unknown_task' }); return; }
    if (perSession(auth.sessionId)) { limited(res); return; }
    const raw = await readBody(req, config.limits.llmInputBytes);
    if (!raw.ok) { reply(res, raw.status, { ok: false, error: raw.error, max_bytes: raw.maxBytes }); return; }
    const prepared = task.prepare(raw.body);
    if (!prepared.ok) { reply(res, 400, { ok: false, error: 'invalid_input', field: prepared.field }); return; }

    const aborted = new AbortController();
    res.on('close', () => { if (!res.writableEnded) aborted.abort(); });
    const result = await callRunner(config, prepared.request, aborted.signal);
    if (aborted.signal.aborted) return; // the client went away
    if (!result.ok) {
      config.log({ level: 'warn', msg: 'llm call failed', task: name, status: result.status, error: result.error });
      reply(res, result.status, { ok: false, error: result.error }, result.error === 'runner_busy' ? { 'Retry-After': '5' } : {});
      return;
    }
    const output = prepared.check(result.json);
    if (output === null) {
      config.log({ level: 'warn', msg: 'llm call failed', task: name, status: 502, error: 'invalid_output' });
      reply(res, 502, { ok: false, error: 'invalid_output' });
      return;
    }
    reply(res, 200, { ok: true, output });
  });
}
