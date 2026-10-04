import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config.ts';
import { ConductorSaid } from '../conductor/ConductorLine.tsx';
import { useConductor } from '../conductor/hooks.ts';
import { useShellState } from '../hooks.ts';
import { formatClock } from '../session-clock.ts';
import { summarizeLatency } from '../state/derive.ts';
import { EvidenceLinks } from './Parts.tsx';
import { StatusPanel } from './StatusChips.tsx';

type Tab = 'status' | 'clipa' | 'screen' | 'decisions' | 'events' | 'session';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'status', label: 'Status' },
  { id: 'clipa', label: 'Clipa lines' },
  { id: 'screen', label: 'Screen events' },
  { id: 'decisions', label: 'Decision log' },
  { id: 'events', label: 'Event log' },
  { id: 'session', label: 'Session' },
];

/** Every screen observation of this page with its kind and evidence (the live feed shows only the newest few). */
function ScreenEvents() {
  const observations = useShellState((s) => s.observations);
  const synthetic = useShellState((s) => s.screen.source?.synthetic ?? false) || observations.some((o) => o.synthetic);
  return (
    <div>
      {synthetic && <p className="as-notwired as-notwired--synthetic" role="note"><strong>Synthetic:</strong> these events are invented sample data, not your screen.</p>}
      {observations.length === 0 ? (
        <p className="as-empty">No screen events yet.</p>
      ) : (
        <ol className="as-obs" aria-label="Observed moments" data-testid="screen-events">
          {observations.map((o) => (
            <li key={o.id} className={`as-obs__row${o.source === 'workspace' ? ' is-heartbeat' : ''}`}>
              <span className="as-obs__time">{formatClock(o.timestampMs)}</span>
              <span className="as-tag as-tag--muted">{o.kind}</span>
              <span className="as-obs__summary">{o.summary}</span>
              <EvidenceLinks ids={o.evidenceIds} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The conductor: connection, the last reason to stay quiet, the map version, and every line with how it ended. */
function ClipaLines() {
  const enabled = useConductor((s) => s.enabled);
  const status = useConductor((s) => s.status);
  const detail = useConductor((s) => s.statusDetail);
  const quiet = useConductor((s) => s.quiet);
  const map = useConductor((s) => s.map);
  const teachBack = useConductor((s) => s.teachBack);
  const rows: Array<[string, string]> = [
    ['conductor', enabled ? `${status}${detail ? ` (${detail})` : ''}` : 'off (the in-browser brain leads)'],
    ['last quiet reason', quiet ?? 'none'],
    ['map', map === null ? 'none' : `version ${map.version}${map.confirmed ? ', confirmed' : ', not confirmed'}`],
    ['teach-back', teachBack === null ? 'none' : `version ${teachBack.version}`],
  ];
  return (
    <div>
      <dl className="as-props" data-testid="conductor-info">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <ConductorSaid title="Lines" />
    </div>
  );
}

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
  const draft = useShellState((s) => s.draftMap);
  const digest = useShellState((s) => s.review.teachBack.digest);
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
    ['draft map', draft.version === undefined ? `${draft.steps.length} steps` : `version ${draft.version}${draft.confirmed ? ', confirmed' : ''}, ${draft.steps.length} steps`],
    ['teach-back fingerprint', digest ?? 'none'],
  ];
  return (
    <dl className="as-props as-props--wide" data-testid="session-info">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function DebugDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('status');
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
        {tab === 'status' && <StatusPanel />}
        {tab === 'clipa' && <ClipaLines />}
        {tab === 'screen' && <ScreenEvents />}
        {tab === 'decisions' && <DecisionLog />}
        {tab === 'events' && <EventLog />}
        {tab === 'session' && <SessionInfo />}
      </div>
    </aside>
  );
}
