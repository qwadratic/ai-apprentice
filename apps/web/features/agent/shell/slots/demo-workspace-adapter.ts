// The WorkspaceAdapter for stream A's demo workspace (apps/web/features/demo-workspace, PR #12), through its public API only
// (index.ts: createWorkspace, mountDemoWorkspace). Nothing of A's is edited or copied. The adapter:
//   - mounts one workspace per page and gives it the session id (setSession) and the off-the-record switch (setOffRecord);
//   - turns the workspace's typing activity into host.reportInput(typing), so Clipa holds still while the person types;
//   - marks the workspace's elements with data-clipa-surface / data-clipa-hint (attributes only, no look change) so that Clipa
//     can fly to the message body, the attachments, Preview and Send;
//   - takes an optional CheckpointPort. Until the real screen bridge (PR #21) provides A's checkpoint adapter there is none, and the
//     workspace itself says "No agent is connected. The draft has not been checked." Nothing here fakes a check.
// `createRuntimeWorkspace` (A's later runtime with a bridge) can replace this file's createWorkspace call without a shell change.
import { createWorkspace, mountDemoWorkspace } from '../../../demo-workspace/index.ts';
import type { CheckpointPort, WorkspaceController } from '../../../demo-workspace/index.ts';
import type { WorkspaceAdapter } from './workspace-adapter.ts';

export { CLIPA_MARKS, markClipaTargets } from '../clipa/workspace-marks.ts';
import { markClipaTargets } from '../clipa/workspace-marks.ts';

/** The workspace needs a non-empty session id from the first moment; this stands in until a mode has started. */
export const IDLE_SESSION_ID = 'no-session-yet';

export interface DemoWorkspaceAdapterOptions {
  /** A's checkpoint adapter over the real bridge, when it exists. */
  checkpoint?: CheckpointPort;
}

export function createDemoWorkspaceAdapter(options: DemoWorkspaceAdapterOptions = {}): WorkspaceAdapter {
  let workspace: WorkspaceController | null = null;
  return {
    label: 'Demo workspace (stream A)',
    mount(root, host) {
      const ws = createWorkspace({
        sessionId: host.sessionId() ?? IDLE_SESSION_ID,
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
        onInputActivity: (activity) => host.reportInput(activity.typing),
      });
      workspace = ws;
      if (host.isOffRecord()) ws.setOffRecord(true);
      const unmount = mountDemoWorkspace(root, ws);
      markClipaTargets(root);
      return () => {
        unmount();
        ws.dispose();
        if (workspace === ws) workspace = null;
      };
    },
    setSession(sessionId) {
      // A new session is a new task flow; none (the session ended) keeps the last id: the workspace cannot be without one.
      if (workspace !== null && sessionId !== null && sessionId.trim() !== '') workspace.setSession(sessionId);
    },
    setOffRecord(on) {
      workspace?.setOffRecord(on);
    },
  };
}
