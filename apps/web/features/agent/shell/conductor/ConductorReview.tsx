import { useMemo, useState } from 'react';
import { WorkMapBoard, fromGenericMap } from '../../workmap/index.ts';
import type { GenericBoard } from '../../workmap/index.ts';
import { ClipaNow } from '../feed/ClipaNow.tsx';
import { LiveFeed } from '../feed/LiveFeed.tsx';
import { useShell, useShellState } from '../hooks.ts';
import { useConductor } from './hooks.ts';
import './rule-hero.css';

/** The rule card shows at most this many rules: the session's main rules, not the whole map. */
const HERO_MAX_RULES = 2;
/** The rule's condition is a small tag; a long one is cut here (the full text is its tooltip). */
const HERO_TAG_MAX = 60;

const shortTag = (text: string): string => (text.length <= HERO_TAG_MAX ? text : `${text.slice(0, HERO_TAG_MAX - 1).trimEnd()}…`);

/**
 * Reflect's hero, as in the reference video: on the left the expert's own words with a link to the screen moment, on the right
 * the rule they became in the Work Map (its condition, the required action, its exceptions) and whether the expert confirmed it.
 * One row per rule. A rule without the expert's words falls back to the words of a judgment step, else says so.
 */
function RuleHero({ board, confirmed, onSeek }: { board: GenericBoard; confirmed: boolean; onSeek: (evidenceId: string) => void }) {
  const rules = board.map.guardrails.slice(0, HERO_MAX_RULES);
  if (rules.length === 0) return null;
  const judged = board.map.steps.filter((s) => s.kind === 'judgment' && s.decision !== null && s.decision.quote !== null);
  return (
    <section className="as-rule-hero" data-testid="rule-hero" aria-label="The rule Clipa learned from you" data-confirmed={confirmed ? 'true' : 'false'}>
      {rules.map((g) => {
        // The judgment step that shares a screen moment with the rule, else the first one with the expert's words.
        const step = judged.find((s) => s.evidenceIds.some((e) => g.evidenceIds.includes(e))) ?? judged[0];
        const quote = g.quote ?? step?.decision?.quote ?? null;
        const evidenceId = g.evidenceIds[0] ?? null;
        const condition = g.condition.trim();
        return (
          <article key={g.id} className="as-rule-hero__row" data-rule-id={g.id}>
            <div className="as-rule-hero__side as-rule-hero__side--words">
              <p className="as-rule-hero__label">Expert explanation</p>
              {quote === null
                ? <p className="as-rule-hero__quote as-rule-hero__quote--none">No reason yet</p>
                : <blockquote className="as-rule-hero__quote">{quote}</blockquote>}
              <p className="as-rule-hero__caption">A reason, with a source</p>
              {evidenceId !== null && (
                <button type="button" className="as-link as-rule-hero__seek" onClick={() => onSeek(evidenceId)}>See the moment</button>
              )}
            </div>
            <div className="as-rule-hero__arrow" aria-hidden="true">→</div>
            <div className="as-rule-hero__side as-rule-hero__side--rule">
              <p className="as-rule-hero__label">Work Map</p>
              {condition !== '' && <span className="as-rule-hero__tag" title={condition}>{shortTag(condition)}</span>}
              <p className="as-rule-hero__action">{g.requiredAction}</p>
              <ul className="as-rule-hero__exceptions">
                {g.exceptions.length === 0
                  ? <li className="as-rule-hero__exception as-rule-hero__exception--none">Exception: none stated yet</li>
                  : g.exceptions.map((x, i) => <li key={i} className="as-rule-hero__exception">{`Exception: ${x.text}`}</li>)}
              </ul>
              <p className="as-rule-hero__footer" data-confirmed={confirmed ? 'true' : 'false'}>
                {confirmed ? '✓ Confirmed by the expert' : 'Waiting for you'}
              </p>
            </div>
          </article>
        );
      })}
    </section>
  );
}

/**
 * Reflect (Review) as a face of the conductor: the rule card first (the expert's words and the rule they became), then the
 * questions still open and the teach-back. The full board (steps and screen moments) stays one click away in a closed fold. The
 * expert mostly talks: Clipa edits the map and reads the teach-back again. The buttons send the same intents as words would
 * (confirm, correct, answer a gap, done with the questions). The map's version is in Debug.
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
  const origin = snapshot?.origin ?? 'session';
  // The conductor takes a confirm of this session's map only after it read the teach-back (its cue arrived); an earlier
  // session's map or the demo map can be confirmed at once. Before that a Confirm button would do nothing.
  const canConfirm = teachBackCue !== null || origin !== 'session';

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

      {board !== null && <RuleHero board={board} confirmed={confirmed} onSeek={(evidenceId) => controller.openEvidence(evidenceId)} />}

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
            teachBack !== null && !confirmed && (canConfirm ? (
              <div className="as-row">
                <button type="button" className="as-btn as-btn--primary" disabled={paused} onClick={() => controller.uiAction('confirm')}>Confirm</button>
                <button type="button" className="as-btn as-btn--quiet" disabled={paused} onClick={() => setCorrecting(true)}>Correct</button>
              </div>
            ) : (
              <p className="as-empty">Clipa reads this back once the open questions are answered; then you confirm or correct it.</p>
            ))
          )}
        </section>
      </div>

      <details className="as-fold as-rule-hero__fold" data-testid="review-full-map">
        <summary className="as-fold__summary">Full Work Map: steps and screen moments</summary>
        <LiveFeed visible={3} empty={running ? 'Changes to the map appear here as you talk.' : 'Nothing yet: start Reflect and talk to Clipa.'} />
        {board !== null && (
          <WorkMapBoard
            map={board.map}
            observations={observations}
            title="Work Map"
            origin={origin}
            inlineMoment={false}
            processes={board.processes}
            onSeek={(evidenceId) => controller.openEvidence(evidenceId)}
            // The open questions are listed once, in their card above. Clicking a step or a rule only shows its moment.
            onCardSelect={(card) => { if (card.kind === 'gap') controller.uiAction('answer_gap', card.id); }}
          />
        )}
      </details>
    </div>
  );
}
