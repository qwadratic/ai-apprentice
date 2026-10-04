import assert from 'node:assert/strict';
import test from 'node:test';
import {EvidenceTimeline, EvidenceTimelineError, type RecordingSegment} from './index.ts';

const segments: RecordingSegment[] = [
  {id: 'two', sessionId: 's', assetRef: '/two.webm', startMs: 4_000, endMs: 6_000, mediaStartMs: 0, mediaEndMs: 2_000, mimeType: 'video/webm'},
  {id: 'one', sessionId: 's', assetRef: '/one.webm', startMs: 0, endMs: 1_000, mediaStartMs: 250, mediaEndMs: 1_250, mimeType: 'video/webm'},
];

test('maps exact session time to segment-local media time across pause/resume', () => {
  const timeline = new EvidenceTimeline(segments);
  assert.equal(timeline.forEvidence({assetRef: '/frame.png', startMs: 4_750, endMs: 4_750})?.segment.id, 'two');
  assert.equal(timeline.at(500)?.mediaTimestampMs, 750);
  assert.equal(timeline.at(5_500)?.mediaTimestampMs, 1_500);
  assert.equal(timeline.at(2_000), null, 'paused time remains an unplayable gap');
  assert.equal(timeline.at(1_000), null, 'an ended segment does not own its half-open boundary');
});

test('rejects timestamps outside Evidence rather than seeking unrelated media', () => {
  const timeline = new EvidenceTimeline(segments);
  assert.throws(() => timeline.forEvidence({assetRef: '/frame.png', startMs: 4_500, endMs: 5_000}, 4_499),
    (error: unknown) => error instanceof EvidenceTimelineError && error.code === 'invalid_evidence');
  assert.equal(timeline.forEvidence({assetRef: '/frame.png', startMs: 2_000, endMs: 2_000}), null);
});

test('rejects malformed, short-media and overlapping segments', () => {
  assert.throws(() => new EvidenceTimeline([{...segments[0]!, assetRef: ''}]), EvidenceTimelineError);
  assert.throws(() => new EvidenceTimeline([{...segments[0]!, mediaEndMs: 10}]), EvidenceTimelineError);
  assert.throws(() => new EvidenceTimeline([segments[0]!, {...segments[0]!, id: 'overlap', startMs: 5_000, endMs: 7_000, mediaEndMs: 2_000}]),
    (error: unknown) => error instanceof EvidenceTimelineError && error.code === 'overlapping_segments');
});

test('allows independent sessions at the same time and selects the requested session', () => {
  const other = {...segments[0]!, id: 'other', sessionId: 'other-session'};
  const timeline = new EvidenceTimeline([segments[0]!, other]);
  assert.equal(timeline.at(5_000, 'other-session')?.segment.id, 'other');
  assert.throws(() => timeline.at(5_000),
    (error: unknown) => error instanceof EvidenceTimelineError && error.code === 'invalid_evidence');
});
