import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import './shell.css';
import { Banner } from './components/Banner.tsx';
import { DebugDrawer } from './components/DebugDrawer.tsx';
import { Header } from './components/Header.tsx';
import { SessionControls } from './components/SessionControls.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { setClipaFavicon } from './components/ClipaLogo.tsx';
import { ShellContext, useShellState } from './hooks.ts';
import { STAGES } from './journey/rail.ts';
import { watchReflectSelection } from './journey/reflect-pointing.ts';
import { requestClipaPoint } from './clipa/director-presenter.ts';
import { createRuntime } from './runtime.ts';
import { ReplaySlot } from './slots/ReplaySlot.tsx';
import { ScreenSlot } from './slots/ScreenSlot.tsx';
import { WorkspaceSlot } from './slots/WorkspaceSlot.tsx';
import { MODES } from './state/types.ts';
import { LearnView } from './views/LearnView.tsx';
import { ReviewView } from './views/ReviewView.tsx';
import { TeachView } from './views/TeachView.tsx';

const VIEWS = { learn: LearnView, review: ReviewView, teach: TeachView } as const;

function ModePanels() {
  const mode = useShellState((s) => s.mode);
  // All three views stay mounted and only the current one is shown: what is typed into one survives a switch.
  return (
    <section className="as-card as-mode" aria-label={STAGES[mode].name}>
      {MODES.map((m) => {
        const View = VIEWS[m];
        return (
          <div key={m} role="tabpanel" id={`as-mode-panel-${m}`} aria-labelledby={`as-tab-${m}`} hidden={mode !== m} className="as-mode__panel">
            <View />
          </div>
        );
      })}
    </section>
  );
}

/**
 * The stage canvas. It carries the mode, so each stage shapes the canvas around its main object (shell.css): Show puts the shared
 * screen first and large, Reflect gives the Work Map the width, Pass it on puts the new hire's case and the screen first with the
 * tutor's warnings beside them. Every slot stays mounted in every stage: only the layout changes.
 */
function ModeLayout({ children }: { children: ReactNode }) {
  const mode = useShellState((s) => s.mode);
  return <main className="as-main" data-mode={mode} data-stage={STAGES[mode].name}>{children}</main>;
}

/** Keeps --as-header-h on the shell at the header's height, so the sticky side column starts below it. */
function useHeaderHeight(shell: RefObject<HTMLDivElement | null>, header: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = shell.current;
    const el = header.current;
    if (!root || !el || typeof ResizeObserver === 'undefined') return undefined;
    const update = (): void => root.style.setProperty('--as-header-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shell, header]);
}

/**
 * The product page: the header with the journey rail, the status bar, and the stage canvas (workspace area and the stage's own
 * column). Clipa is not a card here: the motion director (runtime.ts) keeps her in one layer above the whole page, resting on the
 * rail at the stage on screen and flying out to what she talks about.
 */
export function AppShell() {
  const [runtime] = useState(createRuntime);
  const [debugOpen, setDebugOpen] = useState(false);
  const [screenCollapsed, setScreenCollapsed] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useHeaderHeight(shellRef, headerRef);

  // Reflect: a click on a map item brings Clipa beside it (the presenter answers the clipa:point request).
  useEffect(() => {
    const root = shellRef.current;
    if (!root) return undefined;
    return watchReflectSelection(root, (target) => { requestClipaPoint(target); });
  }, []);

  useEffect(() => {
    const { controller } = runtime;
    document.title = 'Clipa';
    setClipaFavicon();
    const onVisibility = (): void => controller.onVisibilityChange(document.hidden);
    const onPageHide = (): void => controller.onPageHide();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      controller.dispose();
      runtime.dispose();
    };
  }, [runtime]);

  return (
    <ShellContext.Provider value={runtime}>
      <div className="apprentice-shell" ref={shellRef}>
        <Header debugOpen={debugOpen} onToggleDebug={() => setDebugOpen((v) => !v)} headerRef={headerRef} />
        <StatusBar />
        <Banner />
        <ModeLayout>
          <div className="as-left">
            <ScreenSlot collapsed={screenCollapsed} onToggle={() => setScreenCollapsed((v) => !v)} />
            <WorkspaceSlot adapter={runtime.workspace} />
          </div>
          <div className="as-right">
            <SessionControls />
            <ModePanels />
            <ReplaySlot />
          </div>
        </ModeLayout>
        <DebugDrawer open={debugOpen} onClose={() => setDebugOpen(false)} />
      </div>
    </ShellContext.Provider>
  );
}
