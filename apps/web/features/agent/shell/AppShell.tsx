import { useEffect, useState, type ReactNode } from 'react';
import './shell.css';
import { Banner } from './components/Banner.tsx';
import { DebugDrawer } from './components/DebugDrawer.tsx';
import { Header } from './components/Header.tsx';
import { SessionControls } from './components/SessionControls.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ClipaAgent } from './clipa/ClipaAgent.tsx';
import { ShellContext, useShellState } from './hooks.ts';
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
    <section className="as-card as-mode" aria-label="Mode">
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

/** The main area carries the mode, so each mode gets its own layout (shell.css) while every slot stays mounted. */
function ModeLayout({ children }: { children: ReactNode }) {
  const mode = useShellState((s) => s.mode);
  return <main className="as-main" data-mode={mode}>{children}</main>;
}

/** The product page: mode switcher, status bar, workspace area on the left, Clipa and the mode view on the right. */
export function AppShell() {
  const [runtime] = useState(createRuntime);
  const [debugOpen, setDebugOpen] = useState(false);
  const [screenCollapsed, setScreenCollapsed] = useState(false);

  useEffect(() => {
    const { controller } = runtime;
    document.title = 'AI Apprentice';
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
      <div className="apprentice-shell">
        <Header debugOpen={debugOpen} onToggleDebug={() => setDebugOpen((v) => !v)} />
        <StatusBar />
        <Banner />
        <ModeLayout>
          <div className="as-left">
            <ScreenSlot collapsed={screenCollapsed} onToggle={() => setScreenCollapsed((v) => !v)} />
            <WorkspaceSlot adapter={runtime.workspace} />
          </div>
          <div className="as-right">
            <section className="as-card as-clipa-card" aria-label="Clipa">
              <ClipaAgent />
            </section>
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
