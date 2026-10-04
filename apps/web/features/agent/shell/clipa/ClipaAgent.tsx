import { useSyncExternalStore } from 'react';
import { useShell } from '../hooks.ts';

const LABELS = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  warning: 'Warning',
  happy: 'Happy',
  pointing: 'Pointing',
  off: 'Off the record',
} as const;

/**
 * The text side of Clipa: her state and the current question, as an accessible copy of her speech bubble. Clipa herself is the
 * motion director's character (apps/web/features/agent/clipa): she rests in the bottom-right corner of the page, flies beside the
 * element she asks about, flies to Send for a warning, and never starts moving while the person types.
 */
export function ClipaAgent() {
  const { clipa } = useShell();
  const { state, bubble } = useSyncExternalStore(clipa.subscribe, clipa.getSnapshot, clipa.getSnapshot);
  return (
    <div className="as-clipa" data-state={state}>
      <div className="as-clipa__side">
        <p className="as-clipa__state" role="status">
          <span className="as-clipa__label">Clipa</span> {LABELS[state]}
        </p>
        <p className="as-note">She waits in the bottom-right corner, flies to what she asks about and does not move while you type.</p>
        {bubble !== '' && (
          <p className="as-bubble" role="status" aria-live="polite" data-testid="clipa-bubble">{bubble}</p>
        )}
      </div>
    </div>
  );
}
