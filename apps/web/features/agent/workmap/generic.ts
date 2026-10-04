// The conductor's generic Work Map (doc-12: map_synthesis output plus voice edits and comments) as the board's WorkMap.
// The generic map works for any app: steps with a goal, an action and the expert's decision, guardrails with a condition, a
// required action and the expert's words, and open gaps. Its evidence ids name screen observations; the board links cards
// to keyframes by the observations' own evidence ids, so they are translated when the observation is known.
// Pure: no React, tested with node --test.
import type { ScreenObservation } from '@apprentice/contracts';
import type { Question, WorkMap } from './model.ts';

export interface GenericComment { targetId: string; text: string; atMs: number }

export interface GenericBoard {
  map: WorkMap;
  /** The open gaps as the board's follow-ups; their ids are the conductor's (`gap-1`, `gap-2`, ...). */
  gaps: Question[];
  teachBack: string | null;
  comments: GenericComment[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 600): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => list(v).map((x) => str(x, 120)).filter((x): x is string => x !== null);

/**
 * Reads the conductor's map; null when it is not a map at all. `observations` are the page's own screen observations: their
 * evidence ids replace the observation ids the map names, and their times order the steps.
 */
export function fromGenericMap(
  raw: unknown,
  options: { version?: number; confirmed?: boolean; observations?: readonly ScreenObservation[] } = {},
): GenericBoard | null {
  if (!isRec(raw) || !Array.isArray(raw.steps) || !Array.isArray(raw.guardrails)) return null;
  const confirmed = options.confirmed === true;
  const byId = new Map((options.observations ?? []).map((o) => [o.id, o]));
  const evidenceOf = (ids: unknown): string[] => {
    const out: string[] = [];
    for (const id of strings(ids)) {
      const o = byId.get(id);
      for (const e of o && o.evidenceIds.length > 0 ? o.evidenceIds : [id]) if (!out.includes(e)) out.push(e);
    }
    return out;
  };
  const timeOf = (ids: unknown): number | null => {
    for (const id of strings(ids)) {
      const o = byId.get(id);
      if (o) return o.timestampMs;
    }
    return null;
  };

  let at = 0;
  const steps = list(raw.steps).filter(isRec).map((s, i) => {
    // The conductor's order is the process order: times only move forward.
    at = Math.max(at, timeOf(s.evidenceIds) ?? at) + (i === 0 ? 0 : 1);
    const d = isRec(s.decision) ? s.decision : null;
    const reason = d ? str(d.reason) : null;
    const evidenceIds = evidenceOf(s.evidenceIds);
    return {
      id: str(s.id, 64) ?? `s${i + 1}`,
      kind: s.kind === 'judgment' || d !== null ? ('judgment' as const) : ('action' as const),
      goal: str(s.goal) ?? '',
      action: str(s.action) ?? '',
      status: confirmed ? ('confirmed' as const) : reason !== null ? ('inferred' as const) : ('observed' as const),
      atMs: at,
      evidenceIds,
      decision: d === null ? null : { summary: str(d.summary) ?? '', reason, quote: str(d.quote, 1000), evidenceIds },
      guardrailIds: [] as string[],
    };
  });

  const guardrails = list(raw.guardrails).filter(isRec).map((g, i) => {
    const reason = str(g.reason);
    const quote = str(g.quote, 1000);
    return {
      id: str(g.id, 64) ?? `g${i + 1}`,
      trigger: 'stop_condition' as const,
      condition: str(g.condition) ?? '',
      requiredAction: str(g.requiredAction) ?? '',
      requiredFacts: [],
      assumedFacts: [],
      scope: { kind: 'all' as const, customers: [] as string[], explicit: false },
      exceptions: strings(g.exceptions).map((text) => ({ text, quote: text })),
      unknowns: [] as string[],
      reason,
      reasonUnknown: false,
      quote,
      quoteAtMs: num(g.quoteAtMs),
      quotes: quote === null ? [] : [quote],
      scopeQuote: null,
      escalateTo: str(g.escalateTo, 120),
      duration: null,
      status: confirmed ? ('confirmed' as const) : ('proposed' as const),
      // The conductor keeps a reason only with the expert's words for it; without one the rule is a habit, never enforced.
      unexplained: reason === null,
      evidenceIds: evidenceOf(g.evidenceIds),
    };
  });

  const gaps: Question[] = list(raw.gaps).filter(isRec).flatMap((g, i) => {
    const text = str(g.question);
    if (text === null) return [];
    return [{ id: `gap-${i + 1}`, topic: 'reason' as const, text, evidenceIds: evidenceOf(g.evidenceIds), targetId: str(g.targetId, 64), entityRef: null }];
  });

  const comments: GenericComment[] = list(raw.comments).filter(isRec).flatMap((c) => {
    const text = str(c.text);
    const targetId = str(c.targetId, 64);
    return text === null || targetId === null ? [] : [{ targetId, text, atMs: num(c.atMs) ?? 0 }];
  });

  const map: WorkMap = {
    version: options.version ?? 1,
    status: confirmed ? 'confirmed' : 'draft',
    confirmed,
    sealedAtMs: null,
    confirmation: null,
    steps,
    guardrails,
    unknowns: [],
    answered: [],
  };
  return { map, gaps, teachBack: str(raw.teachBack, 4000), comments };
}
