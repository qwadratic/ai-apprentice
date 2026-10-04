import { clockOf } from '../components/Parts.tsx';
import { useConductor } from './hooks.ts';
import type { ConductorStatus } from './client.ts';
import type { SaidItem } from './store.ts';

const KIND_LABEL: Record<SaidItem['kind'], string> = { ask: 'Asked', warn: 'Warned', say: 'Said' };
const OUTCOME_LABEL: Record<SaidItem['outcome'], string> = {
  pending: 'saying…',
  spoken: 'spoken',
  shown: 'shown (no voice)',
  skipped: 'skipped: the moment passed',
  interrupted: 'interrupted',
};

/** What Clipa asked, warned or said in this page, newest first: the questions at natural pauses are visible here. */
export function ConductorSaid({ title = 'What Clipa asked' }: { title?: string }) {
  const said = useConductor((s) => s.said);
  const asked = said.filter((s) => s.kind === 'ask').length;
  return (
    <section aria-labelledby="as-csaid-title" data-testid="conductor-said">
      <h3 className="as-h3" id="as-csaid-title">{title} <span className="as-count">{asked} questions · {said.length} lines</span></h3>
      {said.length === 0 ? (
        <p className="as-empty">Nothing yet. Clipa speaks only at a natural pause after something changed on screen.</p>
      ) : (
        <ol className="as-feed" aria-live="polite">
          {[...said].reverse().map((s) => (
            <li key={s.cueId} className={`as-feed__item as-feed__item--${s.outcome === 'spoken' || s.outcome === 'shown' ? 'said' : 'unspoken'}`}>
              <div className="as-feed__head">
                <span className={`as-tag as-tag--${s.kind === 'warn' ? 'warn' : 'accent'}`}>{KIND_LABEL[s.kind]}</span>
                <span className="as-feed__time">{clockOf(s.atMs)}</span>
              </div>
              <p className="as-feed__text">{s.text}</p>
              <p className="as-note">{OUTCOME_LABEL[s.outcome]}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

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
