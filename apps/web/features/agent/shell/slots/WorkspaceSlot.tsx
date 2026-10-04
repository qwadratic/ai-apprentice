import { useEffect, useRef } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import type { WorkspaceAdapter } from './workspace-adapter.ts';

/**
 * The slot of stream A's demo workspace (order table, email, ticket; TASK-2.4, PR #12, not merged yet). Until it lands this is a
 * box of labelled stand-ins: they carry the data-clipa-surface / data-clipa-hint marks that Clipa flies to (a question about the
 * attachment goes to "Attachments", a warning goes to "Send"), and they do nothing else. Swapping the workspace in changes
 * nothing outside this file: the real workspace's elements get the same marks through the mount adapter (doc-9, section 3.2).
 */
export function WorkspaceSlot({ adapter = null }: { adapter?: WorkspaceAdapter | null }) {
  const { controller } = useShell();
  const sessionId = useShellState((s) => s.session?.id ?? null);
  const offRecord = useShellState((s) => s.offRecord);
  const ref = useRef<HTMLElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<WorkspaceAdapter | null>(null);

  // A real workspace mounts once per adapter (not per session): a new session or off the record only calls the adapter's setters.
  useEffect(() => {
    const root = mountRef.current;
    if (adapter === null || root === null) return undefined;
    adapterRef.current = adapter;
    const unmount = adapter.mount(root, {
      sessionId: () => controller.store.getState().session?.id ?? null,
      isOffRecord: () => controller.store.getState().offRecord,
      reportInput: (typing) => controller.reportInput(typing),
    });
    return () => { unmount(); adapterRef.current = null; };
  }, [adapter, controller]);
  useEffect(() => { adapterRef.current?.setSession?.(sessionId); }, [sessionId]);
  useEffect(() => { adapterRef.current?.setOffRecord?.(offRecord); }, [offRecord]);

  useEffect(() => {
    controller.setTargetResolver(() => {
      const box = ref.current?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    return () => controller.setTargetResolver(null);
  }, [controller]);

  return (
    <section className="as-card as-workspace" aria-labelledby="as-workspace-title" ref={ref} data-clipa-surface="workspace">
      <div className="as-card__head">
        <h2 className="as-card__title" id="as-workspace-title">{adapter ? adapter.label : 'Workspace (stream A)'}</h2>
        {adapter === null && <span className="as-tag as-tag--muted">not mounted</span>}
      </div>
      {adapter !== null && <div ref={mountRef} className="as-workspace__mount" />}
      {adapter === null && <><p className="as-note">
        The demo workspace (order table, email draft, ticket) mounts here when stream A delivers it. The boxes below are stand-ins for
        it: Clipa flies to them, nothing is simulated in them, and nothing in them is clickable.
      </p>
      <div className="as-standin" aria-label="Stand-ins for the workspace surfaces">
        <div className="as-standin__box" data-clipa-surface="order"><strong>Order</strong> <span>customer, order, address, window</span></div>
        <div className="as-standin__box" data-clipa-surface="email">
          <strong>Email</strong>
          <div className="as-standin__row">
            <span className="as-standin__chip" data-clipa-surface="email" data-clipa-hint="recipient">Recipient</span>
            <span className="as-standin__chip" data-clipa-surface="email" data-clipa-hint="attachments">Attachments</span>
            <span className="as-standin__chip" data-clipa-surface="email" data-clipa-hint="body">Message body</span>
          </div>
          <div className="as-standin__row">
            <span className="as-standin__chip" data-clipa-surface="email" data-clipa-hint="preview">Preview</span>
            <span className="as-standin__chip as-standin__chip--send" data-clipa-surface="email" data-clipa-hint="send">Send</span>
          </div>
        </div>
        <div className="as-standin__box" data-clipa-surface="ticket"><strong>Ticket</strong> <span>status, note</span></div>
      </div>
      <dl className="as-props" aria-label="Props the workspace mount will receive">
        <div><dt>sessionId</dt><dd>{sessionId ?? 'none yet'}</dd></div>
        <div><dt>offRecord</dt><dd>{offRecord ? 'true' : 'false'}</dd></div>
        <div><dt>checkpoint port</dt><dd>not connected (the sample source raises sample checkpoints)</dd></div>
      </dl></>}
    </section>
  );
}
