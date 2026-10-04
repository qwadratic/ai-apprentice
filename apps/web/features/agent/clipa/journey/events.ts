/*
 * The events the journey engine reads. The shell emits them; nothing here touches the DOM, so node tests import it.
 * The list the shell must emit is in README.md; keep the two in step.
 */

/** The three product modes plus the wrap-up. Order matters: a later mode means the earlier ones are over. */
export const JOURNEY_MODES = ['learn', 'review', 'teach', 'summary'] as const;
export type JourneyMode = (typeof JOURNEY_MODES)[number];

export function modeRank(mode: JourneyMode): number {
  return JOURNEY_MODES.indexOf(mode);
}

export function isJourneyMode(value: unknown): value is JourneyMode {
  return typeof value === 'string' && (JOURNEY_MODES as readonly string[]).includes(value);
}

export type ShareFailure = 'denied' | 'unsupported' | 'lost' | 'error';

export type JourneyEvent =
  /** A session id exists and the page is ready (the Share control is mounted). Also sent after a reload. */
  | { type: 'session_started'; mode?: JourneyMode }
  /** The person clicked Share screen (or the camera button); the browser picker or permission prompt is opening. */
  | { type: 'share_requested' }
  /** The picker returned and the person must review the privacy masks before anything is processed. */
  | { type: 'mask_review' }
  | { type: 'screen_capturing' }
  | { type: 'camera_capturing' }
  /** Sharing was refused, cancelled, is unsupported, or dropped while the journey was past the share step. */
  | { type: 'screen_unavailable'; reason?: ShareFailure }
  | { type: 'mode_changed'; mode: JourneyMode }
  /** The agent asked a live question (Learn). Clipa stays out of its way and the strip counts it. */
  | { type: 'agent_asked'; guardrail?: boolean }
  | { type: 'teachback_started' }
  | { type: 'teachback_confirmed' }
  /** Teach: the checkpoint warned before Send. */
  | { type: 'checkpoint_warned' }
  /** The person pressed Send and it went through (allowed). */
  | { type: 'sent' }
  /** The person types (keyboard in the workspace or any field). Edge events: active true, then false. */
  | { type: 'typing'; active: boolean }
  /** Somebody speaks: the person (default) or the agent. */
  | { type: 'talking'; active: boolean; by?: 'person' | 'agent' }
  | { type: 'off_record'; on: boolean };

export type JourneyEventType = JourneyEvent['type'];

export const JOURNEY_EVENT_TYPES: readonly JourneyEventType[] = [
  'session_started',
  'share_requested',
  'mask_review',
  'screen_capturing',
  'camera_capturing',
  'screen_unavailable',
  'mode_changed',
  'agent_asked',
  'teachback_started',
  'teachback_confirmed',
  'checkpoint_warned',
  'sent',
  'typing',
  'talking',
  'off_record',
];

/** What a step waits for. `mode_changed` matches the named mode or any later one. */
export type EventMatcher =
  | { type: Exclude<JourneyEventType, 'mode_changed'> }
  | { type: 'mode_changed'; mode: JourneyMode };

export function matchesEvent(matcher: EventMatcher, event: JourneyEvent): boolean {
  if (matcher.type !== event.type) return false;
  if (matcher.type === 'mode_changed' && event.type === 'mode_changed') {
    return modeRank(event.mode) >= modeRank(matcher.mode);
  }
  return true;
}

/** True when the mode the app is in already satisfies a `mode_changed` matcher. */
export function matchesMode(matcher: EventMatcher, mode: JourneyMode): boolean {
  return matcher.type === 'mode_changed' && modeRank(mode) >= modeRank(matcher.mode);
}

export interface JourneyEventSource {
  subscribe(listener: (event: JourneyEvent) => void): () => void;
}

export interface JourneyEventBus extends JourneyEventSource {
  emit(event: JourneyEvent): void;
}

/** A tiny synchronous bus: the shell emits into it and hands it to createJourney as `events`. */
export function createJourneyEventBus(): JourneyEventBus {
  const listeners = new Set<(event: JourneyEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
