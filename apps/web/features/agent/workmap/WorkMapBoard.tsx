// The Review briefing board: the session as a storyboard. Keyframes (what changed on screen, what the vision step saw), step
// cards with the expert's words, guardrails, and the open gaps that invite a click. The board never confirms anything itself:
// Review owns confirm and correct, the board only exposes onConfirmRequest. Clicking a card calls onSeek with its screen moment
// and, until the replay panel lands, shows the still frame inline.
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ScreenEvidence, ScreenObservation } from '@apprentice/contracts';
import {
  buildStoryboard,
  cardKey,
  formatClock,
} from './model.ts';
import type {
  BoardBlocker,
  BoardCard,
  GapCard,
  GuardrailCard,
  Keyframe,
  Moment,
  Question,
  ResolveEvidence,
  ResolvedEvidence,
  StepCard,
  Storyboard,
  WorkMap,
} from './model.ts';
import './board.css';

export interface WorkMapBoardProps {
  map: WorkMap;
  /** The session's screen observations (ScreenBridge v1), any order; heartbeats are ignored. */
  observations: readonly ScreenObservation[];
  /** Evidence records for the session, for frame times and kinds. */
  evidence?: readonly ScreenEvidence[];
  /** Open follow-ups from reviewStatus(state).openFollowUps. */
  gaps?: readonly Question[];
  /** reviewStatus(state).blockers; the board also derives the evidence-and-quote rule itself. */
  blockers?: readonly BoardBlocker[];
  /** A's bridge.resolveEvidence adapted to a URL or blob of the processed, masked frame. */
  resolveEvidence?: ResolveEvidence;
  /** Seek the replay panel to a screen moment. */
  onSeek?: (evidenceId: string, startMs: number, endMs: number) => void;
  /** Review's confirm flow for one item; the board disables it while the validator blocks the item. */
  onConfirmRequest?: (item: { kind: 'step' | 'guardrail'; id: string }) => void;
  /** The expert clicked an open gap: Review can ask it now. */
  onGapSelect?: (gap: Question) => void;
  /** The expert selected a card (a step, a guardrail or a gap): Review can talk about it (the conductor's `ui ask_about`). */
  onCardSelect?: (card: { kind: 'step' | 'guardrail' | 'gap'; id: string }) => void;
  /** Label the whole board as synthetic (sample or simulated session). */
  synthetic?: boolean;
  title?: string;
  /** Show the selected moment's still frame on the board (the placeholder seek). Default true. */
  inlineMoment?: boolean;
  /** Pre-select a card or a frame by key: "step:step-4", "guardrail:g1", "gap:q-R-1" or "frame:obs-005". */
  initialSelection?: string | null;
  /** The map's business processes (fromGenericMap): with two or more, steps and guardrails are grouped under their titles. */
  processes?: readonly BoardProcess[];
}

/** A business process of the map: its title and the ids of its steps and rules. */
export interface BoardProcess { id: string; title: string; stepIds: readonly string[]; guardrailIds: readonly string[] }

/**
 * Cards grouped under the map's processes, in the processes' order; a card no process names goes under the first. Null with
 * fewer than two processes: the board then renders one plain list, exactly as before processes existed.
 */
function byProcess<T extends { id: string }>(
  cards: readonly T[],
  processes: readonly BoardProcess[] | undefined,
  idsOf: (p: BoardProcess) => readonly string[],
): Array<{ id: string; title: string; cards: T[] }> | null {
  if (processes === undefined || processes.length < 2) return null;
  const groups = processes.map((p) => ({ id: p.id, title: p.title, ids: idsOf(p), cards: [] as T[] }));
  for (const c of cards) (groups.find((g) => g.ids.includes(c.id)) ?? groups[0])?.cards.push(c);
  return groups.filter((g) => g.cards.length > 0).map((g) => ({ id: g.id, title: g.title, cards: g.cards }));
}

function ProcessGroup(props: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="wm-process" data-process={props.id}>
      <h4 className="wm-process__title">{props.title}</h4>
      <ol className="wm-cards">{props.children}</ol>
    </div>
  );
}

type MediaState = { state: 'loading' } | { state: 'ready'; url: string; synthetic: boolean } | { state: 'missing' };

/** Resolves every evidence id once, turning blobs into object URLs (revoked on unmount). */
function useEvidenceMedia(ids: readonly string[], resolve: ResolveEvidence | undefined): Record<string, MediaState> {
  const [media, setMedia] = useState<Record<string, MediaState>>({});
  const key = ids.join('|');
  useEffect(() => {
    if (resolve === undefined) return;
    let alive = true;
    const created: string[] = [];
    for (const id of ids) {
      setMedia((m) => (m[id] ? m : { ...m, [id]: { state: 'loading' } }));
      resolve(id)
        .then((r: ResolvedEvidence | null) => {
          if (!alive) return;
          let url = r?.url ?? null;
          if (url === null && r?.blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            url = URL.createObjectURL(r.blob);
            created.push(url);
          }
          setMedia((m) => ({ ...m, [id]: url === null ? { state: 'missing' } : { state: 'ready', url, synthetic: r?.synthetic === true } }));
        })
        .catch(() => {
          if (alive) setMedia((m) => ({ ...m, [id]: { state: 'missing' } }));
        });
    }
    return () => {
      alive = false;
      for (const url of created) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolve]);
  return media;
}

function Thumb(props: { media: MediaState | undefined; alt: string; time?: string | null; index?: number | null; large?: boolean }): ReactNode {
  const { media } = props;
  return (
    <div className={`wm-thumb${props.large ? ' wm-thumb--large' : ''}`}>
      {media?.state === 'ready' ? (
        <img className="wm-thumb__img" src={media.url} alt={props.alt} loading="lazy" />
      ) : (
        <div className="wm-thumb__empty" role="img" aria-label={`${props.alt} (frame unavailable)`}>
          <span>{media?.state === 'loading' ? 'Loading frame…' : 'Frame unavailable'}</span>
        </div>
      )}
      {props.index != null && <span className="wm-thumb__index">#{props.index}</span>}
      {props.time && <span className="wm-thumb__time">{props.time}</span>}
      {media?.state === 'ready' && media.synthetic && <span className="wm-tag wm-tag--synthetic wm-thumb__synthetic">synthetic</span>}
    </div>
  );
}

function frameLabel(f: Keyframe): string {
  return `Frame #${f.index} · ${f.changes[0]?.label ?? f.surfaceLabel}`;
}

function momentLabel(c: BoardCard): string {
  if (c.kind === 'step') return `Step ${c.number} · ${c.action}`;
  if (c.kind === 'gap') return `Open gap · ${c.question}`;
  return `${c.id.toUpperCase()} · ${c.condition}`;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  draft: 'Draft',
  provisional: 'Provisional',
  confirmed: 'Confirmed',
  conflicted: 'Conflicted',
};

function StatusPill(props: { status: string; note: string }): ReactNode {
  return (
    <span className={`wm-status wm-status--${props.status}`} title={props.note}>
      {STATUS_LABEL[props.status] ?? props.status}
    </span>
  );
}

function clickable(onActivate: () => void) {
  return {
    tabIndex: 0,
    onClick: (e: { target: EventTarget | null }) => {
      const el = e.target as HTMLElement | null;
      if (el && typeof el.closest === 'function' && el.closest('button, summary, a, details')) return;
      onActivate();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

function Fields(props: { fields: StepCard['requiredFields'] }): ReactNode {
  if (props.fields.length === 0) return null;
  return (
    <span className="wm-chips">
      {props.fields.map((f) => (
        <span key={f.label} className={`wm-chip${f.assumed ? ' wm-chip--assumed' : ''}`}>
          {f.label}
          {f.assumed && <em> (assumed from the screen)</em>}
        </span>
      ))}
    </span>
  );
}

function Quote(props: { quote: string | null; atMs: number | null }): ReactNode {
  if (props.quote === null) return null;
  return (
    <blockquote className="wm-quote">
      <p>“{props.quote}”</p>
      <cite>Expert{props.atMs !== null ? ` · ${formatClock(props.atMs)}` : ''}</cite>
    </blockquote>
  );
}

function FrameLinks(props: { frameIds: readonly string[]; frames: ReadonlyMap<string, Keyframe> }): ReactNode {
  if (props.frameIds.length === 0) return <span className="wm-frames-none">No screen moment</span>;
  return (
    <span className="wm-framelinks">
      {props.frameIds.map((id) => {
        const f = props.frames.get(id);
        return f ? (
          <span key={id} className="wm-framelink">
            #{f.index} · {formatClock(f.atMs)}
          </span>
        ) : null;
      })}
    </span>
  );
}

function ConfirmHook(props: {
  card: StepCard | GuardrailCard;
  onConfirmRequest: WorkMapBoardProps['onConfirmRequest'];
}): ReactNode {
  const { card } = props;
  const showBlocker = card.blocker !== null;
  if (!showBlocker && (props.onConfirmRequest === undefined || card.status === 'confirmed' || (card.kind === 'step' && !card.judgment))) {
    return null;
  }
  return (
    <div className="wm-confirm">
      {showBlocker && (
        <p className="wm-blocker" role="note">
          <strong>Cannot be confirmed:</strong> {card.blocker}
        </p>
      )}
      {props.onConfirmRequest !== undefined && card.status !== 'confirmed' && (card.kind === 'guardrail' || card.judgment) && (
        <button
          type="button"
          className="wm-btn"
          disabled={!card.confirmable}
          onClick={() => props.onConfirmRequest?.({ kind: card.kind, id: card.id })}
        >
          Confirm in Review
        </button>
      )}
    </div>
  );
}

export function WorkMapBoard(props: WorkMapBoardProps): ReactNode {
  const board: Storyboard = useMemo(
    () =>
      buildStoryboard({
        map: props.map,
        observations: props.observations,
        ...(props.evidence ? { evidence: props.evidence } : {}),
        ...(props.gaps ? { gaps: props.gaps } : {}),
        ...(props.blockers ? { blockers: props.blockers } : {}),
      }),
    [props.map, props.observations, props.evidence, props.gaps, props.blockers],
  );
  const [selected, setSelected] = useState<string | null>(props.initialSelection ?? null);
  const [moment, setMoment] = useState<(Moment & { label: string }) | null>(() => {
    const key = props.initialSelection ?? null;
    if (key === null) return null;
    const all: BoardCard[] = [...board.steps, ...board.guardrails, ...board.gaps];
    const card = all.find((c) => cardKey(c) === key);
    if (card?.moment) return { ...card.moment, label: momentLabel(card) };
    const f = key.startsWith('frame:') ? board.keyframes.find((k) => k.id === key.slice(6)) : undefined;
    return f?.evidenceId ? { evidenceId: f.evidenceId, startMs: f.startMs, endMs: f.endMs, label: frameLabel(f) } : null;
  });

  const frames = useMemo(() => new Map(board.keyframes.map((f) => [f.id, f])), [board]);
  const cards = useMemo(() => {
    const all: BoardCard[] = [...board.steps, ...board.guardrails, ...board.gaps];
    return new Map(all.map((c) => [cardKey(c), c]));
  }, [board]);

  const ids = useMemo(() => {
    const set = new Set<string>();
    for (const f of board.keyframes) if (f.evidenceId) set.add(f.evidenceId);
    for (const c of [...board.steps, ...board.guardrails, ...board.gaps]) if (c.moment) set.add(c.moment.evidenceId);
    return [...set];
  }, [board]);
  const media = useEvidenceMedia(ids, props.resolveEvidence);

  // Related highlighting: a selected card lights up its frames; a selected frame lights up its cards.
  const selectedCard = selected !== null ? cards.get(selected) ?? null : null;
  const selectedFrame = selected?.startsWith('frame:') ? frames.get(selected.slice(6)) ?? null : null;
  const relatedFrames = new Set<string>(selectedCard?.frameIds ?? []);
  const frameCards = new Set(
    selectedFrame ? [...selectedFrame.stepIds.map((id) => `step:${id}`), ...selectedFrame.guardrailIds.map((id) => `guardrail:${id}`), ...selectedFrame.gapIds.map((id) => `gap:${id}`)] : [],
  );

  const seek = (key: string, m: Moment | null, label: string): void => {
    setSelected(key);
    if (m === null) {
      setMoment(null);
      return;
    }
    setMoment({ ...m, label });
    props.onSeek?.(m.evidenceId, m.startMs, m.endMs);
  };
  const selectFrame = (f: Keyframe): void =>
    seek(`frame:${f.id}`, f.evidenceId ? { evidenceId: f.evidenceId, startMs: f.startMs, endMs: f.endMs } : null, frameLabel(f));
  const selectCard = (c: BoardCard): void => {
    seek(cardKey(c), c.moment, momentLabel(c));
    props.onCardSelect?.({ kind: c.kind, id: c.id });
  };

  const stateClass = (key: string): string => (selected === key ? ' is-selected' : frameCards.has(key) ? ' is-related' : '');

  const stepItem = (s: StepCard): ReactNode => (
    <li key={s.id}>
      <article
        className={`wm-card wm-card--step${s.judgment ? ' wm-card--judgment' : ''}${stateClass(cardKey(s))}`}
        data-card={cardKey(s)}
        data-status={s.status}
        {...clickable(() => selectCard(s))}
      >
        <Thumb media={s.moment ? media[s.moment.evidenceId] : undefined} alt={`Screen moment of step ${s.number}`} />
        <div className="wm-card__body">
          <header className="wm-card__head">
            <span className="wm-num">{s.number}</span>
            <span className="wm-kind">{s.judgment ? 'Judgment call' : 'Action'}</span>
            <time className="wm-time">{formatClock(s.atMs)}</time>
            <StatusPill status={s.status} note={s.statusNote} />
          </header>
          <h4 className="wm-card__title">{s.action}</h4>
          <p className="wm-goal">{s.goal}</p>
          {s.decision && (
            <p className="wm-line">
              <span className="wm-label">Decision</span> {s.decision}
            </p>
          )}
          {s.reason && (
            <p className="wm-line">
              <span className="wm-label">Reason</span> {s.reason}
            </p>
          )}
          <Quote quote={s.quote} atMs={s.quoteAtMs} />
          {s.judgment && s.quote === null && <p className="wm-missing">No reason in the expert's words yet.</p>}
          {(s.scope || s.requiredFields.length > 0 || s.exceptions.length > 0) && (
            <dl className="wm-meta">
              {s.scope && (
                <div>
                  <dt>Scope</dt>
                  <dd>{s.scope}</dd>
                </div>
              )}
              {s.requiredFields.length > 0 && (
                <div>
                  <dt>Required</dt>
                  <dd>
                    <Fields fields={s.requiredFields} />
                  </dd>
                </div>
              )}
              {s.exceptions.length > 0 && (
                <div>
                  <dt>Exceptions</dt>
                  <dd>{s.exceptions.join(' ')}</dd>
                </div>
              )}
            </dl>
          )}
          <footer className="wm-card__foot">
            <FrameLinks frameIds={s.frameIds} frames={frames} />
          </footer>
          <ConfirmHook card={s} onConfirmRequest={props.onConfirmRequest} />
        </div>
      </article>
    </li>
  );
  const guardrailItem = (g: GuardrailCard): ReactNode => (
    <li key={g.id}>
      <article
        className={`wm-card wm-card--guardrail${g.unexplained ? ' wm-card--habit' : ''}${stateClass(cardKey(g))}`}
        data-card={cardKey(g)}
        data-status={g.status}
        {...clickable(() => selectCard(g))}
      >
        <div className="wm-card__body">
          <header className="wm-card__head">
            <span className="wm-shield" aria-hidden="true" />
            <span className="wm-kind">
              {g.id.toUpperCase()} · {g.triggerLabel}
            </span>
            <StatusPill status={g.status} note={g.statusNote} />
          </header>
          {g.unexplained && <p className="wm-missing">{g.statusNote}.</p>}
          <p className="wm-line wm-line--when">
            <span className="wm-label">When</span> {g.condition}
          </p>
          <p className="wm-line wm-line--then">
            <span className="wm-label">Then</span> {g.requiredAction}
          </p>
          <dl className="wm-meta">
            <div>
              <dt>Scope</dt>
              <dd>{g.scope}</dd>
            </div>
            {g.requiredFields.length > 0 && (
              <div>
                <dt>Required</dt>
                <dd>
                  <Fields fields={g.requiredFields} />
                </dd>
              </div>
            )}
            <div>
              <dt>Exceptions</dt>
              <dd>{g.exceptions.length > 0 ? g.exceptions.join(' ') : 'None stated'}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd className={g.reason === null ? 'wm-unknown' : ''}>{g.reason ?? 'Unknown'}</dd>
            </div>
            {g.escalateTo && (
              <div>
                <dt>Ask</dt>
                <dd>{g.escalateTo}</dd>
              </div>
            )}
            {g.duration && (
              <div>
                <dt>Holds</dt>
                <dd>{g.duration}</dd>
              </div>
            )}
          </dl>
          <Quote quote={g.quote} atMs={g.quoteAtMs} />
          {g.frameIds.length > 0 && (
            <div className="wm-evidence-strip">
              {g.frameIds.map((id) => {
                const f = frames.get(id);
                return f ? (
                  <Thumb key={id} media={f.evidenceId ? media[f.evidenceId] : undefined} alt={`Evidence frame ${f.index}`} time={formatClock(f.atMs)} />
                ) : null;
              })}
            </div>
          )}
          <footer className="wm-card__foot">
            <FrameLinks frameIds={g.frameIds} frames={frames} />
          </footer>
          <ConfirmHook card={g} onConfirmRequest={props.onConfirmRequest} />
        </div>
      </article>
    </li>
  );
  const stepGroups = byProcess(board.steps, props.processes, (p) => p.stepIds);
  const ruleGroups = byProcess(board.guardrails, props.processes, (p) => p.guardrailIds);

  const versionLabel = board.confirmed ? 'confirmed' : board.mapStatus;
  const inline = props.inlineMoment !== false;
  const title = props.title ?? 'Briefing board';

  return (
    <section className="wm-board" data-clipa-target="review-board" aria-label={title}>
      <header className="wm-head">
        <div className="wm-head__text">
          <p className="wm-eyebrow">Review · session storyboard</p>
          <h2 className="wm-title">{title}</h2>
          <p className="wm-sub">
            What the agent saw on screen, what it understood, and what it still needs to ask you. Click any frame or card to see its moment.
          </p>
        </div>
        <div className="wm-head__badges">
          <span className={`wm-version wm-version--${versionLabel}`}>
            Map v{board.version} · {versionLabel}
          </span>
          {board.confirmation && board.confirmed && (
            <span className="wm-confirmed-quote">
              “{board.confirmation.quote ?? 'confirmed'}” · {formatClock(board.confirmation.atMs)}
            </span>
          )}
          {props.synthetic && <span className="wm-tag wm-tag--synthetic">Synthetic session</span>}
        </div>
        <dl className="wm-counts">
          <div className="wm-count">
            <dt>Steps</dt>
            <dd data-count="steps">{board.counts.steps}</dd>
          </div>
          <div className="wm-count">
            <dt>Judgment calls</dt>
            <dd data-count="judgment-calls">{board.counts.judgmentCalls}</dd>
          </div>
          <div className="wm-count">
            <dt>Guardrails</dt>
            <dd data-count="guardrails">{board.counts.guardrails}</dd>
          </div>
          <div className={`wm-count${board.counts.openGaps > 0 ? ' wm-count--gaps' : ''}`}>
            <dt>Open gaps</dt>
            <dd data-count="open-gaps">{board.counts.openGaps}</dd>
          </div>
        </dl>
        <ol className="wm-pipeline" aria-label="How the screen became knowledge">
          <li>
            <b>{board.pipeline.frames}</b> screen frames
          </li>
          <li>
            <b>{board.pipeline.observations}</b> vision observations
          </li>
          <li>
            <b>{board.pipeline.changes}</b> changes
          </li>
          <li>
            <b>{board.pipeline.mapItems}</b> map items
          </li>
        </ol>
      </header>

      <section className="wm-section" aria-labelledby="wm-story-h">
        <h3 id="wm-story-h" className="wm-h3">
          Storyboard <span className="wm-h3__sub">{board.keyframes.length} keyframes in time order</span>
        </h3>
        <ol className="wm-strip">
          {board.keyframes.map((f) => {
            const key = `frame:${f.id}`;
            const cls = selected === key ? ' is-selected' : relatedFrames.has(f.id) ? ' is-related' : '';
            return (
              <li key={f.id} className={`wm-frame${cls}${f.gapIds.length > 0 ? ' has-gap' : ''}`} data-frame-id={f.id} data-at-ms={f.atMs}>
                <div className="wm-frame__main" {...clickable(() => selectFrame(f))} aria-label={`Frame ${f.index} at ${formatClock(f.atMs)}`}>
                  <Thumb media={f.evidenceId ? media[f.evidenceId] : undefined} alt={`${f.surfaceLabel} at ${formatClock(f.atMs)}`} time={formatClock(f.atMs)} index={f.index} />
                  <div className="wm-frame__body">
                    <span className={`wm-surface wm-surface--${f.surface}`}>{f.surfaceLabel}</span>
                    <ul className="wm-changes">
                      {f.changes.map((c, i) => (
                        <li key={i} className={`wm-change wm-change--${c.kind}`}>
                          {c.label}
                        </li>
                      ))}
                    </ul>
                    <span className="wm-frame__links">
                      {f.stepIds.map((id) => (
                        <span key={id} className="wm-link wm-link--step">
                          Step {board.steps.find((s) => s.id === id)?.number ?? id}
                        </span>
                      ))}
                      {f.guardrailIds.map((id) => (
                        <span key={id} className="wm-link wm-link--guardrail">
                          {id.toUpperCase()}
                        </span>
                      ))}
                      {f.gapIds.length > 0 && <span className="wm-link wm-link--gap">{f.gapIds.length === 1 ? '1 gap' : `${f.gapIds.length} gaps`}</span>}
                    </span>
                  </div>
                </div>
                <details className="wm-saw">
                  <summary>What the agent saw</summary>
                  <dl className="wm-facts">
                    {f.facts.map((r) => (
                      <div key={r.key} className="wm-fact">
                        <dt>{r.key}</dt>
                        <dd>{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      {inline && moment && (
        <section className="wm-moment" aria-live="polite" aria-label="Selected screen moment">
          <Thumb media={media[moment.evidenceId]} alt={moment.label} large />
          <div className="wm-moment__text">
            <p className="wm-eyebrow">Screen moment</p>
            <p className="wm-moment__label">{moment.label}</p>
            <p className="wm-moment__meta">
              {formatClock(moment.startMs)}–{formatClock(moment.endMs)} · <code>{moment.evidenceId}</code>
            </p>
            <p className="wm-moment__note">Still frame of the moment; clip replay opens here once the replay panel is wired.</p>
            <button type="button" className="wm-btn wm-btn--ghost" onClick={() => setMoment(null)}>
              Close
            </button>
          </div>
        </section>
      )}

      <div className="wm-columns">
        <section className="wm-col" aria-labelledby="wm-steps-h">
          <h3 id="wm-steps-h" className="wm-h3">
            Steps <span className="wm-h3__sub">{board.counts.judgmentCalls} judgment calls</span>
          </h3>
          {stepGroups === null ? (
            <ol className="wm-cards">{board.steps.map(stepItem)}</ol>
          ) : (
            stepGroups.map((g) => <ProcessGroup key={g.id} id={g.id} title={g.title}>{g.cards.map(stepItem)}</ProcessGroup>)
          )}
        </section>

        <aside className="wm-col wm-col--side">
          {board.gaps.length > 0 && (
            <section aria-labelledby="wm-gaps-h">
              <h3 id="wm-gaps-h" className="wm-h3">
                Open gaps <span className="wm-h3__sub">the agent will ask these next</span>
              </h3>
              <ol className="wm-cards">
                {board.gaps.map((g: GapCard) => (
                  <li key={g.id}>
                    <article
                      className={`wm-card wm-card--gap${stateClass(cardKey(g))}`}
                      data-card={cardKey(g)}
                      {...(g.first ? { 'data-clipa-target': 'board-gap' } : {})}
                      {...clickable(() => selectCard(g))}
                    >
                      <span className="wm-gap__icon" aria-hidden="true">
                        ?
                      </span>
                      <div className="wm-card__body">
                        <header className="wm-card__head">
                          <span className="wm-kind">{g.topicLabel}</span>
                          {g.atMs !== null && <time className="wm-time">{formatClock(g.atMs)}</time>}
                        </header>
                        <p className="wm-gap__q">{g.question}</p>
                        <footer className="wm-card__foot">
                          <FrameLinks frameIds={g.frameIds} frames={frames} />
                          {props.onGapSelect && (
                            <button
                              type="button"
                              className="wm-btn wm-btn--soft"
                              onClick={() => {
                                const q = props.gaps?.find((x) => x.id === g.id);
                                if (q) props.onGapSelect?.(q);
                              }}
                            >
                              Answer now
                            </button>
                          )}
                        </footer>
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section aria-labelledby="wm-guard-h">
            <h3 id="wm-guard-h" className="wm-h3">
              Guardrails <span className="wm-h3__sub">when to stop or ask</span>
            </h3>
            {ruleGroups === null ? (
              <ol className="wm-cards">{board.guardrails.map(guardrailItem)}</ol>
            ) : (
              ruleGroups.map((g) => <ProcessGroup key={g.id} id={g.id} title={g.title}>{g.cards.map(guardrailItem)}</ProcessGroup>)
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
