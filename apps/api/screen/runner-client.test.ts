import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerClient} from './runner-client.ts';
import type {VisionRunnerRequest} from './runner-client.ts';

const env = {RUNNER_URL: 'http://127.0.0.1:8787', RUNNER_TOKEN: 'synthetic-token-for-test'};
const input: VisionRunnerRequest = {images: [{media_type: 'image/png', data: 'synthetic-base64'}],
  prompt: 'Read visible text', schema: {type: 'object'}};
test('uses the doc-5 runner route and bearer token', async () => {
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/v1/vision');
    assert.equal((options?.headers as Record<string, string>).authorization, `Bearer ${env.RUNNER_TOKEN}`);
    assert.deepEqual(JSON.parse(String(options?.body)), input);
    return Response.json({ok: true, json: {customer: null}, ms: 120});
  };
  assert.deepEqual(await createRunnerClient({env, transport}).vision(input), {json: {customer: null}, ms: 120});
});
test('missing configuration is visible without network access', async () => {
  const transport: typeof fetch = async () => { throw new Error('network must not run'); };
  await assert.rejects(createRunnerClient({env: {}, transport}).vision(input), {code: 'runner_unconfigured'});
});
test('status failures map to safe codes without provider bodies', async () => {
  for (const [status, code] of [[401, 'runner_auth'], [429, 'runner_limit'], [504, 'runner_timeout'], [502, 'runner_unavailable']] as const) {
    const transport: typeof fetch = async () => new Response('private provider text', {status});
    await assert.rejects(createRunnerClient({env, transport}).vision(input), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === code && !error.message.includes('private'));
  }
});
test('invalid and oversized responses never become structured successes', async () => {
  const responses = [new Response('not json'), Response.json({ok: false}),
    Response.json({ok: true, text: 'unvalidated', ms: 1}), Response.json({ok: true, json: [], ms: 1}),
    new Response('x'.repeat(2000))];
  for (const response of responses) {
    const transport: typeof fetch = async () => response;
    await assert.rejects(createRunnerClient({env, transport, maxResponseBytes: 1000}).vision(input), {code: 'runner_invalid_response'});
  }
});
test('transport errors are sanitized and timeout aborts transport', async () => {
  const failure: typeof fetch = async () => { throw new Error('private details'); };
  await assert.rejects(createRunnerClient({env, transport: failure}).vision(input), {code: 'runner_unavailable'});
  const waiting: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
  });
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(createRunnerClient({env, transport: waiting, timeoutMs: 5}).vision(input), {code: 'runner_timeout'}); }
  finally { clearTimeout(keepAlive); }
});
