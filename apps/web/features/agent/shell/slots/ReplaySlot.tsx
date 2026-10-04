import { useEffect, useState } from 'react';
import type { EvidenceRef } from '@apprentice/contracts';
import { useShell, useShellState } from '../hooks.ts';
import { formatClock } from '../session-clock.ts';

type Resolved = { kind: 'loading' } | { kind: 'ok'; evidence: EvidenceRef } | { kind: 'error'; message: string };

/**
 * The slot of stream A's ReplayPanel (TASK-2.5). The real panel receives `resolveEvidence`, the evidence id and
 * onClose (doc-9, section 2.3) and plays the processed clip. Until then this resolves the evidence through the
 * bridge and shows what it found, so that the wiring is visible.
 */
export function ReplaySlot() {
  const { controller } = useShell();
  const evidenceId = useShellState((s) => s.replay.evidenceId);
  const [resolved, setResolved] = useState<Resolved>({ kind: 'loading' });

  useEffect(() => {
    if (evidenceId === null) return undefined;
    let current = true;
    setResolved({ kind: 'loading' });
    controller.resolveEvidence(evidenceId).then(
      (evidence) => { if (current) setResolved({ kind: 'ok', evidence }); },
      (e: unknown) => { if (current) setResolved({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { current = false; };
  }, [controller, evidenceId]);

  if (evidenceId === null) return null;
  return (
    <section className="as-card as-replay" aria-labelledby="as-replay-title" data-testid="replay-slot" data-clipa-surface="replay">
      <div className="as-card__head">
        <h2 className="as-card__title" id="as-replay-title">Screen moment</h2>
        <button type="button" className="as-btn as-btn--small as-btn--quiet" onClick={() => controller.closeEvidence()}>Close</button>
      </div>
      {resolved.kind === 'loading' && <p className="as-note">Finding the moment…</p>}
      {resolved.kind === 'error' && <p className="as-note">This moment is not available: {resolved.message}</p>}
      {resolved.kind === 'ok' && (
        <p className="as-replay__range">
          {formatClock(resolved.evidence.startMs)} to {formatClock(resolved.evidence.endMs)} of the session
          {resolved.evidence.assetRef.startsWith('mock://') && <> <span className="as-tag as-tag--warn">Mock reference</span></>}
        </p>
      )}
      <p className="as-note"><strong>Not wired yet:</strong> playback of the moment comes with stream A&apos;s replay panel.</p>
      <details className="as-details">
        <summary className="as-details__summary">Details</summary>
        <dl className="as-props">
          <div><dt>evidence</dt><dd>{evidenceId}</dd></div>
          {resolved.kind === 'ok' && <div><dt>asset</dt><dd>{resolved.evidence.assetRef}</dd></div>}
        </dl>
      </details>
    </section>
  );
}
