// What the shell does with each mount of stream A's runtime (runtime.ts's LiveMount `bind`). It lives here, not in runtime.ts,
// so node tests can run it: runtime.ts also loads the browser-only screen panel.
import type { ShellController } from '../controller.ts';
import { bindWorkspaceCheckpoint } from './checkpoint-binding.ts';
import type { BindableWorkspace } from './checkpoint-binding.ts';
import type { RuntimeWorkspaceMount } from './runtime-workspace-source.ts';

/**
 * The demo workspace case Pass it on opens on: the new order ORD-2057 with the template image only, the case the tutor has to
 * catch. Show keeps the workspace's first case, the practice order ORD-2041. Other cases stay in the workspace's case list.
 */
export const TEACH_CASE_ID = 'new-image';

export type LiveBindHost = Pick<ShellController, 'store' | 'checkpointGate' | 'captureSession' | 'answerCheckpoint' | 'note'>;

const canReset = (w: unknown): w is { reset(caseId?: string): void } =>
  typeof w === 'object' && w !== null && typeof (w as { reset?: unknown }).reset === 'function';

/**
 * The bind of one mount: a Teach session opens on the new order first, then Preview & check is answered by the tutor (through
 * the shell's own checkpoint port) whenever Teach runs. Returns the cleanup of the checkpoint port.
 */
export function liveWorkspaceBind(deps: { host: LiveBindHost; now: () => number }): (mount: RuntimeWorkspaceMount) => () => void {
  const { host, now } = deps;
  return (mount) => {
    if (host.store.getState().session?.mode === 'teach' && canReset(mount.workspace)) {
      // A failed reset leaves the case as it is; the checkpoint below is connected either way.
      try {
        mount.workspace.reset(TEACH_CASE_ID);
      } catch (e) {
        host.note('SCREEN', `The new order could not be opened: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return bindWorkspaceCheckpoint({ workspace: mount.workspace as BindableWorkspace, bridge: mount.bridge, host, now });
  };
}
