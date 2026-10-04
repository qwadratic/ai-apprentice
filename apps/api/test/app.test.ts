import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApi } from '../src/app.ts';
async function url(server: Server): Promise<string> {
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  return `http://127.0.0.1:${address.port}`;
}
test('health, owner mounts and missing endpoints report actual integration state', async (t) => {
  const app = await createApi({modules: [{name: 'synthetic', mount: async (app) => { app.get('/api/example', (_req, res) => res.json({synthetic: true})); }}]});
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = await url(server);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {ok: true, service: 'api-foundation', modules: ['synthetic']});
  assert.deepEqual(await (await fetch(`${base}/api/example`)).json(), {synthetic: true});
  assert.equal((await fetch(`${base}/api/screen/vision`)).status, 404);
  await assert.rejects(createApi({modules: [{name: 'same', mount() {}}, {name: 'same', mount() {}}]}), /Duplicate/);
});
test('exact CORS allowlist, preflight, malformed JSON and body limits', async (t) => {
  const app = await createApi({allowedOrigins: ['https://allowed.example'], modules: [{name: 'echo', mount(app) { app.post('/api/echo', (req, res) => res.json(req.body)); }}]});
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = await url(server);
  const accepted = await fetch(`${base}/health`, {method: 'OPTIONS', headers: {Origin: 'https://allowed.example'}});
  assert.equal(accepted.status, 204); assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://allowed.example');
  const rejected = await fetch(`${base}/health`, {method: 'OPTIONS', headers: {Origin: 'https://allowed.example.evil'}});
  assert.equal(rejected.status, 403); assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${base}/api/echo`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'})).status, 400);
  assert.equal((await fetch(`${base}/api/echo`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: 'x'.repeat(13_000_000)})})).status, 413);
});

test('published-style Fetch mount receives JSON, auth headers and path params', async (t) => {
  const { registerWebRoute } = await import('../src/web-routes.ts');
  const app = await createApi({modules: [{name: 'web-handlers', mount(app) {
    registerWebRoute(app, {method: 'POST', path: '/screen/example/:id', async handle(request, {id}) {
      if (request.headers.get('authorization') !== 'Bearer synthetic-test-only') return Response.json({ok: false}, {status: 401});
      return Response.json({id, input: await request.json()}, {status: 202, headers: {'cache-control': 'no-store'}});
    }});
  }}]});
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = await url(server);
  assert.equal((await fetch(`${base}/screen/example/frame-1`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 401);
  const response = await fetch(`${base}/screen/example/frame-1`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer synthetic-test-only'}, body: JSON.stringify({data: 'synthetic'})});
  assert.equal(response.status, 202); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {id: 'frame-1', input: {data: 'synthetic'}});
});
