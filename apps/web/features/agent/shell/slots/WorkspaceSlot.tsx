import { useEffect, useRef, useState } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import type { WorkspaceAdapter } from './workspace-adapter.ts';

/**
 * The slot of stream A's demo workspace (order table, email, ticket; TASK-2.4, PR #12, not merged yet). Until it lands this is a
 * box of labelled stand-ins: they carry the data-clipa-surface / data-clipa-hint marks that Clipa flies to (a question about the
 * attachment goes to "Attachments", a warning goes to "Send"), and they do nothing else. Swapping the workspace in changes
 * nothing outside this file: the real workspace's elements get the same marks through the mount adapter (doc-9, section 3.2).
 */
export function WorkspaceSlot({ adapter = null }: { adapter?: WorkspaceAdapter | null }) {
  const { controller, live: liveMount } = useShell();
  const sessionId = useShellState((s) => s.session?.id ?? null);
  const offRecord = useShellState((s) => s.offRecord);
  const ref = useRef<HTMLElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<WorkspaceAdapter | null>(null);
  // The sample source (invented observations) is what the brain reads until the real screen bridge lands, so the stand-ins are the
  // default; the person can switch to the real workspace to look at it. Its Preview is not connected to the agent yet.
  const [useReal, setUseReal] = useState(false);
  const mounted = adapter !== null && useReal;
  const liveRef = useRef<HTMLDivElement | null>(null);

  // With stream A's integrated runtime the workspace mounts here for the session, with the real bridge behind it.
  useEffect(() => {
    const root = liveRef.current;
    if (!root || liveMount === null) return undefined;
    liveMount.setRoots({ workspace: root });
    return () => liveMount.setRoots({ workspace: null });
  }, [liveMount]);

  // A real workspace mounts once per adapter (not per session): a new session or off the record only calls the adapter's setters.
  useEffect(() => {
    const root = mountRef.current;
    if (adapter === null || !useReal || root === null) return undefined;
    adapterRef.current = adapter;
    const unmount = adapter.mount(root, {
      sessionId: () => controller.store.getState().session?.id ?? null,
      isOffRecord: () => controller.store.getState().offRecord,
      reportInput: (typing) => controller.reportInput(typing),
    });
    return () => { unmount(); adapterRef.current = null; };
  }, [adapter, controller, useReal]);
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
        <h2 className="as-card__title" id="as-workspace-title">{mounted && adapter ? adapter.label : 'Workspace (stream A)'}</h2>
        {!mounted && <span className="as-tag as-tag--muted">{adapter === null ? 'not mounted' : 'stand-ins'}</span>}
      </div>
      {liveMount !== null && <div ref={liveRef} className="as-workspace__mount" data-testid="live-workspace" />}
      {liveMount === null && adapter !== null && (
        <label className="as-switch">
          <input type="checkbox" checked={useReal} onChange={(e) => setUseReal(e.target.checked)} />
          <span>
            <strong>Show the real demo workspace</strong>
            <span className="as-switch__hint">
              Its Preview is not connected to the agent until the real screen bridge is wired in: it says &quot;No agent is connected&quot; and
              checks nothing. The sample observations do not follow what you do in it.
            </span>
          </span>
        </label>
      )}
      {liveMount === null && mounted && <div ref={mountRef} className="as-workspace__mount" />}
      {liveMount === null && !mounted && <><p className="as-note">
        The demo workspace (order table, email draft, ticket) is stream A&apos;s. The boxes below are stand-ins for it: Clipa flies to them, nothing is simulated in them, and nothing in them is clickable.
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
