import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config.ts';
import { useShellState } from '../hooks.ts';
import { formatClock } from '../session-clock.ts';
import { summarizeLatency } from '../state/derive.ts';

type Tab = 'decisions' | 'events' | 'session';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'decisions', label: 'Decision log' },
  { id: 'events', label: 'Event log' },
  { id: 'session', label: 'Session' },
];

const timeOf = (t: number): string => {
  const d = new Date(t);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

function DecisionLog() {
  const decisions = useShellState((s) => s.decisions);
  const brain = useShellState((s) => s.brain);
  const latency = summarizeLatency(decisions);
  return (
    <div>
      <p className="as-note" data-testid="latency-summary">
        Observation to audio latency:{' '}
        {latency.count === 0
          ? 'no measurement yet (it needs a spoken question)'
          : `last ${latency.lastMs} ms · median ${latency.medianMs} ms · ${latency.count} measured`}
        . Brain: {brain.name}{brain.wired ? '' : ' (no policy)'}.
      </p>
      {decisions.length === 0 ? (
        <p className="as-empty">No decisions yet. Each one is logged with its reason, also when nothing is asked.</p>
      ) : (
        <ol className="as-decisions" data-testid="decision-log">
          {decisions.map((d) => (
            <li key={d.id} className="as-decision">
              <span className="as-obs__time">{formatClock(d.atMs)}</span>
              <span className={`as-tag as-tag--${d.decision === 'SKIP' ? 'muted' : d.spoken ? 'accent' : 'warn'}`}>{d.decision}</span>
              <span className="as-decision__topic">{d.topic}</span>
              <span className="as-decision__why">{d.whyNow}{d.note ? ` (${d.note})` : ''}</span>
              {d.text && <span className="as-decision__text">&ldquo;{d.text}&rdquo;</span>}
              {d.spoken && <span className="as-decision__latency">{d.latencyMs === null ? 'latency: waiting' : `${d.latencyMs} ms to audio`}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EventLog() {
  const events = useShellState((s) => s.events);
  const endRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [events.length]);
  return events.length === 0 ? (
    <p className="as-empty">No events yet.</p>
  ) : (
    <ol className="as-events" data-testid="event-log" aria-live="off">
      {events.map((e) => (
        <li key={e.id} className={`as-event as-event--${e.dir}`}>
          <time className="as-obs__time">{timeOf(e.t)}</time>
          <span className="as-tag as-tag--muted">{e.type}</span>
          <span className="as-event__text">{e.text}</span>
        </li>
      ))}
      <li ref={endRef} aria-hidden="true" className="as-event__end" />
    </ol>
  );
}

function SessionInfo() {
  const session = useShellState((s) => s.session);
  const brain = useShellState((s) => s.brain);
  const persona = useShellState((s) => s.persona);
  const capture = useShellState((s) => s.screen.capture);
  const phase = useShellState((s) => s.phase);
  const rows: Array<[string, string]> = [
    ['phase', phase],
    ['API base', API_BASE === '' ? 'same origin (dev proxy)' : API_BASE],
    ['session id', session?.id ?? 'none'],
    ['mode', session?.mode ?? 'none'],
    ['epoch (browser Date.now at the click)', session ? `${session.epochMs} (${new Date(session.epochMs).toISOString()})` : 'none'],
    ['auto-ends at', session ? new Date(session.deadlineMs).toISOString() : 'none'],
    ['routes', session ? (session.legacyRoutes ? 'legacy placeholder (no token), temporary' : '/api/agent with a session token') : 'none'],
    ['clock skew vs server', session?.clockSkewMs === null || !session ? 'unknown' : `${session.clockSkewMs} ms`],
    ['conversation id', session?.conversationId ?? 'none'],
    ['brain', `${brain.name}${brain.wired ? '' : ' (not wired)'}`],
    ['persona', persona],
    ['local capture', `${capture.state}${capture.reason ? ` (${capture.reason})` : ''}`],
  ];
  return (
    <dl className="as-props as-props--wide" data-testid="session-info">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function DebugDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('decisions');
  if (!open) return null;
  return (
    <aside className="as-drawer" id="as-debug" aria-label="Debug drawer" data-testid="debug-drawer">
      <div className="as-drawer__head">
        <div className="as-drawer__tabs" role="tablist" aria-label="Debug sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`as-dbg-tab-${t.id}`}
              className="as-tab as-tab--small"
              aria-selected={tab === t.id}
              aria-controls={`as-dbg-panel-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="as-btn as-btn--small" onClick={onClose}>Close</button>
      </div>
      <div className="as-drawer__body" role="tabpanel" id={`as-dbg-panel-${tab}`} aria-labelledby={`as-dbg-tab-${tab}`}>
        {tab === 'decisions' && <DecisionLog />}
        {tab === 'events' && <EventLog />}
        {tab === 'session' && <SessionInfo />}
      </div>
    </aside>
  );
}
