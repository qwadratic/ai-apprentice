// The ops module: raw forwarding of /ops/* to the deploy webhook, and /ops/vm-health. No real webhook or runner:
// a local fake ops server records what it receives, a fake runner answers /health.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/app.ts';
import { modules } from '../src/modules.ts';
import { createOpsModule } from '../ops/index.ts';
import type { OpsOptions } from '../ops/index.ts';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }
interface Fake { url: string; seen: Seen[]; port: number }

/** A tiny HTTP server; `answer` decides the reply for each request. */
async function fake(t: TestContext, answer: (seen: Seen, res: http.ServerResponse) => void): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      answer(entry, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, port };
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function freeUrl(): Promise<string> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function startApi(t: TestContext, options: OpsOptions, allowedOrigins: string[] = []): Promise<string> {
  const app = await createApi({ allowedOrigins, modules: [createOpsModule({ log: () => {}, gitSha: 'abc123def456', ...options })] });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Raw HTTP request (fetch cannot send a chunked body of unknown length or read a reset connection reliably). */
function rawRequest(base: string, method: string, path: string, headers: Record<string, string>, chunks: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('error', reject);
    for (const c of chunks) r.write(c);
    r.end();
  });
}

// Bytes that a JSON parser or a UTF-8 round trip would change: invalid UTF-8, NUL, CR/LF, a BOM, odd spacing.
const SIGNED = Buffer.concat([Buffer.from('﻿{ "sha" :"'), Buffer.from('a'.repeat(40)), Buffer.from('",\r\n"ts":1 }'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])]);

test('forwards the raw bytes of an application/octet-stream body byte for byte, with signature, type and client IP', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 202, { accepted: true, sha: 'a'.repeat(40) }));
  const base = await startApi(t, { opsUrl: ops.url });
  const signature = `sha256=${'ab'.repeat(32)}`;
  const r = await fetch(`${base}/ops/deploy?x=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Deploy-Signature': signature, 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' },
    body: SIGNED,
  });
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { accepted: true, sha: 'a'.repeat(40) });
  assert.equal(ops.seen.length, 1);
  const seen = ops.seen[0]!;
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/ops/deploy?x=1');
  assert.ok(seen.body.equals(SIGNED), 'the body arrives byte for byte');
  assert.equal(seen.headers['content-type'], 'application/octet-stream');
  assert.equal(seen.headers['content-length'], String(SIGNED.length));
  assert.equal(seen.headers['x-deploy-signature'], signature);
  assert.equal(seen.headers['x-forwarded-for'], '203.0.113.9', 'the last X-Forwarded-For entry is the client');
});

test('without X-Forwarded-For the socket address is the client IP; other headers are not forwarded', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 200, { ok: true }));
  const base = await startApi(t, { opsUrl: ops.url });
  await fetch(`${base}/ops/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer secret', Cookie: 'a=b' }, body: 'x' });
  const seen = ops.seen[0]!;
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers['x-deploy-signature'], undefined);
});

test('GET /ops/deploy/status and unknown /ops paths are forwarded with their status and body', async (t) => {
  const ops = await fake(t, (seen, res) => {
    if (seen.url === '/ops/deploy/status') json(res, 200, { deployed_sha: 'f'.repeat(40), last: null });
    else json(res, 404, { ok: false, error: 'not_found' });
  });
  const base = await startApi(t, { opsUrl: ops.url });
  const ok = await fetch(`${base}/ops/deploy/status`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { deployed_sha: 'f'.repeat(40), last: null });
  const missing = await fetch(`${base}/ops/nothing/here`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: 'not_found' });
  assert.deepEqual(ops.seen.map((s) => `${s.method} ${s.url}`), ['GET /ops/deploy/status', 'GET /ops/nothing/here']);
  assert.equal(ops.seen[0]!.headers['content-length'], undefined, 'a GET carries no body headers');
});

test('a body that express.json already parsed is refused with 415 and nothing is forwarded', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 202, { accepted: true }));
  const base = await startApi(t, { opsUrl: ops.url });
  const r = await fetch(`${base}/ops/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deploy-Signature': `sha256=${'0'.repeat(64)}` }, body: '{"sha":"x","ts":1}' });
  assert.equal(r.status, 415);
  assert.equal((await r.json() as { error: string }).error, 'unsupported_media_type');
  assert.equal(ops.seen.length, 0);
});

test('413 above 4 KiB, declared or streamed; exactly 4 KiB passes', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 202, { accepted: true }));
  const base = await startApi(t, { opsUrl: ops.url });
  const octet = { 'Content-Type': 'application/octet-stream' };
  const exact = await fetch(`${base}/ops/deploy`, { method: 'POST', headers: octet, body: Buffer.alloc(4096, 0x61) });
  assert.equal(exact.status, 202);
  assert.equal(ops.seen[0]!.body.length, 4096);

  const declared = await rawRequest(base, 'POST', '/ops/deploy', { ...octet, 'Content-Length': '4097' }, [Buffer.alloc(4097, 0x61)]);
  assert.equal(declared.status, 413);
  assert.equal((JSON.parse(declared.body) as { max_bytes: number }).max_bytes, 4096);

  // No Content-Length: chunked, the size is only known while reading.
  const streamed = await rawRequest(base, 'POST', '/ops/deploy', { ...octet, 'Transfer-Encoding': 'chunked' }, [Buffer.alloc(3000, 0x61), Buffer.alloc(3000, 0x61)]);
  assert.equal(streamed.status, 413);
  assert.equal(ops.seen.length, 1, 'oversized bodies are never forwarded');
});

test('502 ops_unreachable when the webhook is down, and when it does not answer in time', async (t) => {
  const down = await startApi(t, { opsUrl: await freeUrl() });
  const r = await fetch(`${down}/ops/deploy/status`);
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { ok: false, error: 'ops_unreachable' });
  const post = await fetch(`${down}/ops/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' });
  assert.equal(post.status, 502);

  const hang = await fake(t, () => { /* never answers */ });
  const slow = await startApi(t, { opsUrl: hang.url, timeoutMs: 150 });
  const timed = await fetch(`${slow}/ops/deploy/status`);
  assert.equal(timed.status, 502);
  assert.deepEqual(await timed.json(), { ok: false, error: 'ops_unreachable' });
});

test('GET /ops/vm-health reports runner, git_sha and deployed_sha and is not forwarded', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 200, { forwarded: true }));
  const runner = await fake(t, (seen, res) => json(res, seen.url === '/health' ? 200 : 404, { ok: true, mode: 'apikey' }));
  const dir = await mkdtemp(join(tmpdir(), 'ops-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const deployedShaFile = join(dir, 'deployed-sha');
  await writeFile(deployedShaFile, `${'d'.repeat(40)}\n`);
  const base = await startApi(t, { opsUrl: ops.url, runnerUrl: runner.url, deployedShaFile });
  const r = await fetch(`${base}/ops/vm-health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: true, runner: 'up', git_sha: 'abc123def456', deployed_sha: 'd'.repeat(40) });
  assert.equal(ops.seen.length, 0);
  assert.equal(runner.seen[0]!.url, '/health');
});

test('vm-health: runner down on an error status, a closed port or a timeout; deployed_sha null without the file', async (t) => {
  const missing = join(tmpdir(), 'ops-test-does-not-exist', 'deployed-sha');
  const failing = await fake(t, (_seen, res) => json(res, 500, { ok: false }));
  const hanging = await fake(t, () => { /* never answers */ });
  for (const runnerUrl of [failing.url, await freeUrl(), hanging.url]) {
    const base = await startApi(t, { opsUrl: await freeUrl(), runnerUrl, deployedShaFile: missing, runnerTimeoutMs: 200 });
    const r = await fetch(`${base}/ops/vm-health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, runner: 'down', git_sha: 'abc123def456', deployed_sha: null });
  }
});

test('the global CORS rule still applies: a foreign Origin never reaches the webhook', async (t) => {
  const ops = await fake(t, (_seen, res) => json(res, 200, { ok: true }));
  const base = await startApi(t, { opsUrl: ops.url }, ['https://app.example']);
  const foreign = await fetch(`${base}/ops/deploy/status`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const allowed = await fetch(`${base}/ops/deploy/status`, { headers: { Origin: 'https://app.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.equal(ops.seen.length, 1);
});

test('the ops module is registered first in src/modules.ts, before agent', () => {
  // First, so no later module can put a body parser in front of the signed raw body.
  assert.deepEqual(modules.map((m) => m.name).slice(0, 2), ['ops', 'agent']);
});
