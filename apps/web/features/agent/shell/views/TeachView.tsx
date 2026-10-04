import { EvidenceLinks, NotWired } from '../components/Parts.tsx';
import { useConductorLeads } from '../conductor/hooks.ts';
import { ClipaNow } from '../feed/ClipaNow.tsx';
import { LiveFeed } from '../feed/LiveFeed.tsx';
import { useShell, useShellState } from '../hooks.ts';
import { TEACH_CASES, isTeachCaseId } from '../screen/sample-scenarios.ts';

const RESULT_TITLE = {
  clear: 'Clear to send',
  warn: 'Stop before you send',
  unknown: 'Not sure: ask before you send',
} as const;

const RESULT_HINT = {
  clear: 'This matches what the expert did.',
  warn: 'One of the expert’s rules covers this step.',
  unknown: 'The tutor cannot judge this case, so it does not guess.',
} as const;

/** Pass it on: the new hire's case, the warning card before Send, the live feed and, at the end, what is mastered. */
export function TeachView() {
  const { controller } = useShell();
  const brain = useShellState((s) => s.brain);
  const checkpoint = useShellState((s) => s.teach.checkpoint);
  const mastery = useShellState((s) => s.teach.mastery);
  const canRaise = useShellState((s) => s.phase === 'live' && s.screen.source?.synthetic === true);
  const sampleCase = useShellState((s) => s.teach.sampleCase);
  const sampleOn = useShellState((s) => s.screen.sampleOn);
  const busy = useShellState((s) => s.phase === 'starting' || s.phase === 'ending');
  const running = useShellState((s) => s.phase === 'live' && s.session?.mode === 'teach');
  const offRecord = useShellState((s) => s.offRecord);
  const leads = useConductorLeads();

  const idle = running
    ? 'Work on the new case. I speak up before a step one of the expert’s rules covers.'
    : 'Press Start Pass it on, share your screen and work on a case the expert never showed.';

  return (
    <div className="as-view" data-testid="view-teach">
      <ClipaNow idle={idle} />
      {!leads && !brain.wired && (
        <NotWired>the tutor ({brain.name}): every checkpoint is answered &quot;unknown&quot;, never &quot;clear&quot;.</NotWired>
      )}

      {checkpoint !== null && (
        <section
          className={`as-alert as-alert--${checkpoint.status}`}
          role="status"
          aria-live="polite"
          aria-labelledby="as-cp-title"
          data-testid="checkpoint-card"
          data-status={checkpoint.status}
        >
          <h3 className="as-alert__title" id="as-cp-title">{RESULT_TITLE[checkpoint.status]}</h3>
          <p className="as-alert__message">{checkpoint.message}</p>
          <p className="as-alert__hint">
            {RESULT_HINT[checkpoint.status]}
            {checkpoint.evidenceIds.length > 0 && <> See the expert&apos;s moment: <EvidenceLinks ids={checkpoint.evidenceIds} /></>}
          </p>
          {checkpoint.deliveryError && <p className="as-error" role="alert">The workspace did not take the reply: {checkpoint.deliveryError}</p>}
        </section>
      )}

      {sampleOn && (
        <section className="as-case" aria-labelledby="as-case-title">
          <h3 className="as-h3" id="as-case-title">Sample case <span className="as-tag as-tag--warn">Synthetic data</span></h3>
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
              Run this case
            </button>
            {canRaise && <button type="button" className="as-btn as-btn--quiet" onClick={() => controller.raiseSampleCheckpoint()}>Raise a checkpoint</button>}
          </div>
        </section>
      )}

      <LiveFeed empty={running ? 'Watching the new case. Warnings and checks appear here.' : 'Nothing yet: start Pass it on and share your screen.'} />

      {mastery !== null && (
        <section className="as-mastery-card" aria-labelledby="as-mastery-title" data-clipa-target="summary">
          <h3 className="as-h3" id="as-mastery-title">What is mastered</h3>
          <div className="as-mastery">
            <div>
              <h4 className="as-h4">Mastered</h4>
              {mastery.mastered.length === 0 ? <p className="as-empty">Nothing yet.</p> : <ul>{mastery.mastered.map((m) => <li key={m}>{m}</li>)}</ul>}
            </div>
            <div>
              <h4 className="as-h4">To practise</h4>
              {mastery.practise.length === 0 ? <p className="as-empty">Nothing left.</p> : <ul>{mastery.practise.map((m) => <li key={m}>{m}</li>)}</ul>}
            </div>
            {(mastery.notJudged?.length ?? 0) > 0 && (
              <div data-testid="not-judged">
                <h4 className="as-h4">Not judged</h4>
                <ul>{(mastery.notJudged ?? []).map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            )}
          </div>
        </section>
      )}

      <p className="as-footnote" data-testid="teach-honesty">
        Clipa warns before Send in our demo workspace and leaves the decision to you; she never blocks clicks in other apps.
      </p>
    </div>
  );
}
