import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, PRODUCTION_API_BASE, createAgentApi, httpErrorMessage, resolveApiBase } from '../api.ts';
import type { Responder } from './helpers.ts';
import { SIGNED_URL, TOKEN, json, legacyApi, modernApi, recordingFetch } from './helpers.ts';

const BASE = 'https://api.example.invalid';
const make = (...responders: Responder[]) => {
  const { fetch, calls } = recordingFetch(...responders);
  let t = 5000;
  const api = createAgentApi({ base: BASE, fetch, now: () => (t += 100), newId: () => 'legacy-id-1' });
  return { api, calls };
};

test('resolveApiBase: production default, dev default, explicit override', () => {
  assert.equal(resolveApiBase(undefined, true), PRODUCTION_API_BASE);
  assert.equal(PRODUCTION_API_BASE, 'https://apprentice.exe.xyz');
  assert.equal(resolveApiBase(undefined, false), '');
  assert.equal(resolveApiBase('', true), '');
  assert.equal(resolveApiBase(' http://127.0.0.1:8000/// ', false), 'http://127.0.0.1:8000');
  assert.equal(resolveApiBase(42, true), PRODUCTION_API_BASE);
});

test('createSession: 201 gives a token session on the /api/agent routes', async () => {
  const { api, calls } = make(modernApi({ sessionId: 'sess-42' }));
  const session = await api.createSession();
  assert.equal(session.legacy, false);
  assert.equal(session.sessionId, 'sess-42');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.url, `${BASE}/api/agent/sessions`);
  assert.equal(session.events().url, `${BASE}/api/agent/sessions/sess-42/events`);
  assert.equal(session.finish().url, `${BASE}/api/agent/sessions/sess-42/finish`);
  assert.equal(session.signedUrl('interviewer').url, `${BASE}/api/agent/elevenlabs/signed-url?role=interviewer`);
  for (const req of [session.events(), session.finish(), session.signedUrl('tutor')]) {
    assert.equal(req.headers['Authorization'], `Bearer ${TOKEN}`);
  }
  assert.equal(typeof session.clockSkewMs, 'number');
  assert.equal(session.issuedAtMs, 1_000_000);
});

test('createSession: 404 falls back to the legacy routes without a token (temporary)', async () => {
  const { api, calls } = make(legacyApi());
  const session = await api.createSession();
  assert.equal(calls[0]?.url, `${BASE}/api/agent/sessions`);
  assert.equal(session.legacy, true);
  assert.equal(session.sessionId, 'legacy-id-1');
  assert.equal(session.clockSkewMs, null);
  assert.equal(session.events().url, `${BASE}/agent/sessions/legacy-id-1/events`);
  assert.equal(session.finish().url, `${BASE}/agent/sessions/legacy-id-1/finish`);
  assert.equal(session.signedUrl('interviewer').url, `${BASE}/agent/elevenlabs/signed-url?role=interviewer`);
  assert.deepEqual(session.events().headers, {});
  assert.deepEqual(session.signedUrl('interviewer').headers, {});
});

test('createSession: other statuses and network errors do not fall back', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { api, calls } = make((req) => (req.url.endsWith('/api/agent/sessions') ? json(status, { ok: false }) : null));
    await assert.rejects(() => api.createSession(), (e: unknown) => e instanceof ApiError && e.status === status);
    assert.equal(calls.length, 1, `status ${status} must not retry on legacy routes`);
  }
  const down = createAgentApi({
    base: BASE, now: () => 1, newId: () => 'x',
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  await assert.rejects(() => down.createSession(), (e: unknown) => e instanceof ApiError && e.status === null && /Cannot reach/.test(e.message));
});

test('createSession: a 201 without token is an error, not a legacy session', async () => {
  const { api } = make((req) => (req.url.endsWith('/api/agent/sessions') ? json(201, { sessionId: 's' }) : null));
  await assert.rejects(() => api.createSession(), /sessionId, token/);
});

test('fetchSignedUrl sends the bearer token and returns the URL; errors never contain it', async () => {
  const { api, calls } = make(modernApi());
  const session = await api.createSession();
  const url = await api.fetchSignedUrl(session, 'interviewer');
  assert.equal(url, SIGNED_URL);
  const call = calls[1];
  assert.equal(call?.headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(call?.method, 'GET');

  const { api: refused } = make(modernApi({ signedUrlStatus: 503 }));
  const s2 = await refused.createSession();
  await assert.rejects(() => refused.fetchSignedUrl(s2, 'interviewer'), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test('fetchSignedUrl on a legacy session sends no Authorization header', async () => {
  const { api, calls } = make(legacyApi());
  const session = await api.createSession();
  await api.fetchSignedUrl(session, 'interviewer');
  const call = calls[1];
  assert.equal(call?.url, `${BASE}/agent/elevenlabs/signed-url?role=interviewer`);
  assert.equal(call?.headers['authorization'], undefined);
});

test('httpErrorMessage names the cause', () => {
  assert.match(httpErrorMessage(403, 'x'), /origin/);
  assert.match(httpErrorMessage(429, 'x'), /too many/);
  assert.match(httpErrorMessage(500, 'x'), /500/);
});
