import { EvidenceLinks, NotWired, StepCards, clockOf } from '../components/Parts.tsx';
import { ConductorLine } from '../conductor/ConductorLine.tsx';
import { useConductorLeads } from '../conductor/hooks.ts';
import { useShellState } from '../hooks.ts';
import type { FeedStatus } from '../state/types.ts';

const STATUS_LABEL: Record<FeedStatus, string> = {
  asked: 'Asked',
  answered: 'Answered',
  deferred: 'Deferred to Review',
  unspoken: 'Not spoken',
  said: 'Said',
};

/** Learn: the live question feed, the draft map and what the screen source has shown so far. */
export function LearnView() {
  const brain = useShellState((s) => s.brain);
  const feed = useShellState((s) => s.feed);
  const map = useShellState((s) => s.draftMap);
  const observations = useShellState((s) => s.observations);
  const synthetic = useShellState((s) => s.screen.source?.synthetic ?? false);
  const sawSynthetic = observations.some((o) => o.synthetic);
  const waitingWhy = useShellState((s) => [...s.decisions].reverse().find((d) => d.topic === 'waiting')?.whyNow ?? null);
  const leads = useConductorLeads();
  const counts = {
    asked: feed.filter((f) => f.status === 'asked' || f.status === 'answered' || f.status === 'said').length,
    deferred: feed.filter((f) => f.status === 'deferred' || f.status === 'unspoken').length,
  };

  return (
    <div className="as-view" data-testid="view-learn">
      <ConductorLine />
      {leads && (
        <p className="as-note" data-testid="learn-conductor-hint">
          Share your whole screen, start Learn and work in any app. Clipa watches quietly and asks only at a natural pause: never while
          you type or talk. Answer by voice; Reflect then shows the map she made of your steps and rules.
        </p>
      )}
      {!leads && !brain.wired && (
        <NotWired>
          the question policy ({brain.name}). Clipa will not ask anything yet, and the Work Map stays empty. The voice, the session log
          and the observation flow below are real.
        </NotWired>
      )}
      {!leads && brain.wired && (
        <p className="as-note" data-testid="learn-hint">
          Clipa asks only at a natural pause: not while you speak or while the screen is still changing, and not while she hears you type
          in the demo workspace (typing in other windows is not seen). Answer by voice; your words go into the draft map with the screen
          moment they belong to.
        </p>
      )}

      <section aria-labelledby="as-feed-title">
        <h3 className="as-h3" id="as-feed-title">Questions <span className="as-count">{counts.asked} asked · {counts.deferred} deferred</span></h3>
        {feed.length === 0 ? (
          <>
            <p className="as-empty">No questions yet. Questions appear here as Clipa asks them, and deferred ones wait for Review.</p>
            {waitingWhy !== null && <p className="as-note" role="status" data-testid="learn-waiting">{waitingWhy}</p>}
          </>
        ) : (
          <ol className="as-feed" aria-live="polite">
            {feed.map((item) => (
              <li key={item.id} className={`as-feed__item as-feed__item--${item.status}`}>
                <div className="as-feed__head">
                  <span className={`as-tag as-tag--${item.status === 'answered' ? 'ok' : item.status === 'asked' || item.status === 'said' ? 'accent' : 'muted'}`}>{STATUS_LABEL[item.status]}</span>
                  <span className="as-feed__time">{clockOf(item.atMs)}</span>
                </div>
                <p className="as-feed__text">{item.text}</p>
                {item.answer && <p className="as-feed__answer"><span className="as-step__key">Answer</span> <q>{item.answer.text}</q></p>}
                {item.note && <p className="as-note">{item.note}</p>}
                <p className="as-note">Why now: {item.whyNow}</p>
                <EvidenceLinks ids={item.evidenceIds} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="as-map-title">
        <h3 className="as-h3" id="as-map-title">Draft map <span className="as-count">{map.steps.length} steps</span></h3>
        {map.steps.length === 0
          ? <p className="as-empty">No steps yet. The draft map fills as the expert works and answers.</p>
          : <StepCards map={map} />}
      </section>

      <section aria-labelledby="as-obs-title">
        <h3 className="as-h3" id="as-obs-title">What the screen showed <span className="as-count">{observations.length} events</span></h3>
        {(synthetic || sawSynthetic) && (
          <p className="as-notwired as-notwired--synthetic" role="note"><strong>Synthetic:</strong> these events are invented sample data, not your screen.</p>
        )}
        {observations.length === 0 ? (
          <p className="as-empty">Nothing yet. Start Learn with the sample observations on; stream A&apos;s vision replaces them when it is wired.</p>
        ) : (
          <ol className="as-obs" aria-label="Observed moments">
            {observations.map((o) => (
              <li key={o.id} className={`as-obs__row${o.source === 'workspace' ? ' is-heartbeat' : ''}`}>
                <span className="as-obs__time">{clockOf(o.timestampMs)}</span>
                <span className="as-tag as-tag--muted">{o.kind}</span>
                <span className="as-obs__summary">{o.summary}</span>
                <EvidenceLinks ids={o.evidenceIds} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
