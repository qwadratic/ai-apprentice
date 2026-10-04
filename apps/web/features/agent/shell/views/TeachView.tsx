import { EvidenceLinks, NotWired } from '../components/Parts.tsx';
import { useShell, useShellState } from '../hooks.ts';
import { TEACH_CASES, isTeachCaseId } from '../screen/sample-scenarios.ts';

const RESULT_TEXT = {
  clear: 'Clear: this matches what the expert did.',
  warn: 'Warning: stop before you send.',
  unknown: 'Unknown: the tutor cannot judge this, so it does not guess.',
} as const;

/** Teach: the checkpoint result before Send, and the mastery summary at the end. */
export function TeachView() {
  const { controller } = useShell();
  const brain = useShellState((s) => s.brain);
  const checkpoint = useShellState((s) => s.teach.checkpoint);
  const mastery = useShellState((s) => s.teach.mastery);
  const canRaise = useShellState((s) => s.phase === 'live' && s.screen.source?.synthetic === true);
  const sampleCase = useShellState((s) => s.teach.sampleCase);
  const sampleOn = useShellState((s) => s.screen.sampleOn);
  const busy = useShellState((s) => s.phase === 'starting' || s.phase === 'ending');
  const offRecord = useShellState((s) => s.offRecord);

  return (
    <div className="as-view" data-testid="view-teach">
      {!brain.wired && (
        <NotWired>
          the tutor ({brain.name}): it cannot explain steps, predict decisions or judge a checkpoint. Until then every
          checkpoint is answered &quot;unknown&quot;, never &quot;clear&quot;.
        </NotWired>
      )}
      <p className="as-note" data-testid="teach-honesty">
        The checkpoint works in our demo workspace only; it does not block clicks in other apps. In the demo workspace a warning or an
        unknown answer still needs your explicit acknowledgement before Send: the decision stays with you.
      </p>

      {sampleOn && (
        <section aria-labelledby="as-case-title">
          <h3 className="as-h3" id="as-case-title">Sample case <span className="as-tag as-tag--warn">synthetic</span></h3>
          <div className="as-row">
            <select
              className="as-select"
              aria-label="Sample case"
              value={sampleCase}
              onChange={(e) => { if (isTeachCaseId(e.target.value)) controller.setSampleCase(e.target.value); }}
            >
              {TEACH_CASES.map((c) => <option key={c.id} value={c.id}>{c.id.toUpperCase()} · {c.title}</option>)}
            </select>
            <button type="button" className="as-btn" disabled={offRecord || busy} onClick={() => void controller.runSampleCase(sampleCase)}>
              Run this case (new session)
            </button>
          </div>
          <p className="as-note">Each case is a new session. The tutor reads the confirmed Work Map from Review; without one it answers unknown.</p>
        </section>
      )}

      <section aria-labelledby="as-cp-title">
        <h3 className="as-h3" id="as-cp-title">Checkpoint before Send</h3>
        {checkpoint === null ? (
          <p className="as-empty">No checkpoint yet. The workspace raises one at Preview; the answer appears here before anything is sent.</p>
        ) : (
          <div className={`as-checkpoint as-checkpoint--${checkpoint.status}`} role="status" aria-live="polite" data-testid="checkpoint-card" data-status={checkpoint.status}>
            <p className="as-checkpoint__status">{RESULT_TEXT[checkpoint.status]}</p>
            <p className="as-checkpoint__message">{checkpoint.message}</p>
            {checkpoint.evidenceIds.length > 0 && <p className="as-note">The expert&apos;s screen moment:</p>}
            <EvidenceLinks ids={checkpoint.evidenceIds} />
            {checkpoint.evidenceIds.length === 0 && <p className="as-note">No expert moment is linked to this answer.</p>}
            {checkpoint.deliveryError && <p className="as-error" role="alert">The workspace did not accept the reply: {checkpoint.deliveryError}</p>}
          </div>
        )}
        {canRaise && (
          <div className="as-row">
            <button type="button" className="as-btn" onClick={() => controller.raiseSampleCheckpoint()}>Raise sample checkpoint</button>
            <span className="as-tag as-tag--warn">synthetic</span>
          </div>
        )}
      </section>

      <section aria-labelledby="as-mastery-title">
        <h3 className="as-h3" id="as-mastery-title">What is mastered</h3>
        {mastery === null ? (
          <p className="as-empty">Not available yet: it appears after the first checkpoint of a sample case.</p>
        ) : (
          <div className="as-mastery">
            <div>
              <h4 className="as-h4">Mastered</h4>
              <ul>{mastery.mastered.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
            <div>
              <h4 className="as-h4">To practise</h4>
              <ul>{mastery.practise.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
