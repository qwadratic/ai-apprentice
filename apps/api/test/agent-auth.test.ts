import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createApi } from '../src/app.ts';
import { createAgent } from '../agent/index.ts';
import { ORIGIN, issue, requestWith, start, tempDir } from './agent-helpers.ts';

test('POST /api/agent/sessions issues a 32-byte token and stores only its hash', async (t) => {
  const { base, dir } = await start(t);
  const before = Date.now();
  const s = await issue(base);
  assert.deepEqual(Object.keys(s).sort(), ['issuedAtMs', 'serverNowMs', 'sessionId', 'token'], 'no sessionEpochMs: the browser picks the timeline epoch');
  assert.match(s.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(Buffer.from(s.token, 'base64url').length, 32);
  assert.ok(s.issuedAtMs >= before && s.issuedAtMs <= s.serverNowMs && s.serverNowMs <= Date.now());
  const stored = await readFile(join(dir, 'agent-sessions.json'), 'utf8');
  assert.ok(!stored.includes(s.token), 'the raw token must not be stored');
  const hash = createHash('sha256').update(s.token).digest('hex');
  assert.ok(stored.includes(hash));
  const record = (JSON.parse(stored) as { sessions: Array<{ sessionId: string; createdAt: number; expiresAt: number }> }).sessions[0];
  assert.equal(record?.sessionId, s.sessionId);
  assert.equal((record?.expiresAt ?? 0) - (record?.createdAt ?? 0), 12 * 3_600_000);
  const second = await issue(base);
  assert.notEqual(second.token, s.token);
  assert.notEqual(second.sessionId, s.sessionId);
});

test('authorize() with and without a session id', async (t) => {
  const { base, agent } = await start(t);
  const a = await issue(base);
  const b = await issue(base);
  const auth = (token: string): string => `Bearer ${token}`;
  assert.equal(await agent.authorize(requestWith(auth(a.token)), a.sessionId), true);
  assert.equal(await agent.authorize(requestWith(auth(a.token)), null), true);
  assert.equal(await agent.authorize(requestWith(auth(b.token)), a.sessionId), false, 'another session\'s token');
  assert.equal(await agent.authorize(requestWith(auth(b.token)), null), true);
  assert.equal(await agent.authorize(requestWith(auth(a.token)), 'no-such-session'), false);
  assert.equal(await agent.authorize(requestWith(auth('A'.repeat(43))), a.sessionId), false, 'wrong token');
  assert.equal(await agent.authorize(requestWith(auth('A'.repeat(43))), null), false);
  assert.equal(await agent.authorize(requestWith(), a.sessionId), false, 'missing header');
  assert.equal(await agent.authorize(requestWith(), null), false);
  assert.equal(await agent.authorize(requestWith(`Basic ${a.token}`), null), false, 'wrong scheme');
  assert.equal(await agent.authorize(requestWith('Bearer '), null), false);
});

test('an expired session no longer authorizes', async (t) => {
  let now = 1_700_000_000_000;
  const dir = await tempDir(t);
  const agent = createAgent({ allowedOrigins: [ORIGIN], sessionsDir: dir, log: () => {}, now: () => now, sessionTtlMs: 1000 });
  const s = await agent.store.issue();
  const req = requestWith(`Bearer ${s.token}`);
  assert.equal(await agent.authorize(req, s.sessionId), true);
  now += 999;
  assert.equal(await agent.authorize(req, null), true);
  now += 2;
  assert.equal(await agent.authorize(req, s.sessionId), false);
  assert.equal(await agent.authorize(req, null), false);
  // A session file written before a restart is also pruned when loaded after its expiry.
  const reloaded = createAgent({ allowedOrigins: [ORIGIN], sessionsDir: dir, log: () => {}, now: () => now });
  assert.equal(await reloaded.authorize(req, null), false);
});

test('sessions survive a restart (a fresh agent over the same directory)', async (t) => {
  const first = await start(t);
  const s = await issue(first.base);
  const reloaded = createAgent({ allowedOrigins: [ORIGIN], sessionsDir: first.dir, log: () => {} });
  assert.equal(await reloaded.authorize(requestWith(`Bearer ${s.token}`), s.sessionId), true);
  assert.equal(await reloaded.authorize(requestWith(`Bearer ${'B'.repeat(43)}`), s.sessionId), false);
});

test('the exported module and authorize() read the environment and survive a module reload', async (t) => {
  const dir = await tempDir(t);
  const saved = { dir: process.env.SESSIONS_DIR, origins: process.env.ALLOWED_ORIGINS };
  process.env.SESSIONS_DIR = dir;
  process.env.ALLOWED_ORIGINS = ORIGIN;
  t.after(() => {
    for (const [key, value] of [['SESSIONS_DIR', saved.dir], ['ALLOWED_ORIGINS', saved.origins]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  type AgentIndex = typeof import('../agent/index.ts');
  const load = async (tag: string): Promise<AgentIndex> => await import(`../agent/index.ts?${tag}`) as AgentIndex;
  const one = await load('reload-1');
  const app = await createApi({ allowedOrigins: [ORIGIN], modules: [one.agentModule] });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const r = await fetch(`http://127.0.0.1:${address.port}/api/agent/sessions`, { method: 'POST', headers: { Origin: ORIGIN } });
  const s = await r.json() as { sessionId: string; token: string };
  assert.equal(await one.authorize(requestWith(`Bearer ${s.token}`), s.sessionId), true);
  const two = await load('reload-2');
  assert.notEqual(two, one);
  assert.equal(await two.authorize(requestWith(`Bearer ${s.token}`), s.sessionId), true);
  assert.equal(await two.authorize(requestWith(), null), false);
});

test('doc-9 shape: `mount` is a named export next to agentModule', async () => {
  const index = await import('../agent/index.ts');
  assert.equal(typeof index.mount, 'function');
  assert.equal(index.agentModule.name, 'agent');
  assert.equal(index.agentModule.mount, index.mount);
  assert.equal(typeof index.authorize, 'function');
});

test('authorize() protects real screen start and frame routes with session-scoped semantics', async (t) => {
  const { parseScreenObservation, parseScreenStatus } = await import('@apprentice/contracts');
  const { createScreenModule } = await import('../src/screen-module.ts');
  const { ScreenSessionHub, createMemoryEvidenceStore, createScreenService } = await import('../screen/index.ts');
  const { agent } = await start(t);
  const runner = { async vision() { return { json: { outcome: 'incomplete', reason: 'unreadable' }, ms: 1 }; } };
  const evidence = createMemoryEvidenceStore();
  const hub = new ScreenSessionHub(({ publish, onEvent }) => createScreenService({
    runner, evidence, publish, onEvent, parseObservation: parseScreenObservation,
    queueOptions: { sampleIntervalMs: 0 },
  }), parseScreenStatus);
  const screen = createScreenModule({ allowedOrigins: [ORIGIN], hub, authorize: agent.authorize });
  const app = await createApi({ allowedOrigins: [ORIGIN], modules: [screen] });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const a = await agent.store.issue();
  const b = await agent.store.issue();
  const base = `http://127.0.0.1:${address.port}/screen/sessions/${a.sessionId}`;
  const headers = (token: string | null) => ({ Origin: ORIGIN, 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const started = await fetch(`${base}/start`, { method: 'POST', headers: headers(a.token),
    body: JSON.stringify({ sessionEpochMs: Date.now(), clientGeneration: 1 }) });
  assert.equal(started.status, 201);
  assert.equal('sessionToken' in (await started.json() as Record<string, unknown>), false);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
  const frame = JSON.stringify({ generation: 1, frameId: 'f1', timestampMs: 1, processed: true,
    mediaType: 'image/png', data: png,
    provenance: { surface: 'email', sourceRevision: 'email-r1', captureGeneration: 1 } });
  const post = (token: string | null) => fetch(`${base}/frames`, {
    method: 'POST', headers: headers(token), body: frame,
  });
  assert.equal((await post(null)).status, 401, 'no token');
  assert.equal((await post(b.token)).status, 403, 'valid token of another session');
  assert.equal((await post(a.token)).status, 202, 'own session reaches the real screen hub');
});
