import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScreenObservation} from '@apprentice/contracts';
import {createMemoryEvidenceStore} from './evidence-store.ts';
import {createScreenService} from './service.ts';
import {createObservationFactory, parseVisionResult, VISION_RESULT_SCHEMA, VisionContractError} from './vision-contract.ts';

const facts = {
  app: 'Gmail', surface: 'Inbox', summary: 'An inbox with a selected message is visible.', change: null,
  entities: ['Inbox', 'Selected message'], pendingAction: 'Reply', pendingRegionId: 'reply',
  regions: [{id: 'reply', label: 'Reply button', box: [0.7, 0.8, 0.2, 0.1]}],
} as const;

test('screen_activity schema is additive and bounded', () => {
  const variants = (VISION_RESULT_SCHEMA.oneOf as ReadonlyArray<Record<string, unknown>>);
  assert.equal(variants.length, 5);
  assert.ok(JSON.stringify(VISION_RESULT_SCHEMA).includes('screen_activity'));
  assert.deepEqual(parseVisionResult({outcome: 'observation', kind: 'screen_activity', facts}),
    {outcome: 'observation', kind: 'screen_activity', facts});
  assert.deepEqual(parseVisionResult({outcome: 'observation', kind: 'ticket',
    facts: {ticketId: 'SYN-1', orderId: null, customerRef: null, status: 'open', summary: 'Visible'}}),
  {outcome: 'observation', kind: 'ticket',
    facts: {ticketId: 'SYN-1', orderId: null, customerRef: null, status: 'open', summary: 'Visible'}});
});

test('screen_activity parser rejects malformed bounds, IDs and references', () => {
  const invalidFacts: unknown[] = [
    {...facts, app: 'a'.repeat(81)},
    {...facts, surface: ''},
    {...facts, summary: 's'.repeat(401)},
    {...facts, change: 'c'.repeat(301)},
    {...facts, entities: ['same', 'same']},
    {...facts, pendingAction: 'p'.repeat(81)},
    {...facts, pendingRegionId: 'missing'},
    {...facts, regions: Array.from({length: 9}, (_, index) => ({id: `r${index}`, label: 'region', box: [0, 0, 0.1, 0.1]}))},
    {...facts, regions: [{id: 'bad id', label: 'region', box: [0, 0, 0.1, 0.1]}]},
    {...facts, regions: [{id: 'reply', label: 'region', box: [0.9, 0, 0.2, 0.1]}]},
    {...facts, regions: [{id: 'reply', label: 'region', box: [0, 0, Number.NaN, 0.1]}]},
    {...facts, extra: true},
  ];
  for (const invalid of invalidFacts) {
    assert.throws(() => parseVisionResult({outcome: 'observation', kind: 'screen_activity', facts: invalid}),
      (error: unknown) => error instanceof VisionContractError && error.code === 'invalid_model_output');
  }
});

test('screen_activity observations keep evidence but discard workspace provenance', async () => {
  const evidenceStore = createMemoryEvidenceStore();
  const evidence = await evidenceStore.save({sessionId: 'session', frameId: 'frame', timestampMs: 5,
    processed: true, mediaType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])},
    {signal: new AbortController().signal});
  const result = parseVisionResult({outcome: 'observation', kind: 'screen_activity', facts});
  const observation = createObservationFactory(parseScreenObservation, () => 'observation-1')(result, {
    sessionId: 'session', frameId: 'frame', timestampMs: 5, sequence: 1,
    surface: 'email', sourceRevision: 'email-r1', evidence,
  });
  assert.equal(observation.kind, 'screen_activity');
  assert.equal(observation.sourceRevision, null);
  assert.equal(observation.entityRef, null);
  assert.deepEqual(observation.evidenceIds, [evidence.id]);
  assert.deepEqual(observation.facts, facts);
});

test('incomplete outcomes remain limited and reject mixed observation fields', () => {
  assert.deepEqual(parseVisionResult({outcome: 'incomplete', reason: 'unreadable'}),
    {outcome: 'incomplete', reason: 'unreadable'});
  assert.deepEqual(parseVisionResult({outcome: 'incomplete', reason: 'unsupported_surface'}),
    {outcome: 'incomplete', reason: 'unsupported_surface'});
  assert.throws(() => parseVisionResult({outcome: 'incomplete', reason: 'unreadable', kind: 'screen_activity'}),
    {code: 'invalid_model_output'});
});

test('vision runner request spells out generic region and identity semantics', async () => {
  let request: Parameters<NonNullable<Parameters<typeof createScreenService>[0]['runner']['vision']>>[0] | undefined;
  const service = createScreenService({
    runner: {async vision(input) {
      request = input;
      return {json: {outcome: 'observation', kind: 'screen_activity', facts}, ms: 1};
    }},
    parseObservation: parseScreenObservation, evidence: createMemoryEvidenceStore(), publish() {},
    queueOptions: {sampleIntervalMs: 0, now: () => 10},
  });
  service.start({sessionId: 'session', sessionEpochMs: 0});
  service.offer({sessionId: 'session', frameId: 'frame', timestampMs: 5, processed: true,
    mediaType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])});
  for (let index = 0; index < 4 && request === undefined; index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(request);
  assert.match(request.system ?? '', /visible branding; otherwise use null/);
  assert.match(request.system ?? '', /\[x, y, width, height\] normalized to the processed frame/);
  assert.match(request.system ?? '', /pendingRegionId must be null or the id of a region included in regions/);
  assert.match(request.system ?? '', /regions with unique ids/);
  assert.match(JSON.stringify(request.schema), /\[x, y, width, height\] normalized to the processed frame/);
  assert.match(JSON.stringify(request.schema), /The id of one region included in regions, or null/);
});
