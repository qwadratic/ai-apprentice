/*
 * The events the journey engine reads. The shell emits them; nothing here touches the DOM, so node tests import it.
 * The list the shell must emit is in README.md; keep the two in step.
 *
 * Vocabulary of the shell: a MODE is the tab that is selected (learn, review, teach). A SESSION is what the Start button
 * makes: one session per mode, live until End (or the 10 minute limit, or off the record). Clipa guides the sessions.
 */

export const JOURNEY_MODES = ['learn', 'review', 'teach'] as const;
export type JourneyMode = (typeof JOURNEY_MODES)[number];

export function modeRank(mode: JourneyMode): number {
  return JOURNEY_MODES.indexOf(mode);
}

export function isJourneyMode(value: unknown): value is JourneyMode {
  return typeof value === 'string' && (JOURNEY_MODES as readonly string[]).includes(value);
}

export type ShareFailure = 'denied' | 'unsupported' | 'lost' | 'error';

export type JourneyEvent =
  /** The page is ready and the Start control is mounted. Sent on every page load, with the tab that is selected. */
  | { type: 'app_ready'; mode?: JourneyMode }
  /** The person selected a tab. Only changes which control Clipa points at for Start. */
  | { type: 'mode_changed'; mode: JourneyMode }
  /** Start was pressed and the session of this mode is live (the shell's SESSION_READY). */
  | { type: 'session_live'; mode: JourneyMode }
  /** The session of this mode ended: End, the time limit, or off the record (the shell's SESSION_ENDED). */
  | { type: 'session_ended'; mode: JourneyMode; reason?: 'user' | 'limit' | 'off_record' }
  /** The person clicked Share screen; the browser picker is opening. */
  | { type: 'share_requested' }
  /** The picker returned and the person must confirm the privacy masks before anything is processed. */
  | { type: 'mask_review' }
  | { type: 'screen_capturing' }
  | { type: 'camera_capturing' }
  /** Sharing was refused or cancelled (`denied`, `error`), is unsupported (`unsupported`), or dropped (`lost`). */
  | { type: 'screen_unavailable'; reason?: ShareFailure }
  /** The agent is about to ask a question: every spoken ASK_NOW and PREDICT in any mode, sent before the presenter plays. */
  | { type: 'agent_asked'; guardrail?: boolean }
  /** The agent speaks the teach-back (not when it is only shown). */
  | { type: 'teachback_started' }
  | { type: 'teachback_confirmed' }
  /** Teach: the checkpoint warned before Send. */
  | { type: 'checkpoint_warned' }
  /** The person pressed Send and it went through (allowed). */
  | { type: 'sent' }
  /** An explicit Finish in the mastery card, if the shell has one. The end of the Teach session also finishes the journey. */
  | { type: 'teach_finished' }
  /** The person types (keyboard in the workspace or any field). Edge events: active true, then false. */
  | { type: 'typing'; active: boolean }
  /** Somebody speaks: the person (default) or the agent. */
  | { type: 'talking'; active: boolean; by?: 'person' | 'agent' }
  | { type: 'off_record'; on: boolean };

export type JourneyEventType = JourneyEvent['type'];

export const JOURNEY_EVENT_TYPES: readonly JourneyEventType[] = [
  'app_ready',
  'mode_changed',
  'session_live',
  'session_ended',
  'share_requested',
  'mask_review',
  'screen_capturing',
  'camera_capturing',
  'screen_unavailable',
  'agent_asked',
  'teachback_started',
  'teachback_confirmed',
  'checkpoint_warned',
  'sent',
  'teach_finished',
  'typing',
  'talking',
  'off_record',
];

type RankedType = 'session_live' | 'session_ended';

/**
 * What a step waits for. `session_live` and `session_ended` match the named mode or any later one (a new hire who
 * starts Teach has, as far as the journey goes, started everything before it); `mode_changed` matches that tab only.
 */
export type EventMatcher =
  | { type: Exclude<JourneyEventType, RankedType | 'mode_changed'> }
  | { type: RankedType | 'mode_changed'; mode: JourneyMode };

export function matchesEvent(matcher: EventMatcher, event: JourneyEvent): boolean {
  if (matcher.type !== event.type) return false;
  if ('mode' in matcher && 'mode' in event && event.mode !== undefined) {
    return matcher.type === 'mode_changed' ? event.mode === matcher.mode : modeRank(event.mode) >= modeRank(matcher.mode);
  }
  return true;
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
