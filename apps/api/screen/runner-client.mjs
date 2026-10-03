/** Server-only client for the existing TASK-4.2 runner, as specified in doc-5. */
export class RunnerError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function createRunnerClient({ env = process.env, transport = fetch, timeoutMs = 65000,
  maxResponseBytes = 1024 * 1024 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0) throw new TypeError('Invalid runner limits');
  return {
    async vision({ images, prompt, system, schema, model }, { signal } = {}) {
      if (!env.RUNNER_URL || !env.RUNNER_TOKEN) throw new RunnerError('runner_unconfigured');
      let url;
      try {
        url = new URL(env.RUNNER_URL);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.search || url.hash) throw new Error();
        url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/vision`;
      } catch { throw new RunnerError('runner_unconfigured'); }
      if (!Array.isArray(images) || images.length < 1 || images.length > 4 ||
        images.some(image => !['image/png', 'image/jpeg', 'image/webp'].includes(image.media_type) ||
          typeof image.data !== 'string' || !image.data) ||
        typeof prompt !== 'string' || !prompt || !schema || typeof schema !== 'object') {
        throw new TypeError('Invalid runner input');
      }
      const body = JSON.stringify({ images, prompt, system, schema, model });
      if (Buffer.byteLength(body) > 12_000_000) throw new RunnerError('runner_limit', 413);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        combined.throwIfAborted();
        const response = await transport(url.href, { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${env.RUNNER_TOKEN}`, 'content-type': 'application/json' },
          body, signal: combined });
        combined.throwIfAborted();
        if (!response.ok) {
          // Do not include provider bodies or exception text in diagnostics.
          await response.body?.cancel();
          const code = [401, 403].includes(response.status) ? 'runner_auth' :
            [413, 429].includes(response.status) ? 'runner_limit' :
            response.status === 504 ? 'runner_timeout' : 'runner_unavailable';
          throw new RunnerError(code, response.status);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RunnerError('runner_invalid_response');
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            combined.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > maxResponseBytes) throw new RunnerError('runner_invalid_response');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel(); }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new RunnerError('runner_invalid_response'); }
        if (result?.ok !== true || !result.json || typeof result.json !== 'object' ||
          Array.isArray(result.json) || !Number.isFinite(result.ms) || result.ms < 0) {
          throw new RunnerError('runner_invalid_response');
        }
        // Schema validation belongs to the caller's approved contract validator.
        return { json: result.json, ms: result.ms };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (timeout.aborted) throw new RunnerError('runner_timeout', 504);
        if (error instanceof RunnerError) throw error;
        throw new RunnerError('runner_unavailable');
      }
    },
  };
}
