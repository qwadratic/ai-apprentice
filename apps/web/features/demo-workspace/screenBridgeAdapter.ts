import type {
  ActionCheckpoint,
  CheckpointHandler,
  CheckpointReply,
  ScreenObservation,
} from '@apprentice/contracts';
import type { CheckpointPort, OpaqueRevisions, VersionScope } from './workspace.ts';

export type ObservationRegistryRequest = {
  sessionId: string;
  revisions: OpaqueRevisions;
  signal: AbortSignal;
  timeoutMs?: number;
};

/** Trusted capture/vision registry. It returns published observations, never DOM facts. */
export type VisionObservationRegistry = {
  waitForCurrent(request: ObservationRegistryRequest): Promise<readonly ScreenObservation[]>;
  snapshot(sessionId: string): readonly ScreenObservation[];
};

/** Inject the canonical validators until the shared foundation commit is in this branch. */
export type CanonicalContractRuntime = {
  parseScreenObservation(value: unknown): ScreenObservation;
  assertCurrentCheckpoint(value: unknown, sessionId: string, observations: readonly ScreenObservation[]): ActionCheckpoint;
  parseCheckpointReply(value: unknown): CheckpointReply;
};

export type ScreenBridgeCheckpointAdapterOptions = {
  registry: VisionObservationRegistry;
  handleCheckpoint: CheckpointHandler;
  contract: CanonicalContractRuntime;
  getSessionEpochMs(sessionId: string): number | undefined;
  nowEpochMs?: () => number;
  createCheckpointId?: () => string;
  acquisitionTimeoutMs?: number;
};

function nonempty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`Missing ${name}.`);
}

function orderedSnapshot(
  values: readonly ScreenObservation[],
  sessionId: string,
  contract: CanonicalContractRuntime,
): ScreenObservation[] {
  const parsed = values.map(value => contract.parseScreenObservation(value));
  let sequence = 0;
  let timestampMs = -1;
  const ids = new Set<string>();
  for (const observation of parsed) {
    if (observation.sessionId !== sessionId) throw new Error('Observation registry returned another session.');
    if (observation.sequence <= sequence || observation.timestampMs < timestampMs || ids.has(observation.id)) {
      throw new Error('Observation registry snapshot is stale or reordered.');
    }
    sequence = observation.sequence;
    timestampMs = observation.timestampMs;
    ids.add(observation.id);
  }
  return parsed;
}

function latestVisual(observations: readonly ScreenObservation[], kind: 'order_view' | 'email_draft') {
  return observations.filter(observation => observation.kind === kind).at(-1);
}

function assertRequestedRevisions(observations: readonly ScreenObservation[], revisions: OpaqueRevisions): void {
  const order = latestVisual(observations, 'order_view');
  const email = latestVisual(observations, 'email_draft');
  if (!order || !email) throw new Error('Current order and email observations are unavailable.');
  if (order.source !== 'vision' || email.source !== 'vision') throw new Error('Checkpoint requires vision observations.');
  if (order.sourceRevision !== revisions.order || email.sourceRevision !== revisions.email) {
    throw new Error('Vision observations do not match the current workspace revisions.');
  }
}

/**
 * Bridges the workspace state machine to canonical doc-7 checkpoint semantics.
 * No order, email, customer or attachment facts cross the workspace callback.
 */
export function createScreenBridgeCheckpointAdapter(options: ScreenBridgeCheckpointAdapterOptions): CheckpointPort {
  let checkpointSequence = 0;
  const nowEpochMs = options.nowEpochMs ?? Date.now;
  const createCheckpointId = options.createCheckpointId ?? (() => `workspace-checkpoint-${++checkpointSequence}`);
  return {
    async check(scope: VersionScope, signal: AbortSignal, onDispatch?: () => void) {
      signal.throwIfAborted();
      nonempty(scope.sessionId, 'sessionId');
      nonempty(scope.revisions.order, 'order revision');
      nonempty(scope.revisions.email, 'email revision');
      const sessionEpochMs = options.getSessionEpochMs(scope.sessionId);
      if (!Number.isSafeInteger(sessionEpochMs) || sessionEpochMs! < 0) throw new Error('Current session epoch is unavailable.');

      const observed = orderedSnapshot(
        await options.registry.waitForCurrent({
          sessionId: scope.sessionId,
          revisions: structuredClone(scope.revisions),
          signal,
          timeoutMs: options.acquisitionTimeoutMs ?? 15_000,
        }),
        scope.sessionId,
        options.contract,
      );
      signal.throwIfAborted();
      assertRequestedRevisions(observed, scope.revisions);
      const order = latestVisual(observed, 'order_view')!;
      const email = latestVisual(observed, 'email_draft')!;
      const timestampMs = Math.floor(nowEpochMs() - sessionEpochMs!);
      if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new Error('Checkpoint clock is outside the current session.');

      const checkpoint = options.contract.assertCurrentCheckpoint({
        schemaVersion: 1,
        id: createCheckpointId(),
        sessionId: scope.sessionId,
        timestampMs,
        observationIds: [order.id, email.id],
        revisions: structuredClone(scope.revisions),
        action: 'send',
      }, scope.sessionId, observed);

      onDispatch?.();
      signal.throwIfAborted();
      const reply = options.contract.parseCheckpointReply(await options.handleCheckpoint(checkpoint));
      signal.throwIfAborted();
      if (reply.checkpointId !== checkpoint.id) throw new Error('Agent reply belongs to another checkpoint.');
      if (reply.basedOn.order !== checkpoint.revisions.order || reply.basedOn.email !== checkpoint.revisions.email) {
        throw new Error('Agent reply is based on stale workspace revisions.');
      }

      const current = orderedSnapshot(options.registry.snapshot(scope.sessionId), scope.sessionId, options.contract);
      assertRequestedRevisions(current, scope.revisions);
      options.contract.assertCurrentCheckpoint(checkpoint, scope.sessionId, current);
      return { status: reply.status, message: reply.message, evidenceIds: structuredClone(reply.evidenceIds) };
    },
  };
}
