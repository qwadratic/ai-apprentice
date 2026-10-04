import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClipaDirector } from '../../src/director.ts';
import type { JourneyDirector } from '../engine.ts';

/** Compile-time guard: the real ClipaDirector is a JourneyDirector, so the shell can pass it as it is. */
const asJourneyDirector = (director: ClipaDirector): JourneyDirector => director;

describe('the director the journey drives', () => {
  it('is the merged ClipaDirector, unchanged', () => {
    assert.equal(typeof asJourneyDirector, 'function');
  });
});
