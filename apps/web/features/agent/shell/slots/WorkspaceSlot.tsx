import { useEffect, useRef } from 'react';
import { useShell, useShellState } from '../hooks.ts';

/**
 * The slot of stream A's demo workspace (order table, email, ticket; TASK-2.4). Until it lands this is an empty
 * box with the props the real mount will receive (doc-9, section 3.2). Swapping the workspace in changes nothing
 * outside this file. Clipa points at this box when a decision names a surface.
 */
export function WorkspaceSlot() {
  const { controller } = useShell();
  const sessionId = useShellState((s) => s.session?.id ?? null);
  const offRecord = useShellState((s) => s.offRecord);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    controller.setTargetResolver(() => {
      const box = ref.current?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    return () => controller.setTargetResolver(null);
  }, [controller]);

  return (
    <section className="as-card as-workspace" aria-labelledby="as-workspace-title" ref={ref}>
      <div className="as-card__head">
        <h2 className="as-card__title" id="as-workspace-title">Workspace (stream A)</h2>
        <span className="as-tag as-tag--muted">not mounted</span>
      </div>
      <p className="as-note">
        The demo workspace (order table, email draft, ticket) mounts here when stream A delivers it. Nothing is simulated in this box.
      </p>
      <dl className="as-props" aria-label="Props the workspace mount will receive">
        <div><dt>sessionId</dt><dd>{sessionId ?? 'none yet'}</dd></div>
        <div><dt>offRecord</dt><dd>{offRecord ? 'true' : 'false'}</dd></div>
        <div><dt>checkpoint port</dt><dd>not connected</dd></div>
      </dl>
    </section>
  );
}
