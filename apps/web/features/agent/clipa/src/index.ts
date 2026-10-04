export { BUDDY_POINTS, BUDDY_STATES, BUDDY_TAG, defineClipaBuddy } from './buddy.ts';
export type { BuddyPoint, BuddyState, ClipaBuddyElement } from './buddy.ts';
export { createClipaDirector } from './director.ts';
export type { ClipaApplyResult, ClipaDirector, ClipaDirectorOptions, ClipaSpeakOptions } from './director.ts';
export { ACTIVE_STATES, TRANSITIONS, canTransition, createMachine, isActive, reachesDock } from './machine.ts';
export type { ClipaMachine, TransitionResult } from './machine.ts';
export { estimateSpeechMs, planDecision, utteranceText } from './plan.ts';
export type { DecisionPlan } from './plan.ts';
export {
  placeBeside,
  placeBubble,
  planFlightPath,
  flightDuration,
  easeInOutCubic,
  bezierPoint,
  pointDirection,
  lookVector,
} from './geometry.ts';
export type { Box, FlightPath, Placement, Pt, Side, Size } from './geometry.ts';
export { CLIPA_STATES } from './types.ts';
export type {
  BrainVerdict,
  ClipaDecision,
  ClipaDock,
  ClipaEvent,
  ClipaFailure,
  ClipaLogEntry,
  ClipaLogKind,
  ClipaResult,
  ClipaState,
  ClipaStep,
  ClipaTarget,
  FlightKind,
  RectLike,
} from './types.ts';
