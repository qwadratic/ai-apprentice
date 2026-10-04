import {
  assertCurrentCheckpoint,
  parseCheckpointReply,
  parseScreenObservation,
} from '@apprentice/contracts';
import type {WorkspaceActivity} from './activity.ts';
import {createScreenBridgeCheckpointAdapter} from './screenBridgeAdapter.ts';
import type {CheckpointPort, VersionScope} from './workspace.ts';
import type {ScreenBridgeRuntime, ScreenWorkspaceRuntime} from '../screen/index.ts';

export type WorkspaceRuntimeHandle = ScreenWorkspaceRuntime;

export type CheckpointAdapterOptions =
  | {readonly runtime: Pick<ScreenBridgeRuntime, 'workspace'>; readonly bridgeInternalHandle?: never}
  | {readonly runtime?: never; readonly bridgeInternalHandle: WorkspaceRuntimeHandle};

export interface RuntimeCheckpointAdapter {
  readonly checkpoint: CheckpointPort;
  readonly onInputActivity: (activity: WorkspaceActivity) => void;
  readonly syncScope: (scope: VersionScope) => void;
  dispose(): void;
}

/** Connects the demo workspace to the runtime without publishing its order, email or ticket model. */
export function createCheckpointAdapter(options: CheckpointAdapterOptions): RuntimeCheckpointAdapter {
  const runtime = options.runtime?.workspace ?? options.bridgeInternalHandle;
  if (!runtime) throw new TypeError('A screen workspace runtime is required.');
  const handle: WorkspaceRuntimeHandle = runtime;
  const lifetime = new AbortController();
  let disposed = false;
  let latestScope: VersionScope | undefined;
  let activeSignal: AbortSignal | undefined;

  const canonical = createScreenBridgeCheckpointAdapter({
    registry: handle.registry,
    contract: {parseScreenObservation, assertCurrentCheckpoint, parseCheckpointReply},
    getSessionEpochMs(sessionId) {
      const session = handle.getSession();
      return session?.sessionId === sessionId ? session.sessionEpochMs : undefined;
    },
    handleCheckpoint(checkpoint) {
      if (!activeSignal) throw new Error('Checkpoint dispatch is outside an active workspace check.');
      return handle.dispatchCheckpoint(checkpoint, {signal: activeSignal});
    },
  });

  function syncScope(scope: VersionScope): void {
    assertActive();
    const session = handle.getSession();
    if (!session || session.sessionId !== scope.sessionId) throw new Error('Workspace session does not match the screen runtime.');
    const next = structuredClone(scope);
    handle.setScope({sessionId: next.sessionId, revisions: structuredClone(next.revisions)});
    latestScope = next;
  }

  return {
    syncScope,
    onInputActivity(activity) {
      assertActive();
      const session = handle.getSession();
      if (!session) throw new Error('Screen runtime session is unavailable.');
      if (!latestScope || latestScope.sessionId !== session.sessionId) throw new Error('Workspace scope is unavailable for the screen runtime.');
      handle.publishActivity(structuredClone(activity));
    },
    checkpoint: {
      async check(scope, signal, onDispatch) {
        assertActive();
        if (activeSignal) throw new Error('A workspace checkpoint is already pending.');
        if (latestScope && !sameScope(latestScope, scope)) throw new Error('Workspace checkpoint scope is stale.');
        if (!latestScope) syncScope(scope);
        const combined = AbortSignal.any([signal, lifetime.signal]);
        activeSignal = combined;
        try { return await canonical.check(scope, combined, onDispatch); }
        finally { activeSignal = undefined; }
      },
    },
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); latestScope = undefined; },
  };

  function assertActive(): void {
    if (disposed) throw new Error('Workspace runtime adapter has been disposed.');
  }
}

function sameScope(left: VersionScope, right: VersionScope): boolean {
  return left.sessionId === right.sessionId && left.taskGeneration === right.taskGeneration &&
    left.draftRevision === right.draftRevision && left.revisions.order === right.revisions.order &&
    left.revisions.email === right.revisions.email;
}
