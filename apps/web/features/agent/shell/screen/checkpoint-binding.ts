// The demo workspace's "Preview & check" answered by the tutor (TASK-3.31 fixes).
//
// Stream A's createRuntimeWorkspace connects the workspace's CheckpointPort only while the bridge status is `capturing`. The server
// reports every frame the vision cannot read (vision_incomplete) as an `error` status while the capture keeps running, and no
// `capturing` status follows, so after the first unreadable frame Preview said "No agent is connected" (and typing heartbeats
// stopped). The shell therefore gives the workspace its own port, through the workspace's public setCheckpoint, and puts it back
// whenever A's runtime changes the port:
//   - outside a live Teach session it answers `unknown` with "Start Teach first" (Learn can still send after ticking the box);
//   - in Teach it waits (the workspace shows "acquiring") for the vision observations of the exact order and email revisions being
//     checked, then asks the brain (controller.answerCheckpoint: warn, clear or unknown within the deadline). If those observations
//     never arrive, the brain gets the checkpoint anyway and says it cannot match it (unknown): it never guesses.
// Nothing of A's is imported or edited here; the workspace and the bridge are reached through their public interfaces.
import type { ActionCheckpoint, CheckpointReply, ScreenBridge, ScreenObservation, ScreenStatus } from '@apprentice/contracts';

export interface CheckScope {
  sessionId: string;
  revisions: { order: string; email: string };
}

export interface CheckOutcomeLike {
  status: 'clear' | 'warn' | 'unknown';
  message: string;
  evidenceIds: string[];
}

export interface WorkspacePort {
  check(scope: CheckScope, signal: AbortSignal, onDispatch?: () => void): Promise<CheckOutcomeLike>;
}

/** The part of A's WorkspaceController the binding uses. */
export interface BindableWorkspace {
  setCheckpoint(port?: WorkspacePort): void;
}

/** The part of the controller the binding uses. */
export interface CheckpointHost {
  checkpointGate(): { ok: true } | { ok: false; message: string };
  captureSession(): { sessionId: string; sessionEpochMs: number };
  answerCheckpoint(cp: ActionCheckpoint): Promise<CheckpointReply | null>;
}

export interface CheckpointBindingOptions {
  workspace: BindableWorkspace;
  bridge: Pick<ScreenBridge, 'onObservation' | 'onStatus'>;
  host: CheckpointHost;
  now: () => number;
  /** How long Preview waits for the observations of the checked revisions. Below the workspace's 15 s acquisition limit. */
  evidenceWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const EVIDENCE_WAIT_MS = 8000;
const MAX_KEPT = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Installs the shell's port on the workspace. Returns the function that removes the listeners (the mount disposes the workspace). */
export function bindWorkspaceCheckpoint(options: CheckpointBindingOptions): () => void {
  const { workspace, bridge, host, now } = options;
  const waitMs = options.evidenceWaitMs ?? EVIDENCE_WAIT_MS;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const seen: ScreenObservation[] = [];
  let seq = 0;
  let disposed = false;

  const latest = (kind: 'order_view' | 'email_draft', revision: string): ScreenObservation | null => {
    for (let i = seen.length - 1; i >= 0; i--) {
      const o = seen[i];
      if (o !== undefined && o.kind === kind && o.sourceRevision === revision) return o;
    }
    return null;
  };

  const port: WorkspacePort = {
    async check(scope, signal, onDispatch) {
      const gate = host.checkpointGate();
      if (!gate.ok) {
        onDispatch?.();
        return { status: 'unknown', message: gate.message, evidenceIds: [] };
      }
      // Wait for the screen moments of exactly this order and this draft (the workspace shows "acquiring" meanwhile).
      const started = now();
      let order = latest('order_view', scope.revisions.order);
      let email = latest('email_draft', scope.revisions.email);
      while ((order === null || email === null) && now() - started < waitMs && !signal.aborted && !disposed) {
        await sleep(pollMs);
        order = latest('order_view', scope.revisions.order);
        email = latest('email_draft', scope.revisions.email);
      }
      if (signal.aborted || disposed) throw new Error('The check was cancelled.');
      const session = host.captureSession();
      const cp: ActionCheckpoint = {
        schemaVersion: 1,
        id: `cp-ws-${++seq}-${Math.max(0, now() - session.sessionEpochMs)}`,
        sessionId: session.sessionId,
        timestampMs: Math.max(0, now() - session.sessionEpochMs),
        observationIds: [order, email].flatMap((o) => (o === null ? [] : [o.id])),
        revisions: { order: scope.revisions.order, email: scope.revisions.email },
        action: 'send',
      };
      onDispatch?.();
      const reply = await host.answerCheckpoint(cp);
      if (reply === null) throw new Error('The Teach session ended before the tutor answered.');
      return { status: reply.status, message: reply.message, evidenceIds: [...reply.evidenceIds] };
    },
  };

  const apply = (): void => { if (!disposed) workspace.setCheckpoint(port); };
  // Mirror of A's own switch (connected = capturing): whenever A sets or clears its port, the shell's port goes back on top.
  let aConnected = false;
  const offStatus = bridge.onStatus((s: ScreenStatus) => {
    const connected = s.state === 'capturing';
    if (connected === aConnected) return;
    aConnected = connected;
    apply();
  });
  const offObservation = bridge.onObservation((o) => {
    if (o.kind !== 'order_view' && o.kind !== 'email_draft') return;
    seen.push(o);
    if (seen.length > MAX_KEPT) seen.splice(0, seen.length - MAX_KEPT);
  });
  apply();

  return () => {
    disposed = true;
    offStatus();
    offObservation();
  };
}
