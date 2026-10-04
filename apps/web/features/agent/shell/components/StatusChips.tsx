import './status-pill.css';
import { useNow, useShellState } from '../hooks.ts';
import { statusChips } from '../state/derive.ts';

/** Four chips: screen, voice, session, record. Each says its state in words; colour only adds to it. They live in the Debug drawer. */
export function StatusChips() {
  const state = useShellState((s) => s);
  const now = useNow(1000, state.phase === 'live');
  const chips = statusChips(state, now);
  return (
    <ul className="as-status as-status--debug" aria-label="Status" data-testid="status-chips">
      {chips.map((chip) => (
        <li key={chip.label} className={`as-chip as-chip--${chip.tone}`}>
          <span className="as-chip__dot" aria-hidden="true" />
          <span className="as-chip__label">{chip.label}</span>
          <span className="as-chip__value">{chip.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The Debug drawer's Status tab: the chips, and what each one means. They are here, not on the page: the page keeps only the recording pill. */
export function StatusPanel() {
  return (
    <div data-testid="status-panel">
      <StatusChips />
      <p className="as-note">
        Screen: whether a window is shared and where it is read. Voice: the microphone and the agent. Session: the running stage and its
        time left. Record: whether Clipa is recording or off the record.
      </p>
    </div>
  );
}
