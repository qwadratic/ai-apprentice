// Clipa Conductor v1.1 (backlog doc-12), the client's copy of the wire types. The server's own definition is
// apps/api/agent/conductor/protocol.ts; this file mirrors it for the web face and adds a lenient cue parser: a cue the
// web does not know is ignored, never thrown on, so a newer server never breaks an older page.

export type ConductorMode = 'learn' | 'review' | 'teach';
export type ConductorPersona = 'expert' | 'new_hire';
export type Activity = 'typing' | 'working' | 'pause' | 'idle' | 'away';
export type ClipaPose = 'idle' | 'listen' | 'think' | 'speak' | 'point' | 'warn' | 'celebrate' | 'retreat' | 'hidden';
export type UiTargetName = 'share' | 'start' | 'mode_tab' | 'board_gap' | 'teachback' | 'summary';
export type ShareState = 'requested' | 'capturing' | 'camera' | 'unavailable';
export type UiAction = 'confirm' | 'correct' | 'answer_gap' | 'ask_about' | 'finish';
export type CueOutcome = 'spoken' | 'shown' | 'skipped' | 'interrupted';

/** [x, y, w, h], normalised 0..1 to the frame the region was read from. */
export type Box = [number, number, number, number];

export interface Region { regionId: string; label: string; box: Box | null; evidenceId: string | null }

export type RegionTarget = { kind: 'region'; regionId: string; label: string; box: Box | null; evidenceId: string | null };
export type UiTarget = { kind: 'ui'; name: UiTargetName; mode?: ConductorMode };
export type Target = RegionTarget | UiTarget;

export type ClientEvent =
  | { type: 'hello'; client: 'web'; version: string; persona: ConductorPersona; language: string | null; mapFrom: string | null }
  | { type: 'mode'; mode: ConductorMode }
  | { type: 'session'; mode: ConductorMode; live: boolean; reason: string | null }
  | { type: 'share'; state: ShareState; reason: string | null }
  | { type: 'activity'; state: Activity }
  | { type: 'talking'; by: 'person' | 'agent'; active: boolean }
  | { type: 'transcript'; role: 'expert' | 'agent'; text: string }
  | { type: 'ui'; action: UiAction; targetId: string | null; text: string | null }
  | { type: 'cue_done'; cueId: string; outcome: CueOutcome }
  | { type: 'off_record'; on: boolean }
  /** The header's "Lead me through" switch (additive): off, Clipa only proposes the next stage. Never sent means on. */
  | { type: 'auto'; on: boolean };

export interface ClientEnvelope { seq: number; atMs: number; event: ClientEvent }

export type Cue =
  | { type: 'state'; clipa: ClipaPose }
  | { type: 'guide'; step: string; phase: string; text: string; target: Target | null; speak: boolean }
  | { type: 'ask'; questionId: string; text: string; topic: string; regions: Region[]; evidenceIds: string[] }
  | { type: 'point'; target: Target }
  | { type: 'context'; text: string }
  // `origin` (additive): this session's own map, a copy of an earlier session's, or the synthetic demo map.
  | { type: 'map'; version: number; map: unknown; confirmed: boolean; origin?: MapOrigin }
  | { type: 'teachback'; version: number; text: string }
  | { type: 'warn'; guardrailId: string; text: string; regions: Region[]; evidenceIds: string[] }
  | { type: 'say'; text: string }
  | { type: 'presence'; size: string; anchor: string }
  | { type: 'open_web'; page: string; url: string; text: string }
  | { type: 'cancel'; cueId: string }
  | { type: 'quiet'; reason: string }
  /** A thought bubble beside Clipa: visual only, never spoken. */
  | { type: 'thought'; text: string }
  /** Clipa flashes and goes to the target (null: she flashes where she is). */
  | { type: 'attention'; target: Target | null }
  /** The page opens a stage like a click on the rail; with `start` it also starts it like Start (ending the running stage). */
  | { type: 'stage'; mode: ConductorMode; start?: boolean }
  /** The page ends the running session like End: the person said stop, or Pass it on is done. */
  | { type: 'end'; reason: string };

export interface CueEnvelope {
  seq: number;
  cueId: string;
  atMs: number;
  mode: ConductorMode | null;
  persona: ConductorPersona;
  for: 'all' | 'web' | 'macos';
  cue: Cue;
  expiresAtMs: number | null;
}

/** The SSE `hello` event the server writes first on every stream. */
export interface StreamHello { sessionId: string; lastCueSeq: number; serverNowMs: number }

// ---- parsing ---------------------------------------------------------------

const POSES: readonly ClipaPose[] = ['idle', 'listen', 'think', 'speak', 'point', 'warn', 'celebrate', 'retreat', 'hidden'];
const UI_NAMES: readonly UiTargetName[] = ['share', 'start', 'mode_tab', 'board_gap', 'teachback', 'summary'];
const MODES: readonly ConductorMode[] = ['learn', 'review', 'teach'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max = 2000): string | null => (isStr(v) ? v.slice(0, max) : null);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => isStr(v) && (values as readonly string[]).includes(v);

function parseBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => isNum(n) && n >= 0 && n <= 1)) return null;
  const [x, y, w, h] = v as number[];
  if (w! <= 0 || h! <= 0) return null;
  return [x!, y!, Math.min(w!, 1 - x!), Math.min(h!, 1 - y!)];
}

export function parseRegion(v: unknown): Region | null {
  if (!isRecord(v) || !isStr(v.regionId)) return null;
  return {
    regionId: v.regionId.slice(0, 64),
    label: text(v.label, 120) ?? '',
    box: parseBox(v.box),
    evidenceId: isStr(v.evidenceId) ? v.evidenceId.slice(0, 64) : null,
  };
}

function parseRegions(v: unknown): Region[] {
  return Array.isArray(v) ? v.map(parseRegion).filter((r): r is Region => r !== null).slice(0, 8) : [];
}

export function parseTarget(v: unknown): Target | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'ui' && oneOf(v.name, UI_NAMES)) {
    return oneOf(v.mode, MODES) ? { kind: 'ui', name: v.name, mode: v.mode } : { kind: 'ui', name: v.name };
  }
  if (v.kind === 'region') {
    const r = parseRegion(v);
    return r === null ? null : { kind: 'region', ...r };
  }
  return null;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr).map((s) => s.slice(0, 64)).slice(0, 8) : []);

/** Where the map on the board comes from (the conductor's Reflect fallbacks). */
export type MapOrigin = 'session' | 'earlier' | 'demo';
/** An unknown or missing origin is this session's own map, as before the field existed. */
export function parseMapOrigin(v: unknown): MapOrigin {
  return v === 'earlier' || v === 'demo' ? v : 'session';
}

export function parseCue(v: unknown): Cue | null {
  if (!isRecord(v) || !isStr(v.type)) return null;
  switch (v.type) {
    case 'state':
      return oneOf(v.clipa, POSES) ? { type: 'state', clipa: v.clipa } : null;
    case 'guide': {
      const t = text(v.text, 600);
      if (t === null) return null;
      return { type: 'guide', step: text(v.step, 64) ?? '', phase: text(v.phase, 16) ?? '', text: t, target: parseTarget(v.target), speak: v.speak === true };
    }
    case 'ask': {
      const t = text(v.text, 600);
      if (t === null) return null;
      return { type: 'ask', questionId: text(v.questionId, 64) ?? '', text: t, topic: text(v.topic, 40) ?? '', regions: parseRegions(v.regions), evidenceIds: ids(v.evidenceIds) };
    }
    case 'point': {
      const target = parseTarget(v.target);
      return target === null ? null : { type: 'point', target };
    }
    case 'context': {
      const t = text(v.text, 2000);
      return t === null ? null : { type: 'context', text: t };
    }
    case 'map':
      return isNum(v.version) ? { type: 'map', version: v.version, map: v.map, confirmed: v.confirmed === true, origin: parseMapOrigin(v.origin) } : null;
    case 'teachback': {
      const t = text(v.text, 4000);
      return t === null || !isNum(v.version) ? null : { type: 'teachback', version: v.version, text: t };
    }
    case 'warn': {
      const t = text(v.text, 600);
      if (t === null) return null;
      return { type: 'warn', guardrailId: text(v.guardrailId, 64) ?? '', text: t, regions: parseRegions(v.regions), evidenceIds: ids(v.evidenceIds) };
    }
    case 'say': {
      const t = text(v.text, 600);
      return t === null ? null : { type: 'say', text: t };
    }
    case 'presence':
      return { type: 'presence', size: text(v.size, 16) ?? '', anchor: text(v.anchor, 16) ?? '' };
    case 'open_web':
      return { type: 'open_web', page: text(v.page, 16) ?? '', url: text(v.url, 600) ?? '', text: text(v.text, 600) ?? '' };
    case 'cancel':
      return isStr(v.cueId) ? { type: 'cancel', cueId: v.cueId.slice(0, 64) } : null;
    case 'quiet':
      return { type: 'quiet', reason: text(v.reason, 200) ?? '' };
    case 'thought': {
      const t = text(v.text, 120)?.trim() ?? '';
      return t === '' ? null : { type: 'thought', text: t };
    }
    case 'attention':
      return { type: 'attention', target: parseTarget(v.target) };
    case 'stage':
      if (!oneOf(v.mode, MODES)) return null;
      return v.start === true ? { type: 'stage', mode: v.mode, start: true } : { type: 'stage', mode: v.mode };
    case 'end':
      return { type: 'end', reason: text(v.reason, 40) ?? '' };
    default:
      return null;
  }
}

/** One `cue` event's data, or null when it is not a cue this page understands. */
export function parseCueEnvelope(v: unknown): CueEnvelope | null {
  if (!isRecord(v) || !isNum(v.seq) || !Number.isInteger(v.seq) || !isStr(v.cueId)) return null;
  const cue = parseCue(v.cue);
  if (cue === null) return null;
  return {
    seq: v.seq,
    cueId: v.cueId.slice(0, 64),
    atMs: isNum(v.atMs) ? v.atMs : 0,
    mode: oneOf(v.mode, MODES) ? v.mode : null,
    persona: v.persona === 'new_hire' ? 'new_hire' : 'expert',
    for: v.for === 'web' || v.for === 'macos' ? v.for : 'all',
    cue,
    expiresAtMs: isNum(v.expiresAtMs) ? v.expiresAtMs : null,
  };
}

export function parseStreamHello(v: unknown): StreamHello | null {
  if (!isRecord(v) || !isStr(v.sessionId)) return null;
  return {
    sessionId: v.sessionId,
    lastCueSeq: isNum(v.lastCueSeq) ? v.lastCueSeq : -1,
    serverNowMs: isNum(v.serverNowMs) ? v.serverNowMs : 0,
  };
}

// ---- events: made safe for the server's parser ------------------------------
// One bad event makes the server refuse the whole batch (400), so every event is clipped and cleaned before it is queued.

const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const clean = (value: string, max: number): string => value.replace(CONTROL, ' ').trim().slice(0, max);
const optClean = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const c = clean(value, max);
  return c === '' ? null : c;
};

/** The event as the server accepts it, or null when it cannot be sent at all. */
export function sanitizeEvent(e: ClientEvent): ClientEvent | null {
  switch (e.type) {
    case 'hello':
      return {
        ...e,
        version: clean(e.version, 40),
        language: e.language !== null && LANG.test(e.language) ? e.language : null,
        mapFrom: e.mapFrom !== null && ID.test(e.mapFrom) ? e.mapFrom : null,
      };
    case 'session':
    case 'share':
      return { ...e, reason: optClean(e.reason, 40) };
    case 'transcript': {
      const t = clean(e.text, 1000);
      return t === '' ? null : { ...e, text: t };
    }
    case 'ui':
      return { ...e, targetId: e.targetId !== null && ID.test(e.targetId) ? e.targetId : null, text: optClean(e.text, 600) };
    case 'cue_done':
      return ID.test(e.cueId) ? e : null;
    default:
      return e;
  }
}
