import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerClient } from './runner-client.mjs';
const env = { RUNNER_URL: 'http://127.0.0.1:8787', RUNNER_TOKEN: 'synthetic-token-for-test' };
const input = { images: [{ media_type: 'image/png', data: 'synthetic-base64' }],
  prompt: 'Read visible text', schema: { type: 'object' } };

test('doc-5 URL, bearer and structured request/response with injected transport', async () => {
  const runner = createRunnerClient({ env, transport: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/v1/vision');
    assert.equal(options.headers.authorization, `Bearer ${env.RUNNER_TOKEN}`);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), input);
    return Response.json({ ok: true, json: { customer: null }, ms: 120 });
  } });
  assert.deepEqual(await runner.vision(input), { json: { customer: null }, ms: 120 });
});

test('missing configuration is visible without a network request', async () => {
  const runner = createRunnerClient({ env: {}, transport: () => assert.fail('network') });
  await assert.rejects(runner.vision(input), { code: 'runner_unconfigured' });
});

test('status errors expose safe codes without provider bodies', async () => {
  for (const [status, code] of [[401, 'runner_auth'], [403, 'runner_auth'], [413, 'runner_limit'],
    [429, 'runner_limit'], [504, 'runner_timeout'], [502, 'runner_unavailable']]) {
    const runner = createRunnerClient({ env, transport: async () => new Response('private payload', { status }) });
    await assert.rejects(runner.vision(input), error => error.code === code && !error.message.includes('private'));
  }
});

test('invalid JSON, failed results, text-only and oversized results are never successes', async () => {
  for (const response of [new Response('not json'), Response.json({ ok: false }),
    Response.json({ ok: true, text: 'unvalidated', ms: 1 }),
    Response.json({ ok: true, json: [], ms: 1 }),
    new Response('x'.repeat(2000))]) {
    const runner = createRunnerClient({ env, maxResponseBytes: 1000, transport: async () => response });
    await assert.rejects(runner.vision(input), { code: 'runner_invalid_response' });
  }
});

test('transport failures are sanitized and aborted calls do not start transport', async () => {
  const runner = createRunnerClient({ env, transport: async () => { throw new Error('private token'); } });
  await assert.rejects(runner.vision(input), { code: 'runner_unavailable', message: 'runner_unavailable' });
  const controller = new AbortController(); controller.abort();
  const never = createRunnerClient({ env, transport: () => assert.fail('network') });
  await assert.rejects(never.vision(input, { signal: controller.signal }), { name: 'AbortError' });
});

test('timeout propagates abort to transport and produces a typed failure', async () => {
  const runner = createRunnerClient({ env, timeoutMs: 5, transport: async (_, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  // AbortSignal.timeout is unref'ed; keep the synthetic test process alive until it fires.
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(runner.vision(input), { code: 'runner_timeout' }); }
  finally { clearTimeout(keepAlive); }
});
