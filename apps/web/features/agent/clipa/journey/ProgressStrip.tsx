import { useMemo, useState, useSyncExternalStore } from 'react';
import './progress-strip.css';
import type { Journey, JourneySnapshot } from './engine.ts';
import { buildStrip, statusWord } from './progress.ts';

/** What the strip needs from the journey, so tests and stories can pass a stub. */
export type StripJourney = Pick<Journey, 'getSnapshot' | 'subscribe' | 'replay'>;

export function useJourneySnapshot(journey: Pick<Journey, 'getSnapshot' | 'subscribe'>): JourneySnapshot {
  return useSyncExternalStore(journey.subscribe, journey.getSnapshot, journey.getSnapshot);
}

const WHO: Readonly<Record<JourneySnapshot['persona'], string | null>> = {
  expert: "Expert's turn",
  newHire: "New hire's turn",
  any: null,
};

/**
 * Share, Learn, Review, Teach, Summary with the current step highlighted. A finished step is a button that makes
 * Clipa say it again; it never changes the journey, so clicking around is safe. When Clipa cannot show it right now
 * (somebody is talking, or the control is not on this tab) the strip says so instead of doing nothing.
 */
export function ProgressStrip({ journey }: { journey: StripJourney }) {
  const snapshot = useJourneySnapshot(journey);
  const items = useMemo(() => buildStrip(snapshot), [snapshot]);
  const [notice, setNotice] = useState<string | null>(null);
  const who = WHO[snapshot.persona];
  return (
    <nav className="clipa-strip" aria-label="Demo progress">
      <ol className="clipa-strip__list">
        {items.map((item, i) => {
          const body = (
            <>
              <span className="clipa-strip__mark" aria-hidden="true">
                {item.status === 'done' ? '✓' : item.status === 'skipped' ? '–' : i + 1}
              </span>
              <span className="clipa-strip__label">{item.label}</span>
              <span className="clipa-strip__sr">
                , {statusWord(item.status)}
                {item.detail ? `, ${item.detail}` : ''}
              </span>
            </>
          );
          return (
            <li
              key={item.phase}
              className={`clipa-strip__item clipa-strip__item--${item.status}`}
              aria-current={item.status === 'current' ? 'step' : undefined}
            >
              {item.status === 'done' ? (
                <button
                  type="button"
                  className="clipa-strip__btn"
                  aria-label={`Show me ${item.label} again`}
                  title="Show me again"
                  onClick={(event) => {
                    const button = event.currentTarget;
                    const shown = journey.replay(item.replayStep);
                    setNotice(shown ? null : `Clipa cannot show ${item.label} right now. Try again in a moment.`);
                    button.focus(); // keep the keyboard where it was
                  }}
                >
                  {body}
                </button>
              ) : (
                <span className="clipa-strip__btn">{body}</span>
              )}
              {item.detail ? (
                <span className="clipa-strip__detail" aria-hidden="true">
                  {item.detail}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {who ? <p className="clipa-strip__who">{who}</p> : null}
      <p className="clipa-strip__notice" role="status" aria-live="polite">
        {notice}
      </p>
    </nav>
  );
}
