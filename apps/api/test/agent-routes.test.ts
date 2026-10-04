import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchFn } from '../agent/index.ts';
import { EL_AGENT, EL_KEY, ORIGIN, bearer, issue, json, postHeaders, start } from './agent-helpers.ts';

const SIGNED = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=sig-secret';

interface Stub { fetch: FetchFn; calls: Array<{ url: string; key: string | null }> }
function elevenStub(conversation: Record<string, unknown> = { status: 'done', agent_id: EL_AGENT, transcript: [] }): Stub {
  const calls: Stub['calls'] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, key: new Headers(init?.headers).get('xi-api-key') });
    if (url.includes('/get-signed-url')) return Response.json({ signed_url: SIGNED });
    if (url.endsWith('/audio')) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'audio/mpeg' } });
    if (url.includes('/conversations/')) return Response.json(conversation);
    return new Response('unexpected', { status: 500 });
  };
  return { fetch: fetchFn, calls };
}

const ev = (text: string) => ({ t: 1, dir: 'sent', type: 'user_transcript', text });

test('origin is checked on every route; no Origin is accepted only from direct loopback', async (t) => {
  const { base } = await start(t, { fetch: elevenStub().fetch });
  const s = await issue(base);
  const post = (path: string, headers: Record<string, string>, body = '{}') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('/api/agent/sessions', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/agent/sessions', { 'X-Forwarded-For': '203.0.113.9' })).status, 403, 'proxied request without Origin');
  assert.equal((await post('/api/agent/sessions', {})).status, 201, 'loopback dev without Origin');
  assert.equal((await post(`/api/agent/sessions/${s.sessionId}/events`, { Origin: 'https://evil.example', ...bearer(s.token) })).status, 403);
  assert.equal((await post(`/api/agent/sessions/${s.sessionId}/events`, { 'X-Forwarded-For': '203.0.113.9', ...bearer(s.token) }, json({ events: [ev('x')] }))).status, 403);
  assert.equal((await fetch(`${base}/api/agent/elevenlabs/signed-url`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
});

test('session creation is rate limited per IP', async (t) => {
  const { base } = await start(t, { limits: { sessionsPerMinute: 2 } });
  assert.equal((await fetch(`${base}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN } })).status, 201);
  assert.equal((await fetch(`${base}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN } })).status, 201);
  const limited = await fetch(`${base}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await fetch(`${base}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN, 'X-Forwarded-For': '203.0.113.7' } })).status, 201, 'another client IP has its own window');
});

test('signed-url: server key, no-store, optional/required token, rate limit, nothing sensitive logged', async (t) => {
  const stub = elevenStub();
  const logs: unknown[] = [];
  const { base } = await start(t, { fetch: stub.fetch, log: (f) => { logs.push(f); }, limits: { signedUrlPerMinute: 3 } });
  const s = await issue(base);
  const get = (headers: Record<string, string>) => fetch(`${base}/api/agent/elevenlabs/signed-url`, { headers: { Origin: ORIGIN, ...headers } });
  const ok = await get({});
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { signed_url: SIGNED });
  assert.equal(stub.calls[0]?.key, EL_KEY);
  assert.ok(stub.calls[0]?.url.includes(`agent_id=${EL_AGENT}`));
  assert.equal((await get({ Authorization: 'Bearer ' + 'C'.repeat(43) })).status, 401, 'a token that is sent must be valid');
  assert.equal((await get(bearer(s.token))).status, 200);
  assert.equal((await get({})).status, 429);
  const text = JSON.stringify(logs);
  for (const secret of [SIGNED, 'sig-secret', EL_KEY, s.token]) assert.ok(!text.includes(secret));
});

test('signed-url can require a session token, and reports missing configuration', async (t) => {
  const strict = await start(t, { fetch: elevenStub().fetch, signedUrlRequiresSession: true });
  const s = await issue(strict.base);
  const url = `${strict.base}/api/agent/elevenlabs/signed-url`;
  assert.equal((await fetch(url, { headers: { Origin: ORIGIN } })).status, 401);
  assert.equal((await fetch(url, { headers: { Origin: ORIGIN, ...bearer(s.token) } })).status, 200);
  const bare = await start(t, { elevenLabsApiKey: '', elevenLabsAgentIdInterviewer: '' });
  const r = await fetch(`${bare.base}/api/agent/elevenlabs/signed-url`, { headers: { Origin: ORIGIN } });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'elevenlabs_not_configured', missing: ['ELEVENLABS_AGENT_ID_INTERVIEWER', 'ELEVENLABS_API_KEY'] });
});

test('events: token required, own session only, appended as JSONL', async (t) => {
  const { base, dir } = await start(t);
  const a = await issue(base);
  const b = await issue(base);
  const url = `${base}/api/agent/sessions/${a.sessionId}/events`;
  const body = json({ conversationId: 'conv_1', events: [ev('hello'), { t: 2, dir: 'recv', type: 'agent_response', text: 'why?' }] });
  const noToken = await fetch(url, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body });
  assert.equal(noToken.status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders('D'.repeat(43)), body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(b.token), body })).status, 403);
  const ok = await fetch(url, { method: 'POST', headers: postHeaders(a.token), body });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, stored: 2 });
  const lines = (await readFile(join(dir, `${a.sessionId}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.text, 'hello');
  assert.equal(lines[0]?.conversationId, 'conv_1');
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith(b.sessionId)), []);
  // A text/plain body (no JSON parsing by createApi) is read from the stream.
  const plain = await fetch(url, { method: 'POST', headers: { ...postHeaders(a.token), 'Content-Type': 'text/plain' }, body: json({ events: [ev('plain')] }) });
  assert.equal(plain.status, 200);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: json({ conversationId: 'conv_2', events: [ev('x')] }) })).status, 409);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: json({ events: [{ t: 1, dir: 'bogus', type: 'x', text: 'x' }] }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: '{"events":' })).status, 400);
  assert.equal((await fetch(`${base}/api/agent/sessions/bad id/events`, { method: 'POST', headers: postHeaders(a.token), body })).status, 400);
});

test('events: body over 512 KiB is 413, a full session file is 507, rate limit and hourly cap are 429', async (t) => {
  const { base } = await start(t, { limits: { eventsPerMinute: 5, sessionFileBytes: 600, eventBytesPerHour: 2000 } });
  const s = await issue(base);
  const url = `${base}/api/agent/sessions/${s.sessionId}/events`;
  const post = (body: string) => fetch(url, { method: 'POST', headers: postHeaders(s.token), body });
  const big = await post(json({ events: [ev('x'.repeat(520 * 1024))] }));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { ok: false, error: 'body_too_large', max_bytes: 512 * 1024 });
  assert.equal((await post(json({ events: [ev('a'.repeat(300))] }))).status, 200);
  const full = await post(json({ events: [ev('b'.repeat(400))] }));
  assert.equal(full.status, 507);
  assert.equal(((await full.json()) as { error: string }).error, 'session_full');
  const cap = await post(json({ events: [ev('c'.repeat(1800))] }));
  assert.equal(cap.status, 429);
  assert.equal(((await cap.json()) as { error: string }).error, 'hourly_byte_cap');
  assert.equal((await post(json({ events: [ev('d')] }))).status, 200);
  assert.equal((await post(json({ events: [ev('e')] }))).status, 429, 'sixth request in the window is limited');
});

test('finish: token required, stores transcript, fetches audio in the background', async (t) => {
  const stub = elevenStub();
  const { base, dir, agent } = await start(t, { fetch: stub.fetch, limits: { finishPerMinute: 20 } });
  const a = await issue(base);
  const b = await issue(base);
  const url = `${base}/api/agent/sessions/${a.sessionId}/finish`;
  const body = json({ conversationId: 'conv_1' });
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(b.token), body })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: json({ conversationId: 'bad id!' }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: json({ conversationId: 'c'.repeat(5000) }) })).status, 413);
  const r = await fetch(url, { method: 'POST', headers: postHeaders(a.token), body });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, transcriptStored: true, partial: false, conversationStatus: 'done', audioStored: false, audioPending: true });
  await agent.idle();
  const stored = JSON.parse(await readFile(join(dir, `${a.sessionId}.elevenlabs.json`), 'utf8')) as { status: string };
  assert.equal(stored.status, 'done');
  assert.deepEqual([...await readFile(join(dir, `${a.sessionId}.mp3`))], [1, 2, 3, 4]);
  assert.equal(await readFile(join(dir, `${a.sessionId}.conv`), 'utf8'), 'conv_1');
  assert.ok(stub.calls.every((c) => c.key === EL_KEY));
  const again = await fetch(url, { method: 'POST', headers: postHeaders(a.token), body });
  assert.deepEqual(await again.json(), { ok: true, transcriptStored: true, partial: false, audioStored: true, already: true });
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders(a.token), body: json({ conversationId: 'conv_other' }) })).status, 409);
});

test('finish rejects conversations of other agents', async (t) => {
  const { base } = await start(t, { fetch: elevenStub({ status: 'done', agent_id: 'someone_elses_agent' }).fetch });
  const s = await issue(base);
  const r = await fetch(`${base}/api/agent/sessions/${s.sessionId}/finish`, { method: 'POST', headers: postHeaders(s.token), body: json({ conversationId: 'conv_1' }) });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { ok: false, error: 'agent_not_allowed' });
});
