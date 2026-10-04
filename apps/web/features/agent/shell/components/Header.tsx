import type { Ref } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { JourneyRail } from '../journey/JourneyRail.tsx';
import { ClipaLogo } from './ClipaLogo.tsx';
import { ToneMenu } from './ToneMenu.tsx';

interface HeaderProps {
  debugOpen: boolean;
  onToggleDebug: () => void;
  /** The header element, so the shell can keep its sticky columns below it. */
  headerRef?: Ref<HTMLElement>;
}

/** The header: the Clipa wordmark, the journey rail (the mode switcher), Off the record, Clipa's tone and Debug. */
export function Header({ debugOpen, onToggleDebug, headerRef }: HeaderProps) {
  const { controller } = useShell();
  const offRecord = useShellState((s) => s.offRecord);

  return (
    <header className="as-header" ref={headerRef} data-off-record={offRecord ? 'true' : undefined}>
      <div className="as-brand">
        <ClipaLogo height={64} />
        <span className="as-sr">Learns your judgment, then teaches it</span>
      </div>

      <JourneyRail />

      <div className="as-header__tools">
        <button
          type="button"
          className={`as-btn as-btn--off${offRecord ? ' is-on' : ''}`}
          aria-pressed={offRecord}
          onClick={() => { if (offRecord) controller.backOnRecord(); else void controller.goOffRecord(); }}
        >
          {offRecord ? 'Back on record' : 'Off the record'}
        </button>
        <ToneMenu />
        <button type="button" className="as-btn" aria-expanded={debugOpen} aria-controls="as-debug" onClick={onToggleDebug}>
          Debug
        </button>
      </div>
    </header>
  );
}
