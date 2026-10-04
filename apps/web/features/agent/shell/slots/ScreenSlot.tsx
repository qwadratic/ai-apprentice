import { useEffect, useRef } from 'react';
import { ScreenCapture } from '../../../../../../packages/screen/capture/index.ts';
import { mountScreenPanel } from '../../../screen/ScreenPanel/index.ts';
import { useShell, useShellState } from '../hooks.ts';

/**
 * Stream A's ScreenPanel (capture picker, masks, preview). It stays mounted for the whole page: switching
 * Learn / Review / Teach never unmounts it (that would stop the capture), and collapsing only hides it with CSS.
 *
 * What it does today: the panel shows a local, masked preview of the shared window. No `onFrame` consumer is set,
 * so no frame is analysed, recorded or sent anywhere: vision and the real ScreenBridge are stream A's next step
 * (doc-9). The observations of the Learn view come from the sample source until then.
 *
 * The picker needs a user gesture, so the panel calls `session()` synchronously inside its own click. That is why
 * the session must exist first: Start a mode, then choose the window.
 */
export function ScreenSlot({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { controller } = useShell();
  const live = useShellState((s) => s.phase === 'live');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const capture = new ScreenCapture();
    const unregister = controller.registerCapture(capture);
    const unmount = mountScreenPanel(root, { capture, session: () => controller.captureSession() });
    return () => {
      unmount();
      unregister();
      capture.dispose();
    };
  }, [controller]);

  return (
    <section className="as-card as-screen" aria-labelledby="as-screen-title" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="as-card__head">
        <h2 className="as-card__title" id="as-screen-title">Screen</h2>
        <button type="button" className="as-btn as-btn--small" aria-expanded={!collapsed} aria-controls="as-screen-mount" onClick={onToggle}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      <p className="as-note">
        {live
          ? 'Choose the window to share below. The preview stays on this page: frames are not analysed or sent yet (vision is not wired).'
          : 'Start a mode first (right), then choose the window to share. The preview stays on this page: frames are not analysed or sent yet.'}
      </p>
      <div
        id="as-screen-mount"
        ref={rootRef}
        className="as-screen__mount"
        hidden={collapsed}
        inert={!live}
        data-live={live ? 'true' : 'false'}
      />
    </section>
  );
}
