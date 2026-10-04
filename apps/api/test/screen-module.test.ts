import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import type {Server} from 'node:http';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createApi} from '../src/app.ts';
import {createScreenModule} from '../src/screen-module.ts';
import {createScreenRuntime} from '../src/screen-runtime.ts';
import type {VisionRunner} from '../screen/index.ts';

const origin = 'https://screen.test';
const bearer = 'synthetic-agent-session-token';
const otherBearer = 'synthetic-other-session-token';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('screen module binds agent auth, hides hub credentials and persists Evidence metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screen-module-'));
  const databasePath = path.join(root, 'screen.sqlite');
  const mediaDir = path.join(root, 'media');
  const sessionId = 'session-1';
  const sessionEpochMs = Date.now();
  const runner: VisionRunner = {async vision() { return {json: {outcome: 'observation', kind: 'email_draft',
    facts: {recipientRef: null, subject: 'Synthetic', bodyText: 'Visible', attachments: [], previewState: 'editing'}}, ms: 1}; }};
  const runtime = createScreenRuntime({databasePath, mediaDir, runner});
  t.after(async () => { runtime.close(); await rm(root, {recursive: true, force: true}); });
  const module = createScreenModule({allowedOrigins: [origin], hub: runtime.hub,
    authorize: async (request, requestedSession) => {
      const authorization = request.headers.get('authorization');
      if (requestedSession === null) return authorization === `Bearer ${bearer}` || authorization === `Bearer ${otherBearer}`;
      return requestedSession === sessionId && authorization === `Bearer ${bearer}`;
    }});
  const app = await createApi({allowedOrigins: [origin], modules: [module]});
  const server = app.listen(0, '127.0.0.1');
  t.after(() => close(server));
  const base = await serverUrl(server);
  const headers = {origin, authorization: `Bearer ${bearer}`, 'content-type': 'application/json'};

  const originlessPost = await fetch(`${base}/screen/sessions/${sessionId}/start`, {method: 'POST', headers: {authorization: `Bearer ${bearer}`, 'content-type': 'application/json'}, body: JSON.stringify({sessionEpochMs, clientGeneration: 1})});
  assert.equal(originlessPost.status, 403);
  const denied = await fetch(`${base}/screen/sessions/${sessionId}/start`, {method: 'POST', headers: {...headers, authorization: 'Bearer wrong'}, body: JSON.stringify({sessionEpochMs, clientGeneration: 1})});
  assert.equal(denied.status, 401);
  const crossed = await fetch(`${base}/screen/sessions/${sessionId}/start`, {method: 'POST', headers: {...headers, authorization: `Bearer ${otherBearer}`}, body: JSON.stringify({sessionEpochMs, clientGeneration: 1})});
  assert.equal(crossed.status, 403);
  const started = await fetch(`${base}/screen/sessions/${sessionId}/start`, {method: 'POST', headers, body: JSON.stringify({sessionEpochMs, clientGeneration: 1})});
  assert.equal(started.status, 201);
  const startBody = await started.json() as Record<string, unknown>;
  assert.equal(startBody.sessionId, sessionId);
  assert.equal('sessionToken' in startBody, false);

  const frame = await fetch(`${base}/screen/sessions/${sessionId}/frames`, {method: 'POST', headers, body: JSON.stringify({
    generation: 1, frameId: 'frame-1', timestampMs: 1, processed: true,
    mediaType: 'image/png', data: png.toString('base64'),
    provenance: {surface: 'email', sourceRevision: 'email-r1', captureGeneration: 1},
  })});
  assert.equal(frame.status, 202);

  let evidenceId: string | undefined;
  for (let attempt = 0; attempt < 30 && !evidenceId; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const updates = await fetch(`${base}/screen/sessions/${sessionId}/updates?cursor=0&generation=1`, {headers: {authorization: `Bearer ${bearer}`}});
    assert.equal(updates.status, 200);
    const result = await updates.json() as {observations?: Array<{evidenceIds?: string[]}>};
    evidenceId = result.observations?.[0]?.evidenceIds?.[0];
  }
  assert.ok(evidenceId);
  const unauthenticatedGet = await fetch(`${base}/screen/sessions/${sessionId}/updates?cursor=0&generation=1`);
  assert.equal(unauthenticatedGet.status, 401);
  const foreignOriginGet = await fetch(`${base}/screen/sessions/${sessionId}/updates?cursor=0&generation=1`, {headers: {origin: 'https://foreign.test', authorization: `Bearer ${bearer}`}});
  assert.equal(foreignOriginGet.status, 403);
  const database = new DatabaseSync(databasePath, {readOnly: true});
  t.after(() => database.close());
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM screen_evidence').get() as {count: number}).count, 1);
  const stopped = await fetch(`${base}/screen/sessions/${sessionId}/lifecycle`, {method: 'POST', headers,
    body: JSON.stringify({generation: 1, command: 'stop', reason: 'review'})});
  assert.equal(stopped.status, 200);
  const asset = await fetch(`${base}/screen/sessions/${sessionId}/evidence/${evidenceId}/asset`, {headers: {authorization: `Bearer ${bearer}`}});
  assert.equal(asset.status, 200);
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
});

test('environment-backed screen module fails closed without storage configuration', async () => {
  const module = createScreenModule({allowedOrigins: [origin], authorize: async () => true, env: {}});
  await assert.rejects(createApi({modules: [module]}), /DATABASE_PATH is required/);
});

async function serverUrl(server: Server): Promise<string> {
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
