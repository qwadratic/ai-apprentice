import { useConductor } from './hooks.ts';
import type { ConductorStatus } from './client.ts';

const STATUS_TEXT: Record<ConductorStatus, string> = {
  idle: 'starting',
  connecting: 'connecting',
  live: 'live',
  retrying: 'reconnecting',
  failed: 'not available: the in-browser brain leads',
  closed: 'closed',
};

/**
 * What Clipa is saying now, as the conductor decided it, plus the connection state. An accessible copy of her bubble for the
 * mode views; the Clipa layer itself renders the bubble.
 */
export function ConductorLine() {
  const enabled = useConductor((s) => s.enabled);
  const status = useConductor((s) => s.status);
  const line = useConductor((s) => s.line);
  const linked = useConductor((s) => s.linked);
  const paused = useConductor((s) => s.paused);
  if (!enabled) return null;
  return (
    <section className="as-conductor" aria-label="Clipa" data-testid="conductor-line" data-status={status}>
      <p className="as-note">
        <span className={`as-tag as-tag--${status === 'live' ? 'ok' : status === 'failed' ? 'warn' : 'muted'}`}>Clipa {STATUS_TEXT[status]}</span>
        {linked && <> <span className="as-tag as-tag--accent">joined from the Mac</span></>}
        {paused && <> <span className="as-tag as-tag--muted">off the record</span></>}
      </p>
      {line !== null && !paused && (
        <p className="as-feed__text" role="status" aria-live="polite" data-kind={line.kind}>{line.text}</p>
      )}
    </section>
  );
}
