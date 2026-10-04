/*
 * The demo journey: Clipa guides the expert and the new hire through Share, Learn, Review, Teach and Summary.
 * The React progress strip lives in ProgressStrip.tsx and is imported from there, so this barrel stays free of
 * React and CSS and can be used by node tests.
 */
export { canShareScreen, canUseCamera, capturePath, detectCapabilities } from './capabilities.ts';
export type { CaptureCapabilities, CapturePath } from './capabilities.ts';
export { JOURNEY_STORAGE_KEY, createJourney } from './engine.ts';
export type {
  Journey,
  JourneyClock,
  JourneyDirector,
  JourneyOptions,
  JourneySnapshot,
  JourneyStorage,
  StepOutcome,
} from './engine.ts';
export {
  JOURNEY_EVENT_TYPES,
  JOURNEY_MODES,
  createJourneyEventBus,
  isJourneyMode,
  matchesEvent,
  modeRank,
} from './events.ts';
export type {
  EventMatcher,
  JourneyEvent,
  JourneyEventBus,
  JourneyEventSource,
  JourneyEventType,
  JourneyMode,
  ShareFailure,
} from './events.ts';
export {
  JOURNEY_PHASES,
  JOURNEY_STEPS,
  MAX_LINE_WORDS,
  PHASE_LABELS,
  journeyTargets,
  stepIndex,
  wordCount,
} from './journey.ts';
export type {
  JourneyPersona,
  JourneyPhase,
  JourneyStep,
  JourneyStepId,
  JourneyText,
  JourneyVariant,
} from './journey.ts';
export { LEARN_QUESTION_GOAL, buildStrip, statusWord } from './progress.ts';
export type { PhaseStatus, StripItem } from './progress.ts';
export {
  JOURNEY_SURFACE,
  TARGET_ATTRIBUTE,
  createDomTargetResolver,
  createJourneyTargetResolver,
  journeyClipaTarget,
} from './targets.ts';
export type { TargetElement, TargetRoot } from './targets.ts';
