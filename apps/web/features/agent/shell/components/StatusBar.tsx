import { useNow, useShellState } from '../hooks.ts';
import { statusChips } from '../state/derive.ts';

/** Four chips: screen, voice, session, off-record. Each says its state in words; colour only adds to it. */
export function StatusBar() {
  const state = useShellState((s) => s);
  const now = useNow(1000, state.phase === 'live');
  const chips = statusChips(state, now);
  return (
    <ul className="as-status" aria-label="Status">
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
