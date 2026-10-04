// Ported from stream A's TASK-3.52 branch (PR #56) and adapted to main's API (parseScreenObservation) and limits
// (at most 6 regions and 8 entities). Cases that contracts.test.ts already covers are not repeated. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractValidationError, OBSERVATION_KINDS, parseScreenObservation, SCREEN_ACTIVITY_LIMITS as LIMITS } from '../src/index.ts';
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
    { id: 'total.1', label: 'Selected total', box: [0.1, 0.2, 0.3, 0.1] },
    { id: 'save-button', label: 'Save button', box: [0.8, 0.05, 0.1, 0.08] },
  ],
};
const observation: ScreenObservation = {
  schemaVersion: 1, id: 'activity-1', sessionId: 'session', sequence: 1, timestampMs: 1000, source: 'vision',
  frameId: 'frame-1', sourceRevision: null, entityRef: null, evidenceIds: ['evidence-1'], kind: 'screen_activity', facts,
};
const withFacts = (patch: Partial<Record<keyof ScreenActivityFacts, unknown>>): unknown => ({ ...observation, facts: { ...facts, ...patch } });

test('a screen_activity observation of an unknown app round-trips, and the parsed copy is independent', () => {
  assert.ok(OBSERVATION_KINDS.includes('screen_activity'));
  const parsed = parseScreenObservation(observation);
  assert.deepEqual(parsed, observation);
  if (parsed.kind !== 'screen_activity') throw new Error('expected screen_activity');
  const region = parsed.facts.regions[0];
  if (!region) throw new Error('expected a region');
  region.box[0] = 0.9;
  assert.equal(facts.regions[0]?.box[0], 0.1);
});

test('screen_activity rejects empty or over-long text, an empty region label and a non-finite or overflowing box', () => {
  const region = (box: unknown, label = 'Region'): Record<string, unknown> => ({ id: 'r', label, box });
  for (const value of [
    withFacts({ app: '' }),
    withFacts({ summary: 'x'.repeat(LIMITS.summary + 1) }),
    withFacts({ change: 'x'.repeat(LIMITS.change + 1) }),
    withFacts({ pendingAction: 'x'.repeat(LIMITS.pendingAction + 1) }),
    withFacts({ app: 'x'.repeat(LIMITS.app + 1) }),
    withFacts({ regions: [region([0, 0, 0.1, 0.1], '')], pendingRegionId: null }),
    withFacts({ regions: [region([0, 0, Number.NaN, 0.1])], pendingRegionId: null }),
    // The canonical parser rejects a box past the bottom edge; the API cuts such a box at the edge before it gets here.
    withFacts({ regions: [region([0, 0.95, 0.1, 0.1])], pendingRegionId: null }),
  ]) assert.throws(() => parseScreenObservation(value), ContractValidationError, JSON.stringify(value));
});
