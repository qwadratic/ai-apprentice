import { useState } from 'react';
import type { Ref } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { JourneyRail } from '../journey/JourneyRail.tsx';
import { ClipaLogo } from './ClipaLogo.tsx';
import { ToneMenu } from './ToneMenu.tsx';

/** The latest macOS build, published by macos-build.yml on every push to main under one fixed release tag. */
export const MAC_DOWNLOAD_URL = 'https://github.com/qwadratic/clipa/releases/download/clipa-macos-latest/Clipa-macos.zip';

/** The Vite base path (`/clipa/` on Pages). Node tests render this file without import.meta.env, hence the fallback. */
const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';
/** The submission videos, served from apps/web/public/videos. */
export const DEMO_VIDEO_URL = `${BASE_URL}videos/clipa-demo.mp4`;
export const TECH_VIDEO_URL = `${BASE_URL}videos/clipa-tech.mp4`;

interface HeaderProps {
  debugOpen: boolean;
  onToggleDebug: () => void;
  /** The header element, so the shell can keep its sticky columns below it. */
  headerRef?: Ref<HTMLElement>;
}

/** The header: the Clipa wordmark, the journey rail (the mode switcher), the macOS download, the two videos, the microphone, Clipa's tone and Debug. */
export function Header({ debugOpen, onToggleDebug, headerRef }: HeaderProps) {
  const { controller } = useShell();
  const offRecord = useShellState((s) => s.offRecord);
  const [micMuted, setMicMuted] = useState(() => controller.isMicMuted());

  return (
    <header className="as-header" ref={headerRef} data-off-record={offRecord ? 'true' : undefined}>
      <div className="as-brand">
        <ClipaLogo height={64} />
        <span className="as-sr">Learns your judgment, then teaches it</span>
      </div>

      <JourneyRail />

      <div className="as-header__tools">
        <a className="as-btn as-btn--link" href={MAC_DOWNLOAD_URL} title="Clipa for macOS: unzip, then xattr -dr com.apple.quarantine Clipa.app">
          macOS app
        </a>
        <a className="as-btn as-btn--link" href={DEMO_VIDEO_URL} target="_blank" rel="noopener noreferrer">
          Demo video
        </a>
        <a className="as-btn as-btn--link" href={TECH_VIDEO_URL} target="_blank" rel="noopener noreferrer">
          Tech video
        </a>
        {offRecord ? (
          <button type="button" className="as-btn as-btn--off is-on" aria-pressed onClick={() => controller.backOnRecord()}>
            Back on record
          </button>
        ) : (
          <button
            type="button"
            className={`as-btn as-btn--mic${micMuted ? ' is-on' : ''}`}
            aria-pressed={micMuted}
            title={micMuted ? 'Clipa does not hear you. The screen and the session go on.' : 'Turn the microphone off; the screen and the session go on.'}
            onClick={() => { const next = !micMuted; controller.setMicMuted(next); setMicMuted(next); }}
          >
            {micMuted ? 'Unmute mic' : 'Mic off'}
          </button>
        )}
        <ToneMenu />
        <button type="button" className="as-btn" aria-expanded={debugOpen} aria-controls="as-debug" onClick={onToggleDebug}>
          Debug
        </button>
      </div>
    </header>
  );
}
