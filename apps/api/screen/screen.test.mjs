import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileEvidenceStore, createMemoryEvidenceStore, normalizeFrame } from './evidence-store.mjs';
import { createScreenService } from './service.mjs';
import { createScreenHandlers, mount } from './handlers.mjs';

// Synthetic opaque 1x1 PNG: no customer data, raw screenshots or external fixture dependencies.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
const frame = { sessionId: 'synthetic-session', frameId: 'f1', timestampMs: 1,
  processed: true, mediaType: 'image/png', bytes: png };
const tick = () => new Promise(resolve => setImmediate(resolve));
function metadataRepository() {
  const records = new Map();
  return { async put(record) { records.set(record.id, record); },
    async get(id) { return records.get(id); }, async remove(id) { records.delete(id); } };
}

test('file Evidence survives store recreation with injected metadata and serves exact processed bytes', async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'synthetic-evidence-'));
  try {
    const metadata = metadataRepository();
    const store = createFileEvidenceStore({ mediaDir, metadata });
    const record = await store.save(frame);
    const restarted = createFileEvidenceStore({ mediaDir, metadata });
    assert.deepEqual(await restarted.resolve(record.id), record);
    assert.deepEqual((await restarted.read(record.id)).bytes, png);
    assert.equal(record.startMs, 1); assert.equal(record.endMs, 1);
    const files = await readdir(mediaDir);
    assert.equal(files.length, 1); assert.equal(files[0].endsWith('.png'), true);
    await unlink(path.join(mediaDir, files[0]));
    await assert.rejects(restarted.resolve(record.id), { code: 'evidence_not_found' });
  } finally { await rm(mediaDir, { recursive: true, force: true }); }
});

test('failed metadata commit cleans media; aborted saves and unsafe ids cannot resolve', async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'synthetic-evidence-'));
  try {
    const metadata = { ...metadataRepository(), async put() { throw new Error('private database details'); } };
    const store = createFileEvidenceStore({ mediaDir, metadata });
    await assert.rejects(store.save(frame), { code: 'storage_error', message: 'storage_error' });
    assert.deepEqual(await readdir(mediaDir), []);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(store.save(frame, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(store.resolve('../../etc/passwd'), { code: 'evidence_not_found' });
  } finally { await rm(mediaDir, { recursive: true, force: true }); }
});

test('memory Evidence is bounded, copies media and rejects unprocessed/invalid/oversized input', async () => {
  const store = createMemoryEvidenceStore({ maxEntries: 1 });
  const input = { ...frame, bytes: Buffer.from(png) };
  const record = await store.save(input); input.bytes.fill(0);
  assert.deepEqual((await store.read(record.id)).bytes, png);
  await assert.rejects(store.save(frame), { code: 'storage_error' });
  for (const invalid of [{ ...frame, processed: false }, { ...frame, mediaType: 'image/jpeg' },
    { ...frame, mediaType: '__proto__' }, { ...frame, bytes: Buffer.alloc(0) }, { ...frame, timestampMs: -1 }]) {
    assert.throws(() => normalizeFrame(invalid), { code: 'invalid_frame' });
  }
  assert.throws(() => normalizeFrame(frame, 8), { code: 'invalid_frame' });
});

// Local test-only shape. This deliberately is not a draft or replacement ScreenBridge.
const localSchema = { type: 'object', properties: { screen: { const: 'email' },
  customer: { type: ['string', 'null'] }, order: { type: ['string', 'null'] } },
  required: ['screen', 'customer', 'order'], additionalProperties: false };
function localValidator(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'customer,order,screen' || value.screen !== 'email' ||
    ![value.customer, value.order].every(id => id === null || typeof id === 'string')) {
    throw Object.assign(new Error('Invalid local test response'), { code: 'invalid_model_output' });
  }
  return value;
}
function serviceForTests(runner) {
  const published = [], events = [];
  const service = createScreenService({ runner, schema: localSchema, validate: localValidator,
    makeObservation: (facts, context) => ({ facts, ...context }),
    evidence: createMemoryEvidenceStore(), publish: value => published.push(value),
    prompt: 'Describe the visible email', onEvent: event => events.push(event),
    queueOptions: { now: () => 100002, sampleIntervalMs: 0 } });
  service.start({ sessionId: frame.sessionId, sessionEpochMs: 100000 });
  return { service, published, events };
}

test('processed frame -> injected runner -> validated unknown customer -> resolved source -> observation', async () => {
  const h = serviceForTests({ async vision(input) {
    assert.deepEqual(input.schema, localSchema);
    assert.deepEqual(Buffer.from(input.images[0].data, 'base64'), png);
    assert.equal(input.system.includes('Customers and orders are different entities'), true);
    return { json: { screen: 'email', customer: null, order: 'synthetic-order-2' }, ms: 1 };
  } });
  assert.equal(h.service.offer(frame), 'accepted'); await tick();
  const observation = h.published[0];
  assert.equal(observation.facts.customer, null);
  assert.equal(observation.facts.order, 'synthetic-order-2');
  assert.equal(observation.sessionId, frame.sessionId); assert.equal(observation.frameId, 'f1');
  assert.deepEqual(await h.service.evidence.resolve(observation.evidence.id), observation.evidence);
  assert.equal(h.events[0].latencyMs, 1);
});

test('guessed rule/extra fields fail closed; runner errors do not look like observations', async () => {
  for (const runner of [{ async vision() { return { json: { screen: 'email', customer: null,
    order: null, businessRule: 'invented' } }; } }, { async vision() {
    throw Object.assign(new Error('private model output'), { code: 'runner_auth' });
  } }]) {
    const h = serviceForTests(runner); h.service.offer(frame); await tick();
    assert.equal(h.published.length, 0); assert.equal(h.events[0].type, 'error');
    assert.equal(JSON.stringify(h.events).includes('private'), false);
  }
});

function uploadRequest(input, headers = {}) {
  return new Request('https://synthetic.example/screen/frames', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
const upload = { ...frame, bytes: undefined, data: png.toString('base64') };

test('framework-neutral handlers authenticate before ingestion and authorize Evidence session', async () => {
  const h = serviceForTests({ async vision() { return { json: { screen: 'email', customer: null, order: null } }; } });
  const unauthorized = createScreenHandlers({ service: h.service, authorize: () => false });
  assert.equal((await unauthorized.frames(uploadRequest(upload))).status, 401);
  assert.equal(h.service.snapshot().active, 0);
  const handlers = createScreenHandlers({ service: h.service, authorize: (_, sessionId) =>
    sessionId === null || sessionId === frame.sessionId });
  assert.equal((await handlers.frames(uploadRequest({ ...upload, sessionId: 'other' }))).status, 403);
  assert.equal((await handlers.frames(uploadRequest(upload))).status, 202); await tick();
  const id = h.published[0].evidence.id;
  const request = new Request('https://synthetic.example/screen/evidence');
  assert.equal((await handlers.resolve(request, { id })).status, 200);
  assert.deepEqual(Buffer.from(await (await handlers.asset(request, { id })).arrayBuffer()), png);
  const wrongSession = createScreenHandlers({ service: h.service, authorize: (_, sessionId) => sessionId === null });
  assert.equal((await wrongSession.asset(request, { id })).status, 403);
});

test('HTTP limits, malformed input and missing Evidence expose only safe errors', async () => {
  const h = serviceForTests({ async vision() { throw new Error(); } });
  const handlers = createScreenHandlers({ service: h.service, authorize: () => true, maxBodyBytes: 1000 });
  assert.equal((await handlers.frames(uploadRequest({ ...upload, data: 'x'.repeat(1500) }))).status, 413);
  assert.equal((await handlers.frames(uploadRequest({ ...upload, data: '%%%' }))).status, 400);
  assert.equal((await handlers.frames(uploadRequest({ ...upload, processed: false }))).status, 400);
  assert.equal((await handlers.resolve(new Request('https://synthetic.example/'), { id: '../private' })).status, 404);
  const routes = [];
  mount({}, { register: (_, route) => routes.push(route), service: h.service, authorize: () => true });
  assert.equal(routes.length, 3);
  assert.throws(() => mount({}, { service: h.service, authorize: () => true }), /adapter/);
});

test('multi-megabyte processed frames pass canonical base64 handling without regex backtracking', async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(6_000_000 - png.length)]);
  let offered = 0;
  const handlers = createScreenHandlers({ authorize: () => true, service: { offer(input) {
    assert.equal(normalizeFrame(input).bytes.length, 6_000_000);
    offered++; return 'accepted';
  } } });
  const result = await handlers.frames(uploadRequest({ ...upload, data: bytes.toString('base64') }));
  assert.equal(result.status, 202); assert.equal(offered, 1);
});

test('service offers internal source provenance without adding fields to canonical model output', async () => {
  let answer;
  const h = serviceForTests({ vision: () => new Promise(resolve => { answer = resolve; }) });
  h.service.setSourceRevision('draft-1');
  h.service.offer(frame, { sourceRevision: 'draft-1' });
  h.service.setSourceRevision('draft-2');
  answer({ json: { screen: 'email', customer: null, order: null }, ms: 1 }); await tick();
  assert.equal(h.published.length, 1);
  assert.equal(h.service.canUseForCheckpoint({ sessionId: frame.sessionId,
    frameId: frame.frameId, sourceRevision: 'draft-1' }), false);
  assert.equal(Object.hasOwn(h.published[0], 'sourceRevision'), false);
});
