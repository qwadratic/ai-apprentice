import { useMemo, useState } from 'react';
import { WorkMapBoard, fromGenericMap } from '../../workmap/index.ts';
import { ClipaNow } from '../feed/ClipaNow.tsx';
import { LiveFeed } from '../feed/LiveFeed.tsx';
import { useShell, useShellState } from '../hooks.ts';
import { useConductor } from './hooks.ts';

/**
 * Reflect (Review) as a face of the conductor: the questions still open and the teach-back first, then the map Clipa built from
 * the session. The expert mostly talks: Clipa edits the map and reads the teach-back again. The buttons send the same intents as
 * words would (confirm, correct, answer a gap, ask about a card, done with the questions). The map's version is in Debug.
 */
export function ConductorReview() {
  const { controller } = useShell();
  const snapshot = useConductor((s) => s.map);
  const teachBackCue = useConductor((s) => s.teachBack);
  const observations = useConductor((s) => s.observations);
  const paused = useConductor((s) => s.paused);
  const running = useShellState((s) => s.phase === 'live' && s.session?.mode === 'review');
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState('');

  const board = useMemo(
    () => (snapshot === null ? null : fromGenericMap(snapshot.map, { version: snapshot.version, confirmed: snapshot.confirmed, observations })),
    [snapshot, observations],
  );
  const teachBack = teachBackCue?.text ?? board?.teachBack ?? null;
  const confirmed = snapshot?.confirmed === true;
  const gaps = board?.gaps ?? [];

  const submit = (): void => {
    const text = draft.trim();
    if (text === '') return;
    controller.uiAction('correct', null, text);
    setCorrecting(false);
    setDraft('');
  };

  const idle = board === null
    ? 'Press Start Reflect: I show the map of your latest session (or a demo map) and we talk it through.'
    : running
      ? 'Talk to me: answer what is open, then confirm or correct what I read back.'
      : 'Press Start Reflect: I ask what is still open, then read the process back.';

  return (
    <div className="as-view" data-testid="view-review-conductor">
      <ClipaNow idle={idle} />

      <div className="as-focus">
        <section className="as-focus__card" aria-labelledby="as-cgaps-title" data-clipa-target="board_gap">
          <h3 className="as-focus__title" id="as-cgaps-title">Open questions <span className="as-badge">{gaps.length}</span></h3>
          {gaps.length === 0 ? (
            <p className="as-empty">{board === null ? 'They appear once Clipa has a map.' : 'None left. Clipa reads the process back next.'}</p>
          ) : (
            <>
              <ul className="as-gaps">
                {gaps.map((g) => (
                  <li key={g.id} className="as-gap">
                    <button type="button" className="as-gap__button" disabled={paused} onClick={() => controller.uiAction('answer_gap', g.id)} title="Talk about this one now">
                      {g.text}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="as-link" disabled={paused} onClick={() => controller.uiAction('finish')}>Done with the questions</button>
            </>
          )}
        </section>

        <section className="as-focus__card as-focus__card--teachback" aria-labelledby="as-ctb-title" data-clipa-target="teachback" data-confirmed={confirmed ? 'true' : 'false'}>
          <h3 className="as-focus__title" id="as-ctb-title">Teach-back
            {teachBack !== null && <span className={`as-tag as-tag--${confirmed ? 'ok' : 'accent'}`}>{confirmed ? 'Confirmed' : 'Waiting for you'}</span>}
          </h3>
          {teachBack === null ? (
            <p className="as-empty">Clipa reads it back once the open questions are answered.</p>
          ) : (
            <blockquote className="as-teachback" data-testid="conductor-teachback">{teachBack}</blockquote>
          )}
          {correcting ? (
            <div className="as-correct">
              <label className="as-field">
                <span className="as-field__label">What is different?</span>
                <textarea className="as-textarea" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
              </label>
              <div className="as-row">
                <button type="button" className="as-btn as-btn--primary" disabled={draft.trim() === ''} onClick={submit}>Send correction</button>
                <button type="button" className="as-btn as-btn--quiet" onClick={() => { setCorrecting(false); setDraft(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            teachBack !== null && !confirmed && (
              <div className="as-row">
                <button type="button" className="as-btn as-btn--primary" disabled={paused} onClick={() => controller.uiAction('confirm')}>Confirm</button>
                <button type="button" className="as-btn as-btn--quiet" disabled={paused} onClick={() => setCorrecting(true)}>Correct</button>
              </div>
            )
          )}
        </section>
      </div>

      <LiveFeed visible={3} empty={running ? 'Changes to the map appear here as you talk.' : 'Nothing yet: start Reflect and talk to Clipa.'} />

      {board !== null && (
        <WorkMapBoard
          map={board.map}
          observations={observations}
          gaps={board.gaps}
          title="Work Map"
          origin={snapshot?.origin ?? 'session'}
          inlineMoment={false}
          processes={board.processes}
          onSeek={(evidenceId) => controller.openEvidence(evidenceId)}
          onGapSelect={(gap) => controller.uiAction('answer_gap', gap.id)}
          onCardSelect={(card) => {
            if (card.kind === 'gap') controller.uiAction('answer_gap', card.id);
            else controller.uiAction('ask_about', card.id);
          }}
        />
      )}
    </div>
  );
}
