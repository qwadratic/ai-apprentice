import type {SessionStart} from '@apprentice/contracts';
import {createScreenBridge, mountScreenPanel} from '../screen/index.ts';
import type {ScreenBridgeRuntime} from '../screen/index.ts';
import type {WorkspaceSurface} from './activity.ts';
import {createCheckpointAdapter} from './runtimeAdapter.ts';
import {bindWorkspaceSession} from './runtimeSession.ts';
import {mountDemoWorkspace} from './ui.ts';
import {createWorkspace, type WorkspaceController} from './workspace.ts';

type VisualSurface = Extract<WorkspaceSurface, 'order' | 'email'>;

export interface RuntimeWorkspaceOptions {
  readonly workspaceRoot: HTMLElement;
  readonly screenRoot: HTMLElement;
  /** Prepared by the app. Both session ID and epoch must stay stable throughout this mount. */
  readonly session: SessionStart | (() => SessionStart);
  readonly apiBase: string;
  readonly authHeader: () => string | null;
}

export interface RuntimeWorkspaceMount {
  readonly runtime: ScreenBridgeRuntime;
  readonly bridge: ScreenBridgeRuntime['bridge'];
  readonly capture: ScreenBridgeRuntime['capture'];
  readonly workspace: WorkspaceController;
  /** App-owned privacy control. Panel pause/resume cannot clear this state. */
  setOffRecord(offRecord: boolean): Promise<void>;
  dispose(): void;
}

type WorkspaceSnapshot = ReturnType<WorkspaceController['getState']>;

/**
 * Adapts the bridge's ordered surface/revision getters into one state snapshot.
 * ScreenCapture invokes surface first and sourceRevision immediately afterwards.
 */
export function createAlternatingProvenance(getState: () => WorkspaceSnapshot) {
  let next: VisualSurface = 'order';
  let pending: {surface: VisualSurface; sourceRevision: string} | undefined;

  function take() {
    const state = getState();
    const surface = next;
    next = surface === 'order' ? 'email' : 'order';
    return {surface, sourceRevision: state.scope.revisions[surface]};
  }

  return {
    surface(): VisualSurface {
      pending = take();
      return pending.surface;
    },
    sourceRevision(): string {
      const sampled = pending ?? take();
      pending = undefined;
      return sampled.sourceRevision;
    },
  };
}

/** Mounts the real screen runtime and the synthetic workspace as one lifecycle. */
export function createRuntimeWorkspace(options: RuntimeWorkspaceOptions): RuntimeWorkspaceMount {
  const sessionBinding = bindWorkspaceSession(options.session);
  const {sessionId, sessionEpochMs} = sessionBinding.session;

  let workspace!: WorkspaceController;
  const provenance = createAlternatingProvenance(() => workspace.getState());
  const runtime = createScreenBridge({
    apiBase: options.apiBase,
    authHeader: options.authHeader,
    surface: provenance.surface,
    sourceRevision: provenance.sourceRevision,
  });
  const adapter = createCheckpointAdapter({runtime});
  let capturing = false;
  let checkpointConnected = false;
  let disposed = false;

  workspace = createWorkspace({
    sessionId,
    acquisitionTimeoutMs: 15_000,
    replyTimeoutMs: 4_000,
    activityClock: {
      now: () => Math.max(0, Date.now() - sessionEpochMs),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    onInputActivity(activity) {
      if (!capturing || workspace.getState().offRecord) return;
      try { adapter.onInputActivity(activity); }
      catch {
        // A queued heartbeat may outlive the runtime session; keep the activity timer usable.
        console.warn('Workspace activity skipped: screen session unavailable.');
      }
    },
  });

  function setCheckpointConnected(connected: boolean) {
    if (checkpointConnected === connected) return;
    checkpointConnected = connected;
    workspace.setCheckpoint(connected ? adapter.checkpoint : undefined);
  }

  const unsubscribeWorkspace = workspace.subscribe(state => {
    const active = runtime.workspace.getSession();
    if (active?.sessionId === state.scope.sessionId) adapter.syncScope(state.scope);
  });
  const unsubscribeStatus = runtime.bridge.onStatus(status => {
    capturing = status.state === 'capturing';
    if (capturing) {
      const state = workspace.getState();
      adapter.syncScope(state.scope);
      setCheckpointConnected(!state.offRecord);
    } else {
      setCheckpointConnected(false);
    }
  });
  const unmountWorkspace = mountDemoWorkspace(options.workspaceRoot, workspace);
  const unmountScreen = mountScreenPanel(options.screenRoot, {
    capture: runtime.capture,
    controller: runtime.panelController,
    session: sessionBinding.atCapture,
  });

  return {
    runtime,
    bridge: runtime.bridge,
    capture: runtime.capture,
    workspace,
    async setOffRecord(offRecord) {
      if (disposed || workspace.getState().offRecord === offRecord) return;
      if (offRecord) {
        workspace.setOffRecord(true);
        setCheckpointConnected(false);
        await runtime.bridge.pause();
        return;
      }
      await runtime.bridge.resume();
      capturing = runtime.capture.getSnapshot().state === 'capturing';
      workspace.setOffRecord(false);
      if (!capturing) return;
      adapter.syncScope(workspace.getState().scope);
      setCheckpointConnected(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      capturing = false;
      unmountScreen();
      unmountWorkspace();
      unsubscribeStatus();
      unsubscribeWorkspace();
      workspace.dispose();
      adapter.dispose();
      runtime.dispose();
    },
  };
}
