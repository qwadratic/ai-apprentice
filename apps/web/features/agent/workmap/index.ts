// Public surface of the briefing board (TASK-3.11). Review mounts <WorkMapBoard>; Teach can reuse buildStoryboard to show
// where a rule came from.
export { WorkMapBoard } from './WorkMapBoard.tsx';
export type { WorkMapBoardProps } from './WorkMapBoard.tsx';
export { buildKeyframes, buildStoryboard, blockerMessage, cardKey, formatClock } from './model.ts';
export type {
  BoardBlocker,
  BoardCard,
  BoardCounts,
  BoardInput,
  ChangeEvent,
  ChangeKind,
  FactRow,
  GapCard,
  GuardrailCard,
  Keyframe,
  Moment,
  ResolveEvidence,
  ResolvedEvidence,
  StepCard,
  Storyboard,
} from './model.ts';
export { syntheticEvidenceResolver, syntheticFrameUrl } from './synthetic-frames.ts';
export { fromGenericMap } from './generic.ts';
export type { GenericBoard, GenericComment, GenericProcess } from './generic.ts';
