// Generic vision (TASK-3.52): any app on a shared screen becomes a screen_activity observation, while frames of a
// known workspace surface are read exactly as before. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import type {ScreenObservation} from '@apprentice/contracts';
import {parseObservation as conductorObservation} from '../agent/conductor/protocol.ts';
import {createMemoryEvidenceStore} from './evidence-store.ts';
import type {ScreenEvidenceRecord} from './evidence-store.ts';
import {createScreenHandlers} from './handlers.ts';
import type {VisionRunner, VisionRunnerRequest} from './runner-client.ts';
import {createScreenService, defaultVisionPrompt, genericVisionPrompt, genericVisionSystem, visibleOnlySystem} from './service.ts';
import {ScreenSessionHub} from './session-transport.ts';
import {createObservationFactory, parseVisionResult, VISION_RESULT_SCHEMA, WORKSPACE_VISION_SCHEMA} from './vision-contract.ts';

const origin = 'https://demo.example';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgQIAff9vEwAAAABJRU5ErkJggg==', 'base64');
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function activity(facts: Record<string, unknown> = {}): Record<string, unknown> {
  return {outcome: 'observation', kind: 'screen_activity', facts: {app: 'Sheets', surface: 'sheet Q1 budget',
    summary: 'A budget table with three synthetic rows is open.', change: 'Cell C4 now reads 450.',
    entities: ['C4: 450', 'Total: 1,250'], pendingAction: 'Share', pendingRegionId: 'r2',
    regions: [{id: 'r1', label: 'cell C4', box: [0.3, 0.4, 0.1, 0.03]}, {id: 'r2', label: 'Share button', box: [0.85, 0.02, 0.1, 0.05]}],
    ...facts}};
}
function evidence(id: string): ScreenEvidenceRecord {
  return {schemaVersion: 1, id, kind: 'frame', sessionId: 'session', frameId: 'frame-1', assetRef: `/asset/${id}`,
    startMs: 1, endMs: 1, mediaType: 'image/png', byteLength: png.length};
}
function hub(runner: VisionRunner, genericVision?: boolean): ScreenSessionHub {
  return new ScreenSessionHub(({publish, onEvent}) => createScreenService({runner, parseObservation: parseScreenObservation, genericVision,
    evidence: createMemoryEvidenceStore(), publish, onEvent, queueOptions: {sampleIntervalMs: 0, now: () => 100_010}}),
  parseScreenStatus, () => 100_010, 8, 128);
}
function request(url: string, method: 'GET' | 'POST', body?: unknown, token?: string): Request {
  return new Request(url, {method, headers: {origin, ...(body === undefined ? {} : {'content-type': 'application/json'}),
    ...(token ? {authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
function upload(surface: 'email' | null, sourceRevision: string | null) {
  return {generation: 1, frameId: 'frame-1', timestampMs: 5, processed: true, mediaType: 'image/png', data: png.toString('base64'),
    provenance: {surface, sourceRevision, captureGeneration: 7}};
}
/** One frame through the real HTTP path; returns what the runner was sent and what the session published. */
async function runFrame(surface: 'email' | null, sourceRevision: string | null, answer: Record<string, unknown>, genericVision?: boolean) {
  const sent: VisionRunnerRequest[] = [];
  const runner: VisionRunner = {async vision(input) { sent.push(input); return {json: answer, ms: 3}; }};
  const handlers = createScreenHandlers({hub: hub(runner, genericVision), allowOrigin: () => true});
  const started = await (await handlers.start(request(`${origin}/s`, 'POST', {sessionEpochMs: 100_000, clientGeneration: 1}), {sessionId: 's'}))
    .json() as {sessionToken: string};
  const accepted = await handlers.frames(request(`${origin}/s/frames`, 'POST', upload(surface, sourceRevision), started.sessionToken), {sessionId: 's'});
  assert.equal(accepted.status, 202); await tick();
  const updates = await (await handlers.updates(request(`${origin}/s?cursor=0&generation=1`, 'GET', undefined, started.sessionToken), {sessionId: 's'}))
    .json() as {observations: ScreenObservation[]; statuses: {state: string; reason?: string}[]};
  return {sent, updates};
}

test('a readable screen_activity parses and is normalised within the contract limits', () => {
  const result = parseVisionResult(activity({app: '  ', change: '', summary: `  ${'x'.repeat(450)}  `, entities: [' C4: 450 ', ''],
    pendingRegionId: 'Share button', regions: [{id: 'r1', label: 'cell C4', box: [0.3, 0.4, 0.1, 0.03]},
      {id: 'Share button', label: 'Share button', box: [0.85, 0.02, 0.3, 0.05]}]}));
  assert.equal(result.outcome, 'observation');
  if (result.outcome !== 'observation' || result.kind !== 'screen_activity') throw new Error('expected screen_activity');
  assert.equal(result.facts.app, null); assert.equal(result.facts.change, null);
  assert.equal(result.facts.summary.length, 400); assert.deepEqual(result.facts.entities, ['C4: 450']);
  assert.deepEqual(result.facts.regions.map(r => r.id), ['r1', 'r2']); assert.equal(result.facts.pendingRegionId, 'r2');
  const box = result.facts.regions[1]?.box; if (!box) throw new Error('expected a box');
  assert.ok(box[0] + box[2] <= 1.0001, 'a box past the right edge is cut at the edge');
  assert.equal(parseVisionResult(activity({pendingRegionId: 'r9'})).outcome, 'observation');
});

test('malformed screen_activity output is rejected', () => {
  const region = (box: unknown, id = 'r1'): Record<string, unknown> => ({id, label: 'field', box});
  const seven = Array.from({length: 7}, (_, i) => region([0, 0, 0.1, 0.1], `r${i + 1}`));
  for (const facts of [{regions: [region([0, 0, 0.1])]}, {regions: [region([0, 0, 1.2, 0.1])]}, {regions: [region([-0.1, 0, 0.1, 0.1])]},
    {regions: [region({x: 0, y: 0, w: 0.1, h: 0.1})]}, {regions: [region([0, 0, Number.NaN, 0.1])]}, {regions: seven},
    {regions: [{...region([0, 0, 0.1, 0.1]), extra: true}]}, {entities: [42]}, {summary: ' '}, {surface: null}, {rationale: 'invented'}]) {
    assert.throws(() => parseVisionResult(activity({...facts, pendingRegionId: null})), {code: 'invalid_model_output'}, JSON.stringify(facts));
  }
  const missing = activity(); delete (missing.facts as Record<string, unknown>).regions;
  assert.throws(() => parseVisionResult(missing), {code: 'invalid_model_output'});
});

test('the workspace schema is byte-for-byte the schema before screen_activity', () => {
  const sha = createHash('sha256').update(JSON.stringify(WORKSPACE_VISION_SCHEMA)).digest('hex');
  assert.equal(sha, 'e8fd389657e52ed8f146ae244a0a53c26ca6d7e52759d9a0e8a43800fbd5beb7');
  assert.equal(JSON.stringify(WORKSPACE_VISION_SCHEMA).includes('screen_activity'), false);
  assert.equal(JSON.stringify(VISION_RESULT_SCHEMA).includes('screen_activity'), true);
});

test('genericVision false reads a frame with no surface exactly as before screen_activity', async () => {
  const {sent, updates} = await runFrame(null, null, activity(), false);
  assert.equal(sent[0]?.prompt, defaultVisionPrompt); assert.equal(sent[0]?.system, visibleOnlySystem);
  assert.equal(sent[0]?.schema, WORKSPACE_VISION_SCHEMA);
  assert.equal(updates.observations.length, 1, 'a stray screen_activity answer is still a valid generic observation');
});

test('screen_activity becomes an observation only for a frame with no workspace surface', () => {
  const result = parseVisionResult(activity());
  const make = createObservationFactory(parseScreenObservation, () => 'observation-1');
  const context = {sessionId: 'session', frameId: 'frame-1', timestampMs: 5, sequence: 1, sourceRevision: 'r-7', evidence: evidence('evidence-1')};
  const observation = make(result, {...context, surface: null});
  assert.equal(observation.kind, 'screen_activity'); assert.equal(observation.entityRef, null); assert.equal(observation.sourceRevision, null);
  assert.deepEqual(observation.evidenceIds, ['evidence-1']);
  for (const surface of ['order', 'email', 'ticket'] as const) {
    assert.throws(() => make(result, {...context, surface}), {code: 'invalid_model_output'});
  }
});

test('an unknown app on a shared screen is described instead of vision_incomplete, and the conductor keeps it', async () => {
  const {sent, updates} = await runFrame(null, null, activity());
  assert.equal(sent[0]?.prompt, genericVisionPrompt); assert.equal(sent[0]?.system, genericVisionSystem);
  assert.equal(sent[0]?.schema, VISION_RESULT_SCHEMA);
  assert.match(genericVisionSystem, /never read, guess or describe what is under them/);
  assert.equal(updates.statuses.some(s => s.reason === 'vision_incomplete'), false);
  assert.equal(updates.observations.length, 1);
  const observation = updates.observations[0];
  if (observation?.kind !== 'screen_activity') throw new Error('expected a screen_activity observation');
  assert.equal(observation.facts.app, 'Sheets'); assert.equal(observation.sourceRevision, null);
  const seen = conductorObservation(observation);
  if (!seen.ok) throw new Error(`conductor rejected the observation at ${seen.field}`);
  assert.equal(seen.value.kind, 'screen_activity'); assert.equal(seen.value.app, 'Sheets');
  assert.equal(seen.value.surface, 'sheet Q1 budget'); assert.equal(seen.value.change, 'Cell C4 now reads 450.');
  assert.equal(seen.value.pendingAction, 'Share');
  assert.deepEqual(seen.value.regions, [
    {regionId: 'r1', label: 'cell C4', box: [0.3, 0.4, 0.1, 0.03], evidenceId: observation.evidenceIds[0]},
    {regionId: 'r2', label: 'Share button', box: [0.85, 0.02, 0.1, 0.05], evidenceId: observation.evidenceIds[0]},
  ]);
});

test('a workspace frame keeps its targeted prompt, system and schema, and its email_draft facts', async () => {
  const email = {outcome: 'observation', kind: 'email_draft', facts: {recipientRef: null, subject: 'Synthetic',
    bodyText: 'Visible text', attachments: [{kind: 'image'}], previewState: 'preview'}};
  const {sent, updates} = await runFrame('email', 'email-r1', email);
  assert.equal(sent[0]?.prompt, `${defaultVisionPrompt}\nAnalyze the email draft surface. Return its matching kind, or incomplete if it is not readable.`);
  assert.equal(sent[0]?.system, visibleOnlySystem); assert.equal(sent[0]?.schema, WORKSPACE_VISION_SCHEMA);
  assert.equal(updates.observations[0]?.kind, 'email_draft'); assert.equal(updates.observations[0]?.sourceRevision, 'email-r1');
  const generic = await runFrame('email', 'email-r1', activity());
  assert.equal(generic.updates.observations.length, 0);
  assert.equal(generic.updates.statuses.at(-1)?.reason, 'invalid_model_output');
});
