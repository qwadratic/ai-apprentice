import { useEffect, useId, useMemo, useState } from 'react';
import { useConductor, useConductorLeads } from '../conductor/hooks.ts';
import { useNow, useShellState } from '../hooks.ts';
import { FeedIcon } from './FeedIcon.tsx';
import type { FeedEntry } from './model.ts';
import { FEED_LABEL, FEED_VISIBLE, advanceLedger, collectFeed, digestDraftMap, digestGenericMap, emptyLedger, foldFeed, isFresh, relativeTime } from './model.ts';

/** The map changes this page saw, newest first: the conductor's map while it leads, else the in-browser brain's draft. */
function useMapChanges(): readonly FeedEntry[] {
  const leads = useConductorLeads();
  const snapshot = useConductor((s) => s.map);
  const draft = useShellState((s) => s.draftMap);
  const digest = useMemo(() => (leads ? digestGenericMap(snapshot) : digestDraftMap(draft)), [leads, snapshot, draft]);
  const [ledger, setLedger] = useState(emptyLedger);
  useEffect(() => { setLedger((l) => advanceLedger(l, digest, Date.now())); }, [digest]);
  return ledger.entries;
}

/**
 * The live feed: what is happening now in the running stage (a screen change, a question, an answer, a rule learned, a map
 * change, a warning), newest on top. A few items show; the rest fold into "+N earlier". New items slide in and the newest is
 * lit for a moment (shell.css, without motion under prefers-reduced-motion). Off the record greys it.
 */
export function LiveFeed({ empty, title = 'Live feed', visible = FEED_VISIBLE }: { empty: string; title?: string; visible?: number }) {
  const headingId = useId();
  const leads = useConductorLeads();
  const session = useShellState((s) => s.session);
  const phase = useShellState((s) => s.phase);
  const offRecord = useShellState((s) => s.offRecord);
  const observations = useShellState((s) => s.observations);
  const questions = useShellState((s) => s.feed);
  const events = useShellState((s) => s.events);
  const checkpoint = useShellState((s) => s.teach.checkpoint);
  const said = useConductor((s) => s.said);
  const recognised = useConductor((s) => s.recognised);
  const mapChanges = useMapChanges();
  const [expanded, setExpanded] = useState(false);
  const running = phase === 'live' && !offRecord;
  const tick = useNow(1000, session !== null);
  const now = Math.max(tick, Date.now());

  const entries = collectFeed({ session, observations, questions, said, recognised, events, checkpoint, mapChanges, conductorLeads: leads }, now);
  const { shown, earlier, canFold } = foldFeed(entries, expanded, visible);
  const synthetic = entries.some((e) => e.synthetic === true);
  const state = offRecord ? 'Off the record' : running ? 'Live' : phase === 'starting' ? 'Starting' : phase === 'ended' ? 'Ended' : 'Not running';

  return (
    <section className="as-live" aria-labelledby={headingId} data-testid="live-feed" data-running={running ? 'true' : 'false'} data-off-record={offRecord ? 'true' : undefined}>
      <div className="as-live__head">
        <h3 className="as-live__title" id={headingId}>{title}</h3>
        <span className="as-live__state"><span className="as-live__dot" aria-hidden="true" />{state}</span>
        {synthetic && <span className="as-tag as-tag--warn">Synthetic data</span>}
      </div>
      {offRecord && <p className="as-live__note" role="status">Nothing new is captured while you are off the record.</p>}
      {entries.length === 0 ? (
        <p className="as-live__empty">{empty}</p>
      ) : (
        <ol className="as-live__list" aria-live="polite" aria-relevant="additions">
          {shown.map((e, i) => (
            <li
              key={e.id}
              className={`as-live__item${i === 0 && isFresh(e, now) ? ' is-fresh' : ''}`}
              data-kind={e.kind}
              data-tone={e.tone}
            >
              <span className="as-live__icon"><FeedIcon kind={e.kind} /></span>
              <div className="as-live__body">
                <div className="as-live__meta">
                  <span className="as-live__label">{e.label ?? FEED_LABEL[e.kind]}</span>
                  {(e.repeat ?? 1) > 1 && <span className="as-live__repeat">×{e.repeat}</span>}
                  <time className="as-live__time">{relativeTime(now, e.atMs)}</time>
                </div>
                <p className="as-live__text">{e.kind === 'answer' ? <q>{e.text}</q> : e.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {earlier > 0 && (
        <button type="button" className="as-live__more" aria-expanded="false" onClick={() => setExpanded(true)}>+{earlier} earlier</button>
      )}
      {canFold && (
        <button type="button" className="as-live__more" aria-expanded="true" onClick={() => setExpanded(false)}>Show fewer</button>
      )}
    </section>
  );
}
