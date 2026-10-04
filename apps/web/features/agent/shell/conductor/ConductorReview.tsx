import { useMemo, useState } from 'react';
import { WorkMapBoard, fromGenericMap } from '../../workmap/index.ts';
import { useShell } from '../hooks.ts';
import { ConductorLine } from './ConductorLine.tsx';
import { useConductor } from './hooks.ts';

/**
 * Reflect (Review) as a face of the conductor: the map Clipa built from the session, the questions still open and the teach-back.
 * The expert mostly talks: Clipa edits the map and reads the teach-back again. The buttons send the same intents as words would
 * (confirm, correct, answer a gap, ask about a card, done with the questions).
 */
export function ConductorReview() {
  const { controller } = useShell();
  const snapshot = useConductor((s) => s.map);
  const teachBackCue = useConductor((s) => s.teachBack);
  const observations = useConductor((s) => s.observations);
  const paused = useConductor((s) => s.paused);
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

  return (
    <div className="as-view" data-testid="view-review-conductor">
      <ConductorLine />
      <p className="as-note">
        Start Reflect and talk to Clipa: she asks what is still open, then reads back what she understood. Say what to change, add or
        remove, and she edits the map. Click a card to talk about it.
        {snapshot !== null && <> Work Map version {snapshot.version}{confirmed ? ', confirmed.' : ', not confirmed yet.'}</>}
      </p>
      {board === null && (
        <p className="as-empty" data-testid="conductor-no-map">
          No map yet. Run Show first (press Start Show, share your screen and work), then press Start Reflect: Clipa builds the map from
          what she saw and heard.
        </p>
      )}

      <section aria-labelledby="as-cgaps-title" data-clipa-target="board_gap">
        <h3 className="as-h3" id="as-cgaps-title">Open questions <span className="as-count">{gaps.length}</span></h3>
        {gaps.length === 0 ? (
          <p className="as-empty">No open questions.</p>
        ) : (
          <>
            <ul className="as-gaps">
              {gaps.map((g) => (
                <li key={g.id} className="as-gap">
                  <p className="as-gap__text">{g.text}</p>
                  <button type="button" className="as-btn as-btn--small" disabled={paused} onClick={() => controller.uiAction('answer_gap', g.id)}>
                    Answer now
                  </button>
                </li>
              ))}
            </ul>
            <div className="as-row">
              <button type="button" className="as-btn" disabled={paused} onClick={() => controller.uiAction('finish')}>Done with the questions</button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="as-ctb-title" data-clipa-target="teachback">
        <h3 className="as-h3" id="as-ctb-title">Teach-back
          {teachBack !== null && <span className={`as-tag as-tag--${confirmed ? 'ok' : 'accent'}`}>{confirmed ? 'confirmed' : 'pending'}</span>}
        </h3>
        {teachBack === null ? (
          <p className="as-empty">No teach-back yet. Clipa reads it back once the open questions are answered.</p>
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
              <button type="button" className="as-btn" onClick={() => { setCorrecting(false); setDraft(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="as-row">
            <button type="button" className="as-btn as-btn--primary" disabled={teachBack === null || confirmed || paused} onClick={() => controller.uiAction('confirm')}>
              Confirm
            </button>
            <button type="button" className="as-btn" disabled={teachBack === null || paused} onClick={() => setCorrecting(true)}>Correct</button>
          </div>
        )}
      </section>

      {board !== null && (
        <WorkMapBoard
          map={board.map}
          observations={observations}
          gaps={board.gaps}
          title="Work Map"
          inlineMoment={false}
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
