import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { JOURNEY_EVENT_TYPES } from '../events.ts';
import { JOURNEY_PHASES, JOURNEY_STEPS, MAX_LINE_WORDS, journeyTargets, wordCount } from '../journey.ts';
import type { JourneyStep } from '../journey.ts';

const allLines = (step: JourneyStep): string[] => [
  step.line,
  ...(step.nudge?.line ? [step.nudge.line] : []),
  ...Object.values(step.variants ?? {}).flatMap((v) => (v ? [v.line] : [])),
];

describe('the journey table (doc-10)', () => {
  it('has the doc-10 steps in order', () => {
    assert.deepEqual(
      JOURNEY_STEPS.map((s) => s.id),
      ['open', 'share', 'learn', 'review-board', 'teach-back', 'handoff', 'teach', 'teach-fix', 'summary'],
    );
  });

  it('covers every phase of the strip, in order', () => {
    const seen: string[] = [];
    for (const step of JOURNEY_STEPS) if (seen.at(-1) !== step.phase) seen.push(step.phase);
    assert.deepEqual(seen, [...JOURNEY_PHASES]);
  });

  it('gives every step a target, a line and an exit event (the last step ends the journey)', () => {
    for (const step of JOURNEY_STEPS) {
      assert.ok(step.target.length > 0, `${step.id} target`);
      assert.ok(step.line.length > 0, `${step.id} line`);
      if (step.id !== 'summary') assert.ok(step.exit.length > 0, `${step.id} exit`);
    }
    assert.equal(JOURNEY_STEPS.at(-1)?.exit.length, 0);
  });

  it('keeps every line to one short sentence of at most 14 words', () => {
    for (const step of JOURNEY_STEPS) {
      for (const line of allLines(step)) {
        assert.ok(wordCount(line) <= MAX_LINE_WORDS, `${step.id}: "${line}" has ${wordCount(line)} words`);
        const stops = line.match(/[.!?]/g) ?? [];
        assert.ok(stops.length <= 1 && /[.!?]$/.test(line), `${step.id}: "${line}" is not one sentence`);
      }
    }
  });

  it('only waits for events the shell is told to emit', () => {
    for (const step of JOURNEY_STEPS) {
      for (const matcher of [...step.exit, ...(step.enter.on ?? [])]) {
        assert.ok(JOURNEY_EVENT_TYPES.includes(matcher.type), `${step.id} waits for unknown event ${matcher.type}`);
      }
    }
  });

  it('assigns a persona to each step: expert for Learn and Review, new hire for Teach', () => {
    const persona = Object.fromEntries(JOURNEY_STEPS.map((s) => [s.id, s.persona]));
    assert.equal(persona['learn'], 'expert');
    assert.equal(persona['review-board'], 'expert');
    assert.equal(persona['teach'], 'newHire');
    assert.equal(persona['open'], 'any');
  });

  it('lists the data-clipa-target values the shell must expose', () => {
    assert.deepEqual(journeyTargets(), [
      'board-gap',
      'mask-confirm',
      'mastery-summary',
      'mode-review',
      'mode-teach',
      'review-board',
      'screen-preview',
      'send',
      'share-screen',
      'teachback',
      'use-camera',
      'workspace',
    ]);
  });

  it('documents the same targets and events in the README', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const target of journeyTargets()) assert.ok(readme.includes(`\`${target}\``), `README misses target ${target}`);
    for (const type of JOURNEY_EVENT_TYPES) assert.ok(readme.includes(`\`${type}\``), `README misses event ${type}`);
  });

  it('respects reduced motion in the strip styles', () => {
    const css = readFileSync(new URL('../progress-strip.css', import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /prefers-color-scheme: dark/);
  });
});
