import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractValidationError, OBSERVATION_KINDS, parseScreenActivityFacts, parseScreenObservation } from '../src/index.ts';
import type { ScreenActivityFacts, ScreenObservation } from '../src/index.ts';

const facts: ScreenActivityFacts = {
  app: null,
  surface: 'Readable arbitrary screen',
  summary: 'A table with quarterly totals is visible.',
  change: 'The selected total changed to 42.',
  entities: ['Quarterly totals', '42'],
  pendingAction: 'Save',
  pendingRegionId: 'save-button',
  regions: [
    {id: 'total.1', label: 'Selected total', box: [0.1, 0.2, 0.3, 0.1]},
    {id: 'save-button', label: 'Save button', box: [0.8, 0.05, 0.1, 0.08]},
  ],
};

const observation: ScreenObservation = {
  schemaVersion: 1,
  id: 'activity-1',
  sessionId: 'session',
  sequence: 1,
  timestampMs: 1000,
  source: 'vision',
  frameId: 'frame-1',
  sourceRevision: null,
  entityRef: null,
  evidenceIds: ['evidence-1'],
  kind: 'screen_activity',
  facts,
};

test('screen_activity facts and observation round-trip for an unknown app', () => {
  assert.ok(OBSERVATION_KINDS.includes('screen_activity'));
  assert.deepEqual(parseScreenActivityFacts(facts), facts);
  assert.deepEqual(parseScreenObservation(observation), observation);
  const parsed = parseScreenActivityFacts(facts);
  parsed.regions[0]!.box[0] = 0.9;
  assert.equal(facts.regions[0]!.box[0], 0.1);
});

test('screen_activity facts reject malformed bounded fields and regions', () => {
  const invalid: unknown[] = [
    {...facts, app: ''},
    {...facts, surface: 'x'.repeat(121)},
    {...facts, summary: 'x'.repeat(401)},
    {...facts, change: 'x'.repeat(301)},
    {...facts, pendingAction: 'x'.repeat(81)},
    {...facts, entities: ['visible', 'visible']},
    {...facts, regions: [...facts.regions, ...Array.from({length: 7}, (_, i) => ({id: `r${i}`, label: 'region', box: [0, 0, 0.1, 0.1]}))]},
    {...facts, regions: [{id: 'unsafe id', label: 'Region', box: [0, 0, 0.1, 0.1]}], pendingRegionId: null},
    {...facts, regions: [{id: 'r', label: '', box: [0, 0, 0.1, 0.1]}], pendingRegionId: null},
    {...facts, regions: [{id: 'r', label: 'Region', box: [0.9, 0, 0.2, 0.1]}], pendingRegionId: null},
    {...facts, regions: [{id: 'r', label: 'Region', box: [0, 0, Number.NaN, 0.1]}], pendingRegionId: null},
    {...facts, pendingRegionId: 'missing'},
    {...facts, extra: true},
  ];
  for (const value of invalid) assert.throws(() => parseScreenActivityFacts(value), ContractValidationError);
});

test('screen_activity enforces generic visual provenance while legacy kinds remain valid', () => {
  assert.throws(() => parseScreenObservation({...observation, sourceRevision: 'workspace-r1'}), /generic provenance/);
  assert.throws(() => parseScreenObservation({...observation, entityRef: 'person-1'}), /generic provenance/);
  assert.throws(() => parseScreenObservation({...observation, source: 'workspace', frameId: null}), /visual observation provenance/);
});
