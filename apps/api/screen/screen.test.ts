import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm, unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {ActionCheckpoint, ScreenObservation, ScreenStatus} from '@apprentice/contracts';
import {createFileEvidenceStore, createMemoryEvidenceStore} from './evidence-store.ts';
import type {EvidenceMetadataRepository, ScreenEvidenceRecord} from './evidence-store.ts';
import {createScreenService} from './service.ts';
import type {ScreenService} from './service.ts';
import type {VisionRunner} from './runner-client.ts';
import {createAllowedOriginCheck, createScreenHandlers, mount} from './handlers.ts';
import {ObservationProvenanceRegistry} from './provenance.ts';
import {ScreenSessionHub} from './session-transport.ts';
import type {SessionServiceFactoryContext} from './session-transport.ts';
import {createObservationFactory, parseVisionResult} from './vision-contract.ts';
import type {VisionResult} from './vision-contract.ts';
import type {VisionPublicationContext} from '../../../packages/screen/vision/queue.ts';

const origin = 'https://demo.example';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface StartBody {sessionId: string; generation: number; sessionToken: string; nextCursor: number; status: ScreenStatus}
interface LifecycleBody {sessionId: string; generation: number; nextCursor: number; status: ScreenStatus}
interface UpdatesBody {sessionId: string; generation: number; observations: ScreenObservation[]; statuses: ScreenStatus[]; nextCursor: number}
interface ErrorBody {ok: false; code: string; generation?: number; nextCursor?: number; minCursor?: number}
interface Deferred<T> {promise: Promise<T>; resolve(value: T): void}
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return {promise, resolve}; }
function parseStatus(value: unknown): ScreenStatus {
  const item = asRecord(value);
  if (item.schemaVersion !== 1 || typeof item.sessionId !== 'string' ||
    !['capturing', 'paused', 'stopped', 'error'].includes(String(item.state)) ||
    ('reason' in item && typeof item.reason !== 'string')) throw new Error('invalid status');
  return structuredClone(item) as unknown as ScreenStatus;
}
function parseObservation(value: unknown): ScreenObservation {
  const item = asRecord(value);
  if (item.schemaVersion !== 1 || item.source !== 'vision' || typeof item.id !== 'string' ||
    typeof item.sessionId !== 'string' || !Number.isSafeInteger(item.sequence) ||
    !Number.isSafeInteger(item.timestampMs) || typeof item.frameId !== 'string' ||
    !Array.isArray(item.evidenceIds) || !item.evidenceIds.length) throw new Error('invalid observation');
  return structuredClone(item) as unknown as ScreenObservation;
}
function makeHub(runner: VisionRunner, now = (): number => 100_010, maxEvents = 128): ScreenSessionHub {
  return new ScreenSessionHub(({publish, onEvent}) => createScreenService({runner, parseObservation,
    evidence: createMemoryEvidenceStore(), publish, onEvent, queueOptions: {sampleIntervalMs: 0, now}}),
  parseStatus, now, 8, maxEvents);
}
function request(url: string, method: 'GET' | 'POST', body?: unknown, token?: string): Request {
  return new Request(url, {method, headers: {origin, ...(body === undefined ? {} : {'content-type': 'application/json'}),
    ...(token ? {authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
async function body<T>(response: Response): Promise<T> { return await response.json() as T; }
function upload(generation = 1, frameId = 'frame-1', timestampMs = 5) {
  return {generation, frameId, timestampMs, processed: true, mediaType: 'image/png', data: png.toString('base64'),
    provenance: {surface: 'email', sourceRevision: 'email-r1', captureGeneration: 7}};
}

test('file Evidence survives store recreation and missing media never resolves', async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'synthetic-evidence-'));
  const records = new Map<string, ScreenEvidenceRecord>();
  const metadata: EvidenceMetadataRepository = {async put(record) { records.set(record.id, record); },
    async get(id) { return records.get(id); }, async remove(id) { records.delete(id); }};
  try {
    const controller = new AbortController();
    const store = createFileEvidenceStore({mediaDir, metadata});
    const record = await store.save({sessionId: 'session', frameId: 'frame', timestampMs: 1,
      processed: true, mediaType: 'image/png', bytes: png}, {signal: controller.signal});
    const restarted = createFileEvidenceStore({mediaDir, metadata});
    assert.deepEqual(await restarted.resolve(record.id, {signal: controller.signal}), record);
    assert.deepEqual((await restarted.read(record.id)).bytes, png);
    const filename = (await readdir(mediaDir))[0]; assert.ok(filename); await unlink(path.join(mediaDir, filename));
    await assert.rejects(restarted.resolve(record.id, {signal: controller.signal}), {code: 'evidence_not_found'});
  } finally { await rm(mediaDir, {recursive: true, force: true}); }
});

test('canonical observation factory preserves unknown identity and never trusts mismatched surface revision', () => {
  const result = parseVisionResult({outcome: 'observation', kind: 'order_view',
    facts: {customerRef: null, orderId: 'SYN-1', deliveryAddress: null, deliveryWindow: null}});
  const evidence = evidenceRecord('evidence-1', 'session', 'frame-1');
  const observation = createObservationFactory(parseObservation, () => 'observation-1')(result,
    {sessionId: 'session', frameId: 'frame-1', timestampMs: 5, sequence: 1,
      sourceRevision: 'email-r1', surface: 'email', evidence});
  assert.equal(observation.entityRef, null); assert.equal(observation.sourceRevision, null);
  assert.notEqual((observation.facts as {orderId?: string}).orderId, observation.entityRef);
  assert.throws(() => parseVisionResult({outcome: 'incomplete', reason: 'unreadable', kind: 'order_view'}),
    {code: 'invalid_model_output'});
  assert.throws(() => parseVisionResult({outcome: 'observation', kind: 'order_view',
    facts: {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null}, reason: 'unreadable'}),
  {code: 'invalid_model_output'});
});

test('frame upload permits processed media larger than metadata fields', async () => {
  const runner: VisionRunner = {async vision() { return {json: {outcome: 'incomplete', reason: 'unreadable'}, ms: 1}; }};
  const handlers = createScreenHandlers({hub: makeHub(runner), allowOrigin: () => true});
  const started = await body<StartBody>(await handlers.start(request(`${origin}/large`, 'POST',
    {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 'large'}));
  const data = Buffer.concat([png, Buffer.alloc(1024)]).toString('base64');
  const response = await handlers.frames(request(`${origin}/large/frames`, 'POST',
    {...upload(), data}, started.sessionToken), {sessionId: 'large'});
  assert.equal(response.status, 202);
});

test('provenance registry retains both order and email bindings for the current checkpoint', () => {
  const registry = new ObservationProvenanceRegistry('session', 1);
  const order = observation('order-1', 1, 'frame-order', 'order-r1', 'order_view');
  const email = observation('email-1', 2, 'frame-email', 'email-r1', 'email_draft');
  registry.record(order, publicationContext(evidenceRecord('e-order-1', 'session', 'frame-order'), 'order', 'order-r1', 7));
  registry.record(email, publicationContext(evidenceRecord('e-email-1', 'session', 'frame-email'), 'email', 'email-r1', 7));
  const checkpoint: ActionCheckpoint = {schemaVersion: 1, id: 'cp-1', sessionId: 'session', timestampMs: 20,
    observationIds: ['order-1', 'email-1'], revisions: {order: 'order-r1', email: 'email-r1'}, action: 'send'};
  assert.deepEqual(Object.keys(registry.assertCheckpoint(checkpoint, 7)).sort(), ['email', 'order']);
  assert.throws(() => registry.assertCheckpoint(checkpoint, 8), {code: 'checkpoint_stale'});
});

test('HTTP start, processed frame, poll and Evidence asset form a real result path', async () => {
  let sentPrompt = '';
  const runner: VisionRunner = {async vision(input) { sentPrompt = input.prompt; return {json: {outcome: 'observation', kind: 'email_draft',
    facts: {recipientRef: null, subject: 'Synthetic', bodyText: 'Visible text', attachments: [], previewState: 'editing'}}, ms: 3}; }};
  const handlers = createScreenHandlers({hub: makeHub(runner), allowOrigin: createAllowedOriginCheck(origin)});
  const startedResponse = await handlers.start(request(`${origin}/screen/sessions/session/start`, 'POST',
    {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 'session'});
  assert.equal(startedResponse.status, 201); const started = await body<StartBody>(startedResponse);
  const accepted = await handlers.frames(request(`${origin}/screen/sessions/session/frames`, 'POST', upload(), started.sessionToken), {sessionId: 'session'});
  assert.equal(accepted.status, 202); await tick();
  assert.match(sentPrompt, /Analyze the email draft surface/);
  const polledResponse = await handlers.updates(request(`${origin}/screen/sessions/session/updates?cursor=0&generation=1`, 'GET', undefined, started.sessionToken), {sessionId: 'session'});
  assert.equal(polledResponse.status, 200); const updates = await body<UpdatesBody>(polledResponse);
  assert.equal(updates.observations.length, 1); assert.equal(updates.observations[0]?.sourceRevision, 'email-r1');
  const evidenceId = updates.observations[0]?.evidenceIds[0];
  if (!evidenceId) throw new Error('Expected published Evidence');
  const asset = await handlers.asset(request(`${origin}/asset`, 'GET', undefined, started.sessionToken), {sessionId: 'session', id: evidenceId});
  assert.equal(asset.status, 200); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
});

test('auth is session scoped and foreign origins fail before session access', async () => {
  const runner: VisionRunner = {async vision() { throw new Error('unused'); }}; const hub = makeHub(runner);
  const handlers = createScreenHandlers({hub, allowOrigin: createAllowedOriginCheck(origin)});
  const a = await body<StartBody>(await handlers.start(request(`${origin}/a`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 'a'}));
  await handlers.start(request(`${origin}/b`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 'b'});
  const crossed = await handlers.updates(request(`${origin}/b?cursor=0&generation=1`, 'GET', undefined, a.sessionToken), {sessionId: 'b'});
  assert.equal(crossed.status, 401);
  const foreign = new Request('https://evil.example/a?cursor=0&generation=1', {headers: {origin: 'https://evil.example', authorization: `Bearer ${a.sessionToken}`}});
  assert.equal((await handlers.updates(foreign, {sessionId: 'a'})).status, 403);
});

test('pause resets generation and rejects delayed model output and old polls', async () => {
  const gate = deferred<{json: Readonly<Record<string, unknown>>; ms: number}>();
  const runner: VisionRunner = {vision: () => gate.promise}; const handlers = createScreenHandlers({hub: makeHub(runner), allowOrigin: () => true});
  const started = await body<StartBody>(await handlers.start(request(`${origin}/s`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 's'}));
  assert.equal((await handlers.frames(request(`${origin}/s/frames`, 'POST', upload(), started.sessionToken), {sessionId: 's'})).status, 202);
  const pausedResponse = await handlers.lifecycle(request(`${origin}/s/lifecycle`, 'POST',
    {generation: 1, command: 'pause', reason: 'off_record'}, started.sessionToken), {sessionId: 's'});
  assert.equal(pausedResponse.status, 200);
  assert.deepEqual(await body<LifecycleBody>(pausedResponse), {sessionId: 's', generation: 2, nextCursor: 1,
    status: {schemaVersion: 1, sessionId: 's', state: 'paused', reason: 'off_record'}});
  gate.resolve({json: {outcome: 'observation', kind: 'email_draft',
    facts: {recipientRef: null, subject: '', bodyText: '', attachments: [], previewState: 'editing'}}, ms: 10});
  await tick();
  const oldPoll = await handlers.updates(request(`${origin}/s/updates?cursor=0&generation=1`, 'GET', undefined, started.sessionToken), {sessionId: 's'});
  assert.equal(oldPoll.status, 409); assert.equal((await body<ErrorBody>(oldPoll)).code, 'generation_mismatch');
  const current = await body<UpdatesBody>(await handlers.updates(request(`${origin}/s/updates?cursor=0&generation=2`, 'GET', undefined, started.sessionToken), {sessionId: 's'}));
  assert.equal(current.observations.length, 0); assert.equal(current.statuses[0]?.state, 'paused');
});

test('invalid vision is a visible error status and never an observation', async () => {
  const runner: VisionRunner = {async vision() { return {json: {kind: 'email_draft', businessRule: 'invented'}, ms: 1}; }};
  const handlers = createScreenHandlers({hub: makeHub(runner), allowOrigin: () => true});
  const started = await body<StartBody>(await handlers.start(request(`${origin}/s`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 's'}));
  await handlers.frames(request(`${origin}/s/frames`, 'POST', upload(), started.sessionToken), {sessionId: 's'}); await tick();
  const updates = await body<UpdatesBody>(await handlers.updates(request(`${origin}/s?cursor=0&generation=1`, 'GET', undefined, started.sessionToken), {sessionId: 's'}));
  assert.equal(updates.observations.length, 0); assert.equal(updates.statuses.at(-1)?.state, 'error');
  assert.equal(updates.statuses.at(-1)?.reason, 'invalid_model_output');
});

test('bounded updates report cursor expiry instead of silently skipping observations', () => {
  let publish: SessionServiceFactoryContext['publish'] | undefined;
  const evidence = createMemoryEvidenceStore();
  const fake: ScreenService = {start() {}, pause() {}, resume() {}, stop() {},
    snapshot: () => ({state: 'capturing', sessionId: 'session', generation: 1, active: 0, queued: 0, sequence: 0}),
    offer: () => 'accepted', evidence};
  const hub = new ScreenSessionHub(context => { publish = context.publish; return fake; }, parseStatus, () => 100_000, 2, 2);
  const started = hub.start('session', 100_000, 1); const session = hub.authenticate('session', started.sessionToken);
  const record = evidenceRecord('e', 'session', 'frame'); const context = publicationContext(record, 'email', 'email-r1', 1);
  publish?.(observation('o1', 1, 'f1', 'email-r1', 'email_draft'), context);
  publish?.(observation('o2', 2, 'f2', 'email-r1', 'email_draft'), context);
  publish?.(observation('o3', 3, 'f3', 'email-r1', 'email_draft'), context);
  assert.throws(() => hub.updates(session, 1, 0), {code: 'cursor_expired'});
});

test('mount exposes start, frame, poll, lifecycle and scoped Evidence routes', () => {
  const routes: string[] = []; const runner: VisionRunner = {async vision() { throw new Error('unused'); }};
  mount({}, {register: (_app, route) => routes.push(`${route.method} ${route.path}`), hub: makeHub(runner), allowOrigin: () => true});
  assert.deepEqual(routes, ['POST /screen/sessions/:sessionId/start', 'POST /screen/sessions/:sessionId/frames',
    'GET /screen/sessions/:sessionId/updates', 'POST /screen/sessions/:sessionId/lifecycle',
    'GET /screen/sessions/:sessionId/evidence/:id', 'GET /screen/sessions/:sessionId/evidence/:id/asset']);
});

function observation(id: string, sequence: number, frameId: string, sourceRevision: string,
  kind: 'order_view' | 'email_draft'): ScreenObservation {
  if (kind === 'order_view') return {schemaVersion: 1, id, sessionId: 'session', sequence, timestampMs: sequence * 5,
    source: 'vision', frameId, sourceRevision, kind, entityRef: null, evidenceIds: [`e-${id}`],
    facts: {customerRef: null, orderId: 'SYN-1', deliveryAddress: null, deliveryWindow: null}};
  return {schemaVersion: 1, id, sessionId: 'session', sequence, timestampMs: sequence * 5,
    source: 'vision', frameId, sourceRevision, kind, entityRef: null, evidenceIds: [`e-${id}`],
    facts: {recipientRef: null, subject: '', bodyText: '', attachments: [], previewState: 'preview'}};
}
function evidenceRecord(id: string, sessionId: string, frameId: string): ScreenEvidenceRecord {
  return {schemaVersion: 1, id, kind: 'frame', sessionId, frameId, assetRef: `/asset/${id}`,
    startMs: 1, endMs: 1, mediaType: 'image/png', byteLength: png.length};
}
function publicationContext(evidence: ScreenEvidenceRecord, surface: 'order' | 'email', sourceRevision: string,
  captureGeneration: number): VisionPublicationContext<ScreenEvidenceRecord> {
  return {queueGeneration: 1, captureGeneration, surface, sourceRevision,
    capturedAtEpochMs: 100_000, receivedAtEpochMs: 100_001, evidence};
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected record');
  return value as Record<string, unknown>;
}
