import './status-pill.css';
import { useShellState } from '../hooks.ts';

/**
 * The one status the page keeps in view: a compact "Recording" pill while a session records, and "Off the record" while the
 * person is off the record (honesty stays visible). Nothing else: the screen, voice, session and record chips are in the Debug
 * drawer (StatusChips), and the session card says what recording means.
 */
export function StatusBar() {
  const offRecord = useShellState((s) => s.offRecord);
  const recording = useShellState((s) => s.phase === 'live');
  if (offRecord) {
    return (
      <p className="as-pill as-pill--off" role="status" data-testid="status-pill" data-state="off">
        <span className="as-pill__dot" aria-hidden="true" />Off the record
      </p>
    );
  }
  if (!recording) return null;
  return (
    <p className="as-pill as-pill--rec" role="status" data-testid="status-pill" data-state="recording">
      <span className="as-pill__dot" aria-hidden="true" />Recording
    </p>
  );
}
