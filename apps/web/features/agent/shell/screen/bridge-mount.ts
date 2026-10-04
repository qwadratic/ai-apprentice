// Stream A's real capture and ScreenBridge runtime (PR #21: createScreenBridge, mountScreenPanel) as a RuntimeWorkspaceMount, so
// that the shell's LiveMount can mount it per session today. The screen panel mounts in the screen root and owns the capture: the
// person's own click on "Choose screen or window" starts it through `runtime.panelController`, never the shell. The bridge sends
// masked frames to the server's vision and polls observations back; the controller reads them through RuntimeWorkspaceSource.
//
// This file composes only what A exports today. When A's `createRuntimeWorkspace` (the same plus the demo workspace and its
// checkpoint adapter) lands on main, it replaces this factory in runtime.ts and nothing else in the shell changes. Until then
// there is no checkpoint adapter, so a real screen gives Learn and Review input; Teach checkpoints come from the sample source.
import { createScreenBridge, mountScreenPanel } from '../../../screen/index.ts';
import type { RuntimeWorkspaceMount, RuntimeWorkspaceOptions } from './runtime-workspace-source.ts';

export function createBridgeMount(options: RuntimeWorkspaceOptions): RuntimeWorkspaceMount {
  const runtime = createScreenBridge({
    apiBase: options.apiBase,
    authHeader: options.authHeader,
    // No tracked workspace revision without the demo workspace's adapter: honest null, so no checkpoint can be raised from it.
    sourceRevision: () => null,
  });
  const session = options.session;
  const unmountPanel = mountScreenPanel(options.screenRoot, {
    capture: runtime.capture,
    session: () => (typeof session === 'function' ? session() : session),
    controller: runtime.panelController,
  });
  let disposed = false;
  return {
    runtime,
    bridge: runtime.bridge,
    capture: runtime.capture,
    workspace: null,
    // Off the record pauses the capture (reason off_record) before anything else; coming back resumes it.
    setOffRecord: (on) => (on ? runtime.bridge.pause() : runtime.bridge.resume()),
    dispose() {
      if (disposed) return;
      disposed = true;
      unmountPanel();
      runtime.dispose();
    },
  };
}
