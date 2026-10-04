import { useState } from 'react';
import type { Ref } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { JourneyRail } from '../journey/JourneyRail.tsx';
import { ClipaLogo } from './ClipaLogo.tsx';
import { ToneMenu } from './ToneMenu.tsx';

/** The latest macOS build, published by macos-build.yml on every push to main under one fixed release tag. */
export const MAC_DOWNLOAD_URL = 'https://github.com/qwadratic/clipa/releases/download/clipa-macos-latest/Clipa.dmg';

/** The Vite base path (`/clipa/` on Pages). Node tests render this file without import.meta.env, hence the fallback. */
const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';
/** The submission videos, served from apps/web/public/videos. */
/** The product demo: the story of the three stages on the customer_07 case (about a minute, synthetic data, AI voice). */
export const DEMO_VIDEO_URL = `${BASE_URL}videos/clipa-story.mp4`;
export const TECH_VIDEO_URL = `${BASE_URL}videos/clipa-tech.mp4`;

interface HeaderProps {
  debugOpen: boolean;
  onToggleDebug: () => void;
  /** The header element, so the shell can keep its sticky columns below it. */
  headerRef?: Ref<HTMLElement>;
}

/** The header: the Clipa wordmark, the videos and the macOS download, the journey rail (the mode switcher), then Clipa's controls: the microphone, her tone and Debug. */
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

      {/* Things to watch and download, apart from the controls that steer Clipa. */}
      <nav className="as-header__links" aria-label="Videos and downloads">
        <a className="as-hlink" href={DEMO_VIDEO_URL} target="_blank" rel="noopener noreferrer" title="The product in about a minute">
          <span aria-hidden="true">▶</span> Demo video
        </a>
        <a className="as-hlink" href={TECH_VIDEO_URL} target="_blank" rel="noopener noreferrer" title="How it is built, with the live product running, in about a minute">
          <span aria-hidden="true">▶</span> Tech video
        </a>
        <a className="as-hlink" href={MAC_DOWNLOAD_URL} title="Clipa for macOS: open the disk image and drag Clipa to Applications. Not notarized: on the first launch, System Settings > Privacy & Security > Open Anyway.">
          <span aria-hidden="true">↓</span> macOS app
        </a>
      </nav>

      <JourneyRail />

      {/* Clipa's controls. */}
      <div className="as-header__tools">
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
