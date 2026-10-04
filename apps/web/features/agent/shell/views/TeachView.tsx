import { EvidenceLinks, NotWired } from '../components/Parts.tsx';
import { useShell, useShellState } from '../hooks.ts';

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

  return (
    <div className="as-view" data-testid="view-teach">
      {!brain.wired && (
        <NotWired>
          the tutor ({brain.name}): it cannot explain steps, predict decisions or judge a checkpoint (TASK-3.14). Until then every
          checkpoint is answered &quot;unknown&quot;, never &quot;clear&quot;. The checkpoint works in our demo workspace only; it does not block clicks in other apps.
        </NotWired>
      )}

      <section aria-labelledby="as-cp-title">
        <h3 className="as-h3" id="as-cp-title">Checkpoint before Send</h3>
        {checkpoint === null ? (
          <p className="as-empty">No checkpoint yet. The workspace raises one at Preview; the answer appears here before anything is sent.</p>
        ) : (
          <div className={`as-checkpoint as-checkpoint--${checkpoint.status}`} role="status" aria-live="polite" data-testid="checkpoint-card" data-status={checkpoint.status}>
            <p className="as-checkpoint__status">{RESULT_TEXT[checkpoint.status]}</p>
            <p className="as-checkpoint__message">{checkpoint.message}</p>
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
          <p className="as-empty">Not available yet: the summary of what you mastered and what to practise needs the tutor (TASK-3.14).</p>
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
