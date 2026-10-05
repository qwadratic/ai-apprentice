import { useMemo, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { CLIPA_STATE_WORDS, readClipaView } from '../clipa/view.ts';
import type { Mode } from '../state/types.ts';
import { railCaption, railStages, stageForKey, stageOfPhase, statusWord } from './rail.ts';
import type { RailStage } from './rail.ts';

/** The attribute the Clipa director rests on (the director's default dock anchor). */
export const DOCK_ATTR = 'data-clipa-dock';

function Stage({ stage, onPick, onKey }: { stage: RailStage; onPick: (m: Mode) => void; onKey: (e: KeyboardEvent<HTMLButtonElement>, m: Mode) => void }) {
  const { mode, selected, status } = stage;
  // Clipa rests on the seat of the stage on screen (data-clipa-dock); the suggested stage answers the conductor's `mode_tab`.
  const seat: Record<string, string> = {};
  if (selected) seat[DOCK_ATTR] = '';
  if (status === 'next') seat['data-clipa-target'] = 'mode_tab';
  return (
    <button
      id={`as-tab-${mode}`}
      type="button"
      role="tab"
      className="as-stage"
      data-status={status}
      data-wire={stage.wire ?? undefined}
      data-clipa-target={`stage-${mode}`}
      aria-selected={selected}
      aria-controls={`as-mode-panel-${mode}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => onPick(mode)}
      onKeyDown={(e) => onKey(e, mode)}
    >
      <span className="as-stage__seat" aria-hidden="true">
        <span className="as-stage__node" {...seat}>
          <span className="as-stage__mark">{status === 'done' ? '✓' : stage.step}</span>
        </span>
      </span>
      <span className="as-stage__name">
        {stage.name}
        {status === 'active' && <span className="as-stage__live" aria-hidden="true">live</span>}
      </span>
      <span className="as-stage__hint">{stage.hint}</span>
      <span className="as-sr">{`, step ${stage.step} of 3, ${statusWord(status)}`}</span>
    </button>
  );
}

/**
 * The journey rail: Show, Reflect and Pass it on on one teal wire (the material of Clipa and the logo). It is the mode switcher
 * (a tablist over the three mode panels): a click or the arrow keys call controller.setMode. Clipa herself is the director's
 * layer above the page; she rests on the seat of the stage on screen and glides along the wire when the stage changes.
 */
export function JourneyRail() {
  const { controller, clipa } = useShell();
  // The whole state, a stable reference per version: the rail reads several slices and is cheap to redraw.
  const state = useShellState((s) => s);
  const snapshot = useSyncExternalStore(clipa.subscribe, clipa.getSnapshot, clipa.getSnapshot);
  const view = readClipaView(snapshot);
  const guidePhase = view.guide?.phase ?? null;
  const stages = useMemo(() => railStages(state, stageOfPhase(guidePhase)), [state, guidePhase]);
  const caption = railCaption(view.bubble, view.guide?.text ?? null, state.mode);

  const pick = (m: Mode): void => controller.setMode(m);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, current: Mode): void => {
    const next = stageForKey(e.key, current);
    if (next === null) return;
    e.preventDefault();
    controller.setMode(next);
    document.getElementById(`as-tab-${next}`)?.focus();
  };

  return (
    <nav className="as-rail" aria-label="Journey">
      <div className="as-rail__track" role="tablist" aria-label="Journey stages" aria-orientation="horizontal">
        {stages.map((stage) => <Stage key={stage.mode} stage={stage} onPick={pick} onKey={onKey} />)}
      </div>
      <p className="as-rail__caption" data-clipa-state={view.state}>
        <span className="as-rail__who" role="status">
          <span className="as-rail__dot" aria-hidden="true" />
          Clipa <span className="as-rail__state">{CLIPA_STATE_WORDS[view.state]}</span>
        </span>
        {/* The bubble above the page shows what Clipa says, once; this is its accessible copy, for screen readers only. */}
        <span className="as-rail__line as-sr" data-testid="clipa-line">{caption}</span>
      </p>
    </nav>
  );
}
