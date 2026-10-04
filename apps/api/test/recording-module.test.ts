import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {createApi} from '../src/app.ts';
import {createRecordingModule} from '../src/recording-module.ts';
import {createAgent} from '../agent/index.ts';

const ORIGIN = 'https://app.example';

test('production recording composition preserves raw bytes, session and Origin boundaries, limits, and JSON routes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'recording-module-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const agent = createAgent({allowedOrigins: [ORIGIN], sessionsDir: path.join(root, 'sessions'), log: () => {},
    elevenLabsApiKey: 'xi-test-key-never-real', elevenLabsAgentIdInterviewer: 'agent_test'});
  t.after(() => agent.close());
  const recording = createRecordingModule({authorize: agent.authorize, allowedOrigins: [ORIGIN], mediaDir: path.join(root, 'media')});
  const app = await createApi({allowedOrigins: [ORIGIN], modules: [agent.module, recording, {name: 'echo', mount(app) {
    app.post('/api/echo', (req, res) => res.json(req.body));
  }}]});
  const server = app.listen(0, '127.0.0.1');
  t.after(() => close(server));
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const first = await issue(base); const second = await issue(base);
  const asset = `${base}/screen/sessions/${first.sessionId}/recordings/segment-1`;
  const firstChunk = Buffer.from([0x00, 0xff, 0x80, 0x61]);
  const secondChunk = Buffer.from([0xc3, 0x28, 0x7f, 0x00]);
  const bytes = Buffer.concat([firstChunk, secondChunk]);

  const preflight = await fetch(`${asset}/chunks`, {method: 'OPTIONS', headers: {origin: ORIGIN,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-recording-chunk-index'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-Recording-Chunk-Index/i);

  const chunk = await fetch(`${asset}/chunks`, {method: 'POST', headers: headers(first.token, {'content-type': 'video/webm',
    'x-recording-chunk-index': '0'}), body: firstChunk});
  assert.equal(chunk.status, 201);
  const nextChunk = await fetch(`${asset}/chunks`, {method: 'POST', headers: headers(first.token, {'content-type': 'video/webm',
    'x-recording-chunk-index': '1'}), body: secondChunk});
  assert.equal(nextChunk.status, 201);
  const segment = {id: 'segment-1', sessionId: first.sessionId, assetRef: `recording:${first.sessionId}:segment-1`,
    startMs: 100, endMs: 200, mediaStartMs: 0, mediaEndMs: 100, mimeType: 'video/webm'};
  const finalized = await fetch(`${asset}/finalize`, {method: 'POST', headers: headers(first.token, {'content-type': 'application/json'}),
    body: JSON.stringify({chunkCount: 2, mimeType: 'video/webm', segment})});
  assert.equal(finalized.status, 201);
  assert.equal((await finalized.json() as {asset: {assetRef: string}}).asset.assetRef, segment.assetRef);

  const downloaded = await fetch(`${asset}/asset`, {headers: headers(first.token)});
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

  assert.equal((await fetch(`${base}/screen/sessions/${first.sessionId}/recordings/no-auth/chunks`, {method: 'POST',
    headers: {origin: ORIGIN, 'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: bytes})).status, 401);
  assert.equal((await fetch(`${asset}/asset`, {headers: headers(second.token)})).status, 403);
  assert.equal((await fetch(`${base}/screen/sessions/${first.sessionId}/recordings/foreign/chunks`, {method: 'POST',
    headers: {...headers(first.token, {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}), origin: 'https://evil.example'}, body: bytes})).status, 403);
  assert.equal((await fetch(`${base}/screen/sessions/${first.sessionId}/recordings/no-origin/chunks`, {method: 'POST',
    headers: {authorization: `Bearer ${first.token}`, 'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: bytes})).status, 403);
  assert.equal((await fetch(`${base}/screen/sessions/${first.sessionId}/recordings/too-large/chunks`, {method: 'POST',
    headers: headers(first.token, {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}), body: Buffer.alloc(4_000_001)})).status, 413);

  const echo = await fetch(`${base}/api/echo`, {method: 'POST', headers: {origin: ORIGIN, 'content-type': 'application/json'},
    body: JSON.stringify({still: 'json'})});
  assert.equal(echo.status, 200); assert.deepEqual(await echo.json(), {still: 'json'});
});

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {origin: ORIGIN, authorization: `Bearer ${token}`, ...extra};
}
async function issue(base: string): Promise<{sessionId: string; token: string}> {
  const response = await fetch(`${base}/api/agent/sessions`, {method: 'POST', headers: {origin: ORIGIN}});
  assert.equal(response.status, 201); return await response.json() as {sessionId: string; token: string};
}
function close(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
