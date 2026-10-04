import type {EvidenceRef} from '@apprentice/contracts';

/** A committed, playable interval from the processed-only screen recording. */
export interface RecordingSegment {
  readonly id: string;
  readonly sessionId: string;
  readonly assetRef: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly mediaStartMs: number;
  readonly mediaEndMs: number;
  readonly mimeType: string;
}

export interface ReplayTarget {
  readonly segment: RecordingSegment;
  readonly sessionTimestampMs: number;
  readonly mediaTimestampMs: number;
}

export class EvidenceTimelineError extends Error {
  readonly code: 'invalid_segment' | 'overlapping_segments' | 'invalid_evidence';
  constructor(code: 'invalid_segment' | 'overlapping_segments' | 'invalid_evidence', message: string) {
    super(message);
    this.code = code;
    this.name = 'EvidenceTimelineError';
  }
}

/**
 * Validates and indexes ready recording segments. Gaps are intentionally kept:
 * they are paused/off-record time and must never be skipped over during replay.
 */
export class EvidenceTimeline {
  readonly #segments: readonly RecordingSegment[];

  constructor(segments: readonly RecordingSegment[]) {
    const ordered = segments.map(copyAndValidate).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const previousBySession = new Map<string, RecordingSegment>();
    for (const segment of ordered) {
      const previous = previousBySession.get(segment.sessionId);
      if (previous && segment.startMs < previous.endMs) {
        throw new EvidenceTimelineError('overlapping_segments', `Recording segments ${previous.id} and ${segment.id} overlap.`);
      }
      previousBySession.set(segment.sessionId, segment);
    }
    this.#segments = Object.freeze(ordered);
  }

  get segments(): readonly RecordingSegment[] { return this.#segments; }

  /** Returns null for a paused gap or a timestamp outside all committed media. */
  at(sessionTimestampMs: number, sessionId?: string): ReplayTarget | null {
    if (!finiteNonNegative(sessionTimestampMs)) return null;
    if (!sessionId && new Set(this.#segments.map(item => item.sessionId)).size > 1) {
      throw new EvidenceTimelineError('invalid_evidence', 'A sessionId is required when the timeline contains multiple sessions.');
    }
    const segment = this.#segments.find(item => (!sessionId || item.sessionId === sessionId) &&
      sessionTimestampMs >= item.startMs && sessionTimestampMs < item.endMs);
    if (!segment) return null;
    const elapsed = Math.min(sessionTimestampMs - segment.startMs, segment.mediaEndMs - segment.mediaStartMs);
    return {segment, sessionTimestampMs, mediaTimestampMs: segment.mediaStartMs + elapsed};
  }

  /** Maps an exact point covered by Evidence; it never snaps to a nearby segment. */
  forEvidence(evidence: EvidenceRef, sessionTimestampMs = evidence.startMs, sessionId?: string): ReplayTarget | null {
    validateEvidence(evidence);
    if (!finiteNonNegative(sessionTimestampMs) || sessionTimestampMs < evidence.startMs || sessionTimestampMs > evidence.endMs) {
      throw new EvidenceTimelineError('invalid_evidence', 'Replay timestamp must be inside the Evidence interval.');
    }
    return this.at(sessionTimestampMs, sessionId);
  }
}

function copyAndValidate(input: RecordingSegment): RecordingSegment {
  for (const [name, value] of Object.entries({id: input.id, sessionId: input.sessionId, assetRef: input.assetRef, mimeType: input.mimeType})) {
    if (typeof value !== 'string' || !value.trim()) throw new EvidenceTimelineError('invalid_segment', `${name} must be a non-empty string.`);
  }
  for (const [name, value] of Object.entries({startMs: input.startMs, endMs: input.endMs, mediaStartMs: input.mediaStartMs, mediaEndMs: input.mediaEndMs})) {
    if (!finiteNonNegative(value)) throw new EvidenceTimelineError('invalid_segment', `${name} must be a finite non-negative number.`);
  }
  if (input.endMs <= input.startMs || input.mediaEndMs <= input.mediaStartMs) {
    throw new EvidenceTimelineError('invalid_segment', 'Segment intervals must have positive duration.');
  }
  if (input.mediaEndMs - input.mediaStartMs < input.endMs - input.startMs) {
    throw new EvidenceTimelineError('invalid_segment', 'Media must cover the complete session interval.');
  }
  return Object.freeze({...input});
}

function validateEvidence(evidence: EvidenceRef): void {
  if (!evidence || typeof evidence.assetRef !== 'string' || !evidence.assetRef || !finiteNonNegative(evidence.startMs) ||
      !finiteNonNegative(evidence.endMs) || evidence.endMs < evidence.startMs) {
    throw new EvidenceTimelineError('invalid_evidence', 'Evidence reference is invalid.');
  }
}

function finiteNonNegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }
