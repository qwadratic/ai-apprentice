import type { CSSProperties, ReactNode } from 'react';
import './workflow-strip.css';
import { useShellState } from '../hooks.ts';
import type { Mode } from '../state/types.ts';

/** One thing Clipa does, pinned to the expert's steps: a stretch across steps (`bar`) or a point on the workflow (`pin`). */
export interface WorkflowMarker {
  text: string;
  /** The first step column it sits in (1-based) and how many columns it spans. */
  from: number;
  span: number;
  shape: 'bar' | 'pin';
  /** Where it sits, in words: shown on a phone and read by screen readers, where the alignment is lost. */
  at: string;
}

/** The customer_07 case, as the expert does it, and what Clipa does at each stage. Everything the strip shows is here. */
export const WORKFLOW = {
  title: 'The expert’s workflow, and where Clipa fits',
  steps: [
    { title: 'Open the order', ref: 'ORD-2041' },
    { title: 'Read the customer’s note', ref: null },
    { title: 'Write the delivery update', ref: null },
    { title: 'Preview', ref: null },
    { title: 'Send', ref: null },
  ],
  stages: [
    {
      mode: 'learn',
      name: 'Show',
      markers: [
        { text: 'watches quietly', from: 1, span: 3, shape: 'bar', at: 'steps 1–3' },
        { text: 'asks why at the pause', from: 4, span: 1, shape: 'pin', at: 'after step 3' },
      ],
    },
    {
      mode: 'review',
      name: 'Reflect',
      markers: [{ text: 'the answer becomes a rule + exception', from: 4, span: 2, shape: 'pin', at: 'after step 3' }],
    },
    {
      mode: 'teach',
      name: 'Pass it on',
      markers: [{ text: 'checks before Send', from: 5, span: 1, shape: 'pin', at: 'between steps 4 and 5' }],
    },
  ],
} as const satisfies {
  title: string;
  steps: ReadonlyArray<{ title: string; ref: string | null }>;
  stages: ReadonlyArray<{ mode: Mode; name: string; markers: readonly WorkflowMarker[] }>;
};

/**
 * The expert's workflow on the demo case, with Clipa's lane under it: what she does at each stage and at which step. The markers
 * of the stage on screen are lit (the mode comes from the shell store, as on the journey rail). `aside` sits at the right of the
 * title (the recording pill).
 */
export function WorkflowStrip({ aside }: { aside?: ReactNode }) {
  const mode = useShellState((s) => s.mode);
  return (
    <section className="ws" aria-labelledby="ws-title" data-testid="workflow-strip" data-mode={mode}>
      <div className="ws__head">
        <h2 className="ws__title" id="ws-title">{WORKFLOW.title}</h2>
        {aside}
      </div>

      <div className="ws__board">
        <div className="ws__row ws__row--steps">
          <span className="ws__who">Expert</span>
          <ol className="ws__steps" aria-label="The expert’s steps">
            {WORKFLOW.steps.map((step, i) => (
              <li key={step.title} className="ws__step">
                <span className="ws__no" aria-hidden="true">{i + 1}</span>
                <span className="ws__name">{step.title}{step.ref !== null && <span className="ws__ref"> ({step.ref})</span>}</span>
              </li>
            ))}
          </ol>
        </div>

        {WORKFLOW.stages.map((stage, row) => {
          const current = stage.mode === mode;
          return (
            <div key={stage.mode} className="ws__row ws__row--lane" data-stage={stage.mode} data-current={current ? 'true' : 'false'} aria-current={current ? 'true' : undefined}>
              <span className="ws__who">
                {row === 0 && <span className="ws__who-sub">Clipa</span>}
                {stage.name}
              </span>
              <ul className="ws__marks" aria-label={`Clipa in ${stage.name}`}>
                {stage.markers.map((marker) => (
                  <li
                    key={marker.text}
                    className={`ws__mark ws__mark--${marker.shape}`}
                    style={{ '--from': marker.from, '--span': marker.span } as CSSProperties}
                  >
                    <span className="ws__mark-text">{marker.text}</span>
                    <span className="ws__at">{marker.at}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
