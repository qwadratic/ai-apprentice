// Small shared pieces of the mode views.
import type { ReactNode } from 'react';
import type { DraftMap } from '../brain/types.ts';
import { useShell } from '../hooks.ts';
import { formatClock } from '../session-clock.ts';

/** Says what is not wired yet, in the view that depends on it. */
export function NotWired({ children }: { children: ReactNode }) {
  return <p className="as-notwired" role="note"><strong>Not wired yet:</strong> {children}</p>;
}

/** Links to screen moments: a click opens the replay slot for that evidence. */
export function EvidenceLinks({ ids }: { ids: readonly string[] }) {
  const { controller } = useShell();
  if (ids.length === 0) return null;
  return (
    <span className="as-evidence">
      {ids.map((id) => (
        <button key={id} type="button" className="as-link" onClick={() => controller.openEvidence(id)} title="Show the screen moment">
          moment {id}
        </button>
      ))}
    </span>
  );
}

export function clockOf(ms: number | null): string {
  return ms === null ? '' : formatClock(ms);
}

/** The draft map as step cards. Each step links to its screen moments. */
export function StepCards({ map }: { map: DraftMap }) {
  if (map.steps.length === 0) return null;
  const listed = new Set(map.steps.flatMap((s) => s.guardrails.map((g) => g.id)));
  const loose = (map.guardrails ?? []).filter((g) => !listed.has(g.id));
  return (
    <>
    <ol className="as-steps" aria-label="Draft map">
      {map.steps.map((step, i) => (
        <li key={step.id} className={`as-step as-step--${step.kind}`}>
          <div className="as-step__head">
            <span className="as-step__no">{i + 1}</span>
            <strong className="as-step__title">{step.title}</strong>
            <span className={`as-tag as-tag--${step.kind === 'judgment' ? 'accent' : 'muted'}`}>{step.kind === 'judgment' ? 'judgment call' : 'step'}</span>
            {step.atMs !== null && <span className="as-step__time">{clockOf(step.atMs)}</span>}
          </div>
          {step.decision !== null && <p className="as-step__line"><span className="as-step__key">Decision</span> {step.decision}</p>}
          {step.reason !== null && <p className="as-step__line"><span className="as-step__key">Reason</span> <q>{step.reason}</q></p>}
          {step.guardrails.map((g) => (
            <p key={g.id} className="as-step__line as-step__line--guard">
              <span className="as-step__key">Guardrail</span> {g.text} <EvidenceLinks ids={g.evidenceIds} />
            </p>
          ))}
          <EvidenceLinks ids={step.evidenceIds} />
        </li>
      ))}
    </ol>
    {loose.length > 0 && (
      <ul className="as-steps as-steps--guards" aria-label="Guardrails not tied to a step">
        {loose.map((g) => (
          <li key={g.id} className="as-step as-step--guard">
            <p className="as-step__line as-step__line--guard"><span className="as-step__key">Guardrail</span> {g.text} <EvidenceLinks ids={g.evidenceIds} /></p>
          </li>
        ))}
      </ul>
    )}
    </>
  );
}
