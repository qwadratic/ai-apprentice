// Mounts stream A's integrated runtime (createRuntimeWorkspace) for the length of a B session, and hands its bridge to the
// controller. One mount per session: "mount after the B session is created, keep one session for the whole mount, on a new session
// dispose and recreate". The two roots (workspace and screen) are React elements that stay mounted across modes; this class only
// needs them to exist. Review has no screen, so it gets no mount, and off the record never creates one (the controller already
// ended the session; the next session mounts again).
import type { ShellController } from '../controller.ts';
import { RuntimeWorkspaceSource } from './runtime-workspace-source.ts';
import type { CreateRuntimeWorkspace, RuntimeWorkspaceMount } from './runtime-workspace-source.ts';

export interface LiveMountDeps {
  factory: CreateRuntimeWorkspace;
  controller: ShellController;
  /** The API origin the bridge's own requests go to. */
  apiBase: string;
}

export class LiveMount {
  private readonly deps: LiveMountDeps;
  private workspaceRoot: HTMLElement | null = null;
  private screenRoot: HTMLElement | null = null;
  private mounted: { sessionId: string; mount: RuntimeWorkspaceMount } | null = null;
  private readonly off: () => void;

  constructor(deps: LiveMountDeps) {
    this.deps = deps;
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
      this.mounted.mount.dispose();
      this.mounted = null;
    }
    if (wanted === null || this.mounted !== null || this.workspaceRoot === null || this.screenRoot === null) return;
    let mount: RuntimeWorkspaceMount;
    try {
      mount = factory({
        workspaceRoot: this.workspaceRoot,
        screenRoot: this.screenRoot,
        session: () => controller.captureSession(),
        apiBase,
        authHeader: () => controller.authHeader(),
      });
    } catch (e) {
      controller.note('SCREEN', `The workspace runtime could not be mounted: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.mounted = { sessionId: wanted, mount };
    await controller.attachLiveSource(new RuntimeWorkspaceSource(mount));
  }

  dispose(): void {
    this.off();
    this.mounted?.mount.dispose();
    this.mounted = null;
  }
}
