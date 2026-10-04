import { NotWired, StepCards } from '../components/Parts.tsx';
import { useConductorLeads } from '../conductor/hooks.ts';
import { ClipaNow } from '../feed/ClipaNow.tsx';
import { LiveFeed } from '../feed/LiveFeed.tsx';
import { useShellState } from '../hooks.ts';

/**
 * Show: the shared screen is the hero (left); this column holds Clipa's current line and the live feed of what she sees and
 * hears. The full lists (every screen event, every line with how it ended) are in the Debug drawer.
 */
export function LearnView() {
  const brain = useShellState((s) => s.brain);
  const map = useShellState((s) => s.draftMap);
  const running = useShellState((s) => s.phase === 'live' && s.session?.mode === 'learn');
  const waitingWhy = useShellState((s) => [...s.decisions].reverse().find((d) => d.topic === 'waiting')?.whyNow ?? null);
  const leads = useConductorLeads();

  const idle = running
    ? (leads || waitingWhy === null ? 'Work as usual. I ask only at a natural pause, never while you type or talk.' : waitingWhy)
    : 'Press Start Show, share your screen and do the task while you talk.';

  return (
    <div className="as-view" data-testid="view-learn">
      <ClipaNow idle={idle} />
      {!leads && !brain.wired && (
        <NotWired>the question policy ({brain.name}): Clipa asks nothing and the map stays empty. Voice and screen are real.</NotWired>
      )}
      <LiveFeed empty={running ? 'Watching. Screen changes, questions and your answers appear here.' : 'Nothing yet: start Show and share your screen.'} />
      {!leads && map.steps.length > 0 && (
        <details className="as-fold">
          <summary className="as-fold__summary">Draft map <span className="as-count">{map.steps.length} steps</span></summary>
          <StepCards map={map} />
        </details>
      )}
    </div>
  );
}
