import { useEffect, useRef } from 'react';
import { ScreenCapture } from '../../../../../../packages/screen/capture/index.ts';
import { mountScreenPanel } from '../../../screen/ScreenPanel/index.ts';
import { RegionOverlay } from '../conductor/RegionOverlay.tsx';
import { SCREEN_MOUNT_ATTR, TARGET_ATTR } from '../conductor/targets.ts';
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
  const { controller, live: liveMount } = useShell();
  const live = useShellState((s) => s.phase === 'live');
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The conductor's regions are outlined over the preview: the overlay is placed relative to this section.
  const sectionRef = useRef<HTMLElement | null>(null);

  // With stream A's integrated runtime, its own screen panel mounts in this box for the session and owns the capture: this slot
  // then starts no capture of its own (the screen is never captured twice).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || liveMount === null) return undefined;
    liveMount.setRoots({ screen: root });
    return () => liveMount.setRoots({ screen: null });
  }, [liveMount]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || liveMount !== null) return undefined;
    const capture = new ScreenCapture();
    const unregister = controller.registerCapture(capture);
    const unmount = mountScreenPanel(root, { capture, session: () => controller.captureSession() });
    return () => {
      unmount();
      unregister();
      capture.dispose();
    };
  }, [controller, liveMount]);

  return (
    <section
      ref={sectionRef}
      className="as-card as-screen"
      aria-labelledby="as-screen-title"
      data-collapsed={collapsed ? 'true' : 'false'}
      {...{ [TARGET_ATTR]: 'share' }}
      style={{ position: 'relative' }}
    >
      <div className="as-card__head">
        <h2 className="as-card__title" id="as-screen-title">Screen</h2>
        <button type="button" className="as-btn as-btn--small" aria-expanded={!collapsed} aria-controls="as-screen-mount" onClick={onToggle}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      <p className="as-note">
        {liveMount !== null
          ? live
            ? 'Frames are masked here first, then read by vision on our server.'
            : 'Press Start first, then share your screen below.'
          : live
            ? 'Choose the window below. The preview stays on this page: vision is not wired.'
            : 'Press Start first, then choose the window to share.'}
      </p>
      <div
        id="as-screen-mount"
        ref={rootRef}
        className="as-screen__mount"
        hidden={collapsed}
        inert={liveMount === null && !live}
        data-live={live ? 'true' : 'false'}
        {...{ [SCREEN_MOUNT_ATTR]: 'mount' }}
      />
      <RegionOverlay containerRef={sectionRef} />
    </section>
  );
}
