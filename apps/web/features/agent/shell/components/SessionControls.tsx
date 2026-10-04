import { useShell, useShellState } from '../hooks.ts';
import { MODE_LABELS } from '../state/types.ts';

const START_HINT = {
  learn: 'The expert works; Clipa listens and asks a few questions at natural pauses.',
  review: 'A spoken debrief: open questions, then a teach-back to confirm or correct.',
  teach: 'The tutor watches a new case and speaks up before a guardrail is broken.',
} as const;

/** Start / End of a mode, the sample-observations switch and the disclosure. Start of a mode makes the session. */
export function SessionControls() {
  const { controller } = useShell();
  const mode = useShellState((s) => s.mode);
  const phase = useShellState((s) => s.phase);
  const session = useShellState((s) => s.session);
  const offRecord = useShellState((s) => s.offRecord);
  const sampleOn = useShellState((s) => s.screen.sampleOn);
  const label = MODE_LABELS[mode];
  const running = phase === 'live';
  const busy = phase === 'starting' || phase === 'ending';

  return (
    <section className="as-card as-session" aria-labelledby="as-controls-title">
      <h2 className="as-card__title" id="as-controls-title">Session</h2>

      {offRecord && (
        <p className="as-notwired as-notwired--off" role="status">
          You are off the record: nothing is captured, spoken or sent. Press Back on record to start again.
        </p>
      )}

      <div className="as-row">
        {running ? (
          <button type="button" className="as-btn as-btn--primary" onClick={() => void controller.end('Session ended.')}>
            End session
          </button>
        ) : (
          <button
            type="button"
            className="as-btn as-btn--primary"
            disabled={offRecord || busy}
            onClick={() => void controller.start(mode)}
          >
            {phase === 'starting' ? 'Starting...' : phase === 'ending' ? 'Ending...' : `Start ${label}`}
          </button>
        )}
      </div>

      {running && session && session.mode !== mode && (
        <p className="as-note" role="status">A {MODE_LABELS[session.mode]} session is running. Its data stays here while you look at {label}.</p>
      )}
      {!running && !offRecord && <p className="as-note">{START_HINT[mode]}</p>}
      {session && (
        <p className="as-note" data-testid="session-line">
          Session <code>{session.id.length > 12 ? `${session.id.slice(0, 8)}...` : session.id}</code> · {MODE_LABELS[session.mode]}
          {phase === 'ended' ? ' · ended' : ''}
        </p>
      )}

      <label className={`as-switch${mode === 'review' ? ' is-disabled' : ''}`}>
        <input
          type="checkbox"
          checked={sampleOn}
          onChange={(e) => void controller.setSampleObservations(e.target.checked)}
          disabled={offRecord}
        />
        <span>
          <strong>Use sample observations</strong> <span className="as-tag as-tag--warn">synthetic</span>
          <span className="as-switch__hint">
            Invented screen events instead of your screen: the fallback that runs until you share a window in the Screen panel.
            {mode === 'review' ? ' Review does not use the screen.' : ''}
          </span>
        </span>
      </label>

      <p className="as-disclosure">
        Starting a mode stores the session events, the voice transcript and an audio recording on our server, and opens the microphone.
        <strong> Off the record</strong> stops both channels; it does not delete or recall what was already sent.
      </p>
      <details className="as-details">
        <summary className="as-details__summary">Limits and what masks do not cover</summary>
        <p className="as-note">
          The session ends by itself after 10 minutes, or after 2 minutes with this tab hidden. Screen masks hide pixels, not speech:
          do not say anything you want to keep private.
        </p>
      </details>
    </section>
  );
}
