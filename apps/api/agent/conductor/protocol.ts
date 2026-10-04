// Clipa Conductor v1 (backlog doc-12): the events a client (web shell, macOS app) sends and the cues it renders.
// Clients are faces; what Clipa says and does is decided here, on the server, for every client the same way.
import { isRecord } from '../config.ts';

export const MODES = ['learn', 'review', 'teach'] as const;
export type Mode = (typeof MODES)[number];
export type Persona = 'expert' | 'new_hire';
export type Activity = 'typing' | 'working' | 'pause' | 'idle' | 'away';
export type ClipaPose = 'idle' | 'listen' | 'think' | 'speak' | 'point' | 'warn' | 'celebrate' | 'retreat' | 'hidden';
export type ClientKind = 'web' | 'macos';
/** Who a cue is for: every face, or only the web app, or only the macOS app. */
export type Audience = 'all' | ClientKind;
/** macOS: how much of Clipa is out of the corner. */
export type Presence = 'dot' | 'peek' | 'full';
export type UiTarget = 'share' | 'start' | 'mode_tab' | 'board_gap' | 'teachback' | 'summary';

/** A labelled place on a frame; box is [x, y, w, h] normalised 0..1 to that frame. */
export interface Region { regionId: string; label: string; box: [number, number, number, number] | null; evidenceId: string | null }
export type Target = { kind: 'region'; regionId: string; label: string; box: [number, number, number, number] | null; evidenceId: string | null } | { kind: 'ui'; name: UiTarget; mode?: Mode };

/** A screen observation as the conductor keeps it: the generic shape the LLM tasks read, plus region boxes for pointing. */
export interface SeenObservation {
  id: string;
  atMs: number;
  kind: string;
  app: string | null;
  surface: string;
  summary: string;
  change: string | null;
  pendingAction: string | null;
  regions: Region[];
  evidenceIds: string[];
}

export type ClientEvent =
  | { type: 'hello'; client: 'web' | 'macos'; version: string; persona: Persona; language: string | null; mapFrom: string | null }
  | { type: 'mode'; mode: Mode }
  | { type: 'session'; mode: Mode; live: boolean; reason: string | null }
  | { type: 'share'; state: 'requested' | 'capturing' | 'camera' | 'unavailable'; reason: string | null }
  | { type: 'activity'; state: Activity }
  | { type: 'talking'; by: 'person' | 'agent'; active: boolean }
  | { type: 'transcript'; role: 'expert' | 'agent'; text: string }
  | { type: 'ui'; action: 'confirm' | 'correct' | 'answer_gap' | 'ask_about' | 'finish'; targetId: string | null; text: string | null }
  | { type: 'cue_done'; cueId: string; outcome: 'spoken' | 'shown' | 'skipped' | 'interrupted' }
  | { type: 'off_record'; on: boolean }
  | { type: 'observation'; observation: SeenObservation };

export interface ClientEnvelope { seq: number; atMs: number; event: ClientEvent }

export type Cue =
  | { type: 'state'; clipa: ClipaPose }
  | { type: 'guide'; step: string; phase: Mode | 'share' | 'summary'; text: string; target: Target | null; speak: boolean }
  | { type: 'ask'; questionId: string; text: string; topic: string; regions: Region[]; evidenceIds: string[] }
  | { type: 'point'; target: Target }
  | { type: 'context'; text: string }
  | { type: 'map'; version: number; map: unknown; confirmed: boolean }
  | { type: 'teachback'; version: number; text: string }
  | { type: 'warn'; guardrailId: string; text: string; regions: Region[]; evidenceIds: string[] }
  | { type: 'say'; text: string }
  | { type: 'presence'; size: Presence; anchor: 'corner' | 'target' }
  | { type: 'open_web'; page: 'review' | 'teach' | 'summary'; url: string; text: string }
  | { type: 'cancel'; cueId: string }
  | { type: 'quiet'; reason: string }
  // Additive (v1.2): a face that does not know these ignores them. The conductor sends them to the web only for now.
  /** A thought bubble: a short line about what Clipa is working on. Shown beside her, never spoken. */
  | { type: 'thought'; text: string }
  /** The person should look somewhere else (an ask about a region, a warning, the next stage): Clipa flashes and goes there. */
  | { type: 'attention'; target: Target | null }
  /** The person asked for a stage by voice: the face opens it the way a click on its stage does. */
  | { type: 'stage'; mode: Mode };

export interface CueEnvelope { seq: number; cueId: string; atMs: number; mode: Mode | null; persona: Persona; for: Audience; cue: Cue; expiresAtMs: number | null }

// ---- parsing ---------------------------------------------------------------
type P<T> = { ok: true; value: T } | { ok: false; field: string };
const bad = (field: string): { ok: false; field: string } => ({ ok: false, field });
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
function str(v: unknown, max: number, min = 1): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max && !CONTROL.test(v);
}
function optStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  return str(v, max) ? v : undefined;
}
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function parseBox(v: unknown): [number, number, number, number] | null | undefined {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return undefined;
  const [x, y, w, h] = v as number[];
  return x! + w! <= 1.0001 && y! + h! <= 1.0001 ? [x!, y!, w!, h!] : undefined;
}

/**
 * A ScreenObservation (contracts, plus the generic screen_activity kind from stream A) turned into what the conductor
 * keeps. Unknown kinds are kept with a neutral summary so that the conductor never depends on one scenario.
 */
export function parseObservation(v: unknown): P<SeenObservation> {
  if (!isRecord(v)) return bad('observation');
  if (!str(v.id, 64) || !ID.test(v.id)) return bad('observation.id');
  if (!str(v.kind, 40)) return bad('observation.kind');
  const at = typeof v.timestampMs === 'number' && Number.isFinite(v.timestampMs) && v.timestampMs >= 0 ? Math.round(v.timestampMs) : null;
  if (at === null) return bad('observation.timestampMs');
  const evidenceIds = Array.isArray(v.evidenceIds) ? (v.evidenceIds as unknown[]).filter((e): e is string => str(e, 64) && ID.test(e)).slice(0, 8) : [];
  const facts = isRecord(v.facts) ? v.facts : {};
  const firstEvidence = evidenceIds[0] ?? null;
  let app: string | null = null;
  let surface = v.kind.replace(/_/g, ' ');
  let summary = '';
  let change: string | null = null;
  let pendingAction: string | null = null;
  const regions: Region[] = [];
  if (v.kind === 'screen_activity') {
    app = str(facts.app, 80) ? facts.app : null;
    surface = str(facts.surface, 120) ? facts.surface : 'screen';
    summary = str(facts.summary, 400) ? facts.summary : '';
    change = str(facts.change, 300) ? facts.change : null;
    pendingAction = str(facts.pendingAction, 80) ? facts.pendingAction : null;
    const raw = Array.isArray(facts.regions) ? (facts.regions as unknown[]).slice(0, 8) : [];
    for (const r of raw) {
      if (!isRecord(r) || !str(r.id, 32) || !ID.test(r.id) || !str(r.label, 120)) continue;
      const box = parseBox(r.box);
      if (box === undefined) continue;
      regions.push({ regionId: r.id, label: r.label, box, evidenceId: firstEvidence });
    }
  } else {
    // The three workspace kinds and anything newer: a short neutral line built from whichever facts are strings.
    const parts = Object.entries(facts)
      .filter(([, value]) => typeof value === 'string' && value.length > 0 && value.length <= 120)
      .slice(0, 5)
      .map(([key, value]) => `${key} ${String(value)}`);
    summary = parts.join('; ');
  }
  if (summary === '') summary = `A ${surface} is visible.`;
  return { ok: true, value: { id: v.id, atMs: at, kind: v.kind, app, surface, summary, change, pendingAction, regions, evidenceIds } };
}

function parseEvent(v: unknown, f: string): P<ClientEvent> {
  if (!isRecord(v) || typeof v.type !== 'string') return bad(f);
  switch (v.type) {
    case 'hello': {
      if (!oneOf(v.client, ['web', 'macos'] as const)) return bad(`${f}.client`);
      if (!oneOf(v.persona, ['expert', 'new_hire'] as const)) return bad(`${f}.persona`);
      const version = optStr(v.version, 40); if (version === undefined) return bad(`${f}.version`);
      const language = v.language === undefined || v.language === null ? null : typeof v.language === 'string' && LANG.test(v.language) ? v.language : undefined;
      if (language === undefined) return bad(`${f}.language`);
      const mapFrom = v.mapFrom === undefined || v.mapFrom === null ? null : typeof v.mapFrom === 'string' && ID.test(v.mapFrom) ? v.mapFrom : undefined;
      if (mapFrom === undefined) return bad(`${f}.mapFrom`);
      return { ok: true, value: { type: 'hello', client: v.client, version: version ?? '', persona: v.persona, language, mapFrom } };
    }
    case 'mode':
      return oneOf(v.mode, MODES) ? { ok: true, value: { type: 'mode', mode: v.mode } } : bad(`${f}.mode`);
    case 'session': {
      if (!oneOf(v.mode, MODES) || typeof v.live !== 'boolean') return bad(f);
      const reason = optStr(v.reason, 40); if (reason === undefined) return bad(`${f}.reason`);
      return { ok: true, value: { type: 'session', mode: v.mode, live: v.live, reason } };
    }
    case 'share': {
      if (!oneOf(v.state, ['requested', 'capturing', 'camera', 'unavailable'] as const)) return bad(`${f}.state`);
      const reason = optStr(v.reason, 40); if (reason === undefined) return bad(`${f}.reason`);
      return { ok: true, value: { type: 'share', state: v.state, reason } };
    }
    case 'activity':
      return oneOf(v.state, ['typing', 'working', 'pause', 'idle', 'away'] as const) ? { ok: true, value: { type: 'activity', state: v.state } } : bad(`${f}.state`);
    case 'talking':
      return oneOf(v.by, ['person', 'agent'] as const) && typeof v.active === 'boolean' ? { ok: true, value: { type: 'talking', by: v.by, active: v.active } } : bad(f);
    case 'transcript':
      return oneOf(v.role, ['expert', 'agent'] as const) && str(v.text, 1000) ? { ok: true, value: { type: 'transcript', role: v.role, text: v.text } } : bad(f);
    case 'ui': {
      if (!oneOf(v.action, ['confirm', 'correct', 'answer_gap', 'ask_about', 'finish'] as const)) return bad(`${f}.action`);
      const targetId = v.targetId === undefined || v.targetId === null ? null : typeof v.targetId === 'string' && ID.test(v.targetId) ? v.targetId : undefined;
      if (targetId === undefined) return bad(`${f}.targetId`);
      const text = optStr(v.text, 600); if (text === undefined) return bad(`${f}.text`);
      return { ok: true, value: { type: 'ui', action: v.action, targetId, text } };
    }
    case 'cue_done':
      return typeof v.cueId === 'string' && ID.test(v.cueId) && oneOf(v.outcome, ['spoken', 'shown', 'skipped', 'interrupted'] as const)
        ? { ok: true, value: { type: 'cue_done', cueId: v.cueId, outcome: v.outcome } } : bad(f);
    case 'off_record':
      return typeof v.on === 'boolean' ? { ok: true, value: { type: 'off_record', on: v.on } } : bad(f);
    case 'observation': {
      const o = parseObservation(v.observation);
      return o.ok ? { ok: true, value: { type: 'observation', observation: o.value } } : bad(`${f}.${o.field}`);
    }
    default:
      return bad(`${f}.type`);
  }
}

/** A POSTed batch: `{events: [{seq, atMs, event}]}`, at most 50, seq strictly increasing. */
export function parseBatch(body: unknown): P<ClientEnvelope[]> {
  if (!isRecord(body) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return bad('events');
  const out: ClientEnvelope[] = [];
  let last = -1;
  for (const [i, raw] of (body.events as unknown[]).entries()) {
    const f = `events.${i}`;
    if (!isRecord(raw)) return bad(f);
    if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0 || raw.seq <= last) return bad(`${f}.seq`);
    if (typeof raw.atMs !== 'number' || !Number.isFinite(raw.atMs) || raw.atMs < 0) return bad(`${f}.atMs`);
    const e = parseEvent(raw.event, `${f}.event`);
    if (!e.ok) return e;
    last = raw.seq;
    out.push({ seq: raw.seq, atMs: Math.round(raw.atMs), event: e.value });
  }
  return { ok: true, value: out };
}
