import type { KeyboardEvent } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { ClipaLogo } from './ClipaLogo.tsx';
import { MODES, MODE_LABELS, PERSONAS, PERSONA_INFO } from '../state/types.ts';
import type { Mode, Persona } from '../state/types.ts';

export function Header({ debugOpen, onToggleDebug }: { debugOpen: boolean; onToggleDebug: () => void }) {
  const { controller } = useShell();
  const mode = useShellState((s) => s.mode);
  const persona = useShellState((s) => s.persona);
  const offRecord = useShellState((s) => s.offRecord);
  const sessionMode = useShellState((s) => (s.phase === 'live' || s.phase === 'starting' ? s.session?.mode ?? null : null));

  const move = (e: KeyboardEvent<HTMLButtonElement>, current: Mode): void => {
    const i = MODES.indexOf(current);
    const next = e.key === 'ArrowRight' ? MODES[(i + 1) % MODES.length] : e.key === 'ArrowLeft' ? MODES[(i + MODES.length - 1) % MODES.length] : undefined;
    if (!next) return;
    e.preventDefault();
    controller.setMode(next);
    document.getElementById(`as-tab-${next}`)?.focus();
  };

  return (
    <header className="as-header">
      <div className="as-brand">
        <ClipaLogo />
        <span className="as-brand__sub">Learns your judgment, then teaches it</span>
      </div>

      <div className="as-tabs" role="tablist" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m}
            id={`as-tab-${m}`}
            type="button"
            role="tab"
            className="as-tab"
            aria-selected={mode === m}
            aria-controls={`as-mode-panel-${m}`}
            tabIndex={mode === m ? 0 : -1}
            onClick={() => controller.setMode(m)}
            onKeyDown={(e) => move(e, m)}
          >
            {MODE_LABELS[m]}
            {sessionMode === m && <span className="as-tab__live" title="A session is running in this mode"> ●</span>}
          </button>
        ))}
      </div>

      <div className="as-header__tools">
        <label className="as-field as-field--inline">
          <span className="as-field__label">Tone</span>
          <select
            className="as-select"
            value={persona}
            title={PERSONA_INFO[persona].hint}
            onChange={(e) => controller.setPersona(e.target.value as Persona)}
          >
            {PERSONAS.map((p) => <option key={p} value={p}>{PERSONA_INFO[p].label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className={`as-btn as-btn--off${offRecord ? ' is-on' : ''}`}
          aria-pressed={offRecord}
          onClick={() => { if (offRecord) controller.backOnRecord(); else void controller.goOffRecord(); }}
        >
          {offRecord ? 'Back on record' : 'Off the record'}
        </button>
        <button type="button" className="as-btn" aria-expanded={debugOpen} aria-controls="as-debug" onClick={onToggleDebug}>
          Debug
        </button>
      </div>
    </header>
  );
}
