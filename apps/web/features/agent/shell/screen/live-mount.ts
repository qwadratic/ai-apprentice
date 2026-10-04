// Mounts stream A's integrated runtime (createRuntimeWorkspace) for the length of a B session, and hands its bridge to the
// controller. One mount per session: "mount after the B session is created, keep one session for the whole mount, on a new session
// dispose and recreate". The two roots (workspace and screen) are React elements that stay mounted across modes; this class only
// needs them to exist. Review has no screen, so it gets no mount, and off the record never creates one (the controller already
// ended the session; the next session mounts again).
import type { ShellController } from '../controller.ts';
import { markClipaTargets } from '../clipa/workspace-marks.ts';
import { RuntimeWorkspaceSource } from './runtime-workspace-source.ts';
import type { CreateRuntimeWorkspace, RuntimeWorkspaceMount } from './runtime-workspace-source.ts';

export interface LiveMountDeps {
  factory: CreateRuntimeWorkspace;
  controller: ShellController;
  /** The API origin the bridge's own requests go to. */
  apiBase: string;
  /**
   * The factory also mounts the demo workspace into `workspaceRoot` (A's createRuntimeWorkspace does). A factory that only mounts the
   * screen (bridge-mount.ts) leaves the workspace slot to the shell's own adapter and stand-ins.
   */
  providesWorkspace: boolean;
  /** Runs once per mount, after the controller attached it; returns its cleanup (the shell's Preview port, checkpoint-binding.ts). */
  bind?: (mount: RuntimeWorkspaceMount) => () => void;
}

export class LiveMount {
  private readonly deps: LiveMountDeps;
  readonly providesWorkspace: boolean;
  private workspaceRoot: HTMLElement | null = null;
  private screenRoot: HTMLElement | null = null;
  private mounted: { sessionId: string; mount: RuntimeWorkspaceMount; unregisterCapture: () => void; unbind: () => void } | null = null;
  /** The session whose mount failed: it is not tried again (the failure note changes the store, which would call sync again). */
  private failedFor: string | null = null;
  private readonly off: () => void;

  constructor(deps: LiveMountDeps) {
    this.deps = deps;
    this.providesWorkspace = deps.providesWorkspace;
    this.off = deps.controller.store.subscribe(() => { void this.sync(); });
  }

  setRoots(roots: { workspace?: HTMLElement | null; screen?: HTMLElement | null }): void {
    if (roots.workspace !== undefined) this.workspaceRoot = roots.workspace;
    if (roots.screen !== undefined) this.screenRoot = roots.screen;
    void this.sync();
  }

  /** The session the runtime is mounted for, or null. */
  mountedFor(): string | null {
    return this.mounted?.sessionId ?? null;
  }

  async sync(): Promise<void> {
    const { controller, factory, apiBase } = this.deps;
    const s = controller.store.getState();
    const wanted = s.phase === 'live' && s.session !== null && s.session.mode !== 'review' && !s.offRecord ? s.session.id : null;
    if (this.mounted !== null && this.mounted.sessionId !== wanted) {
      this.release();
    }
    if (this.failedFor !== null && this.failedFor !== wanted) this.failedFor = null;
    if (wanted === null || this.mounted !== null || this.failedFor === wanted || this.screenRoot === null) return;
    if (this.providesWorkspace && this.workspaceRoot === null) return;
    let mount: RuntimeWorkspaceMount;
    // Marked before the factory runs: the note below changes the store, which calls sync again.
    this.failedFor = wanted;
    try {
      mount = factory({
        // A screen-only factory ignores the workspace root; it still needs an element.
        workspaceRoot: this.workspaceRoot ?? this.screenRoot,
        screenRoot: this.screenRoot,
        session: () => controller.captureSession(),
        apiBase,
        authHeader: () => controller.authHeader(),
      });
    } catch (e) {
      controller.note('SCREEN', `The workspace runtime could not be mounted: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The controller follows the capture's state (the status chip) and stops it when the session ends.
    this.failedFor = null;
    // A's workspace renders its markup once per mount: the Clipa marks (attributes only) let her fly to the body, Preview and Send.
    const root = this.workspaceRoot;
    if (this.providesWorkspace && root !== null && typeof root.querySelector === 'function') markClipaTargets(root);
    // `mounted` is set first: registering the capture changes the store, which calls sync again.
    const current = { sessionId: wanted, mount, unregisterCapture: (): void => {}, unbind: (): void => {} };
    this.mounted = current;
    current.unregisterCapture = controller.registerCapture(mount.capture);
    await controller.attachLiveSource(new RuntimeWorkspaceSource(mount));
    if (this.mounted !== current || this.deps.bind === undefined) return;
    try {
      current.unbind = this.deps.bind(mount);
    } catch (e) {
      controller.note('SCREEN', `The workspace check could not be connected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private release(): void {
    const current = this.mounted;
    this.mounted = null;
    if (current === null) return;
    // The session is ending: the capture stops with it (the controller no longer holds it once it is unregistered).
    try { current.unbind(); } catch { /* already gone */ }
    try { current.mount.capture.stop(); } catch { /* already stopped */ }
    current.unregisterCapture();
    current.mount.dispose();
  }

  dispose(): void {
    this.off();
    this.release();
  }
}
