import { useShell, useShellState } from '../hooks.ts';
import { MODE_LABELS } from '../state/types.ts';

const START_HINT = {
  learn: 'Do the task and talk as you work. Clipa asks at natural pauses.',
  review: 'A spoken debrief: open questions, then a teach-back you confirm or correct.',
  teach: 'A new hire works on a new case. Clipa speaks up before an expert’s rule is broken.',
} as const;

/**
 * Start or End of the stage on screen (Start makes the session): one main button and one sentence. What recording means (and what
 * Off the record does), the sample observations (invented data) and the limits sit under "Options and limits", collapsed. The
 * session id and the raw state are in Debug.
 */
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
  const elsewhere = running && session !== null && session.mode !== mode;

  return (
    <section className="as-card as-session" aria-label="Session" data-running={running ? 'true' : 'false'}>
      {offRecord && (
        <p className="as-notwired as-notwired--off" role="status">
          Off the record: nothing is captured, spoken or sent. Press Back on record to go on.
        </p>
      )}

      <div className="as-session__main">
        {running ? (
          elsewhere ? (
            <button type="button" className="as-btn as-btn--primary as-btn--big" data-testid="switch-session" disabled={offRecord} onClick={() => void controller.switchSession(mode)}>
              Start {label}
            </button>
          ) : (
            <button type="button" className="as-btn as-btn--big as-btn--end" onClick={() => void controller.end('Session ended.')}>
              <span className="as-session__rec" aria-hidden="true" /> End {label}
            </button>
          )
        ) : (
          <button
            type="button"
            className="as-btn as-btn--primary as-btn--big"
            data-clipa-target="start"
            disabled={offRecord || busy}
            onClick={() => void controller.start(mode)}
          >
            {phase === 'starting' ? 'Starting…' : phase === 'ending' ? 'Ending…' : `Start ${label}`}
          </button>
        )}
        {!offRecord && (
          <p className="as-session__hint">
            {elsewhere
              ? `${MODE_LABELS[session.mode]} is still running; this ends it and starts ${label}.`
              : running ? 'Recording. End it when the task is done.' : START_HINT[mode]}
          </p>
        )}
      </div>

      <details className="as-details">
        <summary className="as-details__summary">Options and limits</summary>
        <p className="as-note" data-testid="recording-note">
          Start records the session&apos;s events, transcript and audio on our server and opens the microphone. <strong>Off the record</strong> stops
          both channels; it does not recall what was already sent.
        </p>
        <label className={`as-switch${mode === 'review' ? ' is-disabled' : ''}`}>
          <input
            type="checkbox"
            checked={sampleOn}
            onChange={(e) => void controller.setSampleObservations(e.target.checked)}
            disabled={offRecord}
          />
          <span>
            <strong>Use sample observations</strong> <span className="as-tag as-tag--warn">Synthetic data</span>
            <span className="as-switch__hint">
              Invented screen events instead of your screen, until you share one.{mode === 'review' ? ' Reflect does not use the screen.' : ''}
            </span>
          </span>
        </label>
        <p className="as-note">
          A session ends by itself after 10 minutes, or after 2 minutes with this tab hidden. Screen masks hide pixels, not speech: do not
          say anything you want to keep private.
        </p>
      </details>
    </section>
  );
}
