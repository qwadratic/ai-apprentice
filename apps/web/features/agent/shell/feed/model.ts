// The live feed: one stream of what is happening now in the running stage, built only from state the page already has (the
// shell store and the conductor store). Newest first; a few items show, the rest fold into "+N earlier". Pure: no React, no
// clock of its own, tested with node --test.
import type { DraftMap } from '../brain/types.ts';
import type { ConductorMapSnapshot, SaidItem } from '../conductor/store.ts';
import { SESSION_LIMIT_MS } from '../session-clock.ts';
import type { CheckpointCard, FeedItem, LogLine, ObservationRow, SessionInfo } from '../state/types.ts';

export const FEED_KINDS = ['screen', 'ask', 'answer', 'rule', 'map', 'warn', 'say', 'check'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** The words beside each item's icon. */
export const FEED_LABEL: Record<FeedKind, string> = {
  screen: 'Screen',
  ask: 'Clipa asked',
  answer: 'You said',
  rule: 'Rule learned',
  map: 'Map changed',
  warn: 'Warning',
  say: 'Clipa said',
  check: 'Checked',
};

/** How many items show before the rest fold into "+N earlier", and how many the expanded list keeps. */
export const FEED_VISIBLE = 5;
export const FEED_EXPANDED_MAX = 30;
/** A new item is highlighted this long. */
export const FEED_FRESH_MS = 2500;

export interface FeedEntry {
  /** Stable key: the same thing keeps its id while the feed grows. */
  id: string;
  kind: FeedKind;
  text: string;
  /** When it happened, on the page's wall clock (Date.now scale). */
  atMs: number;
  /** Replaces the kind's label (an answer to a question reads "Answer captured"). */
  label?: string;
  tone?: 'ok' | 'warn' | 'muted';
  /** How many identical screen changes in a row this item stands for. */
  repeat?: number;
  /** From the sample source: invented data, not the person's screen. */
  synthetic?: boolean;
}

export interface FeedSources {
  /** The session on the page (null before the first Start). Its epoch is the origin of every session time below. */
  session: Pick<SessionInfo, 'epochMs' | 'deadlineMs'> | null;
  observations: readonly ObservationRow[];
  /** The in-browser brain's questions and the answers it captured (the fallback when the conductor does not lead). */
  questions: readonly FeedItem[];
  /** What the conductor had Clipa ask, warn or say. */
  said: readonly SaidItem[];
  /** The debug log: its USER lines are the person's own words (already scrubbed). */
  events: readonly LogLine[];
  checkpoint: CheckpointCard | null;
  /** Map changes the page saw (see mapChangeEntries), already on the wall clock. */
  mapChanges: readonly FeedEntry[];
  /** true: the conductor leads, so the person's words come from the transcript; false: from the brain's captured answers. */
  conductorLeads: boolean;
}

/** Wall-clock start of the running stage: a stage's session ends SESSION_LIMIT_MS after its Start click (deadlineOf). */
export function stageStartMs(session: FeedSources['session']): number | null {
  return session === null ? null : session.deadlineMs - SESSION_LIMIT_MS;
}

const HIDDEN_KINDS = new Set(['input_activity']);
/** Lets a little clock skew through: a cue stamped by the server just before the click still belongs to the stage. */
const SLACK_MS = 2000;

/**
 * Every item of the running stage, newest first. Screen changes that repeat the same line in a row fold into one item (the
 * newest time, with a count); input activity (typing on or off) is not a change and stays out.
 */
export function collectFeed(src: FeedSources, nowMs: number): FeedEntry[] {
  const session = src.session;
  if (session === null) return [];
  const epoch = session.epochMs;
  const from = (stageStartMs(session) ?? epoch) - SLACK_MS;
  const wall = (sessionMs: number): number => Math.min(nowMs, epoch + sessionMs);
  const out: FeedEntry[] = [];

  let run: FeedEntry | null = null;
  for (const o of src.observations) {
    if (HIDDEN_KINDS.has(o.kind)) continue;
    const text = o.summary.trim();
    if (text === '') continue;
    const atMs = wall(o.timestampMs);
    if (run !== null && run.text === text) {
      run.atMs = Math.max(run.atMs, atMs);
      run.repeat = (run.repeat ?? 1) + 1;
      continue;
    }
    run = { id: `obs:${o.id}`, kind: 'screen', text, atMs, ...(o.synthetic ? { synthetic: true } : {}) };
    out.push(run);
  }

  if (src.conductorLeads) {
    for (const s of src.said) {
      if (s.outcome === 'skipped') continue; // never reached the person
      out.push({ id: `cue:${s.cueId}`, kind: s.kind, text: s.text, atMs: wall(s.atMs) });
    }
    for (const line of src.events) {
      if (line.type !== 'USER' || line.text.trim() === '') continue;
      out.push({ id: `user:${line.id}`, kind: 'answer', text: line.text.trim(), atMs: Math.min(nowMs, line.t) });
    }
  } else {
    for (const q of src.questions) {
      if (q.status === 'deferred' || q.status === 'unspoken') continue; // waits for Reflect, never spoken here
      out.push({ id: `q:${q.id}`, kind: q.status === 'said' ? 'say' : 'ask', text: q.text, atMs: wall(q.atMs) });
      if (q.answer) out.push({ id: `a:${q.id}`, kind: 'answer', label: 'Answer captured', text: q.answer.text, atMs: wall(q.answer.atMs) });
    }
  }

  const cp = src.checkpoint;
  if (cp !== null) {
    const atMs = wall(cp.atMs);
    if (cp.status === 'warn') out.push({ id: `cp:${cp.checkpointId}`, kind: 'warn', label: 'Stop before Send', text: cp.message, atMs, tone: 'warn' });
    else out.push({ id: `cp:${cp.checkpointId}`, kind: 'check', label: cp.status === 'clear' ? 'Clear to send' : 'Not sure', text: cp.message, atMs, tone: cp.status === 'clear' ? 'ok' : 'muted' });
  }

  for (const m of src.mapChanges) out.push({ ...m, atMs: Math.min(nowMs, m.atMs) });

  // Newest first; at the same moment, the later-made item first (an answer after its question, a map change after the answer).
  return out
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.atMs >= from)
    .sort((a, b) => b.entry.atMs - a.entry.atMs || b.index - a.index)
    .map(({ entry }) => entry);
}

export interface FoldedFeed {
  shown: FeedEntry[];
  /** Items behind "+N earlier" (0 when expanded or when everything fits). */
  earlier: number;
  /** The list can fold back (it is expanded and longer than the visible part). */
  canFold: boolean;
}

/** The visible part: the newest few, or (expanded) a longer list; the rest is a count. */
export function foldFeed(entries: readonly FeedEntry[], expanded: boolean, visible: number = FEED_VISIBLE): FoldedFeed {
  if (expanded && entries.length > visible) return { shown: entries.slice(0, FEED_EXPANDED_MAX), earlier: 0, canFold: true };
  return { shown: entries.slice(0, visible), earlier: Math.max(0, entries.length - visible), canFold: false };
}

/** "now", "12 s", "3 min", "1 h": how long ago, short. */
export function relativeTime(nowMs: number, atMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

/** The newest item is highlighted for a moment after it arrives. */
export function isFresh(entry: FeedEntry, nowMs: number): boolean {
  return nowMs - entry.atMs < FEED_FRESH_MS;
}

// ---- map changes ------------------------------------------------------------
// Neither store keeps a history of the map, only its latest version. The feed compares each version with the one before and
// turns the difference into items: a rule learned, a step added, changed or removed, the map confirmed.

export interface MapDigest {
  /** Changes when anything shown below changes. */
  sig: string;
  confirmed: boolean;
  steps: Array<{ id: string; title: string }>;
  rules: Array<{ id: string; text: string }>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (s: string, max = 140): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function digest(confirmed: boolean, steps: MapDigest['steps'], rules: MapDigest['rules']): MapDigest | null {
  if (steps.length === 0 && rules.length === 0) return null;
  return { sig: JSON.stringify([confirmed, steps, rules]), confirmed, steps, rules };
}

/** The conductor's generic map (steps with a goal and an action, guardrails with a condition and a required action). */
export function digestGenericMap(snapshot: ConductorMapSnapshot | null): MapDigest | null {
  if (snapshot === null || !isRec(snapshot.map)) return null;
  const raw = snapshot.map;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).filter(isRec).map((s, i) => ({
    id: str(s.id) || `s${i + 1}`,
    title: clip(str(s.goal) || str(s.action) || `Step ${i + 1}`),
  }));
  const rules = (Array.isArray(raw.guardrails) ? raw.guardrails : []).filter(isRec).map((g, i) => {
    const condition = str(g.condition);
    const action = str(g.requiredAction);
    return { id: str(g.id) || `g${i + 1}`, text: clip(condition && action ? `${condition}: ${action}` : condition || action || 'A new rule') };
  });
  return digest(snapshot.confirmed, steps, rules);
}

/** The in-browser brain's draft map. */
export function digestDraftMap(map: DraftMap): MapDigest | null {
  const steps = map.steps.map((s) => ({ id: s.id, title: clip(s.title) }));
  const seen = new Set<string>();
  const rules: MapDigest['rules'] = [];
  for (const g of [...map.steps.flatMap((s) => s.guardrails), ...(map.guardrails ?? [])]) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    rules.push({ id: g.id, text: clip(g.text) });
  }
  return digest(map.confirmed === true, steps, rules);
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
/** More than this many changes of one sort in one version read as one summary item. */
const MAX_ITEMS_PER_SORT = 3;

/**
 * The feed items for one new version of the map, stamped `atMs` (when the page saw it). The first map the page sees is one
 * item ("Work Map ready"), not one per step: a map restored on load must not flood the feed.
 */
export function mapChangeEntries(prev: MapDigest | null, next: MapDigest, atMs: number, seq: number): FeedEntry[] {
  const id = (part: string): string => `map:${seq}:${part}`;
  if (prev === null) {
    return [{ id: id('ready'), kind: 'map', label: 'Work Map', text: `Ready: ${plural(next.steps.length, 'step')}, ${plural(next.rules.length, 'rule')}.`, atMs }];
  }
  if (prev.sig === next.sig) return [];
  const out: FeedEntry[] = [];
  const before = { steps: new Map(prev.steps.map((s) => [s.id, s.title])), rules: new Map(prev.rules.map((r) => [r.id, r.text])) };
  const after = { steps: new Set(next.steps.map((s) => s.id)), rules: new Set(next.rules.map((r) => r.id)) };

  const newRules = next.rules.filter((r) => !before.rules.has(r.id));
  if (newRules.length > MAX_ITEMS_PER_SORT) out.push({ id: id('rules'), kind: 'rule', text: `${plural(newRules.length, 'new rule')} in the map.`, atMs });
  else for (const r of newRules) out.push({ id: id(`rule-${r.id}`), kind: 'rule', text: r.text, atMs });

  const newSteps = next.steps.filter((s) => !before.steps.has(s.id));
  if (newSteps.length > MAX_ITEMS_PER_SORT) out.push({ id: id('steps'), kind: 'map', label: 'Steps added', text: `${plural(newSteps.length, 'new step')} in the map.`, atMs });
  else for (const s of newSteps) out.push({ id: id(`step-${s.id}`), kind: 'map', label: 'Step added', text: s.title, atMs });

  const changed = [
    ...next.steps.filter((s) => before.steps.has(s.id) && before.steps.get(s.id) !== s.title).map((s) => s.title),
    ...next.rules.filter((r) => before.rules.has(r.id) && before.rules.get(r.id) !== r.text).map((r) => r.text),
  ];
  if (changed.length > 0) out.push({ id: id('changed'), kind: 'map', label: 'Changed', text: changed.length === 1 ? changed[0]! : `${plural(changed.length, 'item')} reworded.`, atMs });

  const removed = [...prev.steps.filter((s) => !after.steps.has(s.id)).map((s) => s.title), ...prev.rules.filter((r) => !after.rules.has(r.id)).map((r) => r.text)];
  if (removed.length > 0) out.push({ id: id('removed'), kind: 'map', label: 'Removed', text: removed.length === 1 ? removed[0]! : `${plural(removed.length, 'item')} taken out.`, atMs });

  if (next.confirmed && !prev.confirmed) out.push({ id: id('confirmed'), kind: 'map', label: 'Confirmed', text: 'You confirmed the Work Map.', atMs, tone: 'ok' });
  if (out.length === 0) out.push({ id: id('updated'), kind: 'map', text: 'The Work Map was updated.', atMs });
  return out;
}

/** A small history of map changes: feed it each digest; it keeps the items, newest first. */
export interface MapLedger {
  prev: MapDigest | null;
  seq: number;
  entries: FeedEntry[];
}

export const MAP_LEDGER_MAX = 40;

export function emptyLedger(): MapLedger {
  return { prev: null, seq: 0, entries: [] };
}

/** The ledger after a digest was seen at `atMs`; the same object when nothing changed. A null digest (no map) changes nothing. */
export function advanceLedger(ledger: MapLedger, next: MapDigest | null, atMs: number): MapLedger {
  if (next === null || (ledger.prev !== null && ledger.prev.sig === next.sig)) return ledger;
  const seq = ledger.seq + 1;
  const added = mapChangeEntries(ledger.prev, next, atMs, seq);
  return { prev: next, seq, entries: [...added, ...ledger.entries].slice(0, MAP_LEDGER_MAX) };
}
