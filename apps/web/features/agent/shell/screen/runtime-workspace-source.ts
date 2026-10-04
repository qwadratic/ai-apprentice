// The shell's side of stream A's integrated runtime: `createRuntimeWorkspace` (apps/web/features/demo-workspace, A's facade over
// the real ScreenBridge, the screen panel and the demo workspace). The types below are the spec A sent to the coordinator; the real
// import replaces `CreateRuntimeWorkspace` in runtime.ts once A's commit is on main. Nothing here edits or copies A's code.
//
// What this file does:
//   - RuntimeWorkspaceSource wraps `mount.bridge` as an ObservationSource (label, synthetic: false, dispose). Its `start()` only
//     attaches: the real `bridge.start` opens the screen picker and belongs to A's panel, which is started by the person's own
//     click (a browser gesture), so the shell must never call it.
//   - pause, resume, stop, resolveEvidence, the three subscriptions and the checkpoint reply all go to the bridge. The controller
//     subscribes to onObservation, onStatus and onCheckpoint and answers every checkpoint through replyToCheckpoint (within 4 s or
//     `unknown`; there is no mock success).
//   - setOffRecord(on) goes to `mount.setOffRecord`, which coordinates the workspace and the capture, also before capture started.
import type { ActionCheckpoint, CheckpointReply, EvidenceRef, ScreenObservation, ScreenStatus, SessionStart, Unsubscribe } from '@apprentice/contracts';
import type { ScreenBridge } from '@apprentice/contracts';
import type { CaptureLike } from '../controller.ts';
import type { ObservationSource } from './observation-source.ts';

export interface RuntimeWorkspaceOptions {
  /** Where the demo workspace mounts. */
  workspaceRoot: HTMLElement;
  /** Where the screen panel (picker, mask review, preview) mounts. */
  screenRoot: HTMLElement;
  /** The B session: its stable id and the exact epoch of the start click (controller.captureSession()). */
  session: SessionStart | (() => SessionStart);
  /** The API origin ('' in dev through the Vite proxy). */
  apiBase: string;
  /** `Bearer <token>` of the current B session, or null. */
  authHeader: () => string | null;
}

export interface RuntimeWorkspaceMount {
  /** A's runtime internals: the shell does not use them. */
  runtime: unknown;
  /** The real ScreenBridge (@apprentice/contracts). The only thing the shell's brain side sees. */
  bridge: ScreenBridge;
  /** A's ScreenCapture: the controller listens to its state and stops it when the session ends. */
  capture: CaptureLike;
  workspace: unknown;
  setOffRecord(on: boolean): Promise<void>;
  /** Releases the panel, the workspace, timers and polling. Idempotent. */
  dispose(): void;
}

export type CreateRuntimeWorkspace = (options: RuntimeWorkspaceOptions) => RuntimeWorkspaceMount;

export const LIVE_LABEL = 'Live screen';

export class RuntimeWorkspaceSource implements ObservationSource {
  readonly label = LIVE_LABEL;
  readonly synthetic = false;
  private readonly mount: RuntimeWorkspaceMount;
  private disposed = false;

  constructor(mount: RuntimeWorkspaceMount) {
    this.mount = mount;
  }

  /** Attach only. The panel's picker button starts the capture; calling bridge.start here would open the picker without a gesture. */
  start(_session: SessionStart): Promise<void> {
    return Promise.resolve();
  }

  pause(): Promise<void> { return this.mount.bridge.pause(); }
  resume(): Promise<void> { return this.mount.bridge.resume(); }
  stop(): Promise<void> { return this.mount.bridge.stop(); }
  resolveEvidence(id: string): Promise<EvidenceRef> { return this.mount.bridge.resolveEvidence(id); }
  onObservation(listener: (o: ScreenObservation) => void): Unsubscribe { return this.mount.bridge.onObservation(listener); }
  onStatus(listener: (s: ScreenStatus) => void): Unsubscribe { return this.mount.bridge.onStatus(listener); }
  onCheckpoint(listener: (c: ActionCheckpoint) => void): Unsubscribe { return this.mount.bridge.onCheckpoint(listener); }
  replyToCheckpoint(reply: CheckpointReply): Promise<void> { return this.mount.bridge.replyToCheckpoint(reply); }

  setOffRecord(on: boolean): Promise<void> { return this.mount.setOffRecord(on); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mount.dispose();
  }
}
