export class RunnerError extends Error {
  readonly code: RunnerErrorCode; readonly status: number | undefined;
  constructor(code: RunnerErrorCode, status?: number) { super(code); this.code = code; this.status = status; }
}
export type RunnerErrorCode = 'runner_unconfigured' | 'runner_limit' | 'runner_auth' |
  'runner_timeout' | 'runner_unavailable' | 'runner_invalid_response';
export interface RunnerImage { readonly media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; readonly data: string }
export interface VisionRunnerRequest {
  readonly images: readonly RunnerImage[]; readonly prompt: string; readonly system?: string;
  readonly schema: Readonly<Record<string, unknown>>; readonly model?: string;
}
export interface VisionRunnerResult { readonly json: Readonly<Record<string, unknown>>; readonly ms: number }
export interface VisionRunner { vision(input: VisionRunnerRequest, options?: {signal?: AbortSignal}): Promise<VisionRunnerResult> }
export interface RunnerClientOptions {
  readonly env?: Readonly<Record<string, string | undefined>>; readonly transport?: typeof fetch;
  readonly timeoutMs?: number; readonly maxResponseBytes?: number;
}
export function createRunnerClient({env = process.env, transport = fetch, timeoutMs = 65_000,
  maxResponseBytes = 1024 * 1024}: RunnerClientOptions = {}): VisionRunner {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('Invalid runner limits');
  }
  return { async vision(input, options = {}) {
    if (!env.RUNNER_URL || !env.RUNNER_TOKEN) throw new RunnerError('runner_unconfigured');
    const url = runnerUrl(env.RUNNER_URL);
    validateInput(input);
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 12_000_000) throw new RunnerError('runner_limit', 413);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const response = await transport(url, {method: 'POST', redirect: 'error',
        headers: {authorization: `Bearer ${env.RUNNER_TOKEN}`, 'content-type': 'application/json'}, body, signal});
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        const code: RunnerErrorCode = [401, 403].includes(response.status) ? 'runner_auth' :
          [413, 429].includes(response.status) ? 'runner_limit' : response.status === 504 ? 'runner_timeout' : 'runner_unavailable';
        throw new RunnerError(code, response.status);
      }
      const raw = await readBounded(response, maxResponseBytes, signal);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new RunnerError('runner_invalid_response'); }
      if (!isRecord(value) || value.ok !== true || !isRecord(value.json) ||
        typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0) {
        throw new RunnerError('runner_invalid_response');
      }
      return {json: value.json, ms: value.ms};
    } catch (error: unknown) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.aborted) throw new RunnerError('runner_timeout', 504);
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('runner_unavailable');
    }
  }};
}
function runnerUrl(configured: string): string {
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/vision`;
    return url.href;
  } catch { throw new RunnerError('runner_unconfigured'); }
}
function validateInput(input: VisionRunnerRequest): void {
  if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 4 ||
    input.images.some(image => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.media_type) || !image.data) ||
    !input.prompt || !isRecord(input.schema)) throw new TypeError('Invalid runner input');
}
async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new RunnerError('runner_invalid_response');
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new RunnerError('runner_invalid_response');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
