import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFileRecordingStore, type RecordingStore} from './store.ts';
import {createRecordingHandlers} from './handlers.ts';

const tokenA = 'aaaaaaaaaaaaaaaaaaaa';
const tokenB = 'bbbbbbbbbbbbbbbbbbbb';
const webmA = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]);
const webmB = Buffer.from([0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
const segment = {id: 'segment-1', sessionId: 'session-a', assetRef: 'recording:session-a:segment-1',
  startMs: 1200, endMs: 2400, mediaStartMs: 0, mediaEndMs: 1200, mimeType: 'video/webm'} as const;

test('HTTP chunks finalize into a session-scoped retrievable recording asset', async () => {
  const fixture = await fixtureServer();
  try {
    const base = `${fixture.url}/screen/sessions/session-a/recordings/segment-1`;
    assert.equal((await upload(`${base}/chunks`, tokenA, 0, webmA)).status, 201);
    const duplicate = await upload(`${base}/chunks`, tokenA, 0, webmA);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as {outcome: string}).outcome, 'duplicate');
    assert.equal((await upload(`${base}/chunks`, tokenA, 1, webmB)).status, 201);

    const finalized = await fetch(`${base}/finalize`, {method: 'POST', headers: auth(tokenA, true),
      body: JSON.stringify({chunkCount: 2, mimeType: 'video/webm', segment})});
    assert.equal(finalized.status, 201);
    assert.deepEqual((await finalized.json() as {asset: unknown}).asset, {assetRef: 'recording:session-a:segment-1',
      sessionId: 'session-a', assetId: 'segment-1', mimeType: 'video/webm', byteLength: webmA.length + webmB.length,
      chunkCount: 2, segment});

    const replay = await fetch(`${base}/asset`, {headers: auth(tokenA)});
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('content-type'), 'video/webm');
    assert.deepEqual(Buffer.from(await replay.arrayBuffer()), Buffer.concat([webmA, webmB]));
    assert.equal((await fetch(`${base}/asset`, {headers: auth(tokenB)})).status, 401);
    assert.equal((await fetch(`${fixture.url}/screen/sessions/session-b/recordings/segment-1/asset`, {headers: auth(tokenB)})).status, 404);
  } finally { await fixture.close(); }
});

test('handlers reject malformed, oversized, reordered and conflicting chunks without exposing partial assets', async () => {
  const fixture = await fixtureServer(8);
  try {
    const base = `${fixture.url}/screen/sessions/session-a/recordings/segment-2`;
    assert.equal((await upload(`${base}/chunks`, tokenA, 1, webmA)).status, 409);
    assert.equal((await upload(`${base}/chunks`, tokenA, 0, Buffer.alloc(9))).status, 413);
    assert.equal((await fetch(`${base}/chunks`, {method: 'POST', headers: {...auth(tokenA), 'content-type': 'text/plain',
      'x-recording-chunk-index': '0'}, body: webmA})).status, 400);
    assert.equal((await upload(`${base}/chunks`, tokenA, 0, webmA)).status, 201);
    assert.equal((await upload(`${base}/chunks`, tokenA, 0, Buffer.from([0]))).status, 409);
    assert.equal((await fetch(`${base}/asset`, {headers: auth(tokenA)})).status, 404);
    const incomplete = await fetch(`${base}/finalize`, {method: 'POST', headers: auth(tokenA, true),
      body: JSON.stringify({chunkCount: 2, mimeType: 'video/webm'})});
    assert.equal(incomplete.status, 409);
    assert.equal((await incomplete.json() as {code: string}).code, 'finalization_incomplete');
    assert.equal((await fetch(`${base}/finalize`, {method: 'POST', headers: auth(tokenA, true), body: '{'})).status, 400);
    const wrongSegment = {...segment, id: 'different-segment', assetRef: 'recording:session-a:segment-2'};
    assert.equal((await fetch(`${base}/finalize`, {method: 'POST', headers: auth(tokenA, true),
      body: JSON.stringify({chunkCount: 1, mimeType: 'video/webm', segment: wrongSegment})})).status, 400);
  } finally { await fixture.close(); }
});

test('storage failures are explicit during upload and finalization', async () => {
  const rootFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'recording-failure-')), 'file');
  await writeFile(rootFile, 'blocks directories');
  const store = createFileRecordingStore(rootFile);
  const uploadHandlers = createRecordingHandlers({store, authorize: () => true});
  const response = await uploadHandlers.chunk(new Request('https://local/chunks', {method: 'POST',
    headers: {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: webmA}), {sessionId: 'session-a', assetId: 'asset'});
  assert.equal(response.status, 503);
  assert.equal((await response.json() as {code: string}).code, 'storage_failed');

  const failing: RecordingStore = {
    async append() { return 'created'; },
    async finalize() { throw new Error('synthetic disk failure'); },
    async read() { throw new Error('synthetic disk failure'); },
  };
  const handlers = createRecordingHandlers({store: failing, authorize: () => true});
  const finalized = await handlers.finalize(new Request('https://local/finalize', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({chunkCount: 1, mimeType: 'video/webm'})}),
  {sessionId: 'session-a', assetId: 'asset'});
  assert.equal(finalized.status, 503);
  assert.equal((await finalized.json() as {code: string}).code, 'storage_failed');
  await rm(path.dirname(rootFile), {recursive: true, force: true});
});

test('streaming limits and store path validation hold without trusted HTTP metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recording-validation-'));
  const store = createFileRecordingStore(root);
  await assert.rejects(store.append('../escape', 'asset', 0, 'video/webm', webmA), TypeError);
  await assert.rejects(store.append('session', '../escape', 0, 'video/webm', webmA), TypeError);
  await assert.rejects(store.append('session', 'asset', 0, 'text/plain', webmA), TypeError);

  const handlers = createRecordingHandlers({store, authorize: () => true, maxChunkBytes: 8});
  const streaming = new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); controller.close();
  }});
  const response = await handlers.chunk(new Request('https://local/chunk', {method: 'POST', duplex: 'half',
    headers: {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: streaming} as RequestInit),
  {sessionId: 'session', assetId: 'asset'});
  assert.equal(response.status, 413);
  assert.equal((await response.json() as {code: string}).code, 'body_limit');
  await rm(root, {recursive: true, force: true});
});

function auth(token: string, json = false): Record<string, string> {
  return {authorization: `Bearer ${token}`, ...(json ? {'content-type': 'application/json'} : {})};
}
function upload(url: string, token: string, index: number, bytes: Uint8Array): Promise<Response> {
  return fetch(url, {method: 'POST', headers: {...auth(token), 'content-type': 'video/webm',
    'x-recording-chunk-index': String(index)}, body: Buffer.from(bytes)});
}

async function fixtureServer(maxChunkBytes = 1024): Promise<{url: string; close(): Promise<void>}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recording-http-'));
  const handlers = createRecordingHandlers({store: createFileRecordingStore(root), maxChunkBytes,
    authorize: (request, sessionId) => request.headers.get('authorization') === `Bearer ${sessionId === 'session-a' ? tokenA : tokenB}`});
  const server = createServer(async (incoming, outgoing) => {
    try {
      const match = incoming.url?.match(/^\/screen\/sessions\/([^/]+)\/recordings\/([^/]+)\/(chunks|finalize|asset)$/);
      if (!match) { outgoing.writeHead(404).end(); return; }
      const request = await webRequest(incoming);
      const handler = match[3] === 'chunks' ? handlers.chunk : match[3] === 'finalize' ? handlers.finalize : handlers.asset;
      await send(outgoing, await handler(request, {sessionId: match[1]!, assetId: match[2]!}));
    } catch { outgoing.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address.');
  return {url: `http://127.0.0.1:${address.port}`, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, {recursive: true, force: true});
  }};
}
async function webRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item)); else if (value !== undefined) headers.set(name, value);
  }
  const body = Buffer.concat(chunks);
  return new Request(`http://${incoming.headers.host}${incoming.url}`, {method: incoming.method, headers,
    ...(body.length ? {body} : {})});
}
async function send(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

test('a session cannot fill the disk: total bytes, number of recordings and a free-space floor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recording-quota-'));
  const six = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const roomy = async () => 1e12;
  const bytes = createFileRecordingStore(root, {maxSessionBytes: 10, minFreeBytes: 0, freeBytes: roomy});
  assert.equal(await bytes.append('session-a', 'one', 0, 'video/webm', six), 'created');
  await assert.rejects(bytes.append('session-a', 'two', 0, 'video/webm', six), {code: 'quota_exceeded'});
  await assert.rejects(bytes.append('session-a', 'one', 1, 'video/webm', six), {code: 'quota_exceeded'}, 'pending bytes count too');
  assert.equal(await bytes.append('session-b', 'one', 0, 'video/webm', six), 'created', 'other sessions keep their own quota');

  const count = createFileRecordingStore(path.join(root, 'count'), {maxSessionAssets: 2, minFreeBytes: 0, freeBytes: roomy});
  await count.append('session-a', 'one', 0, 'video/webm', six);
  await count.append('session-a', 'two', 0, 'video/webm', six);
  await assert.rejects(count.append('session-a', 'three', 0, 'video/webm', six), {code: 'quota_exceeded'});
  assert.equal(await count.append('session-a', 'two', 1, 'video/webm', six), 'created', 'an existing recording can still grow');

  const full = createFileRecordingStore(path.join(root, 'full'), {minFreeBytes: 1000, freeBytes: async () => 1003});
  await assert.rejects(full.append('session-a', 'one', 0, 'video/webm', six), {code: 'storage_full'});
  const handlers = createRecordingHandlers({store: full, authorize: () => true});
  const response = await handlers.chunk(new Request('https://local/chunks', {method: 'POST',
    headers: {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: six}), {sessionId: 'session-a', assetId: 'one'});
  assert.equal(response.status, 507);
  const over = createRecordingHandlers({store: bytes, authorize: () => true});
  const tooMuch = await over.chunk(new Request('https://local/chunks', {method: 'POST',
    headers: {'content-type': 'video/webm', 'x-recording-chunk-index': '0'}, body: six}), {sessionId: 'session-a', assetId: 'three'});
  assert.equal(tooMuch.status, 413);
  assert.equal((await tooMuch.json() as {code: string}).code, 'quota_exceeded');
  await rm(root, {recursive: true, force: true});
});
