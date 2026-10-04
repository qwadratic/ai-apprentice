import { useState } from 'react';
import { EvidenceLinks, NotWired, StepCards } from '../components/Parts.tsx';
import { useShell, useShellState } from '../hooks.ts';

/** Review: the gaps still open, the teach-back with Confirm or Correct, and the map so far. */
export function ReviewView() {
  const { controller } = useShell();
  const brain = useShellState((s) => s.brain);
  const gaps = useShellState((s) => s.review.gaps);
  const feed = useShellState((s) => s.feed);
  const teachBack = useShellState((s) => s.review.teachBack);
  const map = useShellState((s) => s.draftMap);
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState('');

  // Questions that were not asked live wait here: deferred by the policy, or not spoken because the voice was away.
  const waiting = feed.filter((f) => f.status === 'deferred' || f.status === 'unspoken');
  const hasText = teachBack.text !== null;

  const submitCorrection = (): void => {
    controller.correctTeachBack(draft);
    setCorrecting(false);
    setDraft('');
  };

  return (
    <div className="as-view" data-testid="view-review">
      {!brain.wired && (
        <NotWired>
          the debrief and the teach-back ({brain.name}): the brain writes the gap questions and the teach-back text, and decides when
          the debrief is done (TASK-3.10). Questions deferred in Learn do show up below.
        </NotWired>
      )}

      <section aria-labelledby="as-gaps-title">
        <h3 className="as-h3" id="as-gaps-title">Open gaps <span className="as-count">{gaps.length + waiting.length}</span></h3>
        {gaps.length + waiting.length === 0 ? (
          <p className="as-empty">No open gaps. Gaps come from the brain and from questions deferred during Learn.</p>
        ) : (
          <ul className="as-gaps">
            {gaps.map((g) => (
              <li key={g.id} className="as-gap">
                <p className="as-gap__text">{g.question}</p>
                <EvidenceLinks ids={g.evidenceIds} />
              </li>
            ))}
            {waiting.map((f) => (
              <li key={f.id} className="as-gap">
                <p className="as-gap__text">{f.text}</p>
                <p className="as-note">{f.status === 'deferred' ? 'Deferred in Learn' : 'Not spoken in Learn'} · {f.whyNow}</p>
                <EvidenceLinks ids={f.evidenceIds} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="as-tb-title">
        <h3 className="as-h3" id="as-tb-title">Teach-back
          {teachBack.status !== 'none' && <span className={`as-tag as-tag--${teachBack.status === 'pending' ? 'accent' : 'ok'}`}>{teachBack.status}</span>}
        </h3>
        {hasText ? (
          <blockquote className="as-teachback" data-testid="teachback-text">{teachBack.text}</blockquote>
        ) : (
          <p className="as-empty">No teach-back yet. Clipa repeats the process back once there is enough to repeat; you then confirm it or correct it.</p>
        )}
        {teachBack.correction && <p className="as-feed__answer"><span className="as-step__key">Your correction</span> <q>{teachBack.correction}</q></p>}
        {correcting ? (
          <div className="as-correct">
            <label className="as-field">
              <span className="as-field__label">What is different?</span>
              <textarea className="as-textarea" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <div className="as-row">
              <button type="button" className="as-btn as-btn--primary" disabled={draft.trim() === ''} onClick={submitCorrection}>Send correction</button>
              <button type="button" className="as-btn" onClick={() => { setCorrecting(false); setDraft(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="as-row">
            <button type="button" className="as-btn as-btn--primary" disabled={!hasText || teachBack.status === 'confirmed'} onClick={() => controller.confirmTeachBack()}>Confirm</button>
            <button type="button" className="as-btn" disabled={!hasText} onClick={() => { setDraft(teachBack.correction ?? ''); setCorrecting(true); }}>Correct</button>
          </div>
        )}
      </section>

      <section aria-labelledby="as-rmap-title">
        <h3 className="as-h3" id="as-rmap-title">Work Map so far <span className="as-count">{map.steps.length} steps</span></h3>
        {map.steps.length === 0
          ? <p className="as-empty">The clickable timeline is the Work Map UI (TASK-3.11). It stays empty until the brain produces steps.</p>
          : <StepCards map={map} />}
      </section>
    </div>
  );
}
